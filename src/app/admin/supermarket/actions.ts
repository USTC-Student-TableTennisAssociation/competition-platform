'use server'

import { revalidatePath } from 'next/cache'

import { getAuditContext, writeAuditLog } from '@/lib/audit-log'
import { validateCsrfToken } from '@/lib/csrf'
import { prisma } from '@/lib/prisma'
import { getAdminIdentity, isAdminReauthed } from '@/lib/server/admin/guard'
import { SupermarketError, supermarketErrorMessage } from '@/lib/server/supermarket/errors'
import {
  adjustSupermarketPoints,
  closeSupermarketPeriod,
  createSupermarketPrize,
  deleteSupermarketPrize,
  openSupermarketPeriod,
  resolveSupermarketRedemption,
  settleMatchPointsIntoSupermarket,
  updateSupermarketPrize,
} from '@/lib/server/supermarket/service'

import {
  INITIAL_SUPERMARKET_ADMIN_STATE,
  type SupermarketAdminState,
  type SupermarketPeriodView,
} from './state'

const MAX_PAGE_REDEMPTIONS = 200
const MAX_PAGE_ADJUSTMENTS = 100

async function fetchSupermarketAdminData(): Promise<Omit<SupermarketAdminState, 'unlocked'>> {
  const openPeriod = await prisma.supermarketPeriod.findFirst({
    where: { status: 'OPEN' },
    orderBy: { openedAt: 'desc' },
  })

  const lastClosedPeriod = await prisma.supermarketPeriod.findFirst({
    where: { status: 'CLOSED' },
    orderBy: { closedAt: 'desc' },
  })

  const [prizes, redemptions, adjustments, walletSummary, pendingCount] =
    await Promise.all([
      openPeriod
        ? prisma.supermarketPrize.findMany({
            where: { periodId: openPeriod.id },
            orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
            select: {
              id: true,
              name: true,
              description: true,
              pointsCost: true,
              stock: true,
              status: true,
              _count: { select: { redemptions: true } },
            },
          })
        : Promise.resolve([]),
      prisma.supermarketRedemption.findMany({
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        take: MAX_PAGE_REDEMPTIONS,
        select: {
          id: true,
          userId: true,
          prizeName: true,
          pointsSpent: true,
          status: true,
          createdAt: true,
          resolvedAt: true,
          period: { select: { sequence: true } },
          user: { select: { nickname: true, email: true } },
        },
      }),
      prisma.supermarketBalanceEntry.findMany({
        where: { type: 'ADMIN_ADJUSTMENT', amount: { not: 0 } },
        orderBy: { createdAt: 'desc' },
        take: MAX_PAGE_ADJUSTMENTS,
        select: {
          id: true,
          amount: true,
          balanceAfter: true,
          reason: true,
          createdAt: true,
          balance: {
            select: { user: { select: { nickname: true, email: true } } },
          },
        },
      }),
      openPeriod
        ? prisma.supermarketBalance.aggregate({
            where: { periodId: openPeriod.id },
            _sum: { balance: true },
            _count: { _all: true },
          })
        : Promise.resolve({ _sum: { balance: 0 }, _count: { _all: 0 } }),
      prisma.supermarketRedemption.count({ where: { status: 'PENDING' } }),
    ])

  const toPeriodView = (
    period: typeof openPeriod,
  ): SupermarketPeriodView | null =>
    period
      ? {
          id: period.id,
          sequence: period.sequence,
          status: period.status,
          openedAt: period.openedAt.toISOString(),
          closedAt: period.closedAt?.toISOString() ?? null,
        }
      : null

  return {
    openPeriod: toPeriodView(openPeriod),
    lastClosedPeriod: toPeriodView(lastClosedPeriod),
    prizes: prizes.map((prize) => ({
      id: prize.id,
      name: prize.name,
      description: prize.description,
      pointsCost: prize.pointsCost,
      stock: prize.stock,
      status: prize.status,
      redemptionCount: prize._count.redemptions,
    })),
    redemptions: redemptions.map((redemption) => ({
      id: redemption.id,
      periodSequence: redemption.period.sequence,
      userId: redemption.userId,
      memberNickname: redemption.user.nickname,
      memberEmail: redemption.user.email,
      prizeName: redemption.prizeName,
      pointsSpent: redemption.pointsSpent,
      status: redemption.status,
      createdAt: redemption.createdAt.toISOString(),
      resolvedAt: redemption.resolvedAt?.toISOString() ?? null,
    })),
    adjustments: adjustments.map((entry) => ({
      id: entry.id,
      memberNickname: entry.balance.user.nickname,
      memberEmail: entry.balance.user.email,
      amount: entry.amount,
      balanceAfter: entry.balanceAfter,
      reason: entry.reason,
      createdAt: entry.createdAt.toISOString(),
    })),
    pendingCount,
    totalBalanceInPeriod: walletSummary._sum.balance ?? 0,
    memberCountInPeriod: walletSummary._count._all,
  }
}

/**
 * Every supermarket write re-derives the admin from the session, validates
 * CSRF, and requires the same email reauth as the main console. The client can
 * never supply its own actor, period, or price.
 */
