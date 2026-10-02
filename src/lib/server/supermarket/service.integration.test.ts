import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Prisma, PrismaClient } from '@prisma/client'

import { SupermarketError } from './errors'
import {
  adjustSupermarketPoints,
  closeSupermarketPeriod,
  createSupermarketPrize,
  deleteSupermarketPrize,
  openSupermarketPeriod,
  readSupermarketWallet,
  redeemSupermarketPrize,
  resolveSupermarketRedemption,
  settleMatchPointsIntoSupermarket,
  updateSupermarketPrize,
} from './service'

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL

/** Wraps a callback in a Serializable transaction, matching production callers. */
function serializable<T>(
  db: PrismaClient,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return db.$transaction(run, {
    isolationLevel: 'Serializable',
    maxWait: 5_000,
    timeout: 30_000,
  })
}

/**
 * Removes a period and its history in dependency order. Period-scoped rows
 * hold RESTRICT foreign keys back to the period by design, so teardown has to
 * clear children first.
 */
async function cleanupPeriods(db: PrismaClient, periodIds: string[]) {
  await db.supermarketRedemption.deleteMany({
    where: { periodId: { in: periodIds } },
  })
  await db.supermarketBalanceEntry.deleteMany({
    where: { balance: { periodId: { in: periodIds } } },
  })
  await db.supermarketBalance.deleteMany({
    where: { periodId: { in: periodIds } },
  })
  await db.supermarketPrize.deleteMany({
    where: { periodId: { in: periodIds } },
  })
  await db.supermarketSettlement.deleteMany({
    where: { periodId: { in: periodIds } },
  })
  await db.supermarketPeriod.deleteMany({ where: { id: { in: periodIds } } })
}

