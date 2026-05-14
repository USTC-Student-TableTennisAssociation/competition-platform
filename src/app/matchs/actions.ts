'use server'

import { CompetitionFormat, MatchStatus, MatchType, type Prisma } from '@prisma/client'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { getCurrentUser } from '@/lib/auth'
import { generateGroupingPayload } from '@/lib/tournament'
import { isMatchAllResultsFinished } from '@/lib/match-status'
import { settleSinglesElo, settleTeamElo } from '@/lib/elo'
import { validateCsrfToken } from '@/lib/csrf'
import { getAuditContext, writeAuditLog } from '@/lib/audit-log'
import {
  registerDoublesTeamByUser,
  removeRegisteredDoublesTeamByMember,
  unregisterDoublesTeamByUser,
} from '@/lib/doubles'

const UNLIMITED_MAX_PARTICIPANTS = 2147483647
const MATCH_POINTS_CAP_PER_MATCH = 5
const MATCH_POINTS_REFERENCE_PREFIX = 'match-points:'

export type MatchFormState = {
  error?: string
  success?: string
}

export type GroupingAdminState = {
  error?: string
  success?: string
  previewJson?: string
}

function parseDateTime(date: string, time: string, timezoneOffsetMinutes = 0) {
  const [year, month, day] = date.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)

  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day) ||
    !Number.isFinite(hour) ||
    !Number.isFinite(minute)
  ) {
    return new Date(NaN)
  }

  const utcMillis = Date.UTC(year, month - 1, day, hour, minute, 0) + timezoneOffsetMinutes * 60 * 1000
  return new Date(utcMillis)
}

function parseLocalDateTimeInput(input: string, timezoneOffsetMinutes = 0) {
  const [date, timeWithSeconds] = input.split('T')
  const time = (timeWithSeconds ?? '').slice(0, 5)

  if (!date || !time) return new Date(NaN)
  return parseDateTime(date, time, timezoneOffsetMinutes)
}

function parseBestOf(raw: FormDataEntryValue | null) {
  const value = Number(raw ?? 0)
  if (![3, 5, 7].includes(value)) return null
  return value as 3 | 5 | 7
}

function validateSingleScore(bestOf: 3 | 5 | 7, myScore: number, opponentScore: number, didWin: boolean) {
  const winsNeeded = Math.floor(bestOf / 2) + 1

  if (!Number.isInteger(myScore) || !Number.isInteger(opponentScore)) {
    return { ok: false as const, error: '比分必须为整数。' }
  }

  if (myScore < 0 || opponentScore < 0 || myScore > winsNeeded || opponentScore > winsNeeded) {
    return { ok: false as const, error: '比分超出可选范围。' }
  }

  if (myScore === winsNeeded && opponentScore === winsNeeded) {
    return { ok: false as const, error: '双方不能同时达到胜场。' }
  }

  if (myScore !== winsNeeded && opponentScore !== winsNeeded) {
    return { ok: false as const, error: `必须有一方达到 ${winsNeeded} 胜。` }
  }

  const myActuallyWon = myScore > opponentScore
  if (myActuallyWon !== didWin) {
    return { ok: false as const, error: '“本场结果”与比分不一致，请检查。' }
  }

  const scoreText = `${myScore}:${opponentScore}（${bestOf}局${winsNeeded}胜）`
  return { ok: true as const, scoreText }
}

function extractWinnerLoserSets(score: unknown) {
  if (typeof score === 'object' && score) {
    const winnerScore = Number((score as { winnerScore?: unknown }).winnerScore)
    const loserScore = Number((score as { loserScore?: unknown }).loserScore)
    if (Number.isFinite(winnerScore) && Number.isFinite(loserScore)) {
      return { winnerScore, loserScore }
    }
  }
  return null
}

function buildGroupStandingsForKnockout(
  players: Array<{ id: string; nickname: string; eloRating: number }>,
  results: Array<{ winnerTeamIds: string[]; loserTeamIds: string[]; confirmed: boolean; score: unknown }>,
) {
  const standings = players.map((player) => ({
    id: player.id,
    nickname: player.nickname,
    wins: 0,
    losses: 0,
    setWins: 0,
    setLosses: 0,
    eloRating: player.eloRating,
  }))

  const byId = new Map(standings.map((item) => [item.id, item]))
  const playerIdSet = new Set(players.map((player) => player.id))

  for (const result of results) {
    if (!result.confirmed) continue
    if (result.winnerTeamIds.length !== 1 || result.loserTeamIds.length !== 1) continue

    const winnerId = result.winnerTeamIds[0]
    const loserId = result.loserTeamIds[0]
    if (!playerIdSet.has(winnerId) || !playerIdSet.has(loserId)) continue

    const winner = byId.get(winnerId)
    const loser = byId.get(loserId)
    if (!winner || !loser) continue

    winner.wins += 1
    loser.losses += 1

    const sets = extractWinnerLoserSets(result.score)
    if (sets) {
      winner.setWins += sets.winnerScore
      winner.setLosses += sets.loserScore
      loser.setWins += sets.loserScore
      loser.setLosses += sets.winnerScore
    }
  }

  return standings.sort((a, b) => {
    const winDiff = b.wins - a.wins
    if (winDiff !== 0) return winDiff
    const setDiff = (b.setWins - b.setLosses) - (a.setWins - a.setLosses)
    if (setDiff !== 0) return setDiff
    const setWinDiff = b.setWins - a.setWins
    if (setWinDiff !== 0) return setWinDiff
    return b.eloRating - a.eloRating
  })
}

function resolveCurrentKnockoutOpponent(params: {
  currentUserId: string
  groupingGeneratedAt: Date | null
  qualifiersPerGroup: number
  groups: Array<{ name: string; players: Array<{ id: string; nickname: string; eloRating: number }> }>
  knockoutRounds: Array<{ matches: Array<{ id: string; homeLabel: string; awayLabel: string }> }>
  results: Array<{ winnerTeamIds: string[]; loserTeamIds: string[]; confirmed: boolean; score: unknown; createdAt: Date; resultVerifiedAt: Date | null }>
}) {
  const {
    currentUserId,
    groupingGeneratedAt,
    qualifiersPerGroup,
    groups,
    knockoutRounds,
    results,
  } = params

  const confirmedSingles = results.filter(
    (result) =>
      result.confirmed &&
      result.winnerTeamIds.length === 1 &&
      result.loserTeamIds.length === 1,
  )

  const qualifierMap = new Map<string, { id: string; nickname: string }>()
  for (const group of groups) {
    const standings = buildGroupStandingsForKnockout(group.players, confirmedSingles)
    const groupPlayerIdSet = new Set(group.players.map((player) => player.id))
    const groupConfirmedCount = confirmedSingles.filter((result) => {
      const winnerId = result.winnerTeamIds[0]
      const loserId = result.loserTeamIds[0]
      return groupPlayerIdSet.has(winnerId) && groupPlayerIdSet.has(loserId)
    }).length
    const totalGroupMatches =
      group.players.length > 1 ? (group.players.length * (group.players.length - 1)) / 2 : 0

    if (!(totalGroupMatches > 0 && groupConfirmedCount >= totalGroupMatches)) continue

    standings.slice(0, Math.min(qualifiersPerGroup, standings.length)).forEach((item, index) => {
      qualifierMap.set(`${group.name}第 ${index + 1} 名`, { id: item.id, nickname: item.nickname })
    })
  }

  const winnerByMatchId = new Map<string, { id: string; nickname: string }>()

  const getHeadToHeadResult = (idA: string, idB: string) => {
    const candidates = confirmedSingles.filter(
      (result) =>
        (!groupingGeneratedAt || result.createdAt >= groupingGeneratedAt) &&
        ((result.winnerTeamIds[0] === idA && result.loserTeamIds[0] === idB) ||
          (result.winnerTeamIds[0] === idB && result.loserTeamIds[0] === idA)),
    )

    if (candidates.length === 0) return null
    return [...candidates].sort((a, b) => {
      const ta = (a.resultVerifiedAt ?? a.createdAt).getTime()
      const tb = (b.resultVerifiedAt ?? b.createdAt).getTime()
      return tb - ta
    })[0]
  }

  const resolveLabel = (label: string) => {
    const qualifier = qualifierMap.get(label)
    if (qualifier) return { id: qualifier.id, nickname: qualifier.nickname }
    const winnerRef = label.match(/^胜者\s+(.+)$/)
    if (winnerRef) return winnerByMatchId.get(winnerRef[1]) ?? null
    return null
  }

  for (const round of knockoutRounds) {
    for (const match of round.matches) {
      const home = resolveLabel(match.homeLabel)
      const away = resolveLabel(match.awayLabel)

      if (home && away) {
        const result = getHeadToHeadResult(home.id, away.id)
        if (result) {
          const winnerId = result.winnerTeamIds[0]
          winnerByMatchId.set(match.id, winnerId === home.id ? home : away)
          continue
        }

        if (home.id === currentUserId) return away.id
        if (away.id === currentUserId) return home.id
      }
    }
  }

  return null
}

