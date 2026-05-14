'use server'

import { revalidatePath } from 'next/cache'
import { type Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getCurrentUser } from '@/lib/auth'
import { validateCsrfToken } from '@/lib/csrf'
import { settleSinglesElo, settleTeamElo } from '@/lib/elo'

export type QuickMatchFormState = {
  error?: string
  success?: string
}

const QUICK_MATCH_TITLE_PREFIX = '[快速比赛]'
const QUICK_MATCH_TIMEOUT_MS = 24 * 60 * 60 * 1000
const QUICK_MATCH_ACTIVE_DESC = '由快速比赛功能创建'
const QUICK_MATCH_VOID_DESC = '由快速比赛功能创建（已作废）'

function isQuickMatchMatch(match: { title: string; isQuickMatch?: boolean | null }) {
  return match.isQuickMatch ?? match.title.startsWith(QUICK_MATCH_TITLE_PREFIX)
}

function isExpired(createdAt: Date) {
  return Date.now() - createdAt.getTime() > QUICK_MATCH_TIMEOUT_MS
}

function normalizeScore(score: unknown) {
  if (typeof score === 'string') {
    return { text: score }
  }

  if (score && typeof score === 'object') {
    return score as Record<string, unknown>
  }

  return {}
}

async function applyQuickMatchElo(
  tx: Prisma.TransactionClient,
  payload: { matchId: string; winnerTeamIds: string[]; loserTeamIds: string[] },
) {
  const allParticipantIds = [...payload.winnerTeamIds, ...payload.loserTeamIds]
  const users = await tx.user.findMany({
    where: { id: { in: allParticipantIds } },
    select: { id: true, eloRating: true, matchesPlayed: true, wins: true, losses: true },
  })

  if (users.length !== allParticipantIds.length) {
    throw new Error('存在无效选手，无法结算 ELO。')
  }

  const userMap = new Map(users.map((u) => [u.id, u]))
  const winnerTeam = payload.winnerTeamIds.map((id) => ({
    userId: id,
    eloRating: userMap.get(id)!.eloRating,
    matchesPlayed: userMap.get(id)!.matchesPlayed,
  }))
  const loserTeam = payload.loserTeamIds.map((id) => ({
    userId: id,
    eloRating: userMap.get(id)!.eloRating,
    matchesPlayed: userMap.get(id)!.matchesPlayed,
  }))

  const deltas =
    winnerTeam.length === 1 && loserTeam.length === 1
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
        eloBefore: delta.before,
        eloAfter: delta.after,
        delta: delta.delta,
      },
    })
  }
}

async function invalidateQuickResult(params: {
  resultId: string
  matchId: string
  existingScore: unknown
  reason: 'rejected' | 'timeout'
}) {
  const baseScore = normalizeScore(params.existingScore)

  await prisma.$transaction([
    prisma.matchResult.update({
      where: { id: params.resultId },
      data: {
        score: {
          ...baseScore,
          invalidatedAt: new Date().toISOString(),
          invalidReason: params.reason,
        },
      },
    }),
    prisma.match.update({
      where: { id: params.matchId },
      data: {
        description: QUICK_MATCH_VOID_DESC,
      },
    }),
  ])
}

export async function reportQuickMatchResultAction(
  _: QuickMatchFormState,
  formData: FormData,
): Promise<QuickMatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录。' }

  const opponentId = String(formData.get('opponentId') ?? '').trim()
  const winnerId = String(formData.get('winnerId') ?? '').trim()
  const bestOfRaw = Number(formData.get('bestOf') ?? 0)
  const myScoreRaw = Number(formData.get('myScore') ?? -1)
  const opponentScoreRaw = Number(formData.get('opponentScore') ?? -1)

  if (!opponentId || opponentId === currentUser.id) {
    return { error: '请选择有效对手。' }
  }

  const allowedBestOf = [3, 5, 7]
  if (!allowedBestOf.includes(bestOfRaw)) {
    return { error: '赛制不合法。' }
  }

  const winsNeeded = Math.floor(bestOfRaw / 2) + 1
  const myScore = Number.isFinite(myScoreRaw) ? myScoreRaw : -1
  const opponentScore = Number.isFinite(opponentScoreRaw) ? opponentScoreRaw : -1

  const scoresInRange =
    myScore >= 0 &&
    opponentScore >= 0 &&
    myScore <= winsNeeded &&
    opponentScore <= winsNeeded

  if (!scoresInRange) {
    return { error: '比分不合法，请检查得分范围。' }
  }

  if (myScore === opponentScore) {
    return { error: '比分不能为平局。' }
  }

  const winnerShouldBeCurrent = myScore === winsNeeded && opponentScore < winsNeeded
  const winnerShouldBeOpponent = opponentScore === winsNeeded && myScore < winsNeeded

  if (!winnerShouldBeCurrent && !winnerShouldBeOpponent) {
    return { error: '比分不符合赛制要求，请检查胜场数。' }
  }

  const opponent = await prisma.user.findUnique({
    where: { id: opponentId },
    select: { id: true, nickname: true, isBanned: true },
  })

  if (!opponent || opponent.isBanned) {
    return { error: '对手不存在或不可用。' }
  }

  if (winnerId !== currentUser.id && winnerId !== opponentId) {
    return { error: '获胜者必须是你或所选对手。' }
  }

  if (winnerId === currentUser.id && !winnerShouldBeCurrent) {
    return { error: '获胜者与比分不一致。' }
  }

  if (winnerId === opponentId && !winnerShouldBeOpponent) {
    return { error: '获胜者与比分不一致。' }
  }

  const loserId = winnerId === currentUser.id ? opponentId : currentUser.id

  await prisma.$transaction(async (tx) => {
    const now = new Date()
    const createdMatch = await tx.match.create({
      data: {
        title: `${QUICK_MATCH_TITLE_PREFIX} ${currentUser.nickname} vs ${opponent.nickname}`,
        description: QUICK_MATCH_ACTIVE_DESC,
        type: 'single',
        format: 'group_only',
        status: 'finished',
        dateTime: now,
        registrationDeadline: now,
        maxParticipants: 2,
        location: '快速比赛',
        isQuickMatch: true,
        createdBy: currentUser.id,
      },
      select: { id: true },
    })

    await tx.registration.createMany({
      data: [
        {
          matchId: createdMatch.id,
          userId: currentUser.id,
          role: 'player',
          status: 'registered',
        },
        {
          matchId: createdMatch.id,
          userId: opponentId,
          role: 'player',
          status: 'registered',
        },
      ],
      skipDuplicates: true,
    })

    await tx.matchResult.create({
      data: {
        matchId: createdMatch.id,
        winnerId,
        loserId,
        winnerTeamIds: [winnerId],
        loserTeamIds: [loserId],
        score: {
          text: `${myScore}:${opponentScore}`,
          bestOf: bestOfRaw,
          myScore,
          opponentScore,
        },
        reportedBy: currentUser.id,
        confirmed: false,
      },
    })
  })

  revalidatePath('/quick-match')
  return { success: '已登记快速比赛结果，等待对手确认（24 小时内）。' }
}

