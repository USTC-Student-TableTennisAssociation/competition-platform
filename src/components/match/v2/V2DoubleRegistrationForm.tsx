"use client";

import { useActionState } from "react";

import {
  cancelV2DoubleRegistrationAction,
  registerV2DoubleAction,
} from "@/app/matchs/v2-actions";
import type { V2DoubleActionState } from "@/modules/competitions-v2/adapters/double-actions";

const INITIAL_STATE: V2DoubleActionState = {};

export default function V2DoubleRegistrationForm({
  matchId,
  mode,
}: Readonly<{ matchId: string; mode: "register" | "cancel" }>) {
  const action =
    mode === "register"
      ? registerV2DoubleAction.bind(null, matchId)
      : cancelV2DoubleRegistrationAction.bind(null, matchId);
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
            ? "小队报名"
            : "小队退出报名"}
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