function resolveFilledKnockoutRoundsForValidation(params: {
  groupingGeneratedAt: Date | null
  qualifiersPerGroup: number
  groups: Array<{ name: string; players: Array<{ id: string; nickname: string; eloRating: number }> }>
  knockoutRounds: Array<{ name: string; matches: Array<{ id: string; homeLabel: string; awayLabel: string }> }>
  results: Array<{ winnerTeamIds: string[]; loserTeamIds: string[]; confirmed: boolean; score: unknown; createdAt: Date; resultVerifiedAt: Date | null }>
}) {
  const {
    groupingGeneratedAt,
    qualifiersPerGroup,
    groups,
    knockoutRounds,
    results,
  } = params

  const confirmedSingles = results.filter(
    (result) =>
      result.confirmed &&
      result.winnerTeamIds.length === 1 &&
      result.loserTeamIds.length === 1,
  )

  const qualifierMap = new Map<string, { id: string; nickname: string }>()
  for (const group of groups) {
    const standings = buildGroupStandingsForKnockout(group.players, confirmedSingles)
    const groupPlayerIdSet = new Set(group.players.map((player) => player.id))
    const groupConfirmedCount = confirmedSingles.filter((result) => {
      const winnerId = result.winnerTeamIds[0]
      const loserId = result.loserTeamIds[0]
      return groupPlayerIdSet.has(winnerId) && groupPlayerIdSet.has(loserId)
    }).length
    const totalGroupMatches = group.players.length > 1 ? (group.players.length * (group.players.length - 1)) / 2 : 0
    const groupCompleted = totalGroupMatches > 0 && groupConfirmedCount >= totalGroupMatches
    if (!groupCompleted) continue

    standings
      .slice(0, Math.min(qualifiersPerGroup, standings.length))
      .forEach((item, index) => {
        qualifierMap.set(`${group.name}第 ${index + 1} 名`, {
          id: item.id,
          nickname: item.nickname,
        })
      })
  }

  const winnerByMatchId = new Map<string, { id: string; nickname: string }>()

  const getHeadToHeadResult = (idA: string, idB: string) => {
    const candidates = confirmedSingles.filter(
      (result) =>
        (!groupingGeneratedAt || result.createdAt >= groupingGeneratedAt) &&
        ((result.winnerTeamIds[0] === idA && result.loserTeamIds[0] === idB) ||
          (result.winnerTeamIds[0] === idB && result.loserTeamIds[0] === idA)),
    )

    if (candidates.length === 0) return null

    return [...candidates].sort((a, b) => {
      const ta = (a.resultVerifiedAt ?? a.createdAt).getTime()
      const tb = (b.resultVerifiedAt ?? b.createdAt).getTime()
      return tb - ta
    })[0]
  }

  const resolveLabel = (label: string) => {
    const qualifier = qualifierMap.get(label)
    if (qualifier) {
      return { id: qualifier.id, nickname: qualifier.nickname }
    }

    const winnerRef = label.match(/^胜者\s+(.+)$/)
    if (winnerRef) {
      return winnerByMatchId.get(winnerRef[1]) ?? null
    }

    return null
  }

  return knockoutRounds.map((round) => ({
    name: round.name,
    matches: round.matches.map((match) => {
      const home = resolveLabel(match.homeLabel)
      const away = resolveLabel(match.awayLabel)

      if (home && away) {
        const result = getHeadToHeadResult(home.id, away.id)
        if (result) {
          const winnerId = result.winnerTeamIds[0]
          winnerByMatchId.set(match.id, winnerId === home.id ? home : away)
          return {
            id: match.id,
            homePlayerId: home.id,
            awayPlayerId: away.id,
            decided: true,
          }
        }

        return {
          id: match.id,
          homePlayerId: home.id,
          awayPlayerId: away.id,
          decided: false,
        }
      }

      return {
        id: match.id,
        homePlayerId: null,
        awayPlayerId: null,
        decided: false,
      }
    }),
  }))
}

function canManageGrouping(currentUser: Awaited<ReturnType<typeof getCurrentUser>>, createdBy: string) {
  if (!currentUser) return false
  return currentUser.id === createdBy || currentUser.role === 'admin'
}

async function grantMatchRewardPoints(
  tx: Prisma.TransactionClient,
  params: {
    userId: string
    matchId: string
    eventKey: string
    desiredAmount: number
    reason: string
  },
) {
  const { userId, matchId, eventKey, desiredAmount, reason } = params
  const referenceId = `${MATCH_POINTS_REFERENCE_PREFIX}${matchId}:${eventKey}`
  const matchReferencePrefix = `${MATCH_POINTS_REFERENCE_PREFIX}${matchId}:`

  const [existingEventReward, awardedSummary, user] = await Promise.all([
    tx.pointsTransaction.findFirst({
      where: {
        userId,
        referenceId,
      },
      select: { id: true },
    }),
    tx.pointsTransaction.aggregate({
      where: {
        userId,
        referenceId: {
          startsWith: matchReferencePrefix,
        },
      },
      _sum: { amount: true },
    }),
    tx.user.findUnique({ where: { id: userId }, select: { points: true } }),
  ])

  const alreadyAwarded = awardedSummary._sum.amount ?? 0
  if (!user || existingEventReward) {
    return {
      granted: 0,
      totalAwarded: alreadyAwarded,
    }
  }

  const remaining = Math.max(0, MATCH_POINTS_CAP_PER_MATCH - alreadyAwarded)
  const grant = Math.max(0, Math.min(desiredAmount, remaining))

  if (grant <= 0) {
    return {
      granted: 0,
      totalAwarded: alreadyAwarded,
    }
  }

  const balanceAfter = user.points + grant

  await tx.user.update({
    where: { id: userId },
    data: {
      points: {
        increment: grant,
      },
    },
  })

  await tx.pointsTransaction.create({
    data: {
      userId,
      amount: grant,
      balanceAfter,
      type: 'earn',
      reason,
      referenceId,
    },
  })

  return {
    granted: grant,
    totalAwarded: alreadyAwarded + grant,
  }
}

async function grantRegistrationRewardPoints(
  tx: Prisma.TransactionClient,
  params: {
    userId: string
    matchId: string
  },
) {
  const { userId, matchId } = params
  const registrationReferencePrefix = `${MATCH_POINTS_REFERENCE_PREFIX}${matchId}:register:`

  const [registrationSummary, matchSummary, user] = await Promise.all([
    tx.pointsTransaction.aggregate({
      where: {
        userId,
        referenceId: {
          startsWith: registrationReferencePrefix,
        },
      },
      _sum: { amount: true },
    }),
    tx.pointsTransaction.aggregate({
      where: {
        userId,
        referenceId: {
          startsWith: `${MATCH_POINTS_REFERENCE_PREFIX}${matchId}:`,
        },
      },
      _sum: { amount: true },
    }),
    tx.user.findUnique({ where: { id: userId }, select: { points: true } }),
  ])

  const netRegistrationAwarded = registrationSummary._sum.amount ?? 0
  const netMatchAwarded = matchSummary._sum.amount ?? 0

  if (!user || netRegistrationAwarded >= 1) {
    return {
      granted: 0,
      totalAwarded: netMatchAwarded,
    }
  }

  const remaining = Math.max(0, MATCH_POINTS_CAP_PER_MATCH - netMatchAwarded)
  const grant = Math.min(1 - netRegistrationAwarded, remaining)

  if (grant <= 0) {
    return {
      granted: 0,
      totalAwarded: netMatchAwarded,
    }
  }

  const balanceAfter = user.points + grant

  await tx.user.update({
    where: { id: userId },
    data: {
      points: {
        increment: grant,
      },
    },
  })

  await tx.pointsTransaction.create({
    data: {
      userId,
      amount: grant,
      balanceAfter,
      type: 'earn',
      reason: '报名比赛奖励',
      referenceId: `${registrationReferencePrefix}earn:${Date.now()}`,
    },
  })

  return {
    granted: grant,
    totalAwarded: netMatchAwarded + grant,
  }
}

async function refundRegistrationRewardPoints(
  tx: Prisma.TransactionClient,
  params: {
    userId: string
    matchId: string
  },
) {
  const { userId, matchId } = params
  const registrationReferencePrefix = `${MATCH_POINTS_REFERENCE_PREFIX}${matchId}:register:`
  const matchReferencePrefix = `${MATCH_POINTS_REFERENCE_PREFIX}${matchId}:`

  const [registrationSummary, matchSummary, user] = await Promise.all([
    tx.pointsTransaction.aggregate({
      where: {
        userId,
        referenceId: {
          startsWith: registrationReferencePrefix,
        },
      },
      _sum: { amount: true },
    }),
    tx.pointsTransaction.aggregate({
      where: {
        userId,
        referenceId: {
          startsWith: matchReferencePrefix,
        },
      },
      _sum: { amount: true },
    }),
    tx.user.findUnique({ where: { id: userId }, select: { points: true } }),
  ])

  const netRegistrationAwarded = registrationSummary._sum.amount ?? 0
  const netMatchAwarded = matchSummary._sum.amount ?? 0
  if (!user || netRegistrationAwarded <= 0) {
    return {
      deducted: 0,
      totalAwarded: netMatchAwarded,
    }
  }

  const deduction = Math.min(1, netRegistrationAwarded, user.points)
  if (deduction <= 0) {
    return {
      deducted: 0,
      totalAwarded: netMatchAwarded,
    }
  }

  const balanceAfter = user.points - deduction

  await tx.user.update({
    where: { id: userId },
    data: {
      points: {
        decrement: deduction,
      },
    },
  })

  await tx.pointsTransaction.create({
    data: {
      userId,
      amount: -deduction,
      balanceAfter,
      type: 'refund',
      reason: '退出报名返还奖励积分',
      referenceId: `${registrationReferencePrefix}refund:${Date.now()}`,
    },
  })

  return {
    deducted: deduction,
    totalAwarded: netMatchAwarded - deduction,
  }
}

