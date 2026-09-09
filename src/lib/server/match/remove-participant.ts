import { type Prisma } from '@prisma/client'
import { lockUsersForUpdate } from '../user/lock-users'
import { lockMatchForEngine } from './engine-guard'

export type RemoveUserFromMatchResult = {
  matchId: string
  matchTitle: string
  removed: boolean
  removedUserIds: string[]
  dissolvedTeamId: null
}

/** Account-ban cleanup for independent quick matches. Formal history is read-only. */
export async function removeUserFromMatch(
  tx: Prisma.TransactionClient,
  params: {
    matchId: string
    userId: string
    actorId: string
    reason: 'manager' | 'user_banned'
    auditContext?: { ip?: string | null; userAgent?: string | null }
  },
): Promise<RemoveUserFromMatchResult> {
  const { matchId, userId, actorId, reason, auditContext } = params
  await lockMatchForEngine(tx, { matchId, expectedEngine: 'LEGACY', expectedQuickMatch: true })
  const match = await tx.match.findUniqueOrThrow({
    where: { id: matchId },
    select: { title: true, status: true, createdBy: true },
  })
  if (match.status === 'finished') throw new Error('已结束比赛的历史参赛数据不可移除。')
  await lockUsersForUpdate(tx, [actorId, userId])
  const actor = await tx.user.findUnique({ where: { id: actorId }, select: { role: true, isBanned: true, emailVerifiedAt: true } })
  if (!actor || actor.isBanned || !actor.emailVerifiedAt || (actor.role !== 'admin' && (reason === 'user_banned' || match.createdBy !== actorId))) {
    throw new Error('无权处理该快速约球。')
  }
  const reports = await tx.matchResult.deleteMany({ where: { matchId, confirmed: false, OR: [{ winnerTeamIds: { has: userId } }, { loserTeamIds: { has: userId } }] } })
  const registrations = await tx.registration.deleteMany({ where: { matchId, userId } })
  const removed = reports.count > 0 || registrations.count > 0
  if (removed) {
    await tx.auditLog.create({ data: {
      actorId, action: 'quick_match.participant.remove', entityType: 'Match', entityId: matchId,
      ip: auditContext?.ip ?? null, userAgent: auditContext?.userAgent ?? null,
      details: { matchId, userId, reason, targetLabel: match.title },
    } })
  }
  return { matchId, matchTitle: match.title, removed, removedUserIds: removed ? [userId] : [], dissolvedTeamId: null }
}
