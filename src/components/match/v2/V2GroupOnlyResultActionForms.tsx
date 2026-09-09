"use client";

import { useActionState, useState } from "react";

export type V2GroupOnlyResultActionState = Readonly<{
  error?: string;
  success?: string;
}>;

export type V2GroupOnlyResultServerAction = (
  matchId: string,
  previousState: V2GroupOnlyResultActionState,
  formData: FormData,
) => Promise<V2GroupOnlyResultActionState>;

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

export function V2GroupOnlyResultSubmissionForm({
  serverAction,
  matchId,
  fixtureId,
  expectedFixtureVersion,
  bestOf = 5,
  sideA,
  sideB,
  confirmationHint = "提交后需由对手或管理员确认。",
}: {
  serverAction: V2GroupOnlyResultServerAction;
  matchId: string;
  fixtureId: string;
  expectedFixtureVersion: number;
  bestOf?: number;
  sideA: Readonly<{ entryId: string; frozenDisplayName: string }>;
  sideB: Readonly<{ entryId: string; frozenDisplayName: string }>;
  confirmationHint?: string;
}) {
  const action = serverAction.bind(null, matchId);
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const [winnerEntryId, setWinnerEntryId] = useState(sideA.entryId);
  const winsNeeded = (bestOf + 1) / 2;
  const [loserScore, setLoserScore] = useState(winsNeeded - 1);

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
      <input type="hidden" name="winnerScore" value={winsNeeded} />

      <div className="grid gap-2 sm:grid-cols-3">
        <label className="space-y-1 text-xs text-slate-300">
          <span>胜方</span>
          <select
            value={winnerEntryId}
            onChange={(event) => setWinnerEntryId(event.target.value)}
            className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100"
          >
            <option value={sideA.entryId}>{sideA.frozenDisplayName}</option>
            <option value={sideB.entryId}>{sideB.frozenDisplayName}</option>
          </select>
        </label>

        <div className="space-y-1 text-xs text-slate-300">
          <span>本场局制</span>
          <input type="hidden" name="bestOf" value={bestOf} />
          <p className="flex h-9 items-center text-sm text-slate-100">{bestOf} 局 {winsNeeded} 胜</p>
        </div>

        <label className="space-y-1 text-xs text-slate-300">
          <span>负方局分</span>
          <select
            name="loserScore"
            value={loserScore}
            onChange={(event) => setLoserScore(Number(event.target.value))}
            className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100"
          >
            {Array.from({ length: winsNeeded }, (_, score) => (
              <option key={`${bestOf}-${score}`} value={score}>
                {score}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="text-xs text-slate-400">
        将提交 {winsNeeded}:{loserScore}，{confirmationHint}
      </p>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-60"
      >
        {pending ? "提交中..." : "提交赛果"}
      </button>
      <ActionStateMessage state={state} />
    </form>
  );
}

export function V2GroupOnlyUnplayedFixtureVoidForm({
  serverAction,
  matchId,
  fixtureId,
  expectedFixtureVersion,
}: {
  serverAction: V2GroupOnlyResultServerAction;
  matchId: string;
  fixtureId: string;
  expectedFixtureVersion: number;
}) {
  const action = serverAction.bind(null, matchId);
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <input type="hidden" name="fixtureId" value={fixtureId} />
      <input
        type="hidden"
        name="expectedFixtureVersion"
        value={expectedFixtureVersion}
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-rose-500/40 px-3 py-1 text-xs text-rose-300 hover:bg-rose-500/10 disabled:opacity-60"
      >
        {pending ? "处理中..." : "作废未赛对局"}
      </button>
      <ActionStateMessage state={state} />
    </form>
  );
}

export function V2GroupOnlyResultCorrectionForm({
  serverAction,
  matchId,
  fixtureId,
  expectedFixtureVersion,
  resultRevisionId,
  currentWinnerName,
  currentLoserName,
  initialScore,
}: {
  serverAction: V2GroupOnlyResultServerAction;
  matchId: string;
  fixtureId: string;
  expectedFixtureVersion: number;
  resultRevisionId: string;
  currentWinnerName: string;
  currentLoserName: string;
  initialScore: Readonly<{ bestOf: 3 | 5 | 7; loserScore: number }>;
}) {
  const action = serverAction.bind(null, matchId);
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const bestOf = initialScore.bestOf;
  const winsNeeded = (bestOf + 1) / 2;
  const [loserScore, setLoserScore] = useState(initialScore.loserScore);
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
      <input type="hidden" name="winnerScore" value={winsNeeded} />
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
          <span>本场局制</span>
          <input type="hidden" name="bestOf" value={bestOf} />
          <p className="flex h-9 items-center text-sm text-slate-100">{bestOf} 局 {winsNeeded} 胜</p>
        </label>
        <label className="space-y-1 text-xs text-slate-300">
          <span>更正后负方局分</span>
          <select
            name="loserScore"
            value={loserScore}
            onChange={(event) => setLoserScore(Number(event.target.value))}
            className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100"
          >
            {Array.from({ length: winsNeeded }, (_, score) => (
              <option key={`${bestOf}-${score}`} value={score}>
                {score}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-xs text-slate-400">
        提交后原赛果继续生效，需管理员再次确认；服务端会从当前赛果推导双方。
      </p>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-amber-400/40 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-500/10 disabled:opacity-60"
      >
        {pending ? "提交中..." : "提交赛果更正"}
      </button>
      <ActionStateMessage state={state} />
    </form>
  );
}

export type V2GroupOnlyRevisionActionKind = "confirm" | "reject" | "void";

const REVISION_ACTION_COPY = {
  confirm: {
    idle: "确认赛果",
    pending: "确认中...",
    className: "border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10",
  },
  reject: {
    idle: "否决赛果",
    pending: "处理中...",
    className: "border-rose-500/40 text-rose-300 hover:bg-rose-500/10",
  },
  void: {
    idle: "作废赛果",
    pending: "处理中...",
    className: "border-rose-500/40 text-rose-300 hover:bg-rose-500/10",
  },
} as const;

export function V2GroupOnlyRevisionActionForm({
  serverAction,
  matchId,
  fixtureId,
  expectedFixtureVersion,
  resultRevisionId,
  kind,
}: {
  serverAction: V2GroupOnlyResultServerAction;
  matchId: string;
  fixtureId: string;
  expectedFixtureVersion: number;
  resultRevisionId: string;
  kind: V2GroupOnlyRevisionActionKind;
}) {
  const action = serverAction.bind(null, matchId);
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  const copy = REVISION_ACTION_COPY[kind];
  return (
    <form action={formAction} className="space-y-1">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <input type="hidden" name="fixtureId" value={fixtureId} />
      <input
        type="hidden"
        name="expectedFixtureVersion"
        value={expectedFixtureVersion}
      />
      <input type="hidden" name="resultRevisionId" value={resultRevisionId} />
      <button
        type="submit"
        disabled={pending}
        className={`rounded-md border px-3 py-1 text-xs disabled:opacity-60 ${copy.className}`}
      >
        {pending ? copy.pending : copy.idle}
      </button>
      <ActionStateMessage state={state} />
    </form>
  );
}

export function V2GroupOnlyForfeitForm({
  serverAction,
  matchId,
  fixtureId,
  expectedFixtureVersion,
  winnerEntries,
}: {
  serverAction: V2GroupOnlyResultServerAction;
  matchId: string;
  fixtureId: string;
  expectedFixtureVersion: number;
  winnerEntries: readonly Readonly<{
    entryId: string;
    frozenDisplayName: string;
  }>[];
}) {
  const action = serverAction.bind(null, matchId);
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  if (winnerEntries.length === 0) return null;
  return (
    <form
      action={formAction}
      className="mt-3 space-y-2 rounded-lg border border-rose-500/25 bg-rose-500/5 p-3"
    >
      <input type="hidden" name="csrfToken" defaultValue="" />
      <input type="hidden" name="fixtureId" value={fixtureId} />
      <input
        type="hidden"
        name="expectedFixtureVersion"
        value={expectedFixtureVersion}
      />
      <label className="block space-y-1 text-xs text-slate-300">
        <span>弃权判定胜方</span>
        <select
          name="winnerEntryId"
          className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100"
        >
          {winnerEntries.map((entry) => (
            <option key={entry.entryId} value={entry.entryId}>
              {entry.frozenDisplayName}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1 text-xs text-slate-300">
        <span>判定原因（必填）</span>
        <input
          type="text"
          name="reason"
          required
          maxLength={500}
          className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100"
        />
      </label>
      <p className="text-xs text-slate-400">
        负方由服务器根据 Fixture 另一侧推导，弃权不产生积分或 ELO 结算。
      </p>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-rose-500/40 px-3 py-1.5 text-xs text-rose-200 hover:bg-rose-500/10 disabled:opacity-60"
      >
        {pending ? "处理中..." : "确认弃权判胜"}
      </button>
      <ActionStateMessage state={state} />
    </form>
  );
}

export function V2GroupOnlyForfeitCorrectionForm({
  serverAction,
  matchId,
  fixtureId,
  expectedFixtureVersion,
  resultRevisionId,
  currentWinnerName,
  currentLoserName,
}: {
  serverAction: V2GroupOnlyResultServerAction;
  matchId: string;
  fixtureId: string;
  expectedFixtureVersion: number;
  resultRevisionId: string;
  currentWinnerName: string;
  currentLoserName: string;
}) {
  const action = serverAction.bind(null, matchId);
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);
  return (
    <form
      action={formAction}
      className="mt-3 space-y-2 rounded-lg border border-amber-500/25 bg-slate-950/35 p-3"
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
        更正弃权胜方：{currentWinnerName} → {currentLoserName}
      </p>
      <label className="block space-y-1 text-xs text-slate-300">
        <span>更正原因（必填）</span>
        <input
          type="text"
          name="reason"
          required
          maxLength={500}
          className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100"
        />
      </label>
      <p className="text-xs text-slate-400">
        胜负方由服务器固定交换；仍记为 1:0 弃权判胜，不产生积分或 ELO 结算。
      </p>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-amber-400/40 px-3 py-1.5 text-xs text-amber-200 hover:bg-amber-500/10 disabled:opacity-60"
      >
        {pending ? "处理中..." : "更正弃权胜方"}
      </button>
      <ActionStateMessage state={state} />
    </form>
  );
}
