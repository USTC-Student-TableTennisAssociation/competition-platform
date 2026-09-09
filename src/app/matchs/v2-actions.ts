'use server'

import { createRosterManagementHandler, type RosterManagementState } from '@/modules/competitions-v2/adapters/roster-management'
import { revalidatePath } from 'next/cache'

import { getCurrentUser } from '@/lib/auth'
import { validateCsrfToken } from '@/lib/csrf'
import { prisma } from '@/lib/prisma'
import {
  createV2SingleActionHandlers,
  type V2SingleActionState,
} from '@/modules/competitions-v2/adapters/single-actions'
import {
  createV2MatchSettingsHandler,
  type V2SingleMatchSettingsState,
} from '@/modules/competitions-v2/adapters/single-match-settings'
import { createV2SingleServerActionBindings } from '@/modules/competitions-v2/adapters/single-server-actions'
import {
  createV2DoubleActionHandlers,
  type V2DoubleActionState,
} from '@/modules/competitions-v2/adapters/double-actions'
import {
  createV2TeamGroupingActionHandlers,
  type V2TeamGroupingActionState,
} from '@/modules/competitions-v2/adapters/team-grouping-actions'
import {
  createV2TeamResultActionHandlers,
  type V2TeamResultActionState,
} from '@/modules/competitions-v2/adapters/team-result-actions'
import {
  createV2GroupStageFinalizationActionHandler,
  type V2GroupStageFinalizationActionState,
} from '@/modules/competitions-v2/adapters/group-stage-finalization-actions'
import {
  createV2KnockoutResultActionHandlers,
  V2_DOUBLE_KNOCKOUT_RESULT_ACTION_PROFILE,
  V2_SINGLE_KNOCKOUT_RESULT_ACTION_PROFILE,
  V2_TEAM_KNOCKOUT_RESULT_ACTION_PROFILE,
  type V2KnockoutResultActionState,
} from '@/modules/competitions-v2/adapters/knockout-result-actions'
import {
  createV2EntryDisqualificationActionHandler,
  createV2EntryWithdrawalActionHandler,
  type V2EntryDisqualificationActionState,
} from '@/modules/competitions-v2/adapters/entry-disqualification-actions'
import {
  createV2KnockoutTableLabelsActionHandler,
  type V2KnockoutTableLabelsActionState,
} from '@/modules/competitions-v2/adapters/knockout-table-labels-actions'

function safeLogV2SingleActionError(message: string, error: unknown) {
  try {
    const name = error instanceof Error ? error.name : 'UnknownError'
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
        ? error.code
        : undefined

    console.error(message, code === undefined ? { name } : { name, code })
  } catch {
    console.error(message, { name: 'UninspectableError' })
  }
}

const handlers = createV2SingleActionHandlers({
  db: prisma,
  validateCsrfToken,
  getCurrentUser,
  revalidatePaths(paths) {
    for (const path of paths) revalidatePath(path)
  },
  logError: safeLogV2SingleActionError,
})

