"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import {
  confirmMatchResultAction,
  submitKnockoutMatchResultAction,
  submitGroupMatchResultAction,
  type MatchFormState,
} from "@/app/matchs/actions";

const initialState: MatchFormState = {};

type PendingResult = {
  id: string;
  reporterId: string;
  reporterName: string;
  winnerLabel: string;
  loserLabel: string;
  scoreText: string;
};

function PendingResultConfirmButton({
  matchId,
  resultId,
}: {
  matchId: string;
  resultId: string;
}) {
  const action = async (_: MatchFormState, formData: FormData) =>
    confirmMatchResultAction(matchId, resultId, formData);
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="mt-2 space-y-1">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-emerald-500/40 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-60"
      >
        {pending ? "确认中..." : "我确认该结果"}
      </button>
      {state.error ? (
        <p className="text-xs text-rose-300">{state.error}</p>
      ) : null}
      {state.success ? (
        <p className="text-xs text-emerald-300">{state.success}</p>
      ) : null}
    </form>
  );
}

export default function ReportResultForm({
  matchId,
  currentUserId,
  mode = "group",
  opponents = [],
  knockoutOpponent,
  pendingResults,
}: {
  matchId: string;
  currentUserId: string;
  mode?: "group" | "knockout";
  opponents?: Array<{ id: string; nickname: string; played: boolean }>;
  knockoutOpponent?: { id: string; nickname: string } | null;
  pendingResults: PendingResult[];
}) {
  const [bestOf, setBestOf] = useState<3 | 5 | 7>(5);
  const submitActionHandler =
    mode === "knockout"
      ? submitKnockoutMatchResultAction.bind(null, matchId)
      : submitGroupMatchResultAction.bind(null, matchId);
  const [submitState, submitAction, submitPending] = useActionState(
    submitActionHandler,
    initialState,
  );

  const winsNeeded = Math.floor(bestOf / 2) + 1;
  const [myScore, setMyScore] = useState(winsNeeded);
  const [opponentScore, setOpponentScore] = useState(
    Math.max(0, winsNeeded - 1),
  );

  useEffect(() => {
    setMyScore(winsNeeded);
    setOpponentScore(Math.max(0, winsNeeded - 1));
  }, [winsNeeded]);

  const scoreOptions = Array.from(
    { length: winsNeeded + 1 },
    (_, index) => index,
  );

  const unplayedOpponents = useMemo(
    () => opponents.filter((o) => !o.played),
    [opponents],
  );

  return (
    <div className="space-y-4 sm:space-y-6">
      <form
        action={submitAction}
        className="space-y-3 rounded-xl border border-slate-700 bg-slate-800/50 p-3 sm:space-y-4 sm:p-4"
      >
        <input type="hidden" name="csrfToken" defaultValue="" />
        <p className="text-xs text-slate-300 sm:text-sm">
          {mode === "knockout"
            ? "当前为淘汰赛阶段，请登记本轮对局结果。提交后需由对手或管理员确认。"
            : "系统会根据你当前小组中尚未对战的对手自动筛选可登记对象。提交后需由对手或管理员确认。"}
        </p>
        <p className="text-xs text-slate-400">
          积分规则：报名 +1，单场胜利（确认后）+1；单人单赛事最多获得 5 分。
        </p>

        <div className="grid grid-cols-2 gap-2 sm:gap-3">
          {mode === "knockout" ? (
            <label className="block space-y-1 text-xs text-slate-300 sm:text-sm">
              <span>本轮对手</span>
              <input
                readOnly
                value={knockoutOpponent?.nickname ?? "待定"}
                className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2.5 text-sm text-slate-100"
              />
              <input
                type="hidden"
                name="opponentId"
                value={knockoutOpponent?.id ?? ""}
              />
            </label>
          ) : (
            <label className="block space-y-1 text-xs text-slate-300 sm:text-sm">
              <span>选择对手</span>
              <select
                name="opponentId"
                required
                className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2.5 text-sm text-slate-100"
              >
                <option value="">请选择</option>
                {unplayedOpponents.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.nickname}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="block space-y-1 text-xs text-slate-300 sm:text-sm">
            <span>本场结果</span>
            <select
              name="didWin"
              className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2.5 text-sm text-slate-100"
            >
              <option value="true">我获胜</option>
              <option value="false">我失利</option>
            </select>
          </label>
        </div>

        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          <label className="block space-y-1 text-xs text-slate-300 sm:text-sm">
            <span>局制</span>
            <select
              name="bestOf"
              required
              value={bestOf}
              onChange={(event) =>
                setBestOf(Number(event.target.value) as 3 | 5 | 7)
              }
              className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100"
            >
              <option value={3}>3局2胜</option>
              <option value={5}>5局3胜</option>
              <option value={7}>7局4胜</option>
            </select>
          </label>

          <label className="block space-y-1 text-xs text-slate-300 sm:text-sm">
            <span>我方局分</span>
            <select
              name="myScore"
              required
              value={myScore}
              onChange={(event) => setMyScore(Number(event.target.value))}
              className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100"
            >
              {scoreOptions.map((score) => (
                <option key={`my-${bestOf}-${score}`} value={score}>
                  {score}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1 text-xs text-slate-300 sm:text-sm">
            <span>对手局分</span>
            <select
              name="opponentScore"
              required
              value={opponentScore}
              onChange={(event) => setOpponentScore(Number(event.target.value))}
              className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100"
            >
              {scoreOptions.map((score) => (
                <option key={`opp-${bestOf}-${score}`} value={score}>
                  {score}
                </option>
              ))}
            </select>
          </label>
        </div>

        {submitState.error ? (
          <p className="text-sm text-rose-300">{submitState.error}</p>
        ) : null}
        {submitState.success ? (
          <p className="text-sm text-emerald-300">{submitState.success}</p>
        ) : null}

        <button
          type="submit"
          disabled={
            submitPending ||
            (mode === "group"
              ? unplayedOpponents.length === 0
              : !knockoutOpponent?.id)
          }
          className="w-full rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
        >
          {submitPending
            ? "提交中..."
            : mode === "group"
              ? unplayedOpponents.length === 0
                ? "当前无可登记对手"
                : "提交登记，等待确认"
              : !knockoutOpponent?.id
                ? "对手尚未产生"
                : "提交登记，等待确认"}
        </button>
      </form>

      <div className="space-y-2.5 rounded-xl border border-slate-700 bg-slate-800/40 p-3 sm:space-y-3 sm:p-4">
        <h3 className="text-sm font-semibold text-slate-100">待确认赛果</h3>
        {pendingResults.length === 0 ? (
          <p className="text-sm text-slate-400">当前没有待确认赛果。</p>
        ) : (
          pendingResults.map((item) => (
            <div
              key={item.id}
              className="rounded-lg border border-slate-700 bg-slate-900/70 p-3"
            >
              <p className="text-sm text-slate-200">
                {item.winnerLabel} 胜 {item.loserLabel}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                登记人：{item.reporterName}{" "}
                {item.scoreText ? `· 比分 ${item.scoreText}` : ""}
              </p>
              {item.reporterId === currentUserId ? (
                <p className="mt-2 text-xs text-amber-300">等待对方确认中</p>
              ) : (
                <PendingResultConfirmButton
                  matchId={matchId}
                  resultId={item.id}
                />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