function getPossibleKValues(eloRating: number) {
  const baseCandidates = [40, 28, 20]
  const adjust = eloRating >= 2200 ? -8 : eloRating >= 2000 ? -4 : 0
  return Array.from(new Set(baseCandidates.map((base) => Math.max(12, Math.min(48, base + adjust)))))
}

function inferKFromDelta(params: {
  eloRating: number
  expected: number
  oldDelta: number
  wasWinner: boolean
}) {
  const { eloRating, expected, oldDelta, wasWinner } = params
  const ks = getPossibleKValues(eloRating)
  const target = wasWinner ? 1 - expected : 0 - expected
  const matched = ks.filter((k) => Math.round(k * target) === oldDelta)
  if (matched.length > 0) {
    return matched[0]
  }
  return null
}

async function revokeMatchRewardPointsForEvent(
  tx: Prisma.TransactionClient,
  params: {
    userId: string
    matchId: string
    eventKey: string
    reason: string
  },
) {
  const { userId, matchId, eventKey, reason } = params
  const referenceId = `${MATCH_POINTS_REFERENCE_PREFIX}${matchId}:${eventKey}`
  const matchReferencePrefix = `${MATCH_POINTS_REFERENCE_PREFIX}${matchId}:`

  const [eventSummary, matchSummary, user] = await Promise.all([
    tx.pointsTransaction.aggregate({
      where: {
        userId,
        referenceId,
      },
      _sum: { amount: true },
    }),
    tx.pointsTransaction.aggregate({
      where: {
        userId,
        referenceId: {
          startsWith: matchReferencePrefix,
        },
      },
      _sum: { amount: true },
    }),
    tx.user.findUnique({ where: { id: userId }, select: { points: true } }),
  ])

  const eventAwarded = eventSummary._sum.amount ?? 0
  const netMatchAwarded = matchSummary._sum.amount ?? 0

  if (!user || eventAwarded <= 0) {
    return {
      deducted: 0,
      totalAwarded: netMatchAwarded,
    }
  }

  const deduction = Math.min(eventAwarded, user.points)
  if (deduction <= 0) {
    return {
      deducted: 0,
      totalAwarded: netMatchAwarded,
    }
  }

  const balanceAfter = user.points - deduction

  await tx.user.update({
    where: { id: userId },
    data: {
      points: {
        decrement: deduction,
      },
    },
  })

  await tx.pointsTransaction.create({
    data: {
      userId,
      amount: -deduction,
      balanceAfter,
      type: 'refund',
      reason,
      referenceId: `${referenceId}:revoke:${Date.now()}`,
    },
  })

  return {
    deducted: deduction,
    totalAwarded: netMatchAwarded - deduction,
  }
}


async function applyConfirmedResult(tx: Prisma.TransactionClient, payload: {
  matchId: string
  matchResultId?: string
  winnerTeamIds: string[]
  loserTeamIds: string[]
}) {
  const allParticipantIds = [...payload.winnerTeamIds, ...payload.loserTeamIds]
  const users = await tx.user.findMany({
    where: { id: { in: allParticipantIds } },
    select: { id: true, eloRating: true, matchesPlayed: true, wins: true, losses: true },
  })

  if (users.length !== allParticipantIds.length) {
    throw new Error('存在无效选手，无法结算 ELO。')
  }

  const userMap = new Map(users.map((u) => [u.id, u]))
  const winnerTeam = payload.winnerTeamIds.map((id) => ({ userId: id, eloRating: userMap.get(id)!.eloRating, matchesPlayed: userMap.get(id)!.matchesPlayed }))
  const loserTeam = payload.loserTeamIds.map((id) => ({ userId: id, eloRating: userMap.get(id)!.eloRating, matchesPlayed: userMap.get(id)!.matchesPlayed }))

  const deltas = winnerTeam.length === 1 && loserTeam.length === 1
    ? settleSinglesElo(winnerTeam[0], loserTeam[0])
    : settleTeamElo(winnerTeam, loserTeam)

  for (const delta of deltas) {
    const base = userMap.get(delta.userId)
    if (!base) continue

    await tx.user.update({
      where: { id: delta.userId },
      data: {
        eloRating: delta.after,
        matchesPlayed: base.matchesPlayed + 1,
        wins: payload.winnerTeamIds.includes(delta.userId) ? base.wins + 1 : base.wins,
        losses: payload.loserTeamIds.includes(delta.userId) ? base.losses + 1 : base.losses,
      },
    })

    await tx.eloHistory.create({
      data: {
        userId: delta.userId,
        matchId: payload.matchId,
        matchResultId: payload.matchResultId,
        eloBefore: delta.before,
        eloAfter: delta.after,
        delta: delta.delta,
      },
    })
  }
}

export async function createMatchAction(_: MatchFormState, formData: FormData): Promise<MatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录后再发布比赛。' }

  const auditContext = await getAuditContext()

  const title = String(formData.get('title') ?? '').trim()
  const description = String(formData.get('description') ?? '').trim()
  const location = String(formData.get('location') ?? '').trim()
  const matchDateTimeInput = String(formData.get('matchDateTime') ?? '')
  const date = String(formData.get('date') ?? '')
  const time = String(formData.get('time') ?? '')
  const deadlineDate = String(formData.get('deadlineDate') ?? '')
  const deadlineTime = String(formData.get('deadlineTime') ?? '')
  const registrationDeadlineRaw = String(formData.get('registrationDeadline') ?? '')
  const startDateTimeInput = matchDateTimeInput || (date && time ? `${date}T${time}` : '')
  const registrationDeadline =
    registrationDeadlineRaw || (deadlineDate && deadlineTime ? `${deadlineDate}T${deadlineTime}` : '')
  const timezoneOffsetRaw = Number(formData.get('timezoneOffset') ?? 0)
  const type = String(formData.get('type') ?? 'single') as MatchType
  const format = String(formData.get('format') ?? 'group_only') as CompetitionFormat
  const timezoneOffset = Number.isFinite(timezoneOffsetRaw) ? timezoneOffsetRaw : 0

  if (!title || !location || !startDateTimeInput || !registrationDeadline) {
    return { error: '请完整填写必填项。' }
  }

  const matchDate = parseLocalDateTimeInput(startDateTimeInput, timezoneOffset)
  const deadline = parseLocalDateTimeInput(registrationDeadline, timezoneOffset)

  if (Number.isNaN(matchDate.getTime()) || Number.isNaN(deadline.getTime())) {
    return { error: '时间格式无效。' }
  }

  if (deadline >= matchDate) {
    return { error: '报名截止时间必须早于比赛开始时间。' }
  }

  const created = await prisma.match.create({
    data: {
      title,
      description: description || null,
      dateTime: matchDate,
      registrationDeadline: deadline,
      location,
      type,
      format,
      maxParticipants: UNLIMITED_MAX_PARTICIPANTS,
      status: MatchStatus.registration,
      createdBy: currentUser.id,
      rule: {
        note: format === 'group_only' ? '分组循环赛' : '先分组后淘汰赛',
      },
    },
  })

  await writeAuditLog({
    actorId: currentUser.id,
    action: 'match.create',
    entityType: 'Match',
    entityId: created.id,
    details: {
      targetLabel: title,
      title,
      type,
      format,
      dateTime: matchDate.toISOString(),
      registrationDeadline: deadline.toISOString(),
    },
    ip: auditContext.ip,
    userAgent: auditContext.userAgent,
  })

  await prisma.registration.deleteMany({ where: { matchId: created.id, userId: currentUser.id } })

  revalidatePath('/matchs')
  redirect(`/matchs/${created.id}`)
}

export async function registerMatchAction(matchId: string, _: MatchFormState, formData: FormData): Promise<MatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录后报名。' }

  const match = await prisma.match.findUnique({ where: { id: matchId } })

  if (!match) return { error: '比赛不存在。' }
  if (match.status !== MatchStatus.registration) return { error: '当前比赛不在报名阶段。' }
  if (new Date() >= match.registrationDeadline) return { error: '报名已截止。' }

  if (match.type === 'double') {
    const result = await registerDoublesTeamByUser(matchId, currentUser.id)
    if (!result.ok) return { error: result.error }

    const currentUserReward = await prisma.$transaction(async (tx) => {
      let current = { granted: 0, totalAwarded: 0 }
      for (const memberId of result.memberIds) {
        const reward = await grantRegistrationRewardPoints(tx, {
          userId: memberId,
          matchId,
        })
        if (memberId === currentUser.id) {
          current = reward
        }
      }
      return current
    })

    revalidatePath('/matchs')
    revalidatePath('/team-invites')
    revalidatePath(`/matchs/${matchId}`)
    return {
      success:
        `双打小队报名成功！报名奖励：积分+${currentUserReward.granted}。` +
        `（本赛事已获积分 ${currentUserReward.totalAwarded}/${MATCH_POINTS_CAP_PER_MATCH}）`,
    }
  }

  try {
    const reward = await prisma.$transaction(async (tx) => {
      await tx.registration.create({
        data: { matchId, userId: currentUser.id },
      })

      return grantRegistrationRewardPoints(tx, {
        userId: currentUser.id,
        matchId,
      })
    })

    revalidatePath('/matchs')
    revalidatePath(`/matchs/${matchId}`)
    return {
      success:
        `报名成功！报名奖励：积分+${reward.granted}。` +
        `（本赛事已获积分 ${reward.totalAwarded}/${MATCH_POINTS_CAP_PER_MATCH}）`,
    }
  } catch {
    return { error: '你已报名该比赛。' }
  }
}