test(
  'supermarket period lifecycle, settlement, redemption and adjustment',
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl
    const db = new PrismaClient()
    const suffix = randomUUID().replaceAll('-', '')
    const adminId = `sm-admin-${suffix}`
    const memberA = `sm-a-${suffix}`
    const memberB = `sm-b-${suffix}`
    const memberC = `sm-c-${suffix}`

    try {
      const verifiedAt = new Date('2026-09-01T00:00:00Z')
      await db.user.createMany({
        data: [
          {
            id: adminId,
            email: `${adminId}@example.test`,
            nickname: 'Supermarket admin',
            role: 'admin',
            emailVerifiedAt: verifiedAt,
          },
          {
            id: memberA,
            email: `${memberA}@example.test`,
            nickname: 'Member A',
            points: 120,
            emailVerifiedAt: verifiedAt,
          },
          {
            id: memberB,
            email: `${memberB}@example.test`,
            nickname: 'Member B',
            points: 30,
            emailVerifiedAt: verifiedAt,
          },
          {
            id: memberC,
            email: `${memberC}@example.test`,
            nickname: 'Member C',
            points: 0,
            emailVerifiedAt: verifiedAt,
          },
        ],
      })

      // --- period lifecycle -------------------------------------------------
      const period = await serializable(db, (tx) => openSupermarketPeriod(tx))
      assert.equal(period.sequence, 1)
      assert.equal(period.status, 'OPEN')

      await assert.rejects(
        () => serializable(db, (tx) => openSupermarketPeriod(tx)),
        (error: unknown) =>
          error instanceof SupermarketError &&
          error.code === 'PERIOD_ALREADY_OPEN',
      )

      // --- settlement -------------------------------------------------------
      const settled = await serializable(db, (tx) =>
        settleMatchPointsIntoSupermarket(tx, { actorId: adminId }),
      )
      // Settlement is deliberately global: it sweeps every member holding
      // points, so this asserts on the members this test owns rather than on
      // suite-wide totals.
      assert.ok(settled.userCount >= 2)
      assert.ok(settled.totalPoints >= 150)

      const balancesAfterSettle = await db.supermarketBalance.findMany({
        where: { periodId: period.id, userId: { in: [memberA, memberB, memberC] } },
        select: { userId: true, balance: true },
        orderBy: { userId: 'asc' },
      })
      assert.deepEqual(
        balancesAfterSettle.map((row) => [row.userId, row.balance]),
        [
          [memberA, 120],
          [memberB, 30],
        ],
      )

      // Match points were zeroed, ELO untouched.
      const usersAfterSettle = await db.user.findMany({
        where: { id: { in: [memberA, memberB, memberC] } },
        select: { id: true, points: true, eloRating: true },
      })
      assert.equal(usersAfterSettle.every((user) => user.points === 0), true)
      assert.equal(
        usersAfterSettle.every((user) => user.eloRating === 1200),
        true,
      )

      // Running the settlement again must not credit the same members twice.
      await serializable(db, (tx) =>
        settleMatchPointsIntoSupermarket(tx, { actorId: adminId }),
      )
      const rebalanced = await db.supermarketBalance.findMany({
        where: { periodId: period.id, userId: { in: [memberA, memberB] } },
        select: { userId: true, balance: true },
        orderBy: { userId: 'asc' },
      })
      assert.deepEqual(
        rebalanced.map((row) => [row.userId, row.balance]),
        [
          [memberA, 120],
          [memberB, 30],
        ],
        'a repeated settlement must not double-credit',
      )

      // --- prizes -----------------------------------------------------------
      const limitedPrize = await serializable(db, (tx) =>
        createSupermarketPrize(tx, {
          periodId: period.id,
          name: '限量球拍',
          pointsCost: 80,
          stock: 1,
        }),
      )
      const unlimitedPrize = await serializable(db, (tx) =>
        createSupermarketPrize(tx, {
          periodId: period.id,
          name: '训练球',
          pointsCost: 10,
          stock: null,
        }),
      )

      await assert.rejects(
        () =>
          serializable(db, (tx) =>
            createSupermarketPrize(tx, {
              periodId: period.id,
              name: '免费赠品',
              pointsCost: 0,
              stock: null,
            }),
          ),
        (error: unknown) =>
          error instanceof SupermarketError && error.code === 'INVALID_PRIZE',
      )

      // --- redemption -------------------------------------------------------
      const first = await serializable(db, (tx) =>
        redeemSupermarketPrize(tx, { userId: memberA, prizeId: limitedPrize.id }),
      )
      assert.equal(first.balanceAfter, 40)
      assert.equal(first.redemption.status, 'PENDING')
      assert.equal(first.redemption.prizeName, '限量球拍')
      assert.equal(first.redemption.pointsSpent, 80)

      // Sold out, and the failed attempt must not have charged anyone.
      await assert.rejects(
        () =>
          serializable(db, (tx) =>
            redeemSupermarketPrize(tx, {
              userId: memberB,
              prizeId: limitedPrize.id,
            }),
          ),
        (error: unknown) =>
          error instanceof SupermarketError && error.code === 'PRIZE_SOLD_OUT',
      )
      const walletBAfterFailure = await serializable(db, (tx) =>
        readSupermarketWallet(tx, { userId: memberB }),
      )
      assert.equal(walletBAfterFailure.balance, 30)

      // Insufficient points reports the exact shortfall. Member C holds
      // nothing and the prize costs 10.
      const shortfall = await serializable(db, (tx) =>
        redeemSupermarketPrize(tx, {
          userId: memberC,
          prizeId: unlimitedPrize.id,
        }).catch((error: unknown) => error),
      )
      assert.ok(shortfall instanceof SupermarketError)
      assert.equal(shortfall.code, 'INSUFFICIENT_POINTS')
      assert.equal(shortfall.details.shortfall, 10)
      // A rejected redemption must leave no trace behind.
      assert.equal(
        await db.supermarketRedemption.count({ where: { userId: memberC } }),
        0,
      )

      // An unlimited prize can be redeemed repeatedly.
      const unlimitedRedemption = await serializable(db, (tx) =>
        redeemSupermarketPrize(tx, {
          userId: memberB,
          prizeId: unlimitedPrize.id,
        }),
      )
      assert.equal(unlimitedRedemption.balanceAfter, 20)

      // --- withdrawal -------------------------------------------------------
      await serializable(db, (tx) =>
        updateSupermarketPrize(tx, {
          prizeId: unlimitedPrize.id,
          status: 'WITHDRAWN',
        }),
      )
      await assert.rejects(
        () =>
          serializable(db, (tx) =>
            redeemSupermarketPrize(tx, {
              userId: memberB,
              prizeId: unlimitedPrize.id,
            }),
          ),
        (error: unknown) =>
          error instanceof SupermarketError &&
          error.code === 'PRIZE_NOT_AVAILABLE',
      )

      // --- deletion protection ---------------------------------------------
      await assert.rejects(
        () =>
          serializable(db, (tx) =>
            deleteSupermarketPrize(tx, limitedPrize.id),
          ),
        (error: unknown) =>
          error instanceof SupermarketError &&
          error.code === 'PRIZE_NOT_AVAILABLE',
      )
      const deletable = await serializable(db, (tx) =>
        createSupermarketPrize(tx, {
          periodId: period.id,
          name: '无人兑换',
          pointsCost: 5,
          stock: null,
        }),
      )
      await serializable(db, (tx) =>
        deleteSupermarketPrize(tx, deletable.id),
      )
      assert.equal(
        await db.supermarketPrize.count({ where: { id: deletable.id } }),
        0,
      )

      // --- resolution -------------------------------------------------------
      const fulfilled = await serializable(db, (tx) =>
        resolveSupermarketRedemption(tx, {
          redemptionId: first.redemption.id,
          resolution: 'FULFILLED',
          actorId: adminId,
        }),
      )
      assert.equal(fulfilled.status, 'FULFILLED')
      assert.ok(fulfilled.resolvedAt)
      assert.equal(fulfilled.resolvedById, adminId)

      // Resolving twice is rejected rather than silently overwriting.
      await assert.rejects(
        () =>
          serializable(db, (tx) =>
            resolveSupermarketRedemption(tx, {
              redemptionId: first.redemption.id,
              resolution: 'VOIDED',
              actorId: adminId,
            }),
          ),
        (error: unknown) =>
          error instanceof SupermarketError &&
          error.code === 'REDEMPTION_ALREADY_RESOLVED',
      )

      // Voiding during the original open period refunds the points.
      const balanceBeforeVoid = await serializable(db, (tx) =>
        readSupermarketWallet(tx, { userId: memberB }),
      )
      const voided = await serializable(db, (tx) =>
        resolveSupermarketRedemption(tx, {
          redemptionId: unlimitedRedemption.redemption.id,
          resolution: 'VOIDED',
          actorId: adminId,
        }),
      )
      assert.equal(voided.status, 'VOIDED')
      assert.equal(voided.refundedPoints, 10)
      const balanceAfterVoid = await serializable(db, (tx) =>
        readSupermarketWallet(tx, { userId: memberB }),
      )
      assert.equal(balanceAfterVoid.balance, balanceBeforeVoid.balance + 10)

      // --- admin adjustment -------------------------------------------------
      const adjusted = await serializable(db, (tx) =>
        adjustSupermarketPoints(tx, {
          userId: memberC,
          amount: 25,
          reason: '补偿未履行的兑换',
          actorId: adminId,
        }),
      )
      assert.equal(adjusted.balanceAfter, 25)

      await assert.rejects(
        () =>
          serializable(db, (tx) =>
            adjustSupermarketPoints(tx, {
              userId: memberC,
              amount: -100,
              reason: '扣回',
              actorId: adminId,
            }),
          ),
        (error: unknown) =>
          error instanceof SupermarketError &&
          error.code === 'INSUFFICIENT_POINTS',
      )
      await assert.rejects(
        () =>
          serializable(db, (tx) =>
            adjustSupermarketPoints(tx, {
              userId: memberC,
              amount: 0,
              reason: '无变化',
              actorId: adminId,
            }),
          ),
        (error: unknown) =>
          error instanceof SupermarketError && error.code === 'INVALID_AMOUNT',
      )
      await assert.rejects(
        () =>
          serializable(db, (tx) =>
            adjustSupermarketPoints(tx, {
              userId: memberC,
              amount: 5,
              reason: '   ',
              actorId: adminId,
            }),
          ),
        (error: unknown) =>
          error instanceof SupermarketError && error.code === 'INVALID_REASON',
      )

      // --- closing ----------------------------------------------------------
      // Re-activating a withdrawn prize restores it without disturbing stock.
      const reactivated = await serializable(db, (tx) =>
        updateSupermarketPrize(tx, {
          prizeId: unlimitedPrize.id,
          status: 'ACTIVE',
        }),
      )
      assert.equal(reactivated.status, 'ACTIVE')

      // Leave one redemption pending across the close to prove handovers can
      // still be finished after the round ends.
      const pendingAcrossClose = await serializable(db, (tx) =>
        redeemSupermarketPrize(tx, {
          userId: memberB,
          prizeId: unlimitedPrize.id,
        }),
      )
      assert.equal(pendingAcrossClose.redemption.status, 'PENDING')

      const frozenPrize = await serializable(db, (tx) =>
        createSupermarketPrize(tx, {
          periodId: period.id,
          name: '闭期后保留的奖品',
          description: '历史配置',
          pointsCost: 5,
          stock: 2,
        }),
      )
      const closed = await serializable(db, (tx) => closeSupermarketPeriod(tx))
      assert.equal(closed.period.status, 'CLOSED')

      // Unspent points expire: 40 (A, after the 80-point redemption)
      // + 20 (B, one fulfilled redemption and one refunded) + 25 (C).
      const closingBalances = await db.supermarketBalance.findMany({
        where: { periodId: period.id, userId: { in: [memberA, memberB, memberC] } },
        select: { balance: true },
      })
      assert.equal(
        closingBalances.every((row) => row.balance === 0),
        true,
        'closing must zero every wallet',
      )

      const closingEntries = await db.supermarketBalanceEntry.findMany({
        where: {
          reason: '本期超市关闭，未使用积分作废',
          balance: {
            periodId: period.id,
            userId: { in: [memberA, memberB, memberC] },
          },
        },
        select: { amount: true },
      })
      assert.equal(
        closingEntries.reduce((total, entry) => total - entry.amount, 0),
        85,
        'expiring 40 (A) + 20 (B) + 25 (C)',
      )

      // Redemptions survived the close and can still be resolved.
      assert.equal(
        await db.supermarketRedemption.count({ where: { periodId: period.id } }),
        3,
      )
      const resolvedAfterClose = await serializable(db, (tx) =>
        resolveSupermarketRedemption(tx, {
          redemptionId: pendingAcrossClose.redemption.id,
          resolution: 'FULFILLED',
          actorId: adminId,
        }),
      )
      assert.equal(resolvedAfterClose.status, 'FULFILLED')

      // An already-resolved redemption still cannot be re-resolved.
      const lateVoid = await serializable(db, (tx) =>
        resolveSupermarketRedemption(tx, {
          redemptionId: pendingAcrossClose.redemption.id,
          resolution: 'VOIDED',
          actorId: adminId,
        }).catch((error: unknown) => error),
      )
      assert.ok(lateVoid instanceof SupermarketError)
      assert.equal(lateVoid.code, 'REDEMPTION_ALREADY_RESOLVED')

      // With the period closed, redemption and adjustment are refused.
      await assert.rejects(
        () =>
          serializable(db, (tx) =>
            redeemSupermarketPrize(tx, {
              userId: memberC,
              prizeId: unlimitedPrize.id,
            }),
          ),
        (error: unknown) =>
          error instanceof SupermarketError && error.code === 'NO_OPEN_PERIOD',
      )
      await assert.rejects(
        () =>
          serializable(db, (tx) =>
            adjustSupermarketPoints(tx, {
              userId: memberC,
              amount: 5,
              reason: '关期后调整',
              actorId: adminId,
            }),
          ),
        (error: unknown) =>
          error instanceof SupermarketError && error.code === 'NO_OPEN_PERIOD',
      )

      // --- the next round starts empty --------------------------------------
      const secondPeriod = await serializable(db, (tx) => openSupermarketPeriod(tx))
      assert.equal(secondPeriod.sequence, 2)

      // A stale admin form cannot mutate a closed period, even with a new
      // period open. Verify every editable field and deletion independently.
      await assert.rejects(
        () => serializable(db, (tx) => createSupermarketPrize(tx, {
          periodId: period.id,
          name: '过期表单新增',
          pointsCost: 1,
          stock: null,
        })),
        (error: unknown) => error instanceof SupermarketError && error.code === 'PERIOD_CLOSED',
      )
      for (const change of [
        { name: '过期表单改名' },
        { description: '过期表单改说明' },
        { description: null },
        { pointsCost: 1 },
        { stock: 100 },
        { status: 'WITHDRAWN' as const },
      ]) {
        await assert.rejects(
          () => serializable(db, (tx) => updateSupermarketPrize(tx, {
            prizeId: frozenPrize.id,
            ...change,
          })),
          (error: unknown) => error instanceof SupermarketError && error.code === 'PERIOD_CLOSED',
        )
      }
      await assert.rejects(
        () => serializable(db, (tx) => deleteSupermarketPrize(tx, frozenPrize.id)),
        (error: unknown) => error instanceof SupermarketError && error.code === 'PERIOD_CLOSED',
      )
      assert.deepEqual(
        await db.supermarketPrize.findUnique({ where: { id: frozenPrize.id } }),
        frozenPrize,
      )
      assert.equal(
        await db.supermarketPrize.count({ where: { periodId: secondPeriod.id } }),
        0,
        'a new period must not inherit prizes',
      )
      const walletInNewPeriod = await serializable(db, (tx) =>
        readSupermarketWallet(tx, { userId: memberA }),
      )
      assert.equal(walletInNewPeriod.balance, 0)
    } finally {
      await db.user.deleteMany({
        where: { id: { in: [adminId, memberA, memberB, memberC] } },
      })
      const leftovers = await db.supermarketPeriod.findMany({
        where: { sequence: { in: [1, 2] } },
        select: { id: true },
      })
      await cleanupPeriods(
        db,
        leftovers.map((period) => period.id),
      )
      await db.$disconnect()
    }
  },
)

