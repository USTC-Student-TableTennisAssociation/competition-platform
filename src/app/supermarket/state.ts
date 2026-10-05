export type SupermarketMemberPrize = {
  id: string
  name: string
  description: string | null
  pointsCost: number
  stock: number | null
  affordable: boolean
  soldOut: boolean
}

export type SupermarketMemberRedemption = {
  id: string
  periodSequence: number
  prizeName: string
  pointsSpent: number
  status: 'PENDING' | 'FULFILLED' | 'VOIDED'
  createdAt: string
  resolvedAt: string | null
}

export type SupermarketMemberState = {
  signedIn: boolean
  periodSequence: number | null
  balance: number | null
  matchPoints: number | null
  prizes: SupermarketMemberPrize[]
  redemptions: SupermarketMemberRedemption[]
  error?: string
  success?: string
}

export const INITIAL_SUPERMARKET_MEMBER_STATE: SupermarketMemberState = {
  signedIn: false,
  periodSequence: null,
  balance: null,
  matchPoints: null,
  prizes: [],
  redemptions: [],
}
