"use client";

import { useActionState, type ComponentProps } from "react";

import {
  cancelV2SingleRegistrationAction,
  confirmV2SingleForfeitAction,
  confirmV2SingleKnockoutForfeitAction,
  confirmV2SingleKnockoutResultAction,
  confirmV2SingleResultAction,
  correctV2SingleForfeitAction,
  correctV2SingleKnockoutForfeitAction,
  registerV2SingleAction,
  rejectV2SingleResultAction,
  rejectV2SingleKnockoutResultAction,
  submitV2SingleKnockoutResultCorrectionAction,
  submitV2SingleKnockoutResultAction,
  submitV2SingleResultCorrectionAction,
  submitV2SingleResultAction,
  voidV2SingleUnplayedFixtureAction,
  voidV2SingleResultAction,
} from "@/app/matchs/v2-actions";
import {
  V2GroupOnlyForfeitForm,
  V2GroupOnlyForfeitCorrectionForm,
  V2GroupOnlyResultCorrectionForm,
  V2GroupOnlyResultSubmissionForm,
  V2GroupOnlyRevisionActionForm,
  V2GroupOnlyUnplayedFixtureVoidForm,
  type V2GroupOnlyRevisionActionKind,
} from "@/components/match/v2/V2GroupOnlyResultActionForms";
import type { V2SingleActionState } from "@/modules/competitions-v2/adapters/single-actions";

const INITIAL_STATE: V2SingleActionState = {};

function ActionStateMessage({ state }: { state: V2SingleActionState }) {
  return (
    <>
      {state.error ? <p className="text-xs text-rose-300">{state.error}</p> : null}
      {state.success ? (
        <p className="text-xs text-emerald-300">{state.success}</p>
      ) : null}
    </>
  );
}

export function V2SingleRegistrationForm({
  matchId,
  mode,
}: {
  matchId: string;
  mode: "register" | "cancel";
}) {
  const action =
    mode === "register"
      ? registerV2SingleAction.bind(null, matchId)
      : cancelV2SingleRegistrationAction.bind(null, matchId);
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <button
        type="submit"
        disabled={pending}
        className={
          mode === "register"
            ? "w-full rounded-lg bg-linear-to-r from-cyan-500 to-blue-500 py-3 font-semibold text-white disabled:opacity-50"
            : "w-full rounded-lg border border-rose-400/50 py-3 font-semibold text-rose-200 hover:bg-rose-500/10 disabled:opacity-60"
        }
      >
        {pending
          ? "处理中..."
          : mode === "register"
            ? "立即报名"
            : "退出报名"}
      </button>
      <ActionStateMessage state={state} />
    </form>
  );
}

export function V2SingleResultSubmissionForm(
  { stage = "GROUP", ...props }: Omit<
    ComponentProps<typeof V2GroupOnlyResultSubmissionForm>,
    "serverAction"
  > & { stage?: "GROUP" | "KNOCKOUT" },
) {
  return (
    <V2GroupOnlyResultSubmissionForm
      {...props}
      serverAction={
        stage === "KNOCKOUT"
          ? submitV2SingleKnockoutResultAction
          : submitV2SingleResultAction
      }
    />
  );
}

export function V2SingleUnplayedFixtureVoidForm(
  props: Omit<
    ComponentProps<typeof V2GroupOnlyUnplayedFixtureVoidForm>,
    "serverAction"
  >,
) {
  return (
    <V2GroupOnlyUnplayedFixtureVoidForm
      {...props}
      serverAction={voidV2SingleUnplayedFixtureAction}
    />
  );
}

export function V2SingleResultCorrectionForm(
  { stage = "GROUP", ...props }: Omit<
    ComponentProps<typeof V2GroupOnlyResultCorrectionForm>,
    "serverAction"
  > & { stage?: "GROUP" | "KNOCKOUT" },
) {
  return (
    <V2GroupOnlyResultCorrectionForm
      {...props}
      serverAction={
        stage === "KNOCKOUT"
          ? submitV2SingleKnockoutResultCorrectionAction
          : submitV2SingleResultCorrectionAction
      }
    />
  );
}

export function V2SingleRevisionActionForm({
  kind,
  stage = "GROUP",
  ...props
}: Omit<
  ComponentProps<typeof V2GroupOnlyRevisionActionForm>,
  "serverAction"
> & {
  kind: V2GroupOnlyRevisionActionKind;
  stage?: "GROUP" | "KNOCKOUT";
}) {
  if (stage === "KNOCKOUT" && kind === "void") {
    throw new Error("KNOCKOUT result VOID is not a supported Web action.");
  }
  const serverAction =
    kind === "confirm"
      ? stage === "KNOCKOUT"
        ? confirmV2SingleKnockoutResultAction
        : confirmV2SingleResultAction
      : kind === "reject"
        ? stage === "KNOCKOUT"
          ? rejectV2SingleKnockoutResultAction
          : rejectV2SingleResultAction
        : voidV2SingleResultAction;
  return (
    <V2GroupOnlyRevisionActionForm
      {...props}
      kind={kind}
      serverAction={serverAction}
    />
  );
}

export function V2SingleForfeitForm(
  { stage = "GROUP", ...props }: Omit<
    ComponentProps<typeof V2GroupOnlyForfeitForm>,
    "serverAction"
  > & { stage?: "GROUP" | "KNOCKOUT" },
) {
  return (
    <V2GroupOnlyForfeitForm
      {...props}
      serverAction={
        stage === "KNOCKOUT"
          ? confirmV2SingleKnockoutForfeitAction
          : confirmV2SingleForfeitAction
      }
    />
  );
}

export function V2SingleForfeitCorrectionForm(
  { stage = "GROUP", ...props }: Omit<
    ComponentProps<typeof V2GroupOnlyForfeitCorrectionForm>,
    "serverAction"
  > & { stage?: "GROUP" | "KNOCKOUT" },
) {
  return (
    <V2GroupOnlyForfeitCorrectionForm
      {...props}
      serverAction={
        stage === "KNOCKOUT"
          ? correctV2SingleKnockoutForfeitAction
          : correctV2SingleForfeitAction
      }
    />
  );
}
