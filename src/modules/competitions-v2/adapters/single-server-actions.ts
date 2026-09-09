import type {
  V2SingleActionHandlers,
  V2SingleActionState,
} from "./single-actions";

type V2SingleServerAction = (
  matchId: string,
  previousState: V2SingleActionState,
  formData: FormData,
) => Promise<V2SingleActionState>;

export type V2SingleServerActionBindings = Readonly<{
  register: V2SingleServerAction;
  cancelRegistration: V2SingleServerAction;
  previewGrouping: V2SingleServerAction;
  publishGrouping: V2SingleServerAction;
  updateGroupTableLabels: V2SingleServerAction;
  voidUnplayedFixture: V2SingleServerAction;
  submitResult: V2SingleServerAction;
  submitCorrection: V2SingleServerAction;
  confirmResult: V2SingleServerAction;
  rejectResult: V2SingleServerAction;
  voidResult: V2SingleServerAction;
  confirmForfeit: V2SingleServerAction;
  correctForfeit: V2SingleServerAction;
}>;

type ExposedV2SingleActionHandlers = Pick<
  V2SingleActionHandlers,
  | "register"
  | "cancelRegistration"
  | "previewGrouping"
  | "publishGrouping"
  | "updateGroupTableLabels"
  | "voidUnplayedFixture"
  | "submitResult"
  | "submitCorrection"
  | "confirmResult"
  | "rejectResult"
  | "voidResult"
  | "confirmForfeit"
  | "correctForfeit"
>;

/**
 * Adapts the trusted two-argument V2 handlers to React's useActionState
 * signature. The previous client-visible state is deliberately ignored and
 * is never forwarded into the application command.
 */
export function createV2SingleServerActionBindings(
  handlers: ExposedV2SingleActionHandlers,
): V2SingleServerActionBindings {
  const bind = (
    handler: (
      matchId: unknown,
      formData: FormData,
    ) => Promise<V2SingleActionState>,
  ): V2SingleServerAction =>
    async (matchId, _previousState, formData) => handler(matchId, formData);

  return Object.freeze({
    register: bind(handlers.register),
    cancelRegistration: bind(handlers.cancelRegistration),
    previewGrouping: bind(handlers.previewGrouping),
    publishGrouping: bind(handlers.publishGrouping),
    updateGroupTableLabels: bind(handlers.updateGroupTableLabels),
    voidUnplayedFixture: bind(handlers.voidUnplayedFixture),
    submitResult: bind(handlers.submitResult),
    submitCorrection: bind(handlers.submitCorrection),
    confirmResult: bind(handlers.confirmResult),
    rejectResult: bind(handlers.rejectResult),
    voidResult: bind(handlers.voidResult),
    confirmForfeit: bind(handlers.confirmForfeit),
    correctForfeit: bind(handlers.correctForfeit),
  });
}
