"use client";

import { useActionState, useMemo, useState } from "react";
import {
  confirmMatchResultAction,
  rejectMatchResultAction,
  submitTeamMatchResultAction,
  swapConfirmedMatchResultWinnerLoserAction,
  type MatchFormState,
} from "@/app/matchs/actions";

const initialState: MatchFormState = {};

export type TeamMatchResultTeam = {
  id: string;
  name: string;
  captainId: string;
  captainNickname: string;
  members: Array<{ userId: string; nickname: string }>;
};

export type TeamMatchResultItem = {
  id: string;
  confirmed: boolean;
  reporterId: string;
  reporterName: string;
  verifierName: string | null;
  winnerMatchTeamId: string | null;
  loserMatchTeamId: string | null;
  winnerTeamName: string;
  loserTeamName: string;
  winnerScore: number | null;
  loserScore: number | null;
  winnerMembers: string[];
  loserMembers: string[];
  remark: string;
  createdAt: string;
};

function ActionMessage({ state }: { state: MatchFormState }) {
  if (state.error) return <p className="text-sm text-rose-300">{state.error}</p>;
  if (state.success) {
    return <p className="text-sm text-emerald-300">{state.success}</p>;
  }
  return null;
}

function ConfirmTeamResultButton({
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
    <form action={formAction} className="mt-3 space-y-2">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <button
        type="submit"
        disabled={pending}
        className="rounded-xl border border-emerald-400/35 px-3 py-1.5 text-xs font-bold text-emerald-200 hover:bg-emerald-400/10 disabled:opacity-60"
      >
        {pending ? "确认中..." : "确认该团体赛结果"}
      </button>
      <ActionMessage state={state} />
    </form>
  );
}

function CorrectTeamResultButton({
  matchId,
  resultId,
}: {
  matchId: string;
  resultId: string;
}) {
  const action = async (_: MatchFormState, formData: FormData) =>
    swapConfirmedMatchResultWinnerLoserAction(matchId, resultId, formData);
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="mt-3 space-y-2">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <button
        type="submit"
        disabled={pending}
        className="rounded-xl border border-amber-400/35 px-3 py-1.5 text-xs font-bold text-amber-200 hover:bg-amber-400/10 disabled:opacity-60"
      >
        {pending ? "纠错中..." : "交换胜负并修正结算"}
      </button>
      <ActionMessage state={state} />
    </form>
  );
}

function RejectTeamResultButton({
  matchId,
  resultId,
}: {
  matchId: string;
  resultId: string;
}) {
  const action = async (_: MatchFormState, formData: FormData) =>
    rejectMatchResultAction(matchId, resultId, formData);
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="mt-3 space-y-2">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <button
        type="submit"
        disabled={pending}
        className="rounded-xl border border-rose-400/35 px-3 py-1.5 text-xs font-bold text-rose-200 hover:bg-rose-400/10 disabled:opacity-60"
      >
        {pending ? "否决中..." : "否决并删除待确认结果"}
      </button>
      <ActionMessage state={state} />
    </form>
  );
}