test(
  'concurrent redemptions of the last unit never oversell',
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl
    const db = new PrismaClient()
    const suffix = randomUUID().replaceAll('-', '')
    const adminId = `sm-race-admin-${suffix}`
    const racers = [`sm-race-1-${suffix}`, `sm-race-2-${suffix}`]

    try {
      const verifiedAt = new Date('2026-09-01T00:00:00Z')
      await db.user.createMany({
        data: [
          {
            id: adminId,
            email: `${adminId}@example.test`,
            nickname: 'Race admin',
            role: 'admin',
            emailVerifiedAt: verifiedAt,
          },
          ...racers.map((id) => ({
            id,
            email: `${id}@example.test`,
            nickname: id,
            points: 0,
            emailVerifiedAt: verifiedAt,
          })),
        ],
      })

      const period = await serializable(db, (tx) => openSupermarketPeriod(tx))
      for (const id of racers) {
        await serializable(db, (tx) =>
          adjustSupermarketPoints(tx, {
            userId: id,
            amount: 100,
            reason: '测试预置积分',
            actorId: adminId,
          }),
        )
      }
      const prize = await serializable(db, (tx) =>
        createSupermarketPrize(tx, {
          periodId: period.id,
          name: '唯一奖品',
          pointsCost: 10,
          stock: 1,
        }),
      )

      const results = await Promise.allSettled(
        racers.map((userId) =>
          serializable(db, (tx) =>
            redeemSupermarketPrize(tx, { userId, prizeId: prize.id }),
          ),
        ),
      )

      const succeeded = results.filter((result) => result.status === 'fulfilled')
      const failed = results.filter((result) => result.status === 'rejected')
      assert.equal(succeeded.length, 1, 'exactly one racer may win')
      assert.equal(failed.length, 1)
      assert.equal(
        (
          await db.supermarketPrize.findUnique({
            where: { id: prize.id },
            select: { stock: true },
          })
        )?.stock,
        0,
      )
      assert.equal(
        await db.supermarketRedemption.count({ where: { prizeId: prize.id } }),
        1,
      )

      // The loser must not have been charged.
      const loserId = racers.find(
        (_, index) => results[index].status === 'rejected',
      )!
      const loserWallet = await db.supermarketBalance.findUnique({
        where: {
          userId_periodId: { userId: loserId, periodId: period.id },
        },
        select: { balance: true },
      })
      assert.equal(loserWallet?.balance, 100)
    } finally {
      await db.user.deleteMany({
        where: { id: { in: [adminId, ...racers] } },
      })
      const leftovers = await db.supermarketPeriod.findMany({
        where: { sequence: 1 },
        select: { id: true },
      })
      await cleanupPeriods(
        db,
        leftovers.map((period) => period.id),
      )
      await db.$disconnect()
    }
  },
)

