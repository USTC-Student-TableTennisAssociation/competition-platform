'use server'

import { revalidatePath } from 'next/cache'

import { getCurrentUser } from '@/lib/auth'
import { validateCsrfToken } from '@/lib/csrf'
import { prisma } from '@/lib/prisma'
import { supermarketErrorMessage } from '@/lib/server/supermarket/errors'
import {
  readSupermarketWallet,
  redeemSupermarketPrize,
} from '@/lib/server/supermarket/service'

import {
  INITIAL_SUPERMARKET_MEMBER_STATE,
  type SupermarketMemberState,
} from './state'

async function fetchMemberData(
  userId: string,
): Promise<Omit<SupermarketMemberState, 'signedIn'>> {
  const openPeriod = await prisma.supermarketPeriod.findFirst({
    where: { status: 'OPEN' },
    orderBy: { openedAt: 'desc' },
    select: { id: true, sequence: true },
  })

  const [wallet, user, prizes, redemptions] = await Promise.all([
    openPeriod ? readSupermarketWallet(prisma, { userId }) : Promise.resolve(null),
    prisma.user.findUnique({
      where: { id: userId },
      select: { points: true },
    }),
    openPeriod
      ? prisma.supermarketPrize.findMany({
          where: { periodId: openPeriod.id, status: 'ACTIVE' },
          orderBy: [{ pointsCost: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true,
            name: true,
            description: true,
            pointsCost: true,
            stock: true,
          },
        })
      : Promise.resolve([]),
    prisma.supermarketRedemption.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        prizeName: true,
        pointsSpent: true,
        status: true,
        createdAt: true,
        resolvedAt: true,
        period: { select: { sequence: true } },
      },
    }),
  ])

  const balance = wallet?.balance ?? null

  return {
    periodSequence: openPeriod?.sequence ?? null,
    balance,
    matchPoints: user?.points ?? null,
    prizes: prizes.map((prize) => ({
      id: prize.id,
      name: prize.name,
      description: prize.description,
      pointsCost: prize.pointsCost,
      stock: prize.stock,
      affordable: balance !== null && balance >= prize.pointsCost,
      soldOut: prize.stock !== null && prize.stock <= 0,
    })),
    redemptions: redemptions.map((redemption) => ({
      id: redemption.id,
      periodSequence: redemption.period.sequence,
      prizeName: redemption.prizeName,
      pointsSpent: redemption.pointsSpent,
      status: redemption.status,
      createdAt: redemption.createdAt.toISOString(),
      resolvedAt: redemption.resolvedAt?.toISOString() ?? null,
    })),
  }
}

export async function supermarketMemberAction(
  prev: SupermarketMemberState,
  formData: FormData,
): Promise<SupermarketMemberState> {
  const intent = String(formData.get('intent') ?? '')

  const currentUser = await getCurrentUser()
  if (!currentUser) {
    return { ...INITIAL_SUPERMARKET_MEMBER_STATE, error: '请先登录。' }
  }

  if (intent === 'bootstrap') {
    const data = await fetchMemberData(currentUser.id)
    return { signedIn: true, ...data }
  }

  const csrfError = await validateCsrfToken(formData)
  if (csrfError) {
    return { ...prev, error: csrfError }
  }

  try {
    if (intent !== 'redeem') {
      return { ...prev, error: '未知操作。' }
    }

    const prizeId = String(formData.get('prizeId') ?? '')
    // The redeeming member always comes from the session, never the form.
    const result = await prisma.$transaction(
      (tx) => redeemSupermarketPrize(tx, { userId: currentUser.id, prizeId }),
      { isolationLevel: 'Serializable', maxWait: 5_000, timeout: 30_000 },
    )

    revalidatePath('/supermarket')

    const data = await fetchMemberData(currentUser.id)
    return {
      signedIn: true,
      ...data,
      success: `兑换成功，剩余 ${result.balanceAfter} 分。奖品将在核实后发放。`,
    }
  } catch (error) {
    const data = await fetchMemberData(currentUser.id)
    return { signedIn: true, ...data, error: supermarketErrorMessage(error) }
  }
}