export async function updateMatchFormatAction(matchId: string, _: MatchFormState, formData: FormData): Promise<MatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录。' }

  const auditContext = await getAuditContext()

  const match = await prisma.match.findUnique({ where: { id: matchId } })
  if (!match) return { error: '比赛不存在。' }
  if (match.createdBy !== currentUser.id) return { error: '仅发起人可修改赛制。' }
  if (new Date() >= match.registrationDeadline) return { error: '报名截止后不可修改赛制。' }

  const format = String(formData.get('format') ?? match.format) as CompetitionFormat
  const deadlineInput = String(formData.get('registrationDeadline') ?? '')
  const timezoneOffsetRaw = Number(formData.get('timezoneOffset') ?? 0)
  const timezoneOffset = Number.isFinite(timezoneOffsetRaw) ? timezoneOffsetRaw : 0

  const nextDeadline = deadlineInput ? parseLocalDateTimeInput(deadlineInput, timezoneOffset) : match.registrationDeadline
  if (Number.isNaN(nextDeadline.getTime())) return { error: '截止时间格式错误。' }
  if (nextDeadline >= match.dateTime) return { error: '截止时间必须早于比赛开始时间。' }

  await prisma.match.update({
    where: { id: matchId },
    data: {
      format,
      registrationDeadline: nextDeadline,
      groupingGeneratedAt: null,
      status: MatchStatus.registration,
    },
  })
  await prisma.matchGrouping.deleteMany({ where: { matchId } })

  await writeAuditLog({
    actorId: currentUser.id,
    action: 'match.format.update',
    entityType: 'Match',
    entityId: matchId,
    details: {
      targetLabel: match.title,
      format,
      registrationDeadline: nextDeadline.toISOString(),
    },
    ip: auditContext.ip,
    userAgent: auditContext.userAgent,
  })

  revalidatePath(`/matchs/${matchId}`)
  revalidatePath('/matchs')
  return { success: '赛制设置已更新。' }
}

export async function unregisterMatchAction(matchId: string, _: MatchFormState, formData: FormData): Promise<MatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录。' }

  const match = await prisma.match.findUnique({ where: { id: matchId } })
  if (!match) return { error: '比赛不存在。' }
  if (new Date() >= match.registrationDeadline) return { error: '报名截止后不可退出。' }

  if (match.type === 'double') {
    const result = await unregisterDoublesTeamByUser(matchId, currentUser.id)
    if (!result.ok) return { error: result.error }

    const currentUserRefund = await prisma.$transaction(async (tx) => {
      let current = { deducted: 0, totalAwarded: 0 }
      for (const memberId of result.memberIds) {
        const refund = await refundRegistrationRewardPoints(tx, {
          userId: memberId,
          matchId,
        })
        if (memberId === currentUser.id) {
          current = refund
        }
      }
      return current
    })

    revalidatePath('/team-invites')
    revalidatePath('/matchs')
    revalidatePath(`/matchs/${matchId}`)
    return {
      success:
        `已退出双打小队报名，已扣除积分 ${currentUserRefund.deducted}。` +
        `（本赛事已获积分 ${currentUserRefund.totalAwarded}/${MATCH_POINTS_CAP_PER_MATCH}）`,
    }
  }

  const unregisterResult = await prisma.$transaction(async (tx) => {
    const deleted = await tx.registration.deleteMany({
      where: { matchId, userId: currentUser.id },
    })

    if (deleted.count === 0) {
      return {
        deleted: 0,
        deducted: 0,
        totalAwarded: 0,
      }
    }

    const refund = await refundRegistrationRewardPoints(tx, {
      userId: currentUser.id,
      matchId,
    })

    return {
      deleted: deleted.count,
      deducted: refund.deducted,
      totalAwarded: refund.totalAwarded,
    }
  })

  if (unregisterResult.deleted === 0) {
    return { error: '你尚未报名该比赛。' }
  }

  revalidatePath('/matchs')
  revalidatePath(`/matchs/${matchId}`)
  return {
    success:
      `已退出报名，已扣除积分 ${unregisterResult.deducted}。` +
      `（本赛事已获积分 ${unregisterResult.totalAwarded}/${MATCH_POINTS_CAP_PER_MATCH}）`,
  }
}

export async function updateMatchAction(matchId: string, formData: FormData) {
  try {
    const csrfError = await validateCsrfToken(formData)
    if (csrfError) return { error: csrfError, success: false }

    const currentUser = await getCurrentUser()
    if (!currentUser) return { error: '请先登录。', success: false }

    const auditContext = await getAuditContext()

    const match = await prisma.match.findUnique({ where: { id: matchId } })
    if (!match) return { error: '比赛不存在。', success: false }
    if (match.createdBy !== currentUser.id) return { error: '仅发起人可修改比赛。', success: false }
    if (new Date() >= match.registrationDeadline) return { error: '报名截止后不可修改。', success: false }

    const title = String(formData.get('title') ?? '').trim()
    const description = String(formData.get('description') ?? '').trim()
    const location = String(formData.get('location') ?? '').trim()
    const matchDateTimeInput = String(formData.get('matchDateTime') ?? '')
    const date = String(formData.get('date') ?? '')
    const time = String(formData.get('time') ?? '')
    const type = String(formData.get('type') ?? 'single') as MatchType
    const format = String(formData.get('format') ?? match.format) as CompetitionFormat
    const deadlineInput = String(formData.get('registrationDeadline') ?? '')
    const startDateTimeInput = matchDateTimeInput || (date && time ? `${date}T${time}` : '')
    const timezoneOffsetRaw = Number(formData.get('timezoneOffset') ?? 0)
    const timezoneOffset = Number.isFinite(timezoneOffsetRaw) ? timezoneOffsetRaw : 0

    if (!title || !location || !startDateTimeInput) return { error: '请完整填写必填项。', success: false }

    const matchDate = parseLocalDateTimeInput(startDateTimeInput, timezoneOffset)
    if (Number.isNaN(matchDate.getTime())) return { error: '比赛时间格式无效。', success: false }

    const deadline = deadlineInput ? parseLocalDateTimeInput(deadlineInput, timezoneOffset) : match.registrationDeadline
    if (Number.isNaN(deadline.getTime())) return { error: '截止时间格式错误。', success: false }
    if (deadline >= matchDate) return { error: '截止时间必须早于比赛开始时间。', success: false }

    await prisma.match.update({
      where: { id: matchId },
      data: {
        title,
        description: description || null,
        location,
        dateTime: matchDate,
        type,
        format,
        registrationDeadline: deadline,
        groupingGeneratedAt: null,
        status: MatchStatus.registration,
        rule: {
          note: format === 'group_only' ? '分组循环赛' : '先分组后淘汰赛',
        },
      },
    })

    // Remove groupings if format changed or just to be safe as per previous logic
    await prisma.matchGrouping.deleteMany({ where: { matchId } })

    await writeAuditLog({
      actorId: currentUser.id,
      action: 'match.update',
      entityType: 'Match',
      entityId: matchId,
      details: {
        targetLabel: title,
        title,
        type,
        format,
        dateTime: matchDate.toISOString(),
        registrationDeadline: deadline.toISOString(),
      },
      ip: auditContext.ip,
      userAgent: auditContext.userAgent,
    })

    // We do NOT revalidatePath here to avoid server-side hanging.
    // The client will force a location change.
    return { success: true }
  } catch (error) {
    console.error('Update Match Error:', error)
    return { error: '更新失败，系统错误。', success: false }
  }
}

export async function previewGroupingAction(matchId: string, _: GroupingAdminState, formData: FormData): Promise<GroupingAdminState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      registrations: {
        include: {
          user: {
            select: { id: true, nickname: true, points: true, eloRating: true },
          },
        },
      },
    },
  })

  if (!match) return { error: '比赛不存在。' }
  if (!canManageGrouping(currentUser, match.createdBy)) return { error: '仅发起人或管理员可生成分组。' }
  if (new Date() < match.registrationDeadline) return { error: '报名截止后才可生成分组。' }

  const groupCount = Number(formData.get('groupCount') ?? 0)
  const qualifiersPerGroup = Number(formData.get('qualifiersPerGroup') ?? 1)
  const seedMethodRaw = String(formData.get('seedMethod') ?? 'min_diff')
  const seedMethod = seedMethodRaw === 'snake' ? 'snake' : 'min_diff'
  const participants = match.registrations.map((r) => r.user)

  if (participants.length < 2) return { error: '报名人数不足，无法分组。' }
  if (!Number.isFinite(groupCount) || groupCount < 1) return { error: '组数必须为正整数。' }
  if (groupCount > participants.length) return { error: '组数不能超过报名人数。' }

  try {
    const payload = generateGroupingPayload(match.format, participants, {
      groupCount,
      qualifiersPerGroup: match.format === 'group_then_knockout' ? qualifiersPerGroup : undefined,
      seedMethod,
    })

    return {
      success: '已生成分组预览，请确认发布。',
      previewJson: JSON.stringify(payload),
    }
  } catch (error) {
    console.error('generateGroupingAction failed', error)
    if (error instanceof Error && error.message) {
      return { error: `生成分组失败：${error.message}` }
    }
    return { error: '生成分组失败。' }
  }
}

