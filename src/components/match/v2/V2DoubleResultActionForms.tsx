"use client";

import type { ComponentProps } from "react";

import {
  confirmV2DoubleForfeitAction,
  confirmV2DoubleKnockoutForfeitAction,
  confirmV2DoubleKnockoutResultAction,
  confirmV2DoubleResultAction,
  correctV2DoubleForfeitAction,
  correctV2DoubleKnockoutForfeitAction,
  rejectV2DoubleKnockoutResultAction,
  rejectV2DoubleResultAction,
  submitV2DoubleKnockoutResultAction,
  submitV2DoubleKnockoutResultCorrectionAction,
  submitV2DoubleResultCorrectionAction,
  submitV2DoubleResultAction,
  voidV2DoubleUnplayedFixtureAction,
  voidV2DoubleResultAction,
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

export function V2DoubleResultSubmissionForm(
  { stage = "GROUP", ...props }: Omit<
    ComponentProps<typeof V2GroupOnlyResultSubmissionForm>,
    "serverAction" | "confirmationHint"
  > & { stage?: "GROUP" | "KNOCKOUT" },
) {
  return (
    <V2GroupOnlyResultSubmissionForm
      {...props}
      serverAction={
        stage === "KNOCKOUT"
          ? submitV2DoubleKnockoutResultAction
          : submitV2DoubleResultAction
      }
      confirmationHint="提交后需由另一方任一非登记搭档或管理员确认。"
    />
  );
}

export function V2DoubleUnplayedFixtureVoidForm(
  props: Omit<
    ComponentProps<typeof V2GroupOnlyUnplayedFixtureVoidForm>,
    "serverAction"
  >,
) {
  return (
    <V2GroupOnlyUnplayedFixtureVoidForm
      {...props}
      serverAction={voidV2DoubleUnplayedFixtureAction}
    />
  );
}

export function V2DoubleResultCorrectionForm(
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
          ? submitV2DoubleKnockoutResultCorrectionAction
          : submitV2DoubleResultCorrectionAction
      }
    />
  );
}

export function V2DoubleRevisionActionForm({
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
        ? confirmV2DoubleKnockoutResultAction
        : confirmV2DoubleResultAction
      : kind === "reject"
        ? stage === "KNOCKOUT"
          ? rejectV2DoubleKnockoutResultAction
          : rejectV2DoubleResultAction
        : voidV2DoubleResultAction;
  return (
    <V2GroupOnlyRevisionActionForm
      {...props}
      kind={kind}
      serverAction={serverAction}
    />
  );
}

export function V2DoubleForfeitForm(
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
          ? confirmV2DoubleKnockoutForfeitAction
          : confirmV2DoubleForfeitAction
      }
    />
  );
}

export function V2DoubleForfeitCorrectionForm(
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
          ? correctV2DoubleKnockoutForfeitAction
          : correctV2DoubleForfeitAction
      }
    />
  );
}
