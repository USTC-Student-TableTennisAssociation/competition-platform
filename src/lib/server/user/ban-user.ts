import { MatchStatus, Prisma } from '@prisma/client'
import { removeUserFromMatch } from '@/lib/server/match/remove-participant'
import { enqueueAccountBanNotification } from '@/lib/server/notification/account-ban-notification'

type AuditContext = {
  ip?: string | null
  userAgent?: string | null
}

export async function setUserBanState(
  tx: Prisma.TransactionClient,
  params: {
    userId: string
    banned: boolean
    actorId: string
    auditContext?: AuditContext
  },
) {
  const { userId, banned, actorId, auditContext } = params
  const target = await tx.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      nickname: true,
      email: true,
      isBanned: true,
    },
  })
  if (!target) throw new Error('用户不存在。')

  const removedMatches: Array<{ id: string; title: string }> = []
  if (banned) {
    const matches = await tx.match.findMany({
      where: {
        status: { not: MatchStatus.finished },
        OR: [
          { registrations: { some: { userId } } },
          { doublesTeamMembers: { some: { userId } } },
          { teamMembers: { some: { userId } } },
          { teamRegistrations: { some: { captainId: userId } } },
        ],
      },
      select: { id: true, title: true },
      orderBy: { createdAt: 'asc' },
    })

    for (const match of matches) {
      const result = await removeUserFromMatch(tx, {
        matchId: match.id,
        userId,
        actorId,
        reason: 'user_banned',
        auditContext,
      })
      if (result.removed) removedMatches.push({ id: match.id, title: match.title })
    }

    await tx.matchDoublesInvite.updateMany({
      where: {
        status: 'pending',
        match: { status: { not: MatchStatus.finished } },
        OR: [{ inviterId: userId }, { inviteeId: userId }],
      },
      data: { status: 'voided', updatedAt: new Date() },
    })
  }

  await tx.user.update({
    where: { id: userId },
    data: {
      isBanned: banned,
      sessionVersion: { increment: 1 },
    },
  })

  const notification =
    banned && !target.isBanned
      ? await enqueueAccountBanNotification(tx, {
          userId,
          recipientEmail: target.email,
        })
      : null

  await tx.auditLog.create({
    data: {
      actorId,
      action: banned ? 'user.ban' : 'user.unban',
      entityType: 'User',
      entityId: userId,
      ip: auditContext?.ip ?? null,
      userAgent: auditContext?.userAgent ?? null,
      details: {
        banned,
        previousBanned: target.isBanned,
        targetLabel: `${target.nickname} (${target.email})`,
        removedMatches,
        removedMatchIds: removedMatches.map((match) => match.id),
      },
    },
  })

  return {
    userId,
    banned,
    removedMatches,
    notificationOutboxId: notification?.id ?? null,
  }
}
