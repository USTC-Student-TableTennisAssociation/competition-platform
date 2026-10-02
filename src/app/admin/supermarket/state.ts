export type SupermarketPrizeView = {
  id: string
  name: string
  description: string | null
  pointsCost: number
  stock: number | null
  status: 'ACTIVE' | 'WITHDRAWN'
  redemptionCount: number
}

export type SupermarketRedemptionView = {
  id: string
  periodSequence: number
  userId: string
  memberNickname: string
  memberEmail: string
  prizeName: string
  pointsSpent: number
  status: 'PENDING' | 'FULFILLED' | 'VOIDED'
  createdAt: string
  resolvedAt: string | null
}

export type SupermarketPeriodView = {
  id: string
  sequence: number
  status: 'OPEN' | 'CLOSED'
  openedAt: string
  closedAt: string | null
}

export type SupermarketAdjustmentView = {
  id: string
  memberNickname: string
  memberEmail: string
  amount: number
  balanceAfter: number
  reason: string
  createdAt: string
}

export type SupermarketAdminState = {
  unlocked: boolean
  error?: string
  success?: string
  openPeriod: SupermarketPeriodView | null
  lastClosedPeriod: SupermarketPeriodView | null
  prizes: SupermarketPrizeView[]
  redemptions: SupermarketRedemptionView[]
  adjustments: SupermarketAdjustmentView[]
  pendingCount: number
  totalBalanceInPeriod: number
  memberCountInPeriod: number
}

export const INITIAL_SUPERMARKET_ADMIN_STATE: SupermarketAdminState = {
  unlocked: false,
  openPeriod: null,
  lastClosedPeriod: null,
  prizes: [],
  redemptions: [],
  adjustments: [],
  pendingCount: 0,
  totalBalanceInPeriod: 0,
  memberCountInPeriod: 0,
}