export async function confirmGroupingAction(matchId: string, _: GroupingAdminState, formData: FormData): Promise<GroupingAdminState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  const previewJson = String(formData.get('previewJson') ?? '')

  if (!currentUser) return { error: '请先登录。' }

  const auditContext = await getAuditContext()

  if (!previewJson) return { error: '请先生成分组预览。' }

  const match = await prisma.match.findUnique({ where: { id: matchId }, include: { groupingResult: true } })
  if (!match) return { error: '比赛不存在。' }
  if (!canManageGrouping(currentUser, match.createdBy)) return { error: '仅发起人或管理员可确认分组。' }
  if (new Date() < match.registrationDeadline) return { error: '报名截止后才可确认分组。' }

  let payload: unknown
  try {
    payload = JSON.parse(previewJson)
  } catch {
    return { error: '预览数据无效，请重新生成。' }
  }

  await prisma.$transaction([
    prisma.matchGrouping.upsert({
      where: { matchId },
      create: { matchId, payload: payload as object },
      update: { payload: payload as object, createdAt: new Date() },
    }),
    prisma.match.update({
      where: { id: matchId },
      data: { status: MatchStatus.ongoing, groupingGeneratedAt: new Date() },
    }),
  ])

  await writeAuditLog({
    actorId: currentUser.id,
    action: 'match.grouping.confirm',
    entityType: 'Match',
    entityId: matchId,
    details: { mode: match.format, targetLabel: match.title },
    ip: auditContext.ip,
    userAgent: auditContext.userAgent,
  })

  revalidatePath('/matchs')
  revalidatePath(`/matchs/${matchId}`)

  return { success: '分组结果已确认并发布到所有用户页面。' }
}


export async function submitGroupMatchResultAction(matchId: string, _: MatchFormState, formData: FormData): Promise<MatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录。' }

  const opponentId = String(formData.get('opponentId') ?? '').trim()
  const didWin = String(formData.get('didWin') ?? 'true') === 'true'
  const bestOf = parseBestOf(formData.get('bestOf'))
  const myScore = Number(formData.get('myScore') ?? -1)
  const opponentScore = Number(formData.get('opponentScore') ?? -1)

  if (!opponentId || opponentId === currentUser.id) return { error: '请选择有效对手。' }
  if (!bestOf) return { error: '请选择合法的局制（3/5/7局）。' }

  const scoreValidation = validateSingleScore(bestOf, myScore, opponentScore, didWin)
  if (!scoreValidation.ok) return { error: scoreValidation.error }

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      registrations: { select: { userId: true } },
      groupingResult: true,
    },
  })

  if (!match) return { error: '比赛不存在。' }
  if (match.type !== 'single') return { error: '当前仅支持单打在站内流程化登记。' }
  if (!match.groupingResult) return { error: '尚未生成分组，无法登记结果。' }

  const registrationSet = new Set(match.registrations.map((r) => r.userId))
  if (!registrationSet.has(currentUser.id) || !registrationSet.has(opponentId)) {
    return { error: '你或对手未报名该比赛。' }
  }

  const payload = match.groupingResult.payload as { groups?: Array<{ players: Array<{ id: string }> }> }
  const inSameGroup = Boolean(payload.groups?.some((g) => {
    const ids = g.players.map((p) => p.id)
    return ids.includes(currentUser.id) && ids.includes(opponentId)
  }))
  if (!inSameGroup) return { error: '当前阶段只能登记与你同组对手的比赛。' }

  const exists = await prisma.matchResult.findFirst({
    where: {
      matchId,
      confirmed: false,
      OR: [
        { winnerTeamIds: { equals: [currentUser.id] }, loserTeamIds: { equals: [opponentId] } },
        { winnerTeamIds: { equals: [opponentId] }, loserTeamIds: { equals: [currentUser.id] } },
      ],
    },
  })
  if (exists) return { error: '该对局已有待确认登记。' }

  const winnerTeamIds = didWin ? [currentUser.id] : [opponentId]
  const loserTeamIds = didWin ? [opponentId] : [currentUser.id]

  await prisma.matchResult.create({
    data: {
      matchId,
      winnerId: winnerTeamIds[0],
      loserId: loserTeamIds[0],
      winnerTeamIds,
      loserTeamIds,
      score: {
        text: scoreValidation.scoreText,
        bestOf,
        myScore,
        opponentScore,
        winnerScore: didWin ? myScore : opponentScore,
        loserScore: didWin ? opponentScore : myScore,
      },
      reportedBy: currentUser.id,
      confirmed: false,
    },
  })

  revalidatePath(`/matchs/${matchId}`)
  return { success: '已登记，等待对手或管理员确认。' }
}

export async function submitKnockoutMatchResultAction(matchId: string, _: MatchFormState, formData: FormData): Promise<MatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录。' }

  const opponentId = String(formData.get('opponentId') ?? '').trim()
  const didWin = String(formData.get('didWin') ?? 'true') === 'true'
  const bestOf = parseBestOf(formData.get('bestOf'))
  const myScore = Number(formData.get('myScore') ?? -1)
  const opponentScore = Number(formData.get('opponentScore') ?? -1)

  if (!opponentId || opponentId === currentUser.id) return { error: '请选择有效对手。' }
  if (!bestOf) return { error: '请选择合法的局制（3/5/7局）。' }

  const scoreValidation = validateSingleScore(bestOf, myScore, opponentScore, didWin)
  if (!scoreValidation.ok) return { error: scoreValidation.error }

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      registrations: { select: { userId: true } },
      groupingResult: true,
      results: {
        select: {
          winnerTeamIds: true,
          loserTeamIds: true,
          confirmed: true,
          score: true,
          createdAt: true,
          resultVerifiedAt: true,
        },
      },
    },
  })

  if (!match) return { error: '比赛不存在。' }
  if (match.type !== 'single') return { error: '当前仅支持单打在站内流程化登记。' }
  if (!match.groupingResult) return { error: '尚未生成分组，无法登记淘汰赛结果。' }

  const registrationSet = new Set(match.registrations.map((r) => r.userId))
  if (!registrationSet.has(currentUser.id) || !registrationSet.has(opponentId)) {
    return { error: '你或对手未报名该比赛。' }
  }

  const payload = match.groupingResult.payload as {
    config?: { qualifiersPerGroup?: number }
    groups?: Array<{ name: string; players: Array<{ id: string; nickname: string; eloRating: number }> }>
    knockout?: { rounds: Array<{ matches: Array<{ id: string; homeLabel: string; awayLabel: string }> }> }
  }

  if (!payload.groups || !payload.knockout) {
    return { error: '当前未配置淘汰赛签表。' }
  }

  const expectedOpponentId = resolveCurrentKnockoutOpponent({
    currentUserId: currentUser.id,
    groupingGeneratedAt: match.groupingGeneratedAt ?? null,
    qualifiersPerGroup: payload.config?.qualifiersPerGroup ?? 1,
    groups: payload.groups,
    knockoutRounds: payload.knockout.rounds,
    results: match.results,
  })

  if (!expectedOpponentId) {
    return { error: '当前你的淘汰赛对手尚未产生或本轮已结束。' }
  }

  if (expectedOpponentId !== opponentId) {
    return { error: '当前仅可登记你本轮已产生对手的淘汰赛结果。' }
  }

  const exists = await prisma.matchResult.findFirst({
    where: {
      matchId,
      confirmed: false,
      OR: [
        { winnerTeamIds: { equals: [currentUser.id] }, loserTeamIds: { equals: [opponentId] } },
        { winnerTeamIds: { equals: [opponentId] }, loserTeamIds: { equals: [currentUser.id] } },
      ],
    },
  })
  if (exists) return { error: '该对局已有待确认登记。' }

  const winnerTeamIds = didWin ? [currentUser.id] : [opponentId]
  const loserTeamIds = didWin ? [opponentId] : [currentUser.id]

  await prisma.matchResult.create({
    data: {
      matchId,
      winnerId: winnerTeamIds[0],
      loserId: loserTeamIds[0],
      winnerTeamIds,
      loserTeamIds,
      score: {
        text: scoreValidation.scoreText,
        bestOf,
        myScore,
        opponentScore,
        winnerScore: didWin ? myScore : opponentScore,
        loserScore: didWin ? opponentScore : myScore,
      },
      reportedBy: currentUser.id,
      confirmed: false,
    },
  })

  revalidatePath(`/matchs/${matchId}`)
  return { success: '已登记淘汰赛结果，等待对手或管理员确认。' }
}