test(
  'void refunds are atomic, issued once, and stay within their original open period',
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    const db = new PrismaClient({ datasourceUrl: integrationDatabaseUrl })
    const suffix = randomUUID().replaceAll('-', '')
    const adminId = `sm-refund-admin-${suffix}`
    const userId = `sm-refund-member-${suffix}`
    const periodIds: string[] = []

    // Competing close/void requests can legitimately abort under Serializable.
    // Retrying an aborted transaction must preserve exactly-once refunds.
    async function retrySerializable<T>(run: (tx: Prisma.TransactionClient) => Promise<T>) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await serializable(db, run)
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError) ||
            error.code !== 'P2034' || attempt >= 2) throw error
        }
      }
    }

    try {
      await db.user.createMany({
        data: [
          { id: adminId, email: `${adminId}@example.test`, nickname: 'Refund admin', role: 'admin' },
          { id: userId, email: `${userId}@example.test`, nickname: 'Refund member' },
        ],
      })
      const period = await serializable(db, (tx) => openSupermarketPeriod(tx))
      periodIds.push(period.id)
      await serializable(db, (tx) => adjustSupermarketPoints(tx, {
        userId, amount: 100, reason: '测试预置积分', actorId: adminId,
      }))
      const prize = await serializable(db, (tx) => createSupermarketPrize(tx, {
        periodId: period.id, name: '退分测试奖品', pointsCost: 10, stock: 5,
      }))
      const redemptionIds: string[] = []
      for (let i = 0; i < 4; i += 1) {
        redemptionIds.push((await serializable(db, (tx) =>
          redeemSupermarketPrize(tx, { userId, prizeId: prize.id }),
        )).redemption.id)
      }

      // A failure after crediting the wallet rolls the credit and ledger back.
      await assert.rejects(
        () => serializable(db, (tx) => resolveSupermarketRedemption(tx, {
          redemptionId: redemptionIds[0], resolution: 'VOIDED', actorId: `missing-${suffix}`,
        })),
        (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003',
      )
      assert.equal((await readSupermarketWallet(db, { userId })).balance, 60)
      assert.equal((await db.supermarketRedemption.findUnique({
        where: { id: redemptionIds[0] },
      }))?.status, 'PENDING')
      assert.equal(await db.supermarketBalanceEntry.count({
        where: { balance: { userId }, reason: { startsWith: '兑换未履行，自动退分：' } },
      }), 0)

      // Two admins attempting the same void can credit the member only once.
      const resolutions = await Promise.allSettled([0, 1].map(() =>
        serializable(db, (tx) => resolveSupermarketRedemption(tx, {
          redemptionId: redemptionIds[0], resolution: 'VOIDED', actorId: adminId,
        })),
      ))
      assert.equal(resolutions.filter((result) => result.status === 'fulfilled').length, 1)
      const successful = resolutions.find((result) => result.status === 'fulfilled')!
      assert.equal(successful.status === 'fulfilled' && successful.value.refundedPoints, 10)
      assert.equal((await readSupermarketWallet(db, { userId })).balance, 70)
      const refundEntries = await db.supermarketBalanceEntry.findMany({
        where: { balance: { userId }, reason: { startsWith: '兑换未履行，自动退分：' } },
      })
      assert.equal(refundEntries.length, 1)
      assert.equal(refundEntries[0].amount, 10)
      assert.equal(refundEntries[0].balanceAfter, 70)
      assert.equal(refundEntries[0].actorId, adminId)
      assert.ok(refundEntries[0].reason.includes(redemptionIds[0]))
      await assert.rejects(
        () => serializable(db, (tx) => resolveSupermarketRedemption(tx, {
          redemptionId: redemptionIds[0], resolution: 'VOIDED', actorId: adminId,
        })),
        (error: unknown) => error instanceof SupermarketError && error.code === 'REDEMPTION_ALREADY_RESOLVED',
      )
      const fulfilled = await serializable(db, (tx) => resolveSupermarketRedemption(tx, {
        redemptionId: redemptionIds[1], resolution: 'FULFILLED', actorId: adminId,
      }))
      assert.equal(fulfilled.refundedPoints, 0)
      assert.equal((await readSupermarketWallet(db, { userId })).balance, 70)

      // Whether voiding wins the race or closing wins, no balance can survive
      // closure and every credited/expired point remains in the ledger.
      await Promise.all([
        retrySerializable((tx) => closeSupermarketPeriod(tx)),
        retrySerializable((tx) => resolveSupermarketRedemption(tx, {
          redemptionId: redemptionIds[3], resolution: 'VOIDED', actorId: adminId,
        })),
      ])
      const closedWallet = await db.supermarketBalance.findUniqueOrThrow({
        where: { userId_periodId: { userId, periodId: period.id } },
      })
      assert.equal(closedWallet.balance, 0)
      const ledger = await db.supermarketBalanceEntry.aggregate({
        where: { balanceId: closedWallet.id }, _sum: { amount: true },
      })
      assert.equal(ledger._sum.amount, 0)

      const nextPeriod = await serializable(db, (tx) => openSupermarketPeriod(tx))
      periodIds.push(nextPeriod.id)
      await serializable(db, (tx) => adjustSupermarketPoints(tx, {
        userId, amount: 5, reason: '新期测试预置', actorId: adminId,
      }))
      const historicalVoid = await serializable(db, (tx) => resolveSupermarketRedemption(tx, {
        redemptionId: redemptionIds[2], resolution: 'VOIDED', actorId: adminId,
      }))
      assert.equal(historicalVoid.status, 'VOIDED')
      assert.equal(historicalVoid.refundedPoints, 0)
      assert.equal((await readSupermarketWallet(db, { userId })).balance, 5)
      assert.equal((await db.supermarketBalance.findUniqueOrThrow({
        where: { id: closedWallet.id },
      })).balance, 0)
      assert.equal((await db.supermarketPrize.findUniqueOrThrow({
        where: { id: prize.id },
      })).stock, 1, 'voiding never restores stock')
    } finally {
      await cleanupPeriods(db, periodIds)
      await db.user.deleteMany({ where: { id: { in: [adminId, userId] } } })
      await db.$disconnect()
    }
  },
)