const actions = createV2SingleServerActionBindings(handlers)
const doubleActions = createV2DoubleActionHandlers({
  db: prisma,
  validateCsrfToken,
  getCurrentUser,
  revalidatePaths(paths) {
    for (const path of paths) revalidatePath(path)
  },
  logError: safeLogV2SingleActionError,
})
const teamGroupingActions = createV2TeamGroupingActionHandlers({
  db: prisma,
  validateCsrfToken,
  getCurrentUser,
  revalidatePaths(paths) {
    for (const path of paths) revalidatePath(path)
  },
  logError: safeLogV2SingleActionError,
})
const teamResultActions = createV2TeamResultActionHandlers({
  db: prisma,
  validateCsrfToken,
  getCurrentUser,
  revalidatePaths(paths) {
    for (const path of paths) revalidatePath(path)
  },
  logError: safeLogV2SingleActionError,
})
const updateV2MatchSettings = createV2MatchSettingsHandler({
  db: prisma,
  validateCsrfToken,
  getCurrentUser,
  revalidatePaths(paths) {
    for (const path of paths) revalidatePath(path)
  },
  logError: safeLogV2SingleActionError,
})
const finalizeV2GroupStage = createV2GroupStageFinalizationActionHandler({
  db: prisma,
  validateCsrfToken,
  getCurrentUser,
  revalidatePaths(paths) {
    for (const path of paths) revalidatePath(path)
  },
  logError: safeLogV2SingleActionError,
})
const disqualifyV2Entry = createV2EntryDisqualificationActionHandler({
  db: prisma,
  validateCsrfToken,
  getCurrentUser,
  revalidatePaths(paths) {
    for (const path of paths) revalidatePath(path)
  },
  logError: safeLogV2SingleActionError,
})
const withdrawV2Entry = createV2EntryWithdrawalActionHandler({
  db: prisma, validateCsrfToken, getCurrentUser,
  revalidatePaths(paths) { for (const path of paths) revalidatePath(path) },
  logError: safeLogV2SingleActionError,
})

const updateV2KnockoutTableLabels = createV2KnockoutTableLabelsActionHandler({
  db: prisma,
  validateCsrfToken,
  getCurrentUser,
  revalidatePaths(paths) {
    for (const path of paths) revalidatePath(path)
  },
  logError: safeLogV2SingleActionError,
})
const knockoutActionDependencies = {
  db: prisma,
  validateCsrfToken,
  getCurrentUser,
  revalidatePaths(paths: readonly string[]) {
    for (const path of paths) revalidatePath(path)
  },
  logError: safeLogV2SingleActionError,
}
const singleKnockoutActions = createV2KnockoutResultActionHandlers(
  knockoutActionDependencies,
  V2_SINGLE_KNOCKOUT_RESULT_ACTION_PROFILE,
)
const doubleKnockoutActions = createV2KnockoutResultActionHandlers(
  knockoutActionDependencies,
  V2_DOUBLE_KNOCKOUT_RESULT_ACTION_PROFILE,
)
const teamKnockoutActions = createV2KnockoutResultActionHandlers(
  knockoutActionDependencies,
  V2_TEAM_KNOCKOUT_RESULT_ACTION_PROFILE,
)

export async function finalizeV2GroupStageAction(
  matchId: string,
  _previousState: V2GroupStageFinalizationActionState,
  formData: FormData,
): Promise<V2GroupStageFinalizationActionState> {
  return finalizeV2GroupStage(matchId, formData)
}

export async function disqualifyV2EntryAction(
  matchId: string,
  _previousState: V2EntryDisqualificationActionState,
  formData: FormData,
): Promise<V2EntryDisqualificationActionState> {
  return disqualifyV2Entry(matchId, formData)
}

export async function updateV2KnockoutTableLabelsAction(
  matchId: string,
  _previousState: V2KnockoutTableLabelsActionState,
  formData: FormData,
): Promise<V2KnockoutTableLabelsActionState> {
  return updateV2KnockoutTableLabels(matchId, formData)
}

export async function updateV2SingleMatchSettingsAction(
  matchId: string,
  _previousState: V2SingleMatchSettingsState,
  formData: FormData,
): Promise<V2SingleMatchSettingsState> {
  return updateV2MatchSettings(matchId, formData)
}

export async function registerV2SingleAction(
  matchId: string,
  previousState: V2SingleActionState,
  formData: FormData,
): Promise<V2SingleActionState> {
  return actions.register(matchId, previousState, formData)
}

export async function cancelV2SingleRegistrationAction(
  matchId: string,
  previousState: V2SingleActionState,
  formData: FormData,
): Promise<V2SingleActionState> {
  return actions.cancelRegistration(matchId, previousState, formData)
}

export async function registerV2DoubleAction(
  matchId: string,
  _previousState: V2DoubleActionState,
  formData: FormData,
): Promise<V2DoubleActionState> {
  return doubleActions.register(matchId, formData)
}

