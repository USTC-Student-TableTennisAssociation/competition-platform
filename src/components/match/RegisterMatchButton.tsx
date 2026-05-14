"use client";

import { useActionState } from "react";
import { type MatchFormState, registerMatchAction } from "@/app/matchs/actions";

type Props = {
  matchId: string;
  disabled?: boolean;
  disabledText?: string;
  submitText?: string;
};

const initialState: MatchFormState = {};

export default function RegisterMatchButton({
  matchId,
  disabled,
  disabledText,
  submitText,
}: Props) {
  const registerWithId = registerMatchAction.bind(null, matchId);
  const [state, formAction, pending] = useActionState(
    registerWithId,
    initialState,
  );

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <button
        disabled={disabled || pending}
        className="w-full rounded-lg bg-linear-to-r from-cyan-500 to-blue-500 py-3 font-semibold text-white disabled:opacity-50"
      >
        {disabled
          ? (disabledText ?? "不可报名")
          : pending
            ? "报名中..."
            : (submitText ?? "立即报名")}
      </button>
      <p className="text-xs text-slate-400">
        积分规则：报名 +1，赛果确认后每胜 1 场 +1；单人单赛事最多获得 5 分。
      </p>
      {state.error && <p className="text-sm text-rose-300">{state.error}</p>}
      {state.success && (
        <p className="text-sm text-emerald-300">{state.success}</p>
      )}
    </form>
  );
}
