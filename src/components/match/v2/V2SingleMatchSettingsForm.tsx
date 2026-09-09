"use client";

import { useActionState, useEffect, useRef } from "react";

import { updateV2SingleMatchSettingsAction } from "@/app/matchs/v2-actions";
import { VENUE_OPTIONS } from "@/lib/locations";
import type { V2SingleMatchSettingsState } from "@/modules/competitions-v2/adapters/single-match-settings";
import { getV2CompetitionLocalDateTimeParts } from "@/modules/competitions-v2/competition-time";

type Props = Readonly<{
  matchId: string;
  expectedUpdatedAt: string;
  initial: Readonly<{
    title: string;
    description: string;
    location: string;
    dateTimeIso: string;
    registrationDeadlineIso: string;
  }>;
}>;

export default function V2SingleMatchSettingsForm({
  matchId,
  expectedUpdatedAt: initialUpdatedAt,
  initial,
}: Props) {
  const action = updateV2SingleMatchSettingsAction.bind(null, matchId);
  const [state, formAction, pending] = useActionState<
    V2SingleMatchSettingsState,
    FormData
  >(action, {});
  const expectedUpdatedAtRef = useRef<HTMLInputElement | null>(null);
  const matchDateRef = useRef<HTMLInputElement | null>(null);
  const matchTimeRef = useRef<HTMLInputElement | null>(null);
  const deadlineDateRef = useRef<HTMLInputElement | null>(null);
  const deadlineTimeRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (state.updatedAt && expectedUpdatedAtRef.current) {
      expectedUpdatedAtRef.current.value = state.updatedAt;
    }
  }, [state.updatedAt]);

  useEffect(() => {
    const match = getV2CompetitionLocalDateTimeParts(initial.dateTimeIso);
    const deadline = getV2CompetitionLocalDateTimeParts(
      initial.registrationDeadlineIso,
    );
    if (matchDateRef.current) matchDateRef.current.value = match.date;
    if (matchTimeRef.current) matchTimeRef.current.value = match.time;
    if (deadlineDateRef.current) deadlineDateRef.current.value = deadline.date;
    if (deadlineTimeRef.current) deadlineTimeRef.current.value = deadline.time;
  }, [initial.dateTimeIso, initial.registrationDeadlineIso]);

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <input
        ref={expectedUpdatedAtRef}
        type="hidden"
        name="expectedUpdatedAt"
        defaultValue={initialUpdatedAt}
      />
      <div>
        <label htmlFor="v2-settings-title" className="mb-1 block text-sm text-slate-300">
          比赛名称 *
        </label>
        <input
          id="v2-settings-title"
          name="title"
          required
          maxLength={200}
          defaultValue={initial.title}
          className="w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-slate-100"
        />
      </div>

      <div className="rounded-xl border border-slate-700 bg-slate-950/35 p-4">
        <h2 className="mb-4 text-sm font-semibold text-cyan-200">
          时间设置（北京时间）
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3">
            <p className="text-sm text-slate-300">比赛开始时间 *</p>
            <input
              ref={matchDateRef}
              type="date"
              name="date"
              aria-label="比赛日期"
              required
              defaultValue=""
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-slate-100"
            />
            <input
              ref={matchTimeRef}
              type="time"
              name="time"
              aria-label="比赛时间"
              required
              step={1800}
              defaultValue=""
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-slate-100"
            />
          </div>
          <div className="space-y-3">
            <p className="text-sm text-slate-300">报名截止时间 *</p>
            <input
              ref={deadlineDateRef}
              type="date"
              name="deadlineDate"
              aria-label="截止日期"
              required
              defaultValue=""
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-slate-100"
            />
            <input
              ref={deadlineTimeRef}
              type="time"
              name="deadlineTime"
              aria-label="截止时间"
              required
              step={1800}
              defaultValue=""
              className="w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-slate-100"
            />
          </div>
        </div>
        <p className="mt-3 text-xs leading-5 text-slate-400">
          新的报名截止时间必须晚于当前时间且早于比赛开始时间；如需立即关闭报名，应使用单独的结束报名操作。
        </p>
      </div>

      <div>
        <label
          htmlFor="v2-settings-description"
          className="mb-1 block text-sm text-slate-300"
        >
          比赛描述
        </label>
        <textarea
          id="v2-settings-description"
          name="description"
          rows={4}
          maxLength={5_000}
          defaultValue={initial.description}
          className="w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-slate-100"
        />
      </div>

      <div>
        <label
          htmlFor="v2-settings-location"
          className="mb-1 block text-sm text-slate-300"
        >
          地点 *
        </label>
        <select
          id="v2-settings-location"
          name="location"
          required
          defaultValue={initial.location}
          className="w-full rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-slate-100"
        >
          {VENUE_OPTIONS.map((venue) => (
            <option key={venue} value={venue}>
              {venue}
            </option>
          ))}
        </select>
      </div>

      <div className="rounded-lg border border-slate-700 bg-slate-950/35 p-3 text-xs leading-5 text-slate-400">
        比赛类型、赛制、引擎和报名规则不会被此表单修改。
      </div>

      {state.error ? <p className="text-sm text-rose-300">{state.error}</p> : null}
      {state.success ? (
        <p className="text-sm text-emerald-300">{state.success}</p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-linear-to-r from-cyan-500 to-blue-500 py-3 font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {pending ? "正在保存..." : "保存基本信息"}
      </button>
    </form>
  );
}
