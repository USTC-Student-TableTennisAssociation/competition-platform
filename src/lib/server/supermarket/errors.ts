export type SupermarketErrorCode =
  | 'NO_OPEN_PERIOD'
  | 'PERIOD_ALREADY_OPEN'
  | 'PERIOD_NOT_OPEN'
  | 'PERIOD_CLOSED'
  | 'PRIZE_NOT_FOUND'
  | 'PRIZE_NOT_AVAILABLE'
  | 'PRIZE_SOLD_OUT'
  | 'INSUFFICIENT_POINTS'
  | 'REDEMPTION_NOT_FOUND'
  | 'REDEMPTION_ALREADY_RESOLVED'
  | 'INVALID_AMOUNT'
  | 'INVALID_REASON'
  | 'INVALID_PRIZE'
  | 'USER_NOT_FOUND'
  | 'SETTLEMENT_STATE_CONFLICT'

export class SupermarketError extends Error {
  readonly code: SupermarketErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: SupermarketErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'SupermarketError'
    this.code = code
    this.details = Object.freeze({ ...details })
  }
}

export function isSupermarketError(error: unknown): error is SupermarketError {
  return error instanceof SupermarketError
}

/**
 * Messages are user-facing and deliberately concrete: a member who cannot
 * afford a prize should learn how many points they are short, not just that
 * the operation failed.
 */
export function supermarketErrorMessage(error: unknown): string {
  if (!isSupermarketError(error)) {
    return '操作失败，请稍后重试。'
  }

  switch (error.code) {
    case 'NO_OPEN_PERIOD':
      return '当前没有开放的积分超市。'
    case 'PERIOD_ALREADY_OPEN':
      return '已有一期积分超市处于开放状态，请先关闭后再开启新一期。'
    case 'PERIOD_NOT_OPEN':
    case 'PERIOD_CLOSED':
      return '本期积分超市已结束，无法再兑换。'
    case 'PRIZE_NOT_FOUND':
      return '奖品不存在。'
    case 'PRIZE_NOT_AVAILABLE':
      return '该奖品已下架。'
    case 'PRIZE_SOLD_OUT':
      return '该奖品已兑完。'
    case 'INSUFFICIENT_POINTS':
      return `积分不足，还差 ${error.details.shortfall ?? 0} 分。`
    case 'REDEMPTION_NOT_FOUND':
      return '兑换记录不存在。'
    case 'REDEMPTION_ALREADY_RESOLVED':
      return '该兑换记录已经处理过了。'
    case 'INVALID_AMOUNT':
      return '调整积分不能为 0。'
    case 'INVALID_REASON':
      return '请填写原因。'
    case 'INVALID_PRIZE':
      return '奖品信息不合法。'
    case 'USER_NOT_FOUND':
      return '用户不存在。'
    case 'SETTLEMENT_STATE_CONFLICT':
      return '结算状态异常，请刷新后重试。'
    default:
      return '操作失败，请稍后重试。'
  }
}
