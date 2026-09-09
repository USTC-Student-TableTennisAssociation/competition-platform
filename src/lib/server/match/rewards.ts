import type { Prisma } from '@prisma/client'
import { lockUsersForUpdate } from '../user/lock-users'

const MATCH_POINTS_CAP_PER_MATCH = 5
const MATCH_POINTS_REFERENCE_PREFIX = 'match-points:'

export async function grantRegistrationRewardPoints(
  tx: Prisma.TransactionClient,
  params: {
    userId: string
    matchId: string
  },
) {
  const { userId, matchId } = params
  const registrationReferencePrefix = `${MATCH_POINTS_REFERENCE_PREFIX}${matchId}:register:`

  // Multi-user callers pre-lock their complete set. Keep this single-row lock
  // as a defensive invariant for direct/future callers.
  await lockUsersForUpdate(tx, [userId])

  const [registrationSummary, matchSummary, user] = await Promise.all([
    tx.pointsTransaction.aggregate({
      where: {
        userId,
        referenceId: { startsWith: registrationReferencePrefix },
      },
      _sum: { amount: true },
    }),
    tx.pointsTransaction.aggregate({
      where: {
        userId,
        referenceId: { startsWith: `${MATCH_POINTS_REFERENCE_PREFIX}${matchId}:` },
      },
      _sum: { amount: true },
    }),
    tx.user.findUnique({ where: { id: userId }, select: { points: true } }),
  ])

  const netRegistrationAwarded = registrationSummary._sum.amount ?? 0
  const netMatchAwarded = matchSummary._sum.amount ?? 0

  if (!user || netRegistrationAwarded >= 1) {
    return { granted: 0, totalAwarded: netMatchAwarded }
  }

  const remaining = Math.max(0, MATCH_POINTS_CAP_PER_MATCH - netMatchAwarded)
  const grant = Math.min(1 - netRegistrationAwarded, remaining)
  if (grant <= 0) return { granted: 0, totalAwarded: netMatchAwarded }

  const balanceAfter = user.points + grant
  await tx.user.update({
    where: { id: userId },
    data: { points: { increment: grant } },
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

  return { granted: grant, totalAwarded: netMatchAwarded + grant }
}

export async function refundRegistrationRewardPoints(
  tx: Prisma.TransactionClient,
  params: {
    userId: string
    matchId: string
  },
) {
  const { userId, matchId } = params
  const registrationReferencePrefix = `${MATCH_POINTS_REFERENCE_PREFIX}${matchId}:register:`
  const matchReferencePrefix = `${MATCH_POINTS_REFERENCE_PREFIX}${matchId}:`

  // See grantRegistrationRewardPoints: callers with a set must lock the full
  // sorted set first, while this protects standalone calls.
  await lockUsersForUpdate(tx, [userId])

  const [registrationSummary, matchSummary, user] = await Promise.all([
    tx.pointsTransaction.aggregate({
      where: {
        userId,
        referenceId: { startsWith: registrationReferencePrefix },
      },
      _sum: { amount: true },
    }),
    tx.pointsTransaction.aggregate({
      where: {
        userId,
        referenceId: { startsWith: matchReferencePrefix },
      },
      _sum: { amount: true },
    }),
    tx.user.findUnique({ where: { id: userId }, select: { points: true } }),
  ])

  const netRegistrationAwarded = registrationSummary._sum.amount ?? 0
  const netMatchAwarded = matchSummary._sum.amount ?? 0
  if (!user || netRegistrationAwarded <= 0) {
    return { deducted: 0, totalAwarded: netMatchAwarded }
  }

  const deduction = Math.min(1, netRegistrationAwarded, user.points)
  if (deduction <= 0) return { deducted: 0, totalAwarded: netMatchAwarded }

  const balanceAfter = user.points - deduction
  await tx.user.update({
    where: { id: userId },
    data: { points: { decrement: deduction } },
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

  return { deducted: deduction, totalAwarded: netMatchAwarded - deduction }
}
