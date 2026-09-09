"use client";

import { useActionState, useState, type ComponentProps } from "react";

import {
  confirmV2TeamForfeitAction,
  confirmV2TeamKnockoutForfeitAction,
  confirmV2TeamKnockoutResultAction,
  confirmV2TeamResultAction,
  correctV2TeamForfeitAction,
  correctV2TeamKnockoutForfeitAction,
  rejectV2TeamKnockoutResultAction,
  rejectV2TeamResultAction,
  submitV2TeamKnockoutResultAction,
  submitV2TeamKnockoutResultCorrectionAction,
  submitV2TeamResultAction,
  submitV2TeamResultCorrectionAction,
  voidV2TeamResultAction,
  voidV2TeamUnplayedFixtureAction,
} from "@/app/matchs/v2-actions";
import {
  V2GroupOnlyForfeitForm,
  V2GroupOnlyForfeitCorrectionForm,
  V2GroupOnlyRevisionActionForm,
  V2GroupOnlyUnplayedFixtureVoidForm,
  type V2GroupOnlyResultActionState,
  type V2GroupOnlyRevisionActionKind,
} from "@/components/match/v2/V2GroupOnlyResultActionForms";
import { V2_MAX_TEAM_SCORE_PER_FIXTURE } from "@/modules/competitions-v2/domain/group-standings";

const INITIAL_STATE: V2GroupOnlyResultActionState = {};

function ActionStateMessage({ state }: { state: V2GroupOnlyResultActionState }) {
  return (
    <>
      {state.error ? <p className="text-xs text-rose-300">{state.error}</p> : null}
      {state.success ? (
        <p className="text-xs text-emerald-300">{state.success}</p>
      ) : null}
    </>
  );
}

export function V2TeamResultSubmissionForm({
  matchId,
  fixtureId,
  expectedFixtureVersion,
  sideA,
  sideB,
  stage = "GROUP",
}: {
  matchId: string;
  fixtureId: string;
  expectedFixtureVersion: number;
  bestOf?: number;
  sideA: Readonly<{ entryId: string; frozenDisplayName: string }>;
  sideB: Readonly<{ entryId: string; frozenDisplayName: string }>;
  stage?: "GROUP" | "KNOCKOUT";
}) {
  const action = (
    stage === "KNOCKOUT"
      ? submitV2TeamKnockoutResultAction
      : submitV2TeamResultAction
  ).bind(null, matchId);
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const [winnerEntryId, setWinnerEntryId] = useState(sideA.entryId);

  return (
    <form
      action={formAction}
      className="mt-3 space-y-3 rounded-lg border border-cyan-500/25 bg-slate-950/35 p-3"
    >
      <input type="hidden" name="csrfToken" defaultValue="" />
      <input type="hidden" name="fixtureId" value={fixtureId} />
      <input
        type="hidden"
        name="expectedFixtureVersion"
        value={expectedFixtureVersion}
      />
      <input type="hidden" name="winnerEntryId" value={winnerEntryId} />

      <div className="grid gap-2 sm:grid-cols-3">
        <label className="space-y-1 text-xs text-slate-300">
          <span>胜方（冻结队名）</span>
          <select
            value={winnerEntryId}
            onChange={(event) => setWinnerEntryId(event.target.value)}
            className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100"
          >
            <option value={sideA.entryId}>{sideA.frozenDisplayName}</option>
            <option value={sideB.entryId}>{sideB.frozenDisplayName}</option>
          </select>
        </label>
        <label className="space-y-1 text-xs text-slate-300">
          <span>胜方团体总分</span>
          <input
            type="number"
            name="winnerScore"
            min={1}
            max={V2_MAX_TEAM_SCORE_PER_FIXTURE}
            step={1}
            defaultValue={3}
            required
            className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100"
          />
        </label>
        <label className="space-y-1 text-xs text-slate-300">
          <span>负方团体总分</span>
          <input
            type="number"
            name="loserScore"
            min={0}
            max={V2_MAX_TEAM_SCORE_PER_FIXTURE}
            step={1}
            defaultValue={1}
            required
            className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100"
          />
        </label>
      </div>
      <p className="text-xs text-slate-400">
        记录一个队对队总比分；只有参赛队长、比赛创建者或管理员可提交。
      </p>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-60"
      >
        {pending ? "提交中..." : "提交团体赛果"}
      </button>
      <ActionStateMessage state={state} />
    </form>
  );
}