export async function cancelV2DoubleRegistrationAction(
  matchId: string,
  _previousState: V2DoubleActionState,
  formData: FormData,
): Promise<V2DoubleActionState> {
  return doubleActions.cancelRegistration(matchId, formData)
}

export async function previewV2DoubleGroupingAction(
  matchId: string,
  _previousState: V2DoubleActionState,
  formData: FormData,
): Promise<V2DoubleActionState> {
  return doubleActions.previewGrouping(matchId, formData)
}

export async function publishV2DoubleGroupingAction(
  matchId: string,
  _previousState: V2DoubleActionState,
  formData: FormData,
): Promise<V2DoubleActionState> {
  return doubleActions.publishGrouping(matchId, formData)
}

export async function updateV2DoubleGroupTableLabelsAction(
  matchId: string,
  _previousState: V2DoubleActionState,
  formData: FormData,
): Promise<V2DoubleActionState> {
  return doubleActions.updateGroupTableLabels(matchId, formData)
}

export async function voidV2DoubleUnplayedFixtureAction(
  matchId: string,
  _previousState: V2DoubleActionState,
  formData: FormData,
): Promise<V2DoubleActionState> {
  return doubleActions.voidUnplayedFixture(matchId, formData)
}

export async function submitV2DoubleResultAction(
  matchId: string,
  _previousState: V2DoubleActionState,
  formData: FormData,
): Promise<V2DoubleActionState> {
  return doubleActions.submitResult(matchId, formData)
}

export async function submitV2DoubleResultCorrectionAction(
  matchId: string,
  _previousState: V2DoubleActionState,
  formData: FormData,
): Promise<V2DoubleActionState> {
  return doubleActions.submitCorrection(matchId, formData)
}

export async function confirmV2DoubleResultAction(
  matchId: string,
  _previousState: V2DoubleActionState,
  formData: FormData,
): Promise<V2DoubleActionState> {
  return doubleActions.confirmResult(matchId, formData)
}

export async function rejectV2DoubleResultAction(
  matchId: string,
  _previousState: V2DoubleActionState,
  formData: FormData,
): Promise<V2DoubleActionState> {
  return doubleActions.rejectResult(matchId, formData)
}

export async function voidV2DoubleResultAction(
  matchId: string,
  _previousState: V2DoubleActionState,
  formData: FormData,
): Promise<V2DoubleActionState> {
  return doubleActions.voidResult(matchId, formData)
}

export async function confirmV2DoubleForfeitAction(
  matchId: string,
  _previousState: V2DoubleActionState,
  formData: FormData,
): Promise<V2DoubleActionState> {
  return doubleActions.confirmForfeit(matchId, formData)
}

export async function correctV2DoubleForfeitAction(
  matchId: string,
  _previousState: V2DoubleActionState,
  formData: FormData,
): Promise<V2DoubleActionState> {
  return doubleActions.correctForfeit(matchId, formData)
}

export async function previewV2TeamGroupingAction(
  matchId: string,
  _previousState: V2TeamGroupingActionState,
  formData: FormData,
): Promise<V2TeamGroupingActionState> {
  return teamGroupingActions.previewGrouping(matchId, formData)
}

export async function publishV2TeamGroupingAction(
  matchId: string,
  _previousState: V2TeamGroupingActionState,
  formData: FormData,
): Promise<V2TeamGroupingActionState> {
  return teamGroupingActions.publishGrouping(matchId, formData)
}

export async function updateV2TeamGroupTableLabelsAction(
  matchId: string,
  _previousState: V2TeamGroupingActionState,
  formData: FormData,
): Promise<V2TeamGroupingActionState> {
  return teamGroupingActions.updateGroupTableLabels(matchId, formData)
}

export async function voidV2TeamUnplayedFixtureAction(
  matchId: string,
  _previousState: V2TeamResultActionState,
  formData: FormData,
): Promise<V2TeamResultActionState> {
  return teamResultActions.voidUnplayedFixture(matchId, formData)
}

