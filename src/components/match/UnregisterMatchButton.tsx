"use client";

import { useActionState } from "react";
import {
  type MatchFormState,
  unregisterMatchAction,
} from "@/app/matchs/actions";

type Props = {
  matchId: string;
};

const initialState: MatchFormState = {};

export default function UnregisterMatchButton({ matchId }: Props) {
  const action = unregisterMatchAction.bind(null, matchId);
  const [state, formAction, pending] = useActionState(action, initialState);

  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <button
        disabled={pending}
        className="w-full rounded-lg border border-rose-400/50 py-3 font-semibold text-rose-200 hover:bg-rose-500/10 disabled:opacity-60"
      >
        {pending ? "处理中..." : "退出报名"}
      </button>
      {state.error && <p className="text-sm text-rose-300">{state.error}</p>}
      {state.success && (
        <p className="text-sm text-emerald-300">{state.success}</p>
      )}
    </form>
  );
}
