export const QUICK_MATCH_VOID_DESCRIPTION = '由快速比赛功能创建（已作废）'

export type QuickResultState = 'pending' | 'confirmed' | 'invalidated'

export function getQuickResultState(result: {
  confirmed: boolean
  score: unknown
  match: { description: string | null }
}): QuickResultState {
  if (result.confirmed) return 'confirmed'

  if (result.match.description === QUICK_MATCH_VOID_DESCRIPTION) {
    return 'invalidated'
  }

  if (
    result.score &&
    typeof result.score === 'object' &&
    !Array.isArray(result.score) &&
    'invalidReason' in result.score
  ) {
    return 'invalidated'
  }

  return 'pending'
}