function ResultCard({
  item,
  matchId,
  currentUserId,
  isManager,
  captainTeamIds,
}: {
  item: TeamMatchResultItem;
  matchId: string;
  currentUserId: string | null;
  isManager: boolean;
  captainTeamIds: Set<string>;
}) {
  const isParticipatingCaptain = Boolean(
    (item.winnerMatchTeamId && captainTeamIds.has(item.winnerMatchTeamId)) ||
      (item.loserMatchTeamId && captainTeamIds.has(item.loserMatchTeamId)),
  );
  const canConfirm =
    !item.confirmed &&
    Boolean(currentUserId) &&
    (isManager || (isParticipatingCaptain && item.reporterId !== currentUserId));

  return (
    <article className="rounded-2xl bg-slate-950/36 p-4 ring-1 ring-white/8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-base font-black text-slate-100">
            {item.winnerTeamName} <span className="text-emerald-300">胜</span>{" "}
            {item.loserTeamName}
          </p>
          <p className="mt-1 text-sm font-bold tabular-nums text-teal-100">
            比分 {item.winnerScore ?? "-"}:{item.loserScore ?? "-"}
          </p>
        </div>
        <span
          className={`status-pill ring-1 ${
            item.confirmed
              ? "bg-emerald-400/12 text-emerald-100 ring-emerald-300/18"
              : "bg-amber-400/12 text-amber-100 ring-amber-300/18"
          }`}
        >
          {item.confirmed ? "已确认" : "待确认"}
        </span>
      </div>

      <div className="mt-3 grid gap-2 text-xs text-slate-300 md:grid-cols-2">
        <p className="rounded-xl bg-white/[0.025] px-3 py-2 ring-1 ring-white/8">
          胜方结算成员：{item.winnerMembers.join("、") || "无"}
        </p>
        <p className="rounded-xl bg-white/[0.025] px-3 py-2 ring-1 ring-white/8">
          负方结算成员：{item.loserMembers.join("、") || "无"}
        </p>
      </div>

      <p className="mt-3 text-xs text-slate-400">
        提交人：{item.reporterName} · {new Date(item.createdAt).toLocaleString("zh-CN")}
        {item.verifierName ? ` · 确认人：${item.verifierName}` : ""}
      </p>
      {item.remark ? (
        <p className="mt-2 text-sm text-slate-300">备注：{item.remark}</p>
      ) : null}

      {canConfirm ? (
        <ConfirmTeamResultButton matchId={matchId} resultId={item.id} />
      ) : !item.confirmed && item.reporterId === currentUserId && !isManager ? (
        <p className="mt-3 text-xs text-amber-300">等待对方队长或管理员确认。</p>
      ) : null}
      {!item.confirmed && isManager ? (
        <RejectTeamResultButton matchId={matchId} resultId={item.id} />
      ) : null}
      {item.confirmed && isManager ? (
        <CorrectTeamResultButton matchId={matchId} resultId={item.id} />
      ) : null}
    </article>
  );
}

