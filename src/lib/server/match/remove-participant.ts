import {
  MatchStatus,
  MatchType,
  Prisma,
  TeamRegistrationStatus,
} from '@prisma/client'
import { isMatchAllResultsFinished } from '@/lib/match-status'
import { refundRegistrationRewardPoints } from '@/lib/server/match/rewards'
import { removeCompetitorsFromGroupingPayload } from '@/lib/server/match/grouping-payload'

type AuditContext = {
  ip?: string | null
  userAgent?: string | null
}

export type RemoveUserFromMatchResult = {
  matchId: string
  matchTitle: string
  removed: boolean
  removedUserIds: string[]
  dissolvedTeamId: string | null
}

async function updateFinishedStatus(tx: Prisma.TransactionClient, matchId: string) {
  const match = await tx.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      type: true,
      status: true,
      format: true,
      groupingGeneratedAt: true,
      groupingResult: { select: { payload: true } },
      results: {
        select: {
          winnerTeamIds: true,
          loserTeamIds: true,
          winnerMatchTeamId: true,
          loserMatchTeamId: true,
          confirmed: true,
          score: true,
          createdAt: true,
          resultVerifiedAt: true,
        },
      },
    },
  })

  if (!match || match.status === MatchStatus.finished) return
  if (
    isMatchAllResultsFinished({
      format: match.format,
      groupingGeneratedAt: match.groupingGeneratedAt,
      groupingResult: match.groupingResult,
      results: match.results,
    })
  ) {
    await tx.match.update({
      where: { id: match.id },
      data: { status: MatchStatus.finished },
    })
  }
}

export async function removeUserFromMatch(
  tx: Prisma.TransactionClient,
  params: {
    matchId: string
    userId: string
    actorId: string
    reason: 'manager' | 'user_banned'
    auditContext?: AuditContext
  },
): Promise<RemoveUserFromMatchResult> {
  const { matchId, userId, actorId, reason, auditContext } = params
  const match = await tx.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      title: true,
      type: true,
      status: true,
      teamMinMembers: true,
      groupingResult: { select: { payload: true } },
      registrations: { where: { userId }, select: { id: true } },
    },
  })

  if (!match) throw new Error('比赛不存在。')
  if (match.status === MatchStatus.finished) {
    throw new Error('已结束比赛的历史参赛数据不可移除。')
  }

  const removedUserIds = new Set<string>()
  const removedGroupingCompetitorIds = new Set<string>()
  let dissolvedTeamId: string | null = null
  let removed = match.registrations.length > 0

  if (match.type === MatchType.double) {
    const doublesTeam = await tx.matchDoublesTeam.findFirst({
      where: { matchId, members: { some: { userId } } },
      select: {
        id: true,
        registeredAt: true,
        members: { select: { userId: true } },
      },
    })

    if (doublesTeam) {
      dissolvedTeamId = doublesTeam.id
      removed = true
      doublesTeam.members.forEach((member) => removedUserIds.add(member.userId))
      await tx.matchDoublesInvite.updateMany({
        where: {
          matchId,
          status: 'pending',
          OR: [
            { inviterId: { in: [...removedUserIds] } },
            { inviteeId: { in: [...removedUserIds] } },
          ],
        },
        data: { status: 'voided', updatedAt: new Date() },
      })
      await tx.matchDoublesTeam.delete({ where: { id: doublesTeam.id } })
    }
  }

  if (match.type === MatchType.team) {
    const team = await tx.matchTeam.findFirst({
      where: {
        matchId,
        OR: [{ captainId: userId }, { members: { some: { userId } } }],
      },
      select: {
        id: true,
        captainId: true,
        members: { select: { id: true, userId: true } },
      },
    })

    if (team) {
      removed = true
      removedUserIds.add(userId)
      if (team.captainId === userId) {
        dissolvedTeamId = team.id
        removedGroupingCompetitorIds.add(team.id)
        await tx.matchTeam.delete({ where: { id: team.id } })
      } else {
        const membership = team.members.find((member) => member.userId === userId)
        if (membership) {
          await tx.matchTeamMember.delete({ where: { id: membership.id } })
        }
        const memberCount = team.members.length - (membership ? 1 : 0)
        const minMembers = match.teamMinMembers ?? 3
        const status =
          memberCount >= minMembers
            ? TeamRegistrationStatus.approved
            : TeamRegistrationStatus.draft
        if (status !== TeamRegistrationStatus.approved) {
          removedGroupingCompetitorIds.add(team.id)
        }
        await tx.matchTeam.update({
          where: { id: team.id },
          data: {
            status,
            submittedAt:
              status === TeamRegistrationStatus.approved ? undefined : null,
            reviewNote: null,
          },
        })
      }
    }
  }

  if (removedUserIds.size === 0) removedUserIds.add(userId)
  const registrationUserIds = [...removedUserIds]
  const registrations = await tx.registration.findMany({
    where: { matchId, userId: { in: registrationUserIds } },
    select: { userId: true },
  })
  const registeredUserIds = new Set(registrations.map((registration) => registration.userId))

  await tx.matchResult.deleteMany({
    where: {
      matchId,
      confirmed: false,
      OR: [
        { winnerTeamIds: { hasSome: registrationUserIds } },
        { loserTeamIds: { hasSome: registrationUserIds } },
      ],
    },
  })
  await tx.registration.deleteMany({
    where: { matchId, userId: { in: registrationUserIds } },
  })

  for (const registeredUserId of registeredUserIds) {
    await refundRegistrationRewardPoints(tx, {
      userId: registeredUserId,
      matchId,
    })
  }

  if (match.groupingResult) {
    const groupingCompetitorIds =
      match.type === MatchType.team
        ? removedGroupingCompetitorIds
        : new Set(registrationUserIds)
    const nextPayload = removeCompetitorsFromGroupingPayload(
      match.groupingResult.payload,
      groupingCompetitorIds,
    )
    if (nextPayload) {
      await tx.matchGrouping.update({
        where: { matchId },
        data: { payload: nextPayload },
      })
    }
  }

  if (removed || registeredUserIds.size > 0) {
    await tx.auditLog.create({
      data: {
        actorId,
        action: 'match.registration.remove',
        entityType: 'Registration',
        entityId: `${matchId}:${userId}`,
        ip: auditContext?.ip ?? null,
        userAgent: auditContext?.userAgent ?? null,
        details: {
          matchId,
          userId,
          reason,
          targetLabel: match.title,
          removedUserIds: registrationUserIds,
          dissolvedTeamId,
        },
      },
    })
  }

  await updateFinishedStatus(tx, matchId)

  return {
    matchId,
    matchTitle: match.title,
    removed: removed || registeredUserIds.size > 0,
    removedUserIds: registrationUserIds,
    dissolvedTeamId,
  }
}
