import { Prisma } from '@prisma/client'

import { lockUsersForUpdate } from '../user/lock-users'
import { SupermarketError } from './errors'

export type SupermarketTransaction = Prisma.TransactionClient

const INT32_MAX = 2_147_483_647
const MAX_REASON_LENGTH = 200
const MAX_PRIZE_NAME_LENGTH = 80
const MAX_PRIZE_DESCRIPTION_LENGTH = 300

function fail(
  code: ConstructorParameters<typeof SupermarketError>[0],
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new SupermarketError(code, message, details)
}

function assertNonEmptyTrimmed(value: string, name: string, maxLength?: number) {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
    fail('INVALID_PRIZE', `${name} must be a non-empty trimmed string.`, { name })
  }
  if (maxLength !== undefined && value.length > maxLength) {
    fail('INVALID_PRIZE', `${name} exceeds ${maxLength} characters.`, {
      name,
      length: value.length,
    })
  }
}

function assertInt32(value: number, name: string) {
  if (Number.isSafeInteger(value) && value >= 0 && value <= INT32_MAX) return
  fail('INVALID_PRIZE', `${name} must be a non-negative integer within Int range.`, {
    name,
    value,
  })
}

/**
 * The single open period, or null. The partial unique index on OPEN status
 * guarantees at most one row, so this never needs to disambiguate.
 */
export async function findOpenPeriod(tx: SupermarketTransaction) {
  return tx.supermarketPeriod.findFirst({
    where: { status: 'OPEN' },
    orderBy: { openedAt: 'desc' },
  })
}