export async function confirmQuickMatchResultAction(
  resultId: string,
  formData: FormData,
): Promise<QuickMatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录。' }

  const result = await prisma.matchResult.findUnique({
    where: { id: resultId },
    include: { match: true },
  })

  if (!result) return { error: '赛果不存在。' }
  if (!isQuickMatchMatch(result.match)) return { error: '不是快速比赛赛果。' }

  if (result.confirmed) {
    return { success: '该赛果已确认。' }
  }

  if (isExpired(result.createdAt)) {
    await invalidateQuickResult({
      resultId: result.id,
      matchId: result.matchId,
      existingScore: result.score,
      reason: 'timeout',
    })
    revalidatePath('/quick-match')
    return { error: '该赛果已超过 24 小时未确认，已作废。' }
  }

  const isOpponent =
    (result.winnerTeamIds.includes(currentUser.id) || result.loserTeamIds.includes(currentUser.id)) &&
    currentUser.id !== result.reportedBy
  const isAdmin = currentUser.role === 'admin'

  if (!isOpponent && !isAdmin) {
    return { error: '仅对手或管理员可确认。' }
  }

  try {
    await prisma.$transaction(async (tx) => {
      const latest = await tx.matchResult.findUnique({
        where: { id: result.id },
        include: { match: true },
      })
      if (!latest) throw new Error('赛果不存在。')
      if (!isQuickMatchMatch(latest.match)) throw new Error('不是快速比赛赛果。')
      if (latest.confirmed) return

      if (isExpired(latest.createdAt)) {
        await invalidateQuickResult({
          resultId: latest.id,
          matchId: latest.matchId,
          existingScore: latest.score,
          reason: 'timeout',
        })
        throw new Error('该赛果已超过 24 小时未确认，已作废。')
      }

      await applyQuickMatchElo(tx, {
        matchId: latest.matchId,
        winnerTeamIds: latest.winnerTeamIds,
        loserTeamIds: latest.loserTeamIds,
      })

      await tx.matchResult.update({
        where: { id: latest.id },
        data: {
          confirmed: true,
          resultVerifiedAt: new Date(),
          verifierId: currentUser.id,
        },
      })
    })
  } catch (error) {
    console.error('confirmQuickMatchResultAction failed', error)
    return { error: '确认失败。' }
  }

  revalidatePath('/quick-match')
  revalidatePath('/rankings')
  revalidatePath('/profile')
  return { success: '已确认该快速比赛结果。' }
}

export async function rejectQuickMatchResultAction(
  resultId: string,
  formData: FormData,
): Promise<QuickMatchFormState> {
  const csrfError = await validateCsrfToken(formData)
  if (csrfError) return { error: csrfError }

  const currentUser = await getCurrentUser()
  if (!currentUser) return { error: '请先登录。' }

  const result = await prisma.matchResult.findUnique({
    where: { id: resultId },
    include: { match: true },
  })

  if (!result) return { error: '赛果不存在。' }
  if (!isQuickMatchMatch(result.match)) return { error: '不是快速比赛赛果。' }
  if (result.confirmed) return { error: '已确认赛果不可拒绝。' }

  const isOpponent =
    (result.winnerTeamIds.includes(currentUser.id) || result.loserTeamIds.includes(currentUser.id)) &&
    currentUser.id !== result.reportedBy
  const isAdmin = currentUser.role === 'admin'

  if (!isOpponent && !isAdmin) {
    return { error: '仅对手或管理员可拒绝。' }
  }

  await invalidateQuickResult({
    resultId: result.id,
    matchId: result.matchId,
    existingScore: result.score,
    reason: 'rejected',
  })

  revalidatePath('/quick-match')
  return { success: '已拒绝该赛果，结果已作废。' }
}

export async function cleanupExpiredQuickResultsForUser(userId: string) {
  const expired = await prisma.matchResult.findMany({
    where: {
      confirmed: false,
      createdAt: {
        lt: new Date(Date.now() - QUICK_MATCH_TIMEOUT_MS),
      },
      OR: [{ winnerTeamIds: { has: userId } }, { loserTeamIds: { has: userId } }],
      match: {
        isQuickMatch: true,
      },
    },
    select: {
      id: true,
      matchId: true,
      score: true,
    },
  })

  for (const item of expired) {
    await invalidateQuickResult({
      resultId: item.id,
      matchId: item.matchId,
      existingScore: item.score,
      reason: 'timeout',
    })
  }
}