export async function submitV2TeamResultAction(
  matchId: string,
  _previousState: V2TeamResultActionState,
  formData: FormData,
): Promise<V2TeamResultActionState> {
  return teamResultActions.submitResult(matchId, formData)
}

export async function submitV2TeamResultCorrectionAction(
  matchId: string,
  _previousState: V2TeamResultActionState,
  formData: FormData,
): Promise<V2TeamResultActionState> {
  return teamResultActions.submitCorrection(matchId, formData)
}

export async function confirmV2TeamResultAction(
  matchId: string,
  _previousState: V2TeamResultActionState,
  formData: FormData,
): Promise<V2TeamResultActionState> {
  return teamResultActions.confirmResult(matchId, formData)
}

export async function rejectV2TeamResultAction(
  matchId: string,
  _previousState: V2TeamResultActionState,
  formData: FormData,
): Promise<V2TeamResultActionState> {
  return teamResultActions.rejectResult(matchId, formData)
}

export async function voidV2TeamResultAction(
  matchId: string,
  _previousState: V2TeamResultActionState,
  formData: FormData,
): Promise<V2TeamResultActionState> {
  return teamResultActions.voidResult(matchId, formData)
}

export async function confirmV2TeamForfeitAction(
  matchId: string,
  _previousState: V2TeamResultActionState,
  formData: FormData,
): Promise<V2TeamResultActionState> {
  return teamResultActions.confirmForfeit(matchId, formData)
}

export async function correctV2TeamForfeitAction(
  matchId: string,
  _previousState: V2TeamResultActionState,
  formData: FormData,
): Promise<V2TeamResultActionState> {
  return teamResultActions.correctForfeit(matchId, formData)
}

export async function previewV2SingleGroupingAction(
  matchId: string,
  previousState: V2SingleActionState,
  formData: FormData,
): Promise<V2SingleActionState> {
  return actions.previewGrouping(matchId, previousState, formData)
}

export async function publishV2SingleGroupingAction(
  matchId: string,
  previousState: V2SingleActionState,
  formData: FormData,
): Promise<V2SingleActionState> {
  return actions.publishGrouping(matchId, previousState, formData)
}

export async function updateV2SingleGroupTableLabelsAction(
  matchId: string,
  previousState: V2SingleActionState,
  formData: FormData,
): Promise<V2SingleActionState> {
  return actions.updateGroupTableLabels(matchId, previousState, formData)
}

export async function voidV2SingleUnplayedFixtureAction(
  matchId: string,
  previousState: V2SingleActionState,
  formData: FormData,
): Promise<V2SingleActionState> {
  return actions.voidUnplayedFixture(matchId, previousState, formData)
}

export async function submitV2SingleResultAction(
  matchId: string,
  previousState: V2SingleActionState,
  formData: FormData,
): Promise<V2SingleActionState> {
  return actions.submitResult(matchId, previousState, formData)
}

export async function submitV2SingleResultCorrectionAction(
  matchId: string,
  previousState: V2SingleActionState,
  formData: FormData,
): Promise<V2SingleActionState> {
  return actions.submitCorrection(matchId, previousState, formData)
}

export async function confirmV2SingleResultAction(
  matchId: string,
  previousState: V2SingleActionState,
  formData: FormData,
): Promise<V2SingleActionState> {
  return actions.confirmResult(matchId, previousState, formData)
}

export async function rejectV2SingleResultAction(
  matchId: string,
  previousState: V2SingleActionState,
  formData: FormData,
): Promise<V2SingleActionState> {
  return actions.rejectResult(matchId, previousState, formData)
}

export async function voidV2SingleResultAction(
  matchId: string,
  previousState: V2SingleActionState,
  formData: FormData,
): Promise<V2SingleActionState> {
  return actions.voidResult(matchId, previousState, formData)
}