export async function confirmMatchResultAction(matchId: string, resultId: string, formData: FormData): Promise<MatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录。' }

  const auditContext = await getAuditContext()

  const result = await prisma.matchResult.findUnique({
    where: { id: resultId },
    include: { match: true },
  })

  if (!result || result.matchId !== matchId) return { error: '赛果不存在。' }
  if (result.confirmed) return { success: '该赛果已确认。' }

  const isOpponent = result.winnerTeamIds.includes(currentUser.id) || result.loserTeamIds.includes(currentUser.id)
  const isManager = result.match.createdBy === currentUser.id || currentUser.role === 'admin'
  if (!isOpponent && !isManager) return { error: '仅对阵双方或管理员可确认。' }
  if (result.reportedBy === currentUser.id && !isManager) return { error: '登记方需由对手确认，或由管理员确认。' }

  let winnerRewardSummary: Array<{
    userId: string
    wins: number
    granted: number
    totalAwarded: number
  }> = []

  try {
    await prisma.$transaction(async (tx) => {
      const latest = await tx.matchResult.findUnique({ where: { id: resultId } })
      if (!latest) throw new Error('赛果不存在。')
      if (latest.confirmed) return

      await applyConfirmedResult(tx, {
        matchId,
        matchResultId: latest.id,
        winnerTeamIds: latest.winnerTeamIds,
        loserTeamIds: latest.loserTeamIds,
      })

      await tx.matchResult.update({
        where: { id: resultId },
        data: {
          confirmed: true,
          resultVerifiedAt: new Date(),
          verifierId: currentUser.id,
        },
      })

      const uniqueWinnerIds = [...new Set(latest.winnerTeamIds)]
      winnerRewardSummary = await Promise.all(
        uniqueWinnerIds.map(async (winnerId) => {
          const reward = await grantMatchRewardPoints(tx, {
            userId: winnerId,
            matchId,
            eventKey: `win:${latest.id}:${winnerId}`,
            desiredAmount: 1,
            reason: '比赛胜利奖励',
          })

          const wins = await tx.matchResult.count({
            where: {
              matchId,
              confirmed: true,
              winnerTeamIds: {
                has: winnerId,
              },
            },
          })

          return {
            userId: winnerId,
            wins,
            granted: reward.granted,
            totalAwarded: reward.totalAwarded,
          }
        }),
      )
    })
  } catch (error) {
    console.error('confirmMatchResultAction failed', error)
    return { error: '确认失败。' }
  }

  const latestMatch = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      status: true,
      format: true,
      groupingGeneratedAt: true,
      groupingResult: { select: { payload: true } },
      results: {
        select: {
          winnerTeamIds: true,
          loserTeamIds: true,
          confirmed: true,
          score: true,
          createdAt: true,
          resultVerifiedAt: true,
        },
      },
    },
  })

  if (latestMatch && latestMatch.status !== MatchStatus.finished) {
    const shouldFinish = isMatchAllResultsFinished({
      format: latestMatch.format,
      groupingGeneratedAt: latestMatch.groupingGeneratedAt,
      groupingResult: latestMatch.groupingResult,
      results: latestMatch.results,
    })

    if (shouldFinish) {
      await prisma.match.update({
        where: { id: latestMatch.id },
        data: { status: MatchStatus.finished },
      })
    }
  }

  revalidatePath('/rankings')
  revalidatePath('/profile')
  revalidatePath(`/matchs/${matchId}`)

  await writeAuditLog({
    actorId: currentUser.id,
    action: 'match.result.confirm',
    entityType: 'MatchResult',
    entityId: resultId,
    details: { matchId, isManager, targetLabel: result.match.title },
    ip: auditContext.ip,
    userAgent: auditContext.userAgent,
  })
  if (winnerRewardSummary.length === 1) {
    const winner = winnerRewardSummary[0]
    return {
      success:
        `确认成功。胜方当前累计获胜 ${winner.wins} 场，` +
        `本次积分 +${winner.granted}，` +
        `本赛事已获积分 ${winner.totalAwarded}/${MATCH_POINTS_CAP_PER_MATCH}。`,
    }
  }

  if (winnerRewardSummary.length > 1) {
    const totalGranted = winnerRewardSummary.reduce((sum, item) => sum + item.granted, 0)
    return {
      success:
        `确认成功。胜方已累计胜场并结算积分，` +
        `本次共发放积分 +${totalGranted}（单人单赛事封顶 ${MATCH_POINTS_CAP_PER_MATCH}）。`,
    }
  }

  return { success: '确认成功，结果已生效。' }
}

export async function confirmMatchResultVoidAction(matchId: string, resultId: string, formData: FormData): Promise<void> {
  await confirmMatchResultAction(matchId, resultId, formData)
}

function expectedScoreByRating(selfRating: number, oppRating: number) {
  return 1 / (1 + 10 ** ((oppRating - selfRating) / 400))
}

