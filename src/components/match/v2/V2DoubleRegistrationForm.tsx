"use client";

import RegistrationIdentityFields from "@/components/match/RegistrationIdentityFields";

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
  collectIdentityInfo = false,
  partnerSubmitted = false,
}: Readonly<{
  matchId: string;
  mode: "register" | "cancel" | "withdrawIdentity";
  collectIdentityInfo?: boolean;
  partnerSubmitted?: boolean;
}>) {
  const action =
    mode === "register"
      ? registerV2DoubleAction.bind(null, matchId)
      : cancelV2DoubleRegistrationAction.bind(null, matchId);
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);

  return (
    <form action={formAction} className="space-y-2">
      {mode === "register" && collectIdentityInfo ? (
        <p className="text-sm leading-6 text-slate-300">
          {partnerSubmitted ? "搭档已确认。提交本人资料后，你们的小队即完成报名。" : "请分别使用自己的账号填写本人信息。双方确认后，小队才会报名成功。"}
        </p>
      ) : null}
      <input type="hidden" name="csrfToken" defaultValue="" />
      {mode === "withdrawIdentity" ? <input type="hidden" name="pendingIdentityOnly" value="1" /> : null}
      {mode === "register" && collectIdentityInfo ? <RegistrationIdentityFields /> : null}
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
            ? (collectIdentityInfo ? "提交本人资料并确认报名" : "小队报名")
            : mode === "withdrawIdentity" ? "撤回本人报名资料" : "小队退出报名"}
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