export async function confirmV2SingleForfeitAction(
  matchId: string,
  previousState: V2SingleActionState,
  formData: FormData,
): Promise<V2SingleActionState> {
  return actions.confirmForfeit(matchId, previousState, formData)
}

export async function correctV2SingleForfeitAction(
  matchId: string,
  previousState: V2SingleActionState,
  formData: FormData,
): Promise<V2SingleActionState> {
  return actions.correctForfeit(matchId, previousState, formData)
}

export async function submitV2SingleKnockoutResultAction(
  matchId: string,
  _previousState: V2KnockoutResultActionState,
  formData: FormData,
): Promise<V2KnockoutResultActionState> {
  return singleKnockoutActions.submitResult(matchId, formData)
}

export async function submitV2SingleKnockoutResultCorrectionAction(
  matchId: string,
  _previousState: V2KnockoutResultActionState,
  formData: FormData,
): Promise<V2KnockoutResultActionState> {
  return singleKnockoutActions.submitCorrection(matchId, formData)
}

export async function confirmV2SingleKnockoutResultAction(
  matchId: string,
  _previousState: V2KnockoutResultActionState,
  formData: FormData,
): Promise<V2KnockoutResultActionState> {
  return singleKnockoutActions.confirmResult(matchId, formData)
}

export async function rejectV2SingleKnockoutResultAction(
  matchId: string,
  _previousState: V2KnockoutResultActionState,
  formData: FormData,
): Promise<V2KnockoutResultActionState> {
  return singleKnockoutActions.rejectResult(matchId, formData)
}

export async function confirmV2SingleKnockoutForfeitAction(
  matchId: string,
  _previousState: V2KnockoutResultActionState,
  formData: FormData,
): Promise<V2KnockoutResultActionState> {
  return singleKnockoutActions.confirmForfeit(matchId, formData)
}

export async function correctV2SingleKnockoutForfeitAction(
  matchId: string,
  _previousState: V2KnockoutResultActionState,
  formData: FormData,
): Promise<V2KnockoutResultActionState> {
  return singleKnockoutActions.correctForfeit(matchId, formData)
}

export async function submitV2DoubleKnockoutResultAction(
  matchId: string,
  _previousState: V2KnockoutResultActionState,
  formData: FormData,
): Promise<V2KnockoutResultActionState> {
  return doubleKnockoutActions.submitResult(matchId, formData)
}

export async function submitV2DoubleKnockoutResultCorrectionAction(
  matchId: string,
  _previousState: V2KnockoutResultActionState,
  formData: FormData,
): Promise<V2KnockoutResultActionState> {
  return doubleKnockoutActions.submitCorrection(matchId, formData)
}

export async function confirmV2DoubleKnockoutResultAction(
  matchId: string,
  _previousState: V2KnockoutResultActionState,
  formData: FormData,
): Promise<V2KnockoutResultActionState> {
  return doubleKnockoutActions.confirmResult(matchId, formData)
}

export async function rejectV2DoubleKnockoutResultAction(
  matchId: string,
  _previousState: V2KnockoutResultActionState,
  formData: FormData,
): Promise<V2KnockoutResultActionState> {
  return doubleKnockoutActions.rejectResult(matchId, formData)
}

export async function confirmV2DoubleKnockoutForfeitAction(
  matchId: string,
  _previousState: V2KnockoutResultActionState,
  formData: FormData,
): Promise<V2KnockoutResultActionState> {
  return doubleKnockoutActions.confirmForfeit(matchId, formData)
}

export async function correctV2DoubleKnockoutForfeitAction(
  matchId: string,
  _previousState: V2KnockoutResultActionState,
  formData: FormData,
): Promise<V2KnockoutResultActionState> {
  return doubleKnockoutActions.correctForfeit(matchId, formData)
}

export async function submitV2TeamKnockoutResultAction(
  matchId: string,
  _previousState: V2KnockoutResultActionState,
  formData: FormData,
): Promise<V2KnockoutResultActionState> {
  return teamKnockoutActions.submitResult(matchId, formData)
}

