import type { Prisma } from '@prisma/client'

import { lockUsersForUpdate } from './lock-users'

const BUSINESS_HISTORY_COUNT_KEYS = [
  'createdMatches',
  'registrations',
  'wonResults',
  'lostResults',
  'reportedResults',
  'verifiedResults',
  'eloHistory',
  'pointsLedger',
  'redemptions',
  'awardedBadges',
  'reviewsGiven',
  'reviewsReceived',
  'auditLogs',
  'certificates',
  'doublesTeamsCreated',
  'doublesTeamMembers',
  'doublesInvitesSent',
  'doublesInvitesReceived',
  'createdMatchPosts',
  'matchedMatchPosts',
  'matchApplications',
  'captainedMatchTeams',
  'reviewedMatchTeams',
  'matchTeamMembers',
  'notificationOutbox',
  'matchEntryMembers',
  'sourcedMatchEntries',
  'resultRevisionsReported',
  'resultRevisionsVerified',
  'settlementEffects',
] as const

type BusinessHistoryCountKey = (typeof BUSINESS_HISTORY_COUNT_KEYS)[number]

type HardDeleteMode = 'single' | 'bulk'

export type HardDeleteUsersInput = {
  actorId: string
  userIds: readonly string[]
  mode: HardDeleteMode
  auditContext?: {
    ip?: string | null
    userAgent?: string | null
  }
}

export type HardDeleteUsersResult = {
  deletedCount: number
  deletedUserIds: string[]
}

export class HardDeleteUsersBlockedError extends Error {
  readonly blockedCount: number
  readonly requestedCount: number

  constructor(params: {
    mode: HardDeleteMode
    blockedCount: number
    requestedCount: number
    reason?: 'actor-not-admin'
  }) {
    const message =
      params.reason === 'actor-not-admin'
        ? '管理员权限已发生变化，本次未删除任何账号。'
        : params.mode === 'single'
          ? '该账号存在业务历史、账号不存在或属于受保护账号，不能硬删除；本次未删除任何账号。'
          : `所选 ${params.requestedCount} 个账号中有 ${params.blockedCount} 个不允许硬删除；本次未删除任何账号。仅可删除无业务历史的普通账号。`

    super(message)
    this.name = 'HardDeleteUsersBlockedError'
    this.blockedCount = params.blockedCount
    this.requestedCount = params.requestedCount
  }
}

export function getHardDeleteUsersBlockedMessage(error: unknown) {
  return error instanceof HardDeleteUsersBlockedError ? error.message : null
}

function hasNonDefaultAggregate(user: {
  points: number
  eloRating: number
  wins: number
  losses: number
  matchesPlayed: number
}) {
  return (
    user.points !== 0 ||
    user.eloRating !== 1200 ||
    user.wins !== 0 ||
    user.losses !== 0 ||
    user.matchesPlayed !== 0
  )
}

/**
 * Permanently deletes only unused ordinary accounts.
 *
 * The caller must use an interactive transaction. Target and actor User rows are
 * locked before any eligibility read. Authentication-only dependants
 * (verification tokens and trusted devices) may cascade; every business/history
 * relation is fail-closed here, including the certificate identity and relations
 * whose FK would otherwise cascade or SetNull.
 */