export default function TeamMatchResultsPanel({
  matchId,
  currentUserId,
  isManager,
  matchFinished,
  teams,
  results,
}: {
  matchId: string;
  currentUserId: string | null;
  isManager: boolean;
  matchFinished: boolean;
  teams: TeamMatchResultTeam[];
  results: TeamMatchResultItem[];
}) {
  const captainedTeam = currentUserId
    ? teams.find((team) => team.captainId === currentUserId) ?? null
    : null;
  const canSubmit =
    !matchFinished && teams.length >= 2 && Boolean(isManager || captainedTeam);
  const initialTeamAId = captainedTeam?.id ?? teams[0]?.id ?? "";
  const [teamAId, setTeamAId] = useState(initialTeamAId);
  const availableOpponents = useMemo(
    () => teams.filter((team) => team.id !== teamAId),
    [teams, teamAId],
  );
  const [teamBId, setTeamBId] = useState(
    teams.find((team) => team.id !== initialTeamAId)?.id ?? "",
  );
  const selectedTeamBId = availableOpponents.some((team) => team.id === teamBId)
    ? teamBId
    : (availableOpponents[0]?.id ?? "");
  const action = submitTeamMatchResultAction.bind(null, matchId);
  const [state, formAction, pending] = useActionState(action, initialState);
  const pendingResults = results.filter((result) => !result.confirmed);
  const confirmedResults = results.filter((result) => result.confirmed);
  const captainTeamIds = new Set(
    teams
      .filter((team) => team.captainId === currentUserId)
      .map((team) => team.id),
  );

  return (
    <section className="surface-card rounded-3xl p-4 sm:p-6">
      <p className="eyebrow">Team Results</p>
      <h2 className="mt-1 text-xl font-black text-white sm:text-2xl">
        团体赛赛果
      </h2>
      <p className="mt-2 text-sm leading-6 text-slate-400">
        团体比分按一场团队胜负结算。确认后，以提交时双方全队有效成员快照统一计算 ELO、胜负场和积分。
      </p>

      <div className="mt-5 rounded-2xl bg-slate-950/24 p-4 ring-1 ring-white/8">
        <h3 className="text-base font-bold text-slate-100">已批准参赛队伍</h3>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {teams.length === 0 ? (
            <p className="text-sm text-slate-400">暂无已批准队伍。</p>
          ) : (
            teams.map((team) => (
              <div
                key={team.id}
                className="rounded-xl bg-white/[0.025] px-3 py-2 ring-1 ring-white/8"
              >
                <p className="text-sm font-bold text-slate-100">{team.name}</p>
                <p className="mt-1 text-xs text-slate-400">
                  队长：{team.captainNickname} · 成员：
                  {team.members.map((member) => member.nickname).join("、")}
                </p>
              </div>
            ))
          )}
        </div>
      </div>

      {canSubmit ? (
        <form
          action={formAction}
          className="mt-5 space-y-4 rounded-2xl border border-teal-400/20 bg-teal-400/5 p-4"
        >
          <input type="hidden" name="csrfToken" defaultValue="" />
          <h3 className="text-base font-bold text-teal-100">提交团体赛结果</h3>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-sm text-slate-300">
              <span>{isManager ? "队伍 A" : "我的队伍"}</span>
              {isManager ? (
                <select
                  name="teamAId"
                  value={teamAId}
                  onChange={(event) => setTeamAId(event.target.value)}
                  className="input-dark h-10 w-full rounded-xl px-3"
                >
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  <input
                    readOnly
                    value={captainedTeam?.name ?? ""}
                    className="input-dark h-10 w-full rounded-xl px-3"
                  />
                  <input type="hidden" name="teamAId" value={captainedTeam?.id ?? ""} />
                </>
              )}
            </label>

            <label className="space-y-1 text-sm text-slate-300">
              <span>对手队伍</span>
              <select
                name="teamBId"
                value={selectedTeamBId}
                onChange={(event) => setTeamBId(event.target.value)}
                className="input-dark h-10 w-full rounded-xl px-3"
              >
                {availableOpponents.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-sm text-slate-300">
              <span>队伍 A 比分</span>
              <input
                name="teamAScore"
                type="number"
                min={0}
                step={1}
                required
                className="input-dark h-10 w-full rounded-xl px-3"
              />
            </label>
            <label className="space-y-1 text-sm text-slate-300">
              <span>队伍 B 比分</span>
              <input
                name="teamBScore"
                type="number"
                min={0}
                step={1}
                required
                className="input-dark h-10 w-full rounded-xl px-3"
              />
            </label>
          </div>

          <label className="block space-y-1 text-sm text-slate-300">
            <span>备注（可选）</span>
            <textarea
              name="remark"
              maxLength={500}
              rows={2}
              className="input-dark w-full rounded-xl px-3 py-2"
            />
          </label>

          <ActionMessage state={state} />
          <button
            type="submit"
            disabled={pending || !selectedTeamBId}
            className="rounded-xl bg-teal-600 px-4 py-2 text-sm font-bold text-white hover:bg-teal-500 disabled:opacity-60"
          >
            {pending ? "提交中..." : "提交结果，等待确认"}
          </button>
        </form>
      ) : (
        <p className="mt-5 text-sm text-slate-400">
          {matchFinished
            ? "比赛已结束，不能继续提交新赛果。"
            : "只有参赛队长、比赛发起人或管理员可提交；且至少需要两支已批准队伍。"}
        </p>
      )}

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <div>
          <h3 className="text-base font-bold text-white">待确认结果</h3>
          <div className="mt-3 space-y-3">
            {pendingResults.length === 0 ? (
              <p className="text-sm text-slate-400">当前没有待确认团体赛结果。</p>
            ) : (
              pendingResults.map((item) => (
                <ResultCard
                  key={item.id}
                  item={item}
                  matchId={matchId}
                  currentUserId={currentUserId}
                  isManager={isManager}
                  captainTeamIds={captainTeamIds}
                />
              ))
            )}
          </div>
        </div>

        <div>
          <h3 className="text-base font-bold text-white">已确认结果</h3>
          <div className="mt-3 space-y-3">
            {confirmedResults.length === 0 ? (
              <p className="text-sm text-slate-400">当前没有已确认团体赛结果。</p>
            ) : (
              confirmedResults.map((item) => (
                <ResultCard
                  key={item.id}
                  item={item}
                  matchId={matchId}
                  currentUserId={currentUserId}
                  isManager={isManager}
                  captainTeamIds={captainTeamIds}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
