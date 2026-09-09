"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { type MatchFormState, createMatchAction } from "@/app/matchs/actions";
import { VENUE_OPTIONS } from "@/lib/locations";

const initialState: MatchFormState = {};

export default function CreateMatchForm({
  v2SingleGroupOnlyCreationRequestKey,
  v2SingleGroupThenKnockoutCreationRequestKey,
  v2DoubleGroupOnlyCreationRequestKey,
  v2DoubleGroupThenKnockoutCreationRequestKey,
  v2TeamGroupOnlyCreationRequestKey,
  v2TeamGroupThenKnockoutCreationRequestKey,
}: Readonly<{
  v2SingleGroupOnlyCreationRequestKey: string | null;
  v2SingleGroupThenKnockoutCreationRequestKey: string | null;
  v2DoubleGroupOnlyCreationRequestKey: string | null;
  v2DoubleGroupThenKnockoutCreationRequestKey: string | null;
  v2TeamGroupOnlyCreationRequestKey: string | null;
  v2TeamGroupThenKnockoutCreationRequestKey: string | null;
}>) {
  const [state, formAction, pending] = useActionState(
    createMatchAction,
    initialState,
  );
  const [matchType, setMatchType] = useState<"single" | "double" | "team">(
    "single",
  );
  const [matchFormat, setMatchFormat] = useState<
    "group_only" | "group_then_knockout"
  >("group_only");
  const [stableV2SingleCreationRequestKey] = useState(
    () => v2SingleGroupOnlyCreationRequestKey,
  );
  const [stableV2SingleGroupThenKnockoutCreationRequestKey] = useState(
    () => v2SingleGroupThenKnockoutCreationRequestKey,
  );
  const [stableV2DoubleCreationRequestKey] = useState(
    () => v2DoubleGroupOnlyCreationRequestKey,
  );
  const [stableV2DoubleGroupThenKnockoutCreationRequestKey] = useState(
    () => v2DoubleGroupThenKnockoutCreationRequestKey,
  );
  const [stableV2TeamCreationRequestKey] = useState(
    () => v2TeamGroupOnlyCreationRequestKey,
  );
  const [stableV2TeamGroupThenKnockoutCreationRequestKey] = useState(
    () => v2TeamGroupThenKnockoutCreationRequestKey,
  );

  // Native date/time inputs: yyyy-MM-dd / HH:mm
  const [matchDate, setMatchDate] = useState("");
  const [matchTime, setMatchTime] = useState("19:00");
  const [deadlineDate, setDeadlineDate] = useState("");
  const [deadlineTime, setDeadlineTime] = useState("17:00");
  const [teamStartDate, setTeamStartDate] = useState("");
  const [teamStartTime, setTeamStartTime] = useState("09:00");
  const [teamMinMembers, setTeamMinMembers] = useState(3);
  const [teamMaxMembers, setTeamMaxMembers] = useState(6);
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
  const teamRegistrationStartValue =
    matchType === "team" && teamStartDate && teamStartTime
      ? `${teamStartDate}T${teamStartTime}`
      : "";
  const teamRegistrationDeadlineValue =
    matchType === "team"
      ? registrationDeadlineValue
      : "";

  const teamWindowInvalid =
    matchType === "team" &&
    teamRegistrationStartValue !== "" &&
    teamRegistrationDeadlineValue !== "" &&
    new Date(teamRegistrationStartValue) >=
      new Date(teamRegistrationDeadlineValue);

  const teamSizeInvalid =
    matchType === "team" &&
    (teamMinMembers < 1 ||
      teamMaxMembers < teamMinMembers ||
      teamMaxMembers > 50);

  const v2CreationRequestKey =
    matchFormat === "group_only"
      ? matchType === "single"
        ? stableV2SingleCreationRequestKey
        : matchType === "double"
          ? stableV2DoubleCreationRequestKey
          : stableV2TeamCreationRequestKey
      : matchType === "single"
        ? stableV2SingleGroupThenKnockoutCreationRequestKey
        : matchType === "double"
          ? stableV2DoubleGroupThenKnockoutCreationRequestKey
          : stableV2TeamGroupThenKnockoutCreationRequestKey;
  const submitsV2CreationRequestKey = v2CreationRequestKey !== null;

  return (
    <form action={formAction} className="space-y-8">
      {v2CreationRequestKey ? (
        <input
          type="hidden"
          name="creationRequestKey"
          value={v2CreationRequestKey}
        />
      ) : null}
      {/* ===== 基础信息 ===== */}
      <section className="surface-card rounded-3xl p-5">
        <h2 className="mb-4 text-sm font-black tracking-wide text-teal-100">
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
              className="input-dark w-full rounded-2xl px-4 py-2 text-slate-100 placeholder:text-slate-600"
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
              className="input-dark w-full rounded-2xl px-4 py-2 text-slate-100 placeholder:text-slate-600"
            />
          </div>
          <div>
            <label
              htmlFor="location"
              className="mb-1 block text-sm text-slate-300"
            >
              地点 *
            </label>
            <select
              id="location"
              name="location"
              required
              className="input-dark w-full rounded-2xl px-4 py-2 text-slate-100 placeholder:text-slate-600"
            >
              {VENUE_OPTIONS.map((venue) => (
                <option key={venue} value={venue}>
                  {venue}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {/* ===== 时间设置 ===== */}
      <section className="surface-card rounded-3xl p-5">
        <h2 className="mb-4 text-sm font-black tracking-wide text-teal-100">
          {submitsV2CreationRequestKey ? "时间设置（北京时间）" : "时间设置"}
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
        <input
          type="hidden"
          name="teamRegistrationStart"
          value={teamRegistrationStartValue}
        />
        <input
          type="hidden"
          name="teamRegistrationDeadline"
          value={teamRegistrationDeadlineValue}
        />

        <div className="grid gap-5 lg:grid-cols-2">
          {/* -- 比赛开始时间 -- */}
          <div className="rounded-3xl bg-slate-950/36 p-4 ring-1 ring-white/8">
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
                className="native-picker native-picker-date input-dark h-10 w-full rounded-2xl px-3 text-sm text-slate-100 accent-teal-500"
              />
              <input
                type="time"
                name="time"
                aria-label="比赛时间"
                required
                value={matchTime}
                step={1800}
                onChange={(e) => setMatchTime(e.target.value)}
                className="native-picker native-picker-time input-dark h-10 w-full rounded-2xl px-3 text-sm text-slate-100 accent-teal-500"
              />
            </div>
          </div>

          {/* -- 报名截止时间 -- */}
          <div className="rounded-3xl bg-slate-950/36 p-4 ring-1 ring-white/8">
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
                className="native-picker native-picker-date input-dark h-10 w-full rounded-2xl px-3 text-sm text-slate-100 accent-teal-500"
              />
              <input
                type="time"
                name="deadlineTime"
                aria-label="截止时间"
                required
                value={deadlineTime}
                step={1800}
                onChange={(e) => setDeadlineTime(e.target.value)}
                className="native-picker native-picker-time input-dark h-10 w-full rounded-2xl px-3 text-sm text-slate-100 accent-teal-500"
              />
            </div>
          </div>
        </div>
        {timeError ? (
          <p className="mt-2 text-sm text-rose-300">{timeError}</p>
        ) : null}
      </section>

      {/* ===== 赛制 ===== */}
      <section className="surface-card rounded-3xl p-5">
        <h2 className="mb-4 text-sm font-black tracking-wide text-teal-100">
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
              value={matchType}
              onChange={(e) =>
                setMatchType(e.target.value as "single" | "double" | "team")
              }
              className="input-dark w-full rounded-2xl px-4 py-2 text-slate-100"
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
              className="input-dark w-full rounded-2xl px-4 py-2 text-slate-100"
            >
              <option value="group_only">分组比赛</option>
              <option value="group_then_knockout">前期分组后期淘汰</option>
            </select>
          </div>
        </div>
        {matchType !== "team" ? (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {[{ name: "groupBestOf", label: "小组赛局制" }, ...(matchFormat === "group_then_knockout" ? [{ name: "knockoutBestOf", label: "淘汰赛局制" }] : [])].map(field => (
              <label key={field.name} className="space-y-2 text-sm text-slate-300">
                <span>{field.label}</span>
                <select name={field.name} defaultValue="5" className="input-dark w-full rounded-2xl px-4 py-2">
                  <option value="3">三局两胜</option><option value="5">五局三胜</option><option value="7">七局四胜</option>
                </select>
              </label>
            ))}
          </div>
        ) : <p className="mt-4 text-sm text-slate-400">团体赛录入队伍总比分，按每场名单整队结算。</p>}
        <div className="mt-4 rounded-2xl bg-teal-400/8 px-3 py-2 text-xs leading-5 text-teal-100 ring-1 ring-teal-300/12">
          {formatTips}
        </div>
      </section>

      {matchType === "team" ? (
        <section className="surface-card rounded-3xl p-5">
          <h2 className="mb-4 text-sm font-black tracking-wide text-teal-100">
            团体报名
          </h2>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label
                htmlFor="teamMinMembers"
                className="mb-1 block text-sm text-slate-300"
              >
                最少队伍人数 *
              </label>
              <input
                id="teamMinMembers"
                name="teamMinMembers"
                type="number"
                min={1}
                max={50}
                required
                value={teamMinMembers}
                onChange={(e) => setTeamMinMembers(Number(e.target.value))}
                className="input-dark w-full rounded-2xl px-4 py-2 text-slate-100"
              />
            </div>
            <div>
              <label
                htmlFor="teamMaxMembers"
                className="mb-1 block text-sm text-slate-300"
              >
                最多队伍人数 *
              </label>
              <input
                id="teamMaxMembers"
                name="teamMaxMembers"
                type="number"
                min={teamMinMembers}
                max={50}
                required
                value={teamMaxMembers}
                onChange={(e) => setTeamMaxMembers(Number(e.target.value))}
                className="input-dark w-full rounded-2xl px-4 py-2 text-slate-100"
              />
            </div>
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <div className="rounded-3xl bg-slate-950/36 p-4 ring-1 ring-white/8">
              <p className="mb-3 text-sm font-medium text-slate-200">
                团体报名开始时间 *
              </p>
              <div className="space-y-3">
                <input
                  type="date"
                  aria-label="团体报名开始日期"
                  required
                  value={teamStartDate}
                  onChange={(e) => setTeamStartDate(e.target.value)}
                  className="native-picker native-picker-date input-dark h-10 w-full rounded-2xl px-3 text-sm text-slate-100 accent-teal-500"
                />
                <input
                  type="time"
                  aria-label="团体报名开始时间"
                  required
                  value={teamStartTime}
                  step={1800}
                  onChange={(e) => setTeamStartTime(e.target.value)}
                  className="native-picker native-picker-time input-dark h-10 w-full rounded-2xl px-3 text-sm text-slate-100 accent-teal-500"
                />
              </div>
            </div>


          </div>

          {teamWindowInvalid ? (
            <p className="mt-2 text-sm text-rose-300">
              团体报名开始时间必须早于截止时间。
            </p>
          ) : null}
          {teamSizeInvalid ? (
            <p className="mt-2 text-sm text-rose-300">
              队伍人数范围应为 1 到 50，且最多人数不能少于最少人数。
            </p>
          ) : null}
        </section>
      ) : null}

      {state.error && <p className="text-sm text-rose-300">{state.error}</p>}
      {state.success && (
        <p className="text-sm text-emerald-300">{state.success}</p>
      )}

      <button
        disabled={pending || !!timeError || teamWindowInvalid || teamSizeInvalid}
        className="btn-primary w-full rounded-2xl py-3 font-bold text-white disabled:opacity-60"
      >
        {pending ? "发布中..." : "发布比赛"}
      </button>
    </form>
  );
}