export async function hardDeleteUsersWithoutBusinessHistory(
  tx: Prisma.TransactionClient,
  input: HardDeleteUsersInput,
): Promise<HardDeleteUsersResult> {
  const targetIds = [...new Set(input.userIds.map((id) => id.trim()).filter(Boolean))].sort()
  if (targetIds.length === 0) {
    throw new Error('At least one user id is required for hard deletion.')
  }
  if (input.mode === 'single' && targetIds.length !== 1) {
    throw new Error('Single-user hard deletion requires exactly one user id.')
  }

  await lockUsersForUpdate(tx, [...targetIds, input.actorId])

  const actor = await tx.user.findUnique({
    where: { id: input.actorId },
    select: { role: true, isBanned: true, emailVerifiedAt: true },
  })
  if (
    actor?.role !== 'admin' ||
    actor.isBanned ||
    !actor.emailVerifiedAt
  ) {
    throw new HardDeleteUsersBlockedError({
      mode: input.mode,
      blockedCount: targetIds.length,
      requestedCount: targetIds.length,
      reason: 'actor-not-admin',
    })
  }

  const targets = await tx.user.findMany({
    where: { id: { in: targetIds } },
    select: {
      id: true,
      email: true,
      nickname: true,
      role: true,
      points: true,
      eloRating: true,
      wins: true,
      losses: true,
      matchesPlayed: true,
      identity: { select: { id: true } },
      _count: {
        select: {
          createdMatches: true,
          registrations: true,
          wonResults: true,
          lostResults: true,
          reportedResults: true,
          verifiedResults: true,
          eloHistory: true,
          pointsLedger: true,
          redemptions: true,
          awardedBadges: true,
          reviewsGiven: true,
          reviewsReceived: true,
          auditLogs: true,
          certificates: true,
          doublesTeamsCreated: true,
          doublesTeamMembers: true,
          doublesInvitesSent: true,
          doublesInvitesReceived: true,
          createdMatchPosts: true,
          matchedMatchPosts: true,
          matchApplications: true,
          captainedMatchTeams: true,
          reviewedMatchTeams: true,
          matchTeamMembers: true,
          notificationOutbox: true,
          matchEntryMembers: true,
          sourcedMatchEntries: true,
          resultRevisionsReported: true,
          resultRevisionsVerified: true,
          settlementEffects: true,
        },
      },
    },
  })

  const [legacyParticipantResults, leaderboardRows, targetAuditLogs] = await Promise.all([
    tx.matchResult.findMany({
      where: {
        OR: [
          { winnerTeamIds: { hasSome: targetIds } },
          { loserTeamIds: { hasSome: targetIds } },
        ],
      },
      select: { winnerTeamIds: true, loserTeamIds: true },
    }),
    tx.leaderboardCache.groupBy({
      by: ['userId'],
      where: { userId: { in: targetIds } },
      _count: { _all: true },
    }),
    tx.auditLog.findMany({
      where: {
        entityType: 'User',
        entityId: { in: targetIds },
      },
      select: { entityId: true },
    }),
  ])

  const foundIds = new Set(targets.map((target) => target.id))
  const blockedIds = new Set(targetIds.filter((id) => !foundIds.has(id)))

  for (const target of targets) {
    if (
      target.id === input.actorId ||
      target.role === 'admin' ||
      target.identity ||
      hasNonDefaultAggregate(target)
    ) {
      blockedIds.add(target.id)
      continue
    }

    if (
      BUSINESS_HISTORY_COUNT_KEYS.some(
        (key: BusinessHistoryCountKey) => target._count[key] > 0,
      )
    ) {
      blockedIds.add(target.id)
    }
  }

  for (const result of legacyParticipantResults) {
    for (const userId of [...result.winnerTeamIds, ...result.loserTeamIds]) {
      if (foundIds.has(userId)) blockedIds.add(userId)
    }
  }
  for (const row of leaderboardRows) blockedIds.add(row.userId)
  for (const row of targetAuditLogs) blockedIds.add(row.entityId)

  if (blockedIds.size > 0) {
    throw new HardDeleteUsersBlockedError({
      mode: input.mode,
      blockedCount: blockedIds.size,
      requestedCount: targetIds.length,
    })
  }

  const deleted = await tx.user.deleteMany({
    where: { id: { in: targetIds } },
  })
  if (deleted.count !== targetIds.length) {
    throw new Error('User hard deletion count changed after eligibility checks.')
  }

  const labels = targets
    .map((target) => ({
      id: target.id,
      label: `${target.nickname} (${target.email})`,
    }))
    .sort((left, right) => left.id.localeCompare(right.id))

  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      action: input.mode === 'single' ? 'user.delete' : 'user.bulk.delete',
      entityType: 'User',
      entityId: input.mode === 'single' ? targetIds[0] : 'bulk',
      details:
        input.mode === 'single'
          ? { targetLabel: labels[0]?.label ?? targetIds[0] }
          : {
              count: targetIds.length,
              userIds: targetIds,
              targetLabels: labels.slice(0, 5).map((target) => target.label),
            },
      ip: input.auditContext?.ip ?? null,
      userAgent: input.auditContext?.userAgent ?? null,
    },
  })

  return { deletedCount: deleted.count, deletedUserIds: targetIds }
}