// Ordinary writes share the period lock; closing takes it exclusively before
// touching wallets. Always acquire this lock before user, wallet, or prize locks.
async function findLockedPeriod(
  tx: SupermarketTransaction,
  periodId: string,
  exclusive = false,
) {
  const lock = exclusive ? Prisma.sql`FOR UPDATE` : Prisma.sql`FOR SHARE`
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "supermarket_period"
    WHERE "id" = ${periodId} ${lock}
  `)
  return tx.supermarketPeriod.findUnique({ where: { id: periodId } })
}

async function requireOpenPeriod(tx: SupermarketTransaction, exclusive = false) {
  const period = await findOpenPeriod(tx)
  if (!period) fail('NO_OPEN_PERIOD', 'There is no open supermarket period.')
  const locked = await findLockedPeriod(tx, period.id, exclusive)
  if (!locked || locked.status !== 'OPEN') {
    fail('PERIOD_CLOSED', 'The supermarket period has closed.')
  }
  return locked
}

async function requirePrizePeriodOpen(tx: SupermarketTransaction, periodId: string) {
  const period = await findLockedPeriod(tx, periodId)
  if (!period) {
    fail('PRIZE_NOT_FOUND', 'The target period does not exist.', { periodId })
  }
  if (period.status !== 'OPEN') {
    fail('PERIOD_CLOSED', 'Prizes in a closed period are frozen.', { periodId })
  }
  return period
}

/**
 * Opens the next round. Prizes and stock start empty: a period never inherits
 * leftovers from the previous one.
 */
export async function openSupermarketPeriod(
  tx: SupermarketTransaction,
  input: Readonly<{ clock?: () => Date }> = {},
) {
  const existing = await findOpenPeriod(tx)
  if (existing) {
    fail('PERIOD_ALREADY_OPEN', 'A supermarket period is already open.', {
      periodId: existing.id,
      sequence: existing.sequence,
    })
  }

  const highest = await tx.supermarketPeriod.aggregate({ _max: { sequence: true } })
  const sequence = (highest._max.sequence ?? 0) + 1
  const now = (input.clock ?? (() => new Date()))()

  return tx.supermarketPeriod.create({
    data: { sequence, status: 'OPEN', openedAt: now },
  })
}

/**
 * Closes the open period: supermarket points are zeroed for everyone and the
 * period's prizes are frozen as history. Redemption records are untouched and
 * can still be resolved afterwards.
 *
 * Closing deliberately does not require pending redemptions to be resolved
 * first. A round ends when it ends; admins finish the handovers afterwards.
 */
export async function closeSupermarketPeriod(
  tx: SupermarketTransaction,
  input: Readonly<{ clock?: () => Date }> = {},
) {
  const period = await requireOpenPeriod(tx, true)
  const now = (input.clock ?? (() => new Date()))()

  const zeroed = await tx.supermarketBalance.aggregate({
    where: { periodId: period.id },
    _sum: { balance: true },
    _count: { _all: true },
  })

  // Zero every wallet in the period. The ledger keeps the closing trail so the
  // expiring amount stays explainable after the fact.
  const balances = await tx.supermarketBalance.findMany({
    where: { periodId: period.id, balance: { gt: 0 } },
    select: { id: true, balance: true },
  })
  for (const balance of balances) {
    await tx.supermarketBalance.update({
      where: { id: balance.id },
      data: { balance: 0 },
    })
    await tx.supermarketBalanceEntry.create({
      data: {
        balanceId: balance.id,
        amount: -balance.balance,
        balanceAfter: 0,
        type: 'ADMIN_ADJUSTMENT',
        reason: '本期超市关闭，未使用积分作废',
      },
    })
  }

  const closed = await tx.supermarketPeriod.update({
    where: { id: period.id },
    data: { status: 'CLOSED', closedAt: now },
  })

  return {
    period: closed,
    expiredPoints: zeroed._sum.balance ?? 0,
    affectedUserCount: zeroed._count._all,
  }
}

/**
 * Converts every member's current match points into supermarket points for the
 * open period, then zeroes match points. Both ledgers move in one transaction
 * so a member can never be credited twice or left with points in neither.
 *
 * Intended to run once at the start of a round. Running it again is harmless:
 * match points are already zero, so it transfers nothing.
 */
export async function settleMatchPointsIntoSupermarket(
  tx: SupermarketTransaction,
  input: Readonly<{ actorId: string; clock?: () => Date }>,
) {
  const period = await requireOpenPeriod(tx)

  // Only members with a positive balance participate; transferring zero points
  // would create noise without changing anyone's spending power.
  const eligible = await tx.user.findMany({
    where: { points: { gt: 0 } },
    select: { id: true, points: true },
    orderBy: { id: 'asc' },
  })

  let totalPoints = 0
  let userCount = 0

  if (eligible.length > 0) {
    const userIds = eligible.map((user) => user.id)
    await lockUsersForUpdate(tx, userIds)

    // Re-read after locking: a concurrent settlement or award may have changed
    // these values between the initial read and the lock.
    const locked = await tx.user.findMany({
      where: { id: { in: userIds }, points: { gt: 0 } },
      select: { id: true, points: true },
      orderBy: { id: 'asc' },
    })

    for (const user of locked) {
      const balance = await tx.supermarketBalance.upsert({
        where: {
          userId_periodId: { userId: user.id, periodId: period.id },
        },
        create: {
          userId: user.id,
          periodId: period.id,
          balance: user.points,
        },
        update: { balance: { increment: user.points } },
        select: { id: true, balance: true },
      })

      await tx.supermarketBalanceEntry.create({
        data: {
          balanceId: balance.id,
          amount: user.points,
          balanceAfter: balance.balance,
          type: 'SETTLEMENT',
          reason: '比赛积分结算转入',
          actorId: input.actorId,
        },
      })

      await tx.user.update({
        where: { id: user.id },
        data: { points: 0 },
      })

      totalPoints += user.points
      userCount += 1
    }
  }

  const settlement = await tx.supermarketSettlement.create({
    data: {
      periodId: period.id,
      userCount,
      totalPoints,
    },
  })

  return { period, settlement, userCount, totalPoints }
}

export type CreatePrizeInput = Readonly<{
  periodId: string
  name: string
  description?: string | null
  pointsCost: number
  stock: number | null
}>

export async function createSupermarketPrize(
  tx: SupermarketTransaction,
  input: CreatePrizeInput,
) {
  assertNonEmptyTrimmed(input.name, 'name', MAX_PRIZE_NAME_LENGTH)
  assertInt32(input.pointsCost, 'pointsCost')
  if (input.pointsCost <= 0) {
    fail('INVALID_PRIZE', 'A prize must cost at least one point.', {
      pointsCost: input.pointsCost,
    })
  }
  if (input.stock !== null) assertInt32(input.stock, 'stock')
  if (input.description != null) {
    assertNonEmptyTrimmed(
      input.description,
      'description',
      MAX_PRIZE_DESCRIPTION_LENGTH,
    )
  }

  const period = await requirePrizePeriodOpen(tx, input.periodId)

  return tx.supermarketPrize.create({
    data: {
      periodId: period.id,
      name: input.name,
      description: input.description ?? null,
      pointsCost: input.pointsCost,
      stock: input.stock,
    },
  })
}

export type UpdatePrizeInput = Readonly<{
  prizeId: string
  name?: string
  description?: string | null
  pointsCost?: number
  stock?: number | null
  status?: 'ACTIVE' | 'WITHDRAWN'
}>

export async function updateSupermarketPrize(
  tx: SupermarketTransaction,
  input: UpdatePrizeInput,
) {
  const prize = await tx.supermarketPrize.findUnique({
    where: { id: input.prizeId },
    select: { id: true, periodId: true },
  })
  if (!prize) fail('PRIZE_NOT_FOUND', 'The prize does not exist.', {
    prizeId: input.prizeId,
  })
  await requirePrizePeriodOpen(tx, prize.periodId)

  const data: Prisma.SupermarketPrizeUpdateInput = {}
  if (input.name !== undefined) {
    assertNonEmptyTrimmed(input.name, 'name', MAX_PRIZE_NAME_LENGTH)
    data.name = input.name
  }
  if (input.description !== undefined) {
    if (input.description !== null) {
      assertNonEmptyTrimmed(
        input.description,
        'description',
        MAX_PRIZE_DESCRIPTION_LENGTH,
      )
    }
    data.description = input.description
  }
  if (input.pointsCost !== undefined) {
    assertInt32(input.pointsCost, 'pointsCost')
    if (input.pointsCost <= 0) {
      fail('INVALID_PRIZE', 'A prize must cost at least one point.', {
        pointsCost: input.pointsCost,
      })
    }
    data.pointsCost = input.pointsCost
  }
  if (input.stock !== undefined) {
    if (input.stock !== null) assertInt32(input.stock, 'stock')
    data.stock = input.stock
  }
  if (input.status !== undefined) data.status = input.status

  return tx.supermarketPrize.update({ where: { id: prize.id }, data })
}

/**
 * A prize may only be deleted while nobody has redeemed it. Once a redemption
 * exists the prize is part of that record's history and can only be withdrawn.
 */
export async function deleteSupermarketPrize(
  tx: SupermarketTransaction,
  prizeId: string,
) {
  const prize = await tx.supermarketPrize.findUnique({
    where: { id: prizeId },
    select: { id: true, periodId: true, _count: { select: { redemptions: true } } },
  })
  if (!prize) fail('PRIZE_NOT_FOUND', 'The prize does not exist.', { prizeId })
  await requirePrizePeriodOpen(tx, prize.periodId)

  if (prize._count.redemptions > 0) {
    fail(
      'PRIZE_NOT_AVAILABLE',
      'A prize with redemptions can only be withdrawn, not deleted.',
      { prizeId, redemptionCount: prize._count.redemptions },
    )
  }

  await tx.supermarketPrize.delete({ where: { id: prize.id } })
  return { deletedPrizeId: prize.id }
}

export type RedeemPrizeInput = Readonly<{
  userId: string
  prizeId: string
  clock?: () => Date
}>

/**
 * Redeems a prize for a member.
 *
 * Points and stock move together under one Serializable transaction. The stock
 * decrement is a conditional update, so two members racing for the last unit
 * cannot both succeed: the loser sees zero affected rows and is rejected.
 */
export async function redeemSupermarketPrize(
  tx: SupermarketTransaction,
  input: RedeemPrizeInput,
) {
  const period = await requireOpenPeriod(tx)
  const now = (input.clock ?? (() => new Date()))()

  const prize = await tx.supermarketPrize.findUnique({
    where: { id: input.prizeId },
    select: {
      id: true,
      periodId: true,
      name: true,
      pointsCost: true,
      stock: true,
      status: true,
    },
  })

  if (!prize || prize.periodId !== period.id) {
    fail('PRIZE_NOT_FOUND', 'The prize is not part of the open period.', {
      prizeId: input.prizeId,
      periodId: period.id,
    })
  }
  if (prize.status !== 'ACTIVE') {
    fail('PRIZE_NOT_AVAILABLE', 'The prize has been withdrawn.', {
      prizeId: prize.id,
    })
  }

  // Lock the member's wallet row (and their user row) before deciding, so the
  // balance used for the sufficiency check cannot change under us.
  await lockUsersForUpdate(tx, [input.userId])

  const user = await tx.user.findUnique({
    where: { id: input.userId },
    select: { id: true },
  })
  if (!user) fail('USER_NOT_FOUND', 'The redeeming member does not exist.', {
    userId: input.userId,
  })

  if (prize.stock !== null) {
    const decremented = await tx.supermarketPrize.updateMany({
      where: {
        id: prize.id,
        status: 'ACTIVE',
        stock: { gte: 1 },
      },
      data: { stock: { decrement: 1 } },
    })
    if (decremented.count !== 1) {
      fail('PRIZE_SOLD_OUT', 'The prize ran out of stock.', {
        prizeId: prize.id,
      })
    }
  }

  const wallet = await tx.supermarketBalance.findUnique({
    where: { userId_periodId: { userId: user.id, periodId: period.id } },
    select: { id: true, balance: true },
  })

  const available = wallet?.balance ?? 0
  if (available < prize.pointsCost) {
    fail('INSUFFICIENT_POINTS', 'The member cannot afford this prize.', {
      available,
      required: prize.pointsCost,
      shortfall: prize.pointsCost - available,
    })
  }

  const balanceAfter = available - prize.pointsCost
  const updatedWallet = await tx.supermarketBalance.update({
    where: { id: wallet!.id },
    data: { balance: balanceAfter },
    select: { id: true },
  })

  await tx.supermarketBalanceEntry.create({
    data: {
      balanceId: updatedWallet.id,
      amount: -prize.pointsCost,
      balanceAfter,
      type: 'REDEMPTION',
      reason: `兑换奖品：${prize.name}`,
    },
  })

  const redemption = await tx.supermarketRedemption.create({
    data: {
      periodId: period.id,
      prizeId: prize.id,
      userId: user.id,
      // Snapshot so the record stays readable after the prize is edited.
      prizeName: prize.name,
      pointsSpent: prize.pointsCost,
      status: 'PENDING',
      createdAt: now,
    },
  })

  return { redemption, balanceAfter }
}

export type ResolveRedemptionInput = Readonly<{
  redemptionId: string
  resolution: 'FULFILLED' | 'VOIDED'
  actorId: string
  clock?: () => Date
}>

/**
 * Marks a pending redemption as handed over or as never fulfilled.
 *
 * Voiding refunds points only while the redemption's own period is open.
 * Stock is always handled manually. Once the period closes, compensation is
 * an operational decision handled through the admin adjustment tool.
 *
 * Resolution stays available after the period closes so admins can finish
 * outstanding handovers.
 */
export async function resolveSupermarketRedemption(
  tx: SupermarketTransaction,
  input: ResolveRedemptionInput,
) {
  const now = (input.clock ?? (() => new Date()))()

  const redemption = await tx.supermarketRedemption.findUnique({
    where: { id: input.redemptionId },
    select: {
      id: true,
      status: true,
      periodId: true,
      userId: true,
      prizeName: true,
      pointsSpent: true,
    },
  })
  if (!redemption) {
    fail('REDEMPTION_NOT_FOUND', 'The redemption does not exist.', {
      redemptionId: input.redemptionId,
    })
  }
  if (redemption.status !== 'PENDING') {
    fail(
      'REDEMPTION_ALREADY_RESOLVED',
      'The redemption has already been resolved.',
      { redemptionId: redemption.id, status: redemption.status },
    )
  }

  let refundedPoints = 0
  if (input.resolution === 'VOIDED') {
    const period = await findLockedPeriod(tx, redemption.periodId)
    if (period?.status === 'OPEN') {
      await lockUsersForUpdate(tx, [redemption.userId])
      const wallet = await tx.supermarketBalance.findUnique({
        where: {
          userId_periodId: {
            userId: redemption.userId,
            periodId: redemption.periodId,
          },
        },
        select: { id: true },
      })
      if (!wallet) {
        fail('SETTLEMENT_STATE_CONFLICT', 'The redemption wallet is missing.', {
          redemptionId: redemption.id,
        })
      }
      const refunded = await tx.supermarketBalance.update({
        where: { id: wallet.id },
        data: { balance: { increment: redemption.pointsSpent } },
        select: { balance: true },
      })
      await tx.supermarketBalanceEntry.create({
        data: {
          balanceId: wallet.id,
          amount: redemption.pointsSpent,
          balanceAfter: refunded.balance,
          type: 'ADMIN_ADJUSTMENT',
          reason: `兑换未履行，自动退分：${redemption.prizeName}（${redemption.id}）`,
          actorId: input.actorId,
          createdAt: now,
        },
      })
      refundedPoints = redemption.pointsSpent
    }
  }

  const resolved = await tx.supermarketRedemption.update({
    where: { id: redemption.id },
    data: {
      status: input.resolution,
      resolvedAt: now,
      resolvedById: input.actorId,
    },
  })
  return { ...resolved, refundedPoints }
}

export type AdjustPointsInput = Readonly<{
  userId: string
  amount: number
  reason: string
  actorId: string
  clock?: () => Date
}>

/**
 * Operational fallback for correcting supermarket points by hand: a mistaken
 * redemption, a goodwill credit, a manual clawback. Only the currently open
 * period can be adjusted, and the balance may never go negative.
 */
export async function adjustSupermarketPoints(
  tx: SupermarketTransaction,
  input: AdjustPointsInput,
) {
  if (!Number.isSafeInteger(input.amount) || input.amount === 0) {
    fail('INVALID_AMOUNT', 'An adjustment must be a non-zero integer.', {
      amount: input.amount,
    })
  }
  if (input.amount > INT32_MAX || input.amount < -INT32_MAX) {
    fail('INVALID_AMOUNT', 'The adjustment exceeds Int range.', {
      amount: input.amount,
    })
  }
  if (
    typeof input.reason !== 'string' ||
    input.reason.trim() === '' ||
    input.reason !== input.reason.trim() ||
    input.reason.length > MAX_REASON_LENGTH
  ) {
    fail('INVALID_REASON', 'An adjustment requires a trimmed reason.', {
      reason: input.reason,
    })
  }

  const period = await requireOpenPeriod(tx)
  const now = (input.clock ?? (() => new Date()))()

  await lockUsersForUpdate(tx, [input.userId])

  const user = await tx.user.findUnique({
    where: { id: input.userId },
    select: { id: true },
  })
  if (!user) fail('USER_NOT_FOUND', 'The member does not exist.', {
    userId: input.userId,
  })

  const wallet = await tx.supermarketBalance.findUnique({
    where: { userId_periodId: { userId: user.id, periodId: period.id } },
    select: { id: true, balance: true },
  })

  const current = wallet?.balance ?? 0
  const balanceAfter = current + input.amount
  if (balanceAfter < 0) {
    fail('INSUFFICIENT_POINTS', 'An adjustment cannot make a balance negative.', {
      available: current,
      requested: input.amount,
      shortfall: -balanceAfter,
    })
  }

  const target = wallet
    ? await tx.supermarketBalance.update({
        where: { id: wallet.id },
        data: { balance: balanceAfter },
        select: { id: true },
      })
    : await tx.supermarketBalance.create({
        data: {
          userId: user.id,
          periodId: period.id,
          balance: balanceAfter,
        },
        select: { id: true },
      })

  await tx.supermarketBalanceEntry.create({
    data: {
      balanceId: target.id,
      amount: input.amount,
      balanceAfter,
      type: 'ADMIN_ADJUSTMENT',
      reason: input.reason,
      actorId: input.actorId,
      createdAt: now,
    },
  })

  return { balanceAfter, periodId: period.id }
}

/**
 * Reads a member's wallet for the open period, creating nothing.
 */
export async function readSupermarketWallet(
  tx: SupermarketTransaction,
  input: Readonly<{ userId: string }>,
) {
  const period = await findOpenPeriod(tx)
  if (!period) return { period: null, balance: 0 }

  const wallet = await tx.supermarketBalance.findUnique({
    where: { userId_periodId: { userId: input.userId, periodId: period.id } },
    select: { balance: true },
  })

  return { period, balance: wallet?.balance ?? 0 }
}
