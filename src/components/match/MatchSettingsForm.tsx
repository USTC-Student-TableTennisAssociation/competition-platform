"use client";

import { useActionState } from "react";
import {
  type MatchFormState,
  updateMatchFormatAction,
} from "@/app/matchs/actions";

type Props = {
  matchId: string;
  format: "group_only" | "group_then_knockout";
  registrationDeadline: string;
};

const initialState: MatchFormState = {};

export default function MatchSettingsForm({
  matchId,
  format,
  registrationDeadline,
}: Props) {
  const action = updateMatchFormatAction.bind(null, matchId);
  const [state, formAction, pending] = useActionState(action, initialState);
  const timezoneOffset = String(new Date().getTimezoneOffset());

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <input type="hidden" name="timezoneOffset" value={timezoneOffset} />
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label
            htmlFor="settings-format"
            className="mb-1 block text-sm text-slate-300"
          >
            赛制
          </label>
          <select
            id="settings-format"
            name="format"
            defaultValue={format}
            title="比赛赛制"
            className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-slate-100"
          >
            <option value="group_only">分组比赛</option>
            <option value="group_then_knockout">前期分组后期淘汰</option>
          </select>
        </div>
        <div>
          <label
            htmlFor="settings-registration-deadline"
            className="mb-1 block text-sm text-slate-300"
          >
            报名截止时间
          </label>
          <input
            id="settings-registration-deadline"
            name="registrationDeadline"
            type="datetime-local"
            defaultValue={registrationDeadline}
            title="报名截止时间"
            className="native-picker native-picker-date w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-slate-100"
          />
        </div>
      </div>
      {state.error && <p className="text-sm text-rose-300">{state.error}</p>}
      {state.success && (
        <p className="text-sm text-emerald-300">{state.success}</p>
      )}
      <button
        disabled={pending}
        className="rounded-lg border border-cyan-400/50 px-4 py-2 text-sm text-cyan-100 hover:bg-cyan-500/10 disabled:opacity-60"
      >
        {pending ? "保存中..." : "保存赛制设置"}
      </button>
    </form>
  );
}