export function V2TeamResultCorrectionForm({
  matchId,
  fixtureId,
  expectedFixtureVersion,
  resultRevisionId,
  currentWinnerName,
  currentLoserName,
  initialScore,
  stage = "GROUP",
}: {
  matchId: string;
  fixtureId: string;
  expectedFixtureVersion: number;
  resultRevisionId: string;
  currentWinnerName: string;
  currentLoserName: string;
  initialScore: Readonly<{ winnerScore: number; loserScore: number }>;
  stage?: "GROUP" | "KNOCKOUT";
}) {
  const action = (
    stage === "KNOCKOUT"
      ? submitV2TeamKnockoutResultCorrectionAction
      : submitV2TeamResultCorrectionAction
  ).bind(null, matchId);
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const [correctionMode, setCorrectionMode] = useState<
    "KEEP_WINNER" | "SWAP_WINNER"
  >("KEEP_WINNER");
  const correctedWinnerName =
    correctionMode === "KEEP_WINNER" ? currentWinnerName : currentLoserName;
  const correctedLoserName =
    correctionMode === "KEEP_WINNER" ? currentLoserName : currentWinnerName;
  return (
    <form
      action={formAction}
      className="mt-3 space-y-3 rounded-lg border border-amber-500/25 bg-slate-950/35 p-3"
    >
      <input type="hidden" name="csrfToken" defaultValue="" />
      <input type="hidden" name="fixtureId" value={fixtureId} />
      <input
        type="hidden"
        name="expectedFixtureVersion"
        value={expectedFixtureVersion}
      />
      <input type="hidden" name="resultRevisionId" value={resultRevisionId} />
      <p className="text-xs text-amber-100">
        更正为：{correctedWinnerName} 胜 {correctedLoserName}
      </p>
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="space-y-1 text-xs text-slate-300">
          <span>更正类型</span>
          <select
            name="correctionMode"
            value={correctionMode}
            onChange={(event) =>
              setCorrectionMode(
                event.target.value as "KEEP_WINNER" | "SWAP_WINNER",
              )
            }
            className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100"
          >
            <option value="KEEP_WINNER">胜方不变，仅改比分</option>
            <option value="SWAP_WINNER">交换胜负方</option>
          </select>
        </label>
        <label className="space-y-1 text-xs text-slate-300">
          <span>更正后胜方团体总分</span>
          <input
            type="number"
            name="winnerScore"
            min={1}
            max={V2_MAX_TEAM_SCORE_PER_FIXTURE}
            step={1}
            defaultValue={initialScore.winnerScore}
            required
            className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100"
          />
        </label>
        <label className="space-y-1 text-xs text-slate-300">
          <span>更正后负方团体总分</span>
          <input
            type="number"
            name="loserScore"
            min={0}
            max={V2_MAX_TEAM_SCORE_PER_FIXTURE}
            step={1}
            defaultValue={initialScore.loserScore}
            required
            className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100"
          />
        </label>
      </div>
      <p className="text-xs text-slate-400">
        可仅改比分或交换胜负方；提交后原赛果继续生效，需管理员再次确认。
      </p>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-amber-400/40 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-500/10 disabled:opacity-60"
      >
        {pending ? "提交中..." : "提交团体胜负更正"}
      </button>
      <ActionStateMessage state={state} />
    </form>
  );
}

export function V2TeamUnplayedFixtureVoidForm(
  props: Omit<
    ComponentProps<typeof V2GroupOnlyUnplayedFixtureVoidForm>,
    "serverAction"
  >,
) {
  return (
    <V2GroupOnlyUnplayedFixtureVoidForm
      {...props}
      serverAction={voidV2TeamUnplayedFixtureAction}
    />
  );
}

export function V2TeamRevisionActionForm({
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
        ? confirmV2TeamKnockoutResultAction
        : confirmV2TeamResultAction
      : kind === "reject"
        ? stage === "KNOCKOUT"
          ? rejectV2TeamKnockoutResultAction
          : rejectV2TeamResultAction
        : voidV2TeamResultAction;
  return (
    <V2GroupOnlyRevisionActionForm
      {...props}
      kind={kind}
      serverAction={serverAction}
    />
  );
}

export function V2TeamForfeitForm(
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
          ? confirmV2TeamKnockoutForfeitAction
          : confirmV2TeamForfeitAction
      }
    />
  );
}

export function V2TeamForfeitCorrectionForm(
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
          ? correctV2TeamKnockoutForfeitAction
          : correctV2TeamForfeitAction
      }
    />
  );
}