export async function submitV2TeamKnockoutResultCorrectionAction(
  matchId: string,
  _previousState: V2KnockoutResultActionState,
  formData: FormData,
): Promise<V2KnockoutResultActionState> {
  return teamKnockoutActions.submitCorrection(matchId, formData)
}

export async function confirmV2TeamKnockoutResultAction(
  matchId: string,
  _previousState: V2KnockoutResultActionState,
  formData: FormData,
): Promise<V2KnockoutResultActionState> {
  return teamKnockoutActions.confirmResult(matchId, formData)
}

export async function rejectV2TeamKnockoutResultAction(
  matchId: string,
  _previousState: V2KnockoutResultActionState,
  formData: FormData,
): Promise<V2KnockoutResultActionState> {
  return teamKnockoutActions.rejectResult(matchId, formData)
}

export async function confirmV2TeamKnockoutForfeitAction(
  matchId: string,
  _previousState: V2KnockoutResultActionState,
  formData: FormData,
): Promise<V2KnockoutResultActionState> {
  return teamKnockoutActions.confirmForfeit(matchId, formData)
}

export async function correctV2TeamKnockoutForfeitAction(
  matchId: string,
  _previousState: V2KnockoutResultActionState,
  formData: FormData,
): Promise<V2KnockoutResultActionState> {
  return teamKnockoutActions.correctForfeit(matchId, formData)
}

export async function withdrawV2EntryAction(matchId: string, _previousState: V2EntryDisqualificationActionState, formData: FormData): Promise<V2EntryDisqualificationActionState> {
  return withdrawV2Entry(matchId, formData)
}

export async function replaceCompetitionRosterAction(matchId: string, _previousState: RosterManagementState, formData: FormData): Promise<RosterManagementState> {
  return createRosterManagementHandler({ db: prisma, getCurrentUser, validateCsrfToken, revalidatePaths(paths) { for (const path of paths) revalidatePath(path) } })(matchId, formData)
}


export async function startCompetitionFixtureAction(
  matchId: string,
  _state: { error?: string; success?: string },
  formData: FormData,
): Promise<{ error?: string; success?: string }> {
  const { assertUniqueTextFormData, assertSingleCsrfField, readStableIdentifier, readNonNegativeSafeInteger, readSingleTextField, parseStableIdentifier, mapV2ActionError } = await import('@/modules/competitions-v2/adapters/action-boundary');
  const { startCompetitionFixture } = await import('@/modules/competitions-v2/application/results');
  try {
    assertUniqueTextFormData(formData);
    assertSingleCsrfField(formData);
    const csrf = await validateCsrfToken(formData);
    if (csrf) return { error: csrf };
    // React adds action-routing metadata to native server-action forms.
    for (const key of formData.keys()) if (!key.startsWith('$ACTION_') && !['csrfToken', 'fixtureId', 'expectedFixtureVersion', 'stage'].includes(key)) return { error: '提交包含无效字段。' };
    const user = await getCurrentUser();
    if (!user) return { error: '请先登录。' };
    const stage = readSingleTextField(formData, 'stage');
    if (stage !== 'GROUP' && stage !== 'KNOCKOUT') return { error: '场次阶段无效。' };
    await startCompetitionFixture(prisma, {
      actor: { actorId: user.id, role: user.role }, matchId: parseStableIdentifier(matchId, 'matchId'),
      fixtureId: readStableIdentifier(formData, 'fixtureId'), expectedFixtureVersion: readNonNegativeSafeInteger(formData, 'expectedFixtureVersion'), requiredFixtureStage: stage,
    });
    revalidatePath(`/matchs/${matchId}`);
    revalidatePath(`/matchs/${matchId}/grouping`);
    return { success: '已标记开始，本场成员名单已保留。' };
  } catch (error) { return { error: mapV2ActionError(error).message }; }
}
