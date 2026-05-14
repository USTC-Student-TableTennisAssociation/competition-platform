"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { type MatchFormState, createMatchAction } from "@/app/matchs/actions";

const initialState: MatchFormState = {};

export default function CreateMatchForm() {
  const [state, formAction, pending] = useActionState(
    createMatchAction,
    initialState,
  );
  const [matchFormat, setMatchFormat] = useState<
    "group_only" | "group_then_knockout"
  >("group_only");

  // Native date/time inputs: yyyy-MM-dd / HH:mm
  const [matchDate, setMatchDate] = useState("");
  const [matchTime, setMatchTime] = useState("19:00");
  const [deadlineDate, setDeadlineDate] = useState("");
  const [deadlineTime, setDeadlineTime] = useState("17:00");
  const timezoneOffsetInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!timezoneOffsetInputRef.current) return;
    timezoneOffsetInputRef.current.value = String(
      new Date().getTimezoneOffset(),
    );
  }, []);

  const formatTips = useMemo(() => {
    if (matchFormat === "group_then_knockout") {
      return "先按积分均衡分组，再进入淘汰赛。报名截止后由发起人/管理员手动配置组数与晋级人数并确认发布。";
    }
    return "仅进行分组赛。报名截止后由发起人/管理员手动配置组数并确认发布。";
  }, [matchFormat]);

  function toDateTime(date: string, time: string) {
    if (!date || !time) return null;
    return new Date(`${date}T${time}`);
  }

  const matchDateTime = toDateTime(matchDate, matchTime);
  const deadlineDateTime = toDateTime(deadlineDate, deadlineTime);

  const isTimeValid =
    matchDate !== "" &&
    deadlineDate !== "" &&
    matchDateTime !== null &&
    deadlineDateTime !== null &&
    deadlineDateTime < matchDateTime;

  const timeError =
    matchDate &&
    deadlineDate &&
    matchDateTime &&
    deadlineDateTime &&
    !isTimeValid
      ? "报名截止时间必须早于比赛开始时间。"
      : null;

  // Hidden fields: keep the names the server action expects
  const matchDateTimeValue = matchDateTime ? `${matchDate}T${matchTime}` : "";
  const registrationDeadlineValue = deadlineDateTime
    ? `${deadlineDate}T${deadlineTime}`
    : "";

  return (
    <form action={formAction} className="space-y-8">
      {/* ===== 基础信息 ===== */}
      <section className="rounded-xl border border-slate-700 bg-slate-800/60 p-5">
        <h2 className="mb-4 text-sm font-semibold tracking-wide text-cyan-200">
          基础信息
        </h2>
        <div className="space-y-4">
          <div>
            <label
              htmlFor="title"
              className="mb-1 block text-sm text-slate-300"
            >
              比赛名称 *
            </label>
            <input
              id="title"
              name="title"
              required
              placeholder="例如：校内春季积分赛"
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-4 py-2 text-slate-100 placeholder:text-slate-500"
            />
          </div>
          <div>
            <label
              htmlFor="description"
              className="mb-1 block text-sm text-slate-300"
            >
              比赛描述
            </label>
            <textarea
              id="description"
              name="description"
              rows={4}
              placeholder="简要说明比赛规则、奖项和注意事项"
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-4 py-2 text-slate-100 placeholder:text-slate-500"
            />
          </div>
          <div>
            <label
              htmlFor="location"
              className="mb-1 block text-sm text-slate-300"
            >
              地点 *
            </label>
            <input
              id="location"
              name="location"
              required
              placeholder="例如：西区体育馆二楼"
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-4 py-2 text-slate-100 placeholder:text-slate-500"
            />
          </div>
        </div>
      </section>

      {/* ===== 时间设置 ===== */}
      <section className="rounded-xl border border-slate-700 bg-slate-800/60 p-5">
        <h2 className="mb-4 text-sm font-semibold tracking-wide text-cyan-200">
          时间设置
        </h2>

        {/* Hidden fields for server */}
        <input
          ref={timezoneOffsetInputRef}
          type="hidden"
          name="timezoneOffset"
          defaultValue=""
        />
        <input type="hidden" name="matchDateTime" value={matchDateTimeValue} />
        <input
          type="hidden"
          name="registrationDeadline"
          value={registrationDeadlineValue}
        />

        <div className="grid gap-5 lg:grid-cols-2">
          {/* -- 比赛开始时间 -- */}
          <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-4">
            <p className="mb-3 text-sm font-medium text-slate-200">
              比赛开始时间 *
            </p>
            <div className="space-y-3">
              <input
                type="date"
                name="date"
                aria-label="比赛日期"
                required
                value={matchDate}
                onChange={(e) => setMatchDate(e.target.value)}
                className="native-picker native-picker-date h-10 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 text-sm text-slate-100 accent-cyan-500"
              />
              <input
                type="time"
                name="time"
                aria-label="比赛时间"
                required
                value={matchTime}
                step={1800}
                onChange={(e) => setMatchTime(e.target.value)}
                className="native-picker native-picker-time h-10 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 text-sm text-slate-100 accent-cyan-500"
              />
            </div>
          </div>

          {/* -- 报名截止时间 -- */}
          <div className="rounded-xl border border-slate-700 bg-slate-900/70 p-4">
            <p className="mb-3 text-sm font-medium text-slate-200">
              报名截止时间 *
            </p>
            <div className="space-y-3">
              <input
                type="date"
                name="deadlineDate"
                aria-label="截止日期"
                required
                value={deadlineDate}
                max={matchDate || undefined}
                onChange={(e) => setDeadlineDate(e.target.value)}
                className="native-picker native-picker-date h-10 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 text-sm text-slate-100 accent-cyan-500"
              />
              <input
                type="time"
                name="deadlineTime"
                aria-label="截止时间"
                required
                value={deadlineTime}
                step={1800}
                onChange={(e) => setDeadlineTime(e.target.value)}
                className="native-picker native-picker-time h-10 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 text-sm text-slate-100 accent-cyan-500"
              />
            </div>
          </div>
        </div>
        {timeError ? (
          <p className="mt-2 text-sm text-rose-300">{timeError}</p>
        ) : null}
      </section>

      {/* ===== 赛制 ===== */}
      <section className="rounded-xl border border-slate-700 bg-slate-800/60 p-5">
        <h2 className="mb-4 text-sm font-semibold tracking-wide text-cyan-200">
          赛制
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="type" className="mb-1 block text-sm text-slate-300">
              比赛类型
            </label>
            <select
              id="type"
              name="type"
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-4 py-2 text-slate-100"
            >
              <option value="single">单打</option>
              <option value="double">双打</option>
              <option value="team">团体</option>
            </select>
          </div>
          <div>
            <label
              htmlFor="format"
              className="mb-1 block text-sm text-slate-300"
            >
              赛制 *
            </label>
            <select
              id="format"
              name="format"
              value={matchFormat}
              onChange={(e) =>
                setMatchFormat(
                  e.target.value as "group_only" | "group_then_knockout",
                )
              }
              className="w-full rounded-lg border border-slate-600 bg-slate-900 px-4 py-2 text-slate-100"
            >
              <option value="group_only">分组比赛</option>
              <option value="group_then_knockout">前期分组后期淘汰</option>
            </select>
          </div>
        </div>
        <div className="mt-4 rounded-lg border border-cyan-400/25 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100">
          {formatTips}
        </div>
      </section>

      {state.error && <p className="text-sm text-rose-300">{state.error}</p>}
      {state.success && (
        <p className="text-sm text-emerald-300">{state.success}</p>
      )}

      <button
        disabled={pending || !!timeError}
        className="w-full rounded-lg bg-linear-to-r from-cyan-500 to-blue-500 py-3 font-semibold text-white disabled:opacity-60"
      >
        {pending ? "发布中..." : "发布比赛"}
      </button>
    </form>
  );
}