export async function swapConfirmedMatchResultWinnerLoserAction(
  matchId: string,
  resultId: string,
  formData: FormData,
): Promise<MatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录。' }

  const auditContext = await getAuditContext()

  const result = await prisma.matchResult.findUnique({
    where: { id: resultId },
    include: { match: true },
  })

  if (!result || result.matchId !== matchId) return { error: '赛果不存在。' }
  if (!result.confirmed) return { error: '仅支持纠错已确认赛果。' }

  const isManager = result.match.createdBy === currentUser.id || currentUser.role === 'admin'
  if (!isManager) return { error: '仅发起人或管理员可执行纠错。' }

  if (result.winnerTeamIds.length === 0 || result.loserTeamIds.length === 0) {
    return { error: '当前赛果缺少胜负方成员，无法自动纠错。' }
  }

  const participantIdSet = new Set([...result.winnerTeamIds, ...result.loserTeamIds])
  if (participantIdSet.size !== result.winnerTeamIds.length + result.loserTeamIds.length) {
    return { error: '当前赛果成员异常，无法自动纠错。' }
  }

  const participantIds = Array.from(participantIdSet)

  try {
    await prisma.$transaction(async (tx) => {
      const latest = await tx.matchResult.findUnique({
        where: { id: resultId },
      })

      if (!latest || latest.matchId !== matchId) {
        throw new Error('赛果不存在。')
      }
      if (!latest.confirmed) {
        throw new Error('仅支持纠错已确认赛果。')
      }

      const oldWinnerTeamIds = [...latest.winnerTeamIds]
      const oldLoserTeamIds = [...latest.loserTeamIds]
      const newWinnerTeamIds = [...oldLoserTeamIds]
      const newLoserTeamIds = [...oldWinnerTeamIds]

      const users = await tx.user.findMany({
        where: { id: { in: participantIds } },
        select: { id: true, eloRating: true, wins: true, losses: true },
      })

      if (users.length !== participantIds.length) {
        throw new Error('存在无效选手，无法自动纠错。')
      }

      const userMap = new Map(users.map((user) => [user.id, user]))
      const anchorTime = latest.resultVerifiedAt ?? latest.createdAt

      const linkedHistories = await tx.eloHistory.findMany({
        where: {
          userId: { in: participantIds },
          matchResultId: latest.id,
        },
        orderBy: { createdAt: 'desc' },
      })

      let selectedHistoryByUserId = new Map<string, (typeof linkedHistories)[number]>()

      if (linkedHistories.length > 0) {
        for (const history of linkedHistories) {
          if (!selectedHistoryByUserId.has(history.userId)) {
            selectedHistoryByUserId.set(history.userId, history)
          }
        }
      }

      if (selectedHistoryByUserId.size !== participantIds.length) {
        const fallbackHistories = await tx.eloHistory.findMany({
          where: {
            userId: { in: participantIds },
            matchId,
          },
          orderBy: { createdAt: 'desc' },
        })

        const grouped = new Map<string, typeof fallbackHistories>()
        for (const history of fallbackHistories) {
          const arr = grouped.get(history.userId) ?? []
          arr.push(history)
          grouped.set(history.userId, arr)
        }

        selectedHistoryByUserId = new Map()
        for (const userId of participantIds) {
          const candidates = grouped.get(userId) ?? []
          if (candidates.length === 0) {
            throw new Error('未找到可回溯的 ELO 历史记录，无法自动纠错。')
          }

          const nearest = [...candidates].sort((a, b) => {
            const da = Math.abs(a.createdAt.getTime() - anchorTime.getTime())
            const db = Math.abs(b.createdAt.getTime() - anchorTime.getTime())
            return da - db
          })[0]

          if (!nearest || Math.abs(nearest.createdAt.getTime() - anchorTime.getTime()) > 60 * 60 * 1000) {
            throw new Error('ELO 历史记录无法准确匹配到该赛果，已阻止自动纠错。')
          }

          selectedHistoryByUserId.set(userId, nearest)
        }
      }

      const oldWinnerAvgElo =
        oldWinnerTeamIds.reduce((sum, id) => {
          const history = selectedHistoryByUserId.get(id)
          if (!history) throw new Error('ELO 历史不完整，无法自动纠错。')
          return sum + history.eloBefore
        }, 0) / oldWinnerTeamIds.length
      const oldLoserAvgElo =
        oldLoserTeamIds.reduce((sum, id) => {
          const history = selectedHistoryByUserId.get(id)
          if (!history) throw new Error('ELO 历史不完整，无法自动纠错。')
          return sum + history.eloBefore
        }, 0) / oldLoserTeamIds.length

      const winnerExpected = expectedScoreByRating(oldWinnerAvgElo, oldLoserAvgElo)
      const loserExpected = expectedScoreByRating(oldLoserAvgElo, oldWinnerAvgElo)

      const nextDeltaByUserId = new Map<string, number>()

      for (const userId of participantIds) {
        const history = selectedHistoryByUserId.get(userId)
        if (!history) throw new Error('ELO 历史不完整，无法自动纠错。')

        const wasWinner = oldWinnerTeamIds.includes(userId)
        const expected = wasWinner ? winnerExpected : loserExpected
        const inferredK = inferKFromDelta({
          eloRating: history.eloBefore,
          expected,
          oldDelta: history.delta,
          wasWinner,
        })

        if (!inferredK) {
          throw new Error('无法推断原始 ELO K 值，已阻止自动纠错。')
        }

        const nextDelta = wasWinner
          ? Math.round(inferredK * (0 - expected))
          : Math.round(inferredK * (1 - expected))

        nextDeltaByUserId.set(userId, nextDelta)
      }

      for (const userId of participantIds) {
        const history = selectedHistoryByUserId.get(userId)
        const baseUser = userMap.get(userId)
        const nextDelta = nextDeltaByUserId.get(userId)

        if (!history || !baseUser || nextDelta === undefined) {
          throw new Error('数据不完整，无法自动纠错。')
        }

        const wasWinner = oldWinnerTeamIds.includes(userId)

        if (wasWinner && baseUser.wins <= 0) {
          throw new Error('当前胜负统计异常（胜场不足），已阻止自动纠错。')
        }
        if (!wasWinner && baseUser.losses <= 0) {
          throw new Error('当前胜负统计异常（负场不足），已阻止自动纠错。')
        }

        const eloDeltaAdjust = nextDelta - history.delta

        await tx.user.update({
          where: { id: userId },
          data: {
            eloRating: {
              increment: eloDeltaAdjust,
            },
            wins: {
              increment: wasWinner ? -1 : 1,
            },
            losses: {
              increment: wasWinner ? 1 : -1,
            },
          },
        })

        await tx.eloHistory.update({
          where: { id: history.id },
          data: {
            matchResultId: latest.id,
            eloBefore: history.eloBefore,
            eloAfter: history.eloBefore + nextDelta,
            delta: nextDelta,
          },
        })
      }

      for (const oldWinnerId of [...new Set(oldWinnerTeamIds)]) {
        await revokeMatchRewardPointsForEvent(tx, {
          userId: oldWinnerId,
          matchId,
          eventKey: `win:${latest.id}:${oldWinnerId}`,
          reason: '管理员纠错：交换胜负后回收胜场奖励',
        })
      }

      for (const newWinnerId of [...new Set(newWinnerTeamIds)]) {
        await grantMatchRewardPoints(tx, {
          userId: newWinnerId,
          matchId,
          eventKey: `win:${latest.id}:${newWinnerId}`,
          desiredAmount: 1,
          reason: '管理员纠错：交换胜负后补发胜场奖励',
        })
      }

      await tx.matchResult.update({
        where: { id: latest.id },
        data: {
          winnerId: newWinnerTeamIds[0] ?? null,
          loserId: newLoserTeamIds[0] ?? null,
          winnerTeamIds: newWinnerTeamIds,
          loserTeamIds: newLoserTeamIds,
          verifierId: currentUser.id,
          resultVerifiedAt: new Date(),
        },
      })
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '交换胜负纠错失败。'
    console.error('swapConfirmedMatchResultWinnerLoserAction failed', error)
    return { error: message }
  }

  revalidatePath('/rankings')
  revalidatePath('/profile')
  revalidatePath(`/matchs/${matchId}`)

  await writeAuditLog({
    actorId: currentUser.id,
    action: 'match.result.swap_winner_loser',
    entityType: 'MatchResult',
    entityId: resultId,
    details: { matchId, targetLabel: result.match.title },
    ip: auditContext.ip,
    userAgent: auditContext.userAgent,
  })

  return { success: '纠错成功：已交换该赛果胜负并同步修正统计与积分。' }
}

export async function swapConfirmedMatchResultWinnerLoserVoidAction(
  matchId: string,
  resultId: string,
  formData: FormData,
): Promise<void> {
  await swapConfirmedMatchResultWinnerLoserAction(matchId, resultId, formData)
}

export async function removeRegistrationByManagerAction(matchId: string, userId: string, formData: FormData): Promise<MatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录。' }

  const auditContext = await getAuditContext()

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      groupingResult: true,
      registrations: {
        where: { userId },
        select: { id: true },
      },
      results: {
        where: {
          OR: [
            { winnerTeamIds: { has: userId } },
            { loserTeamIds: { has: userId } },
          ],
        },
        select: { id: true, confirmed: true },
      },
    },
  })

  if (!match) return { error: '比赛不存在。' }

  const isManager = currentUser.id === match.createdBy || currentUser.role === 'admin'
  if (!isManager) return { error: '仅发起人或管理员可移除参赛者。' }

  if (match.registrations.length === 0) {
    return { error: '该用户不在参赛名单中。' }
  }

  const pendingResultIds = match.results
    .filter((result) => !result.confirmed)
    .map((result) => result.id)

  const updateMatchFinishedStatus = async () => {
    const latestMatch = await prisma.match.findUnique({
      where: { id: matchId },
      select: {
        id: true,
        status: true,
        format: true,
        groupingGeneratedAt: true,
        groupingResult: { select: { payload: true } },
        results: {
          select: {
            winnerTeamIds: true,
            loserTeamIds: true,
            confirmed: true,
            score: true,
            createdAt: true,
            resultVerifiedAt: true,
          },
        },
      },
    })

    if (!latestMatch || latestMatch.status === MatchStatus.finished) return

    const shouldFinish = isMatchAllResultsFinished({
      format: latestMatch.format,
      groupingGeneratedAt: latestMatch.groupingGeneratedAt,
      groupingResult: latestMatch.groupingResult,
      results: latestMatch.results,
    })

    if (shouldFinish) {
      await prisma.match.update({
        where: { id: latestMatch.id },
        data: { status: MatchStatus.finished },
      })
    }
  }

  if (match.type === 'double') {
    const removeResult = await removeRegisteredDoublesTeamByMember(matchId, userId)
    if (!removeResult.ok) {
      return { error: removeResult.error }
    }

    await prisma.$transaction(async (tx) => {
      for (const memberId of removeResult.memberIds) {
        await refundRegistrationRewardPoints(tx, {
          userId: memberId,
          matchId,
        })
      }
    })

    await updateMatchFinishedStatus()

    revalidatePath('/matchs')
    revalidatePath('/team-invites')
    revalidatePath(`/matchs/${matchId}`)
    return { success: '已移除该双打小队，并回收报名奖励积分。' }
  }

  await prisma.$transaction(async (tx) => {
    if (match.groupingResult) {
      const payload = match.groupingResult.payload as {
        groups?: Array<{
          name: string
          averagePoints: number
          players: Array<{ id: string; points: number; eloRating: number }>
        }>
      }

      if (payload?.groups) {
        let changed = false
        const nextGroups = payload.groups.map((group) => {
          const remaining = group.players.filter((player) => player.id !== userId)
          if (remaining.length !== group.players.length) {
            changed = true
          }
          const averagePoints =
            remaining.length > 0
              ? Math.round(
                  remaining.reduce((sum, player) => sum + player.eloRating, 0) /
                    remaining.length,
                )
              : 0
          return { ...group, players: remaining, averagePoints }
        })

        if (changed) {
          await tx.matchGrouping.update({
            where: { matchId },
            data: {
              payload: {
                ...(payload as object),
                groups: nextGroups,
              },
            },
          })
        }
      }
    }

    if (pendingResultIds.length > 0) {
      await tx.matchResult.deleteMany({
        where: { id: { in: pendingResultIds } },
      })
    }

    await tx.registration.deleteMany({ where: { matchId, userId } })
    await refundRegistrationRewardPoints(tx, {
      userId,
      matchId,
    })
  })

  await updateMatchFinishedStatus()

  await writeAuditLog({
    actorId: currentUser.id,
    action: 'match.registration.remove',
    entityType: 'Registration',
    entityId: `${matchId}:${userId}`,
    details: { matchId, userId, targetLabel: match.title },
    ip: auditContext.ip,
    userAgent: auditContext.userAgent,
  })

  revalidatePath('/matchs')
  revalidatePath(`/matchs/${matchId}`)
  return { success: '已移除该参赛者，并回收报名奖励积分。' }
}

export async function removeRegistrationByManagerVoidAction(matchId: string, userId: string, formData: FormData): Promise<void> {
  await removeRegistrationByManagerAction(matchId, userId, formData)
}

export async function rejectMatchResultAction(matchId: string, resultId: string, formData: FormData): Promise<MatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录。' }

  const auditContext = await getAuditContext()

  const result = await prisma.matchResult.findUnique({
    where: { id: resultId },
    include: { match: true },
  })

  if (!result || result.matchId !== matchId) return { error: '赛果不存在。' }
  if (result.confirmed) return { error: '已确认赛果不可否决。' }

  const isManager = result.match.createdBy === currentUser.id || currentUser.role === 'admin'
  if (!isManager) return { error: '仅发起人或管理员可否决。' }

  await prisma.matchResult.delete({ where: { id: resultId } })

  await writeAuditLog({
    actorId: currentUser.id,
    action: 'match.result.reject',
    entityType: 'MatchResult',
    entityId: resultId,
    details: { matchId, targetLabel: result.match.title },
    ip: auditContext.ip,
    userAgent: auditContext.userAgent,
  })

  revalidatePath(`/matchs/${matchId}`)
  return { success: '已否决并移除该待确认赛果。' }
}