async function guardedAdmin() {
  const admin = await getAdminIdentity()
  if (!admin.ok) return { ok: false as const, error: admin.error }

  const reauthed = await isAdminReauthed(admin.userId)
  if (!reauthed) {
    return {
      ok: false as const,
      error: '管理员二次认证已失效，请先在控制台重新验证。',
    }
  }

  return { ok: true as const, userId: admin.userId }
}

function serializableTransaction<T>(
  run: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>,
) {
  return prisma.$transaction(run, {
    isolationLevel: 'Serializable',
    maxWait: 5_000,
    timeout: 60_000,
  })
}

export async function supermarketAdminAction(
  prev: SupermarketAdminState,
  formData: FormData,
): Promise<SupermarketAdminState> {
  const intent = String(formData.get('intent') ?? '')

  // Bootstrap is read-only and does not require CSRF, matching the main console.
  if (intent === 'bootstrap') {
    const admin = await getAdminIdentity()
    if (!admin.ok) {
      return { ...INITIAL_SUPERMARKET_ADMIN_STATE, error: admin.error }
    }
    const reauthed = await isAdminReauthed(admin.userId)
    if (!reauthed) {
      return {
        ...INITIAL_SUPERMARKET_ADMIN_STATE,
        error: '请先在控制台完成管理员二次验证。',
      }
    }
    const data = await fetchSupermarketAdminData()
    return { unlocked: true, ...data }
  }

  const csrfError = await validateCsrfToken(formData)
  if (csrfError) {
    return { ...prev, error: csrfError }
  }

  const guard = await guardedAdmin()
  if (!guard.ok) {
    return { ...INITIAL_SUPERMARKET_ADMIN_STATE, error: guard.error }
  }

  const actorId = guard.userId
  const auditContext = await getAuditContext()

  const finish = async (success: string): Promise<SupermarketAdminState> => {
    const data = await fetchSupermarketAdminData()
    return { unlocked: true, success, ...data }
  }

  try {
    switch (intent) {
      case 'openPeriod': {
        const period = await serializableTransaction((tx) =>
          openSupermarketPeriod(tx),
        )
        await writeAuditLog({
          actorId,
          action: 'supermarket.period.open',
          entityType: 'SupermarketPeriod',
          entityId: period.id,
          details: { sequence: period.sequence },
          ...auditContext,
        })
        revalidatePath('/admin/supermarket')
        revalidatePath('/supermarket')
        return finish(`已开启第 ${period.sequence} 期积分超市。`)
      }

      case 'closePeriod': {
        const result = await serializableTransaction((tx) =>
          closeSupermarketPeriod(tx),
        )
        await writeAuditLog({
          actorId,
          action: 'supermarket.period.close',
          entityType: 'SupermarketPeriod',
          entityId: result.period.id,
          details: {
            sequence: result.period.sequence,
            expiredPoints: result.expiredPoints,
            affectedUserCount: result.affectedUserCount,
          },
          ...auditContext,
        })
        revalidatePath('/admin/supermarket')
        revalidatePath('/supermarket')
        return finish(
          `已关闭第 ${result.period.sequence} 期，作废 ${result.expiredPoints} 分。`,
        )
      }

      case 'settle': {
        const result = await serializableTransaction((tx) =>
          settleMatchPointsIntoSupermarket(tx, { actorId }),
        )
        await writeAuditLog({
          actorId,
          action: 'supermarket.settle',
          entityType: 'SupermarketPeriod',
          entityId: result.period.id,
          details: {
            sequence: result.period.sequence,
            userCount: result.userCount,
            totalPoints: result.totalPoints,
          },
          ...auditContext,
        })
        revalidatePath('/admin/supermarket')
        revalidatePath('/supermarket')
        revalidatePath('/rankings')
        return finish(
          `结算完成，${result.userCount} 人共转入 ${result.totalPoints} 分，比赛积分已归零。`,
        )
      }

      case 'createPrize': {
        const name = String(formData.get('name') ?? '').trim()
        const description = String(formData.get('description') ?? '').trim()
        const pointsCost = Number(formData.get('pointsCost'))
        const stockRaw = String(formData.get('stock') ?? '').trim()
        const stock = stockRaw === '' ? null : Number(stockRaw)

        const period = await prisma.supermarketPeriod.findFirst({
          where: { status: 'OPEN' },
          select: { id: true },
        })
        if (!period) {
          throw new SupermarketError('NO_OPEN_PERIOD', 'No open period.')
        }

        const prize = await serializableTransaction((tx) =>
          createSupermarketPrize(tx, {
            periodId: period.id,
            name,
            description: description === '' ? null : description,
            pointsCost,
            stock,
          }),
        )
        await writeAuditLog({
          actorId,
          action: 'supermarket.prize.create',
          entityType: 'SupermarketPrize',
          entityId: prize.id,
          details: { name: prize.name, pointsCost: prize.pointsCost, stock: prize.stock },
          ...auditContext,
        })
        revalidatePath('/admin/supermarket')
        revalidatePath('/supermarket')
        return finish(`已添加奖品「${prize.name}」。`)
      }

      case 'updatePrize': {
        const prizeId = String(formData.get('prizeId') ?? '')
        const name = String(formData.get('name') ?? '').trim()
        const pointsCost = Number(formData.get('pointsCost'))
        const stockRaw = String(formData.get('stock') ?? '').trim()
        const stock = stockRaw === '' ? null : Number(stockRaw)
        const statusRaw = String(formData.get('status') ?? '')
        const status =
          statusRaw === 'ACTIVE' || statusRaw === 'WITHDRAWN' ? statusRaw : undefined

        const prize = await serializableTransaction((tx) =>
          updateSupermarketPrize(tx, {
            prizeId,
            name,
            pointsCost,
            stock,
            status,
          }),
        )
        await writeAuditLog({
          actorId,
          action: 'supermarket.prize.update',
          entityType: 'SupermarketPrize',
          entityId: prize.id,
          details: {
            name: prize.name,
            pointsCost: prize.pointsCost,
            stock: prize.stock,
            status: prize.status,
          },
          ...auditContext,
        })
        revalidatePath('/admin/supermarket')
        revalidatePath('/supermarket')
        return finish(`已更新奖品「${prize.name}」。`)
      }

      case 'togglePrizeStatus': {
        const prizeId = String(formData.get('prizeId') ?? '')
        const nextStatus =
          String(formData.get('status') ?? '') === 'ACTIVE' ? 'ACTIVE' : 'WITHDRAWN'
        const prize = await serializableTransaction((tx) =>
          updateSupermarketPrize(tx, { prizeId, status: nextStatus }),
        )
        await writeAuditLog({
          actorId,
          action: 'supermarket.prize.update',
          entityType: 'SupermarketPrize',
          entityId: prize.id,
          details: { name: prize.name, status: prize.status },
          ...auditContext,
        })
        revalidatePath('/admin/supermarket')
        revalidatePath('/supermarket')
        return finish(
          nextStatus === 'ACTIVE'
            ? `已重新上架「${prize.name}」。`
            : `已下架「${prize.name}」。`,
        )
      }

      case 'deletePrize': {
        const prizeId = String(formData.get('prizeId') ?? '')
        const result = await serializableTransaction((tx) =>
          deleteSupermarketPrize(tx, prizeId),
        )
        await writeAuditLog({
          actorId,
          action: 'supermarket.prize.delete',
          entityType: 'SupermarketPrize',
          entityId: result.deletedPrizeId,
          details: {},
          ...auditContext,
        })
        revalidatePath('/admin/supermarket')
        revalidatePath('/supermarket')
        return finish('奖品已删除。')
      }

      case 'resolveRedemption': {
        const redemptionId = String(formData.get('redemptionId') ?? '')
        const resolution =
          String(formData.get('resolution') ?? '') === 'VOIDED'
            ? 'VOIDED'
            : 'FULFILLED'

        const redemption = await serializableTransaction((tx) =>
          resolveSupermarketRedemption(tx, {
            redemptionId,
            resolution,
            actorId,
          }),
        )
        await writeAuditLog({
          actorId,
          action:
            resolution === 'FULFILLED'
              ? 'supermarket.redemption.fulfill'
              : 'supermarket.redemption.void',
          entityType: 'SupermarketRedemption',
          entityId: redemption.id,
          details: {
            prizeName: redemption.prizeName,
            pointsSpent: redemption.pointsSpent,
            userId: redemption.userId,
            refundedPoints: redemption.refundedPoints,
          },
          ...auditContext,
        })
        revalidatePath('/admin/supermarket')
        revalidatePath('/supermarket')
        return finish(
          resolution === 'FULFILLED'
            ? '已标记为已发放。'
            : redemption.refundedPoints > 0
              ? `已标记为已作废，退回 ${redemption.refundedPoints} 分。库存如需恢复，请手工调整。`
              : '已标记为已作废。原期次已关闭，积分不自动退回；如需补偿，请手工处理。',
        )
      }

      case 'adjustPoints': {
        const userId = String(formData.get('userId') ?? '')
        const amount = Number(formData.get('amount'))
        const reason = String(formData.get('reason') ?? '').trim()

        const result = await serializableTransaction((tx) =>
          adjustSupermarketPoints(tx, { userId, amount, reason, actorId }),
        )
        await writeAuditLog({
          actorId,
          action: 'supermarket.points.adjust',
          entityType: 'User',
          entityId: userId,
          details: { amount, reason, balanceAfter: result.balanceAfter },
          ...auditContext,
        })
        revalidatePath('/admin/supermarket')
        revalidatePath('/supermarket')
        return finish(
          `已调整积分 ${amount > 0 ? '+' : ''}${amount}，当前余额 ${result.balanceAfter} 分。`,
        )
      }

      default:
        return { ...prev, error: '未知操作。' }
    }
  } catch (error) {
    if (!(error instanceof SupermarketError)) {
      console.error('supermarketAdminAction failed', error)
    }
    const data = await fetchSupermarketAdminData()
    return {
      unlocked: true,
      error: supermarketErrorMessage(error),
      ...data,
    }
  }
}