export async function rejectMatchResultVoidAction(matchId: string, resultId: string, formData: FormData): Promise<void> {
  await rejectMatchResultAction(matchId, resultId, formData)
}


function parseTeamIds(raw: FormDataEntryValue | null) {
  const text = String(raw ?? '').trim()
  return Array.from(new Set(text.split(/[\s,，]+/).map((id) => id.trim()).filter(Boolean)))
}

export async function reportMatchResultAction(matchId: string, _: MatchFormState, formData: FormData): Promise<MatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录。' }

  const auditContext = await getAuditContext()

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: {
      registrations: {
        select: { userId: true },
      },
      groupingResult: true,
      results: {
        select: {
          winnerTeamIds: true,
          loserTeamIds: true,
          confirmed: true,
          score: true,
          createdAt: true,
          resultVerifiedAt: true,
        },
      },
    },
  })

  if (!match) return { error: '比赛不存在。' }

  const isManager = currentUser.id === match.createdBy || currentUser.role === 'admin'
  if (!isManager) return { error: '仅发起人或管理员可录入赛果。' }

  const phase = String(formData.get('phase') ?? 'group')
  const groupName = String(formData.get('groupName') ?? '').trim()
  const knockoutRound = String(formData.get('knockoutRound') ?? '').trim()
  const winnerTeamIds = parseTeamIds(formData.get('winnerTeamIds'))
  const loserTeamIds = parseTeamIds(formData.get('loserTeamIds'))
  const bestOf = parseBestOf(formData.get('bestOf'))
  const loserScore = Number(formData.get('loserScore') ?? -1)

  if (winnerTeamIds.length === 0 || loserTeamIds.length === 0) {
    return { error: '请填写胜方与负方成员。' }
  }

  if (!bestOf) return { error: '请选择合法的局制（3/5/7局）。' }

  const winsNeeded = Math.floor(bestOf / 2) + 1
  if (!Number.isInteger(loserScore) || loserScore < 0 || loserScore >= winsNeeded) {
    return { error: '负方局分不合法。' }
  }

  const idSet = new Set([...winnerTeamIds, ...loserTeamIds])
  if (idSet.size !== winnerTeamIds.length + loserTeamIds.length) {
    return { error: '同一名选手不能同时出现在胜负双方。' }
  }

  if (match.type === 'single' && (winnerTeamIds.length !== 1 || loserTeamIds.length !== 1)) {
    return { error: '单打赛果必须是一对一。' }
  }

  if (match.type === 'double' && (winnerTeamIds.length !== 2 || loserTeamIds.length !== 2)) {
    return { error: '双打赛果必须是 2v2。' }
  }

  const registrationSet = new Set(match.registrations.map((r) => r.userId))
  const allParticipantIds = [...winnerTeamIds, ...loserTeamIds]
  if (allParticipantIds.some((id) => !registrationSet.has(id))) {
    return { error: '赛果中存在未报名选手。' }
  }

  const users = await prisma.user.findMany({
    where: { id: { in: allParticipantIds } },
    select: { id: true },
  })

  if (users.length !== allParticipantIds.length) {
    return { error: '存在无效选手 ID，请检查后重试。' }
  }

  if (!match.groupingResult) {
    return { error: '尚未生成分组，无法按阶段录入赛果。' }
  }

  const payload = match.groupingResult.payload as {
    config?: { qualifiersPerGroup?: number }
    groups?: Array<{ name: string; players: Array<{ id: string; nickname?: string; eloRating?: number }> }>
    knockout?: { rounds: Array<{ name: string; matches: Array<{ id: string; homeLabel: string; awayLabel: string }> }> }
  }

  if (phase === 'group') {
    if (!groupName) return { error: '请选择小组。' }
    const selectedGroup = payload.groups?.find((group) => group.name === groupName)
    if (!selectedGroup) return { error: '所选小组不存在。' }

    const selectedIds = new Set(selectedGroup.players.map((player) => player.id))
    if (![...winnerTeamIds, ...loserTeamIds].every((id) => selectedIds.has(id))) {
      return { error: '小组赛录入时，双方选手必须都属于所选小组。' }
    }

    const [winnerId] = winnerTeamIds
    const [loserId] = loserTeamIds
    const pairExists = match.results.some((result) =>
      result.winnerTeamIds.length === 1 &&
      result.loserTeamIds.length === 1 &&
      ((result.winnerTeamIds[0] === winnerId && result.loserTeamIds[0] === loserId) ||
        (result.winnerTeamIds[0] === loserId && result.loserTeamIds[0] === winnerId)),
    )
    if (pairExists) {
      return { error: '该小组对局已有赛果（待确认或已确认），不可重复录入。' }
    }
  } else if (phase === 'knockout') {
    if (!knockoutRound) return { error: '请选择淘汰赛轮次。' }
    const roundExists = payload.knockout?.rounds.some((round) => round.name === knockoutRound)
    if (!roundExists) return { error: '所选淘汰赛轮次不存在。' }

    if (!payload.groups || !payload.knockout) return { error: '当前未配置淘汰赛结构。' }

    const resolvedRounds = resolveFilledKnockoutRoundsForValidation({
      groupingGeneratedAt: match.groupingGeneratedAt ?? null,
      qualifiersPerGroup: payload.config?.qualifiersPerGroup ?? 1,
      groups: payload.groups.map((group) => ({
        name: group.name,
        players: group.players.map((player) => ({
          id: player.id,
          nickname: player.nickname ?? player.id,
          eloRating: player.eloRating ?? 0,
        })),
      })),
      knockoutRounds: payload.knockout.rounds,
      results: match.results,
    })

    const targetRound = resolvedRounds.find((round) => round.name === knockoutRound)
    if (!targetRound) return { error: '所选淘汰赛轮次不存在。' }

    const [winnerId] = winnerTeamIds
    const [loserId] = loserTeamIds

    const hasEligibleMatchInRound = targetRound.matches.some((item) =>
      item.homePlayerId &&
      item.awayPlayerId &&
      !item.decided &&
      ((item.homePlayerId === winnerId && item.awayPlayerId === loserId) ||
        (item.homePlayerId === loserId && item.awayPlayerId === winnerId)),
    )

    if (!hasEligibleMatchInRound) {
      return { error: '当前轮次仅允许录入已出现对手且尚未完成的对局。' }
    }

    const pairExists = match.results.some((result) =>
      result.winnerTeamIds.length === 1 &&
      result.loserTeamIds.length === 1 &&
      (!match.groupingGeneratedAt || result.createdAt >= match.groupingGeneratedAt) &&
      ((result.winnerTeamIds[0] === winnerId && result.loserTeamIds[0] === loserId) ||
        (result.winnerTeamIds[0] === loserId && result.loserTeamIds[0] === winnerId)),
    )

    if (pairExists) {
      return { error: '该淘汰赛对局已有赛果（待确认或已确认），不可重复录入。' }
    }
  } else {
    return { error: '无效阶段类型。' }
  }

  const scoreText = `${winsNeeded}:${loserScore}（${bestOf}局${winsNeeded}胜）`
  const score = {
    text: scoreText,
    bestOf,
    winnerScore: winsNeeded,
    loserScore,
    phase,
    groupName: phase === 'group' ? groupName : undefined,
    knockoutRound: phase === 'knockout' ? knockoutRound : undefined,
    adminSubmitted: true,
  }
  const winnerAnchorId = winnerTeamIds[0] ?? null
  const loserAnchorId = loserTeamIds[0] ?? null

  const exists = await prisma.matchResult.findFirst({
    where: {
      matchId,
      confirmed: false,
      OR: [
        { winnerTeamIds: { equals: winnerTeamIds }, loserTeamIds: { equals: loserTeamIds } },
        { winnerTeamIds: { equals: loserTeamIds }, loserTeamIds: { equals: winnerTeamIds } },
      ],
    },
  })

  if (exists) return { error: '该对局已有待确认赛果。' }

  await prisma.matchResult.create({
    data: {
      matchId,
      winnerId: winnerAnchorId,
      loserId: loserAnchorId,
      winnerTeamIds,
      loserTeamIds,
      score,
      reportedBy: currentUser.id,
      confirmed: false,
    },
  })

  await writeAuditLog({
    actorId: currentUser.id,
    action: 'match.result.admin.report',
    entityType: 'MatchResult',
    entityId: matchId,
    details: {
      targetLabel: match.title,
      matchId,
      phase,
      groupName: phase === 'group' ? groupName : undefined,
      knockoutRound: phase === 'knockout' ? knockoutRound : undefined,
      winnerTeamIds,
      loserTeamIds,
    },
    ip: auditContext.ip,
    userAgent: auditContext.userAgent,
  })

  revalidatePath(`/matchs/${matchId}`)
  revalidatePath('/rankings')
  revalidatePath('/profile')

  return { success: '管理员录入成功，已进入待确认列表。' }
}
