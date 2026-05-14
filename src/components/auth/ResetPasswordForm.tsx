"use client";

import Link from "next/link";
import { useActionState } from "react";
import { type AuthFormState, resetPasswordAction } from "@/app/auth/actions";

const initialState: AuthFormState = {};

type Props = {
  token: string;
};

export default function ResetPasswordForm({ token }: Props) {
  const [state, formAction, pending] = useActionState(
    resetPasswordAction,
    initialState,
  );

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <input type="hidden" name="token" value={token} />

      <div>
        <label
          htmlFor="reset-password"
          className="mb-1 block text-sm text-slate-300"
        >
          新密码
        </label>
        <input
          id="reset-password"
          name="password"
          type="password"
          className="w-full rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-slate-100 outline-none ring-cyan-400/40 focus:ring"
        />
      </div>

      <div>
        <label
          htmlFor="reset-password-confirm"
          className="mb-1 block text-sm text-slate-300"
        >
          确认新密码
        </label>
        <input
          id="reset-password-confirm"
          name="confirmPassword"
          type="password"
          className="w-full rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-slate-100 outline-none ring-cyan-400/40 focus:ring"
        />
      </div>

      {state.error && <p className="text-sm text-rose-300">{state.error}</p>}
      {state.success && (
        <p className="text-sm text-emerald-300">
          {state.success}{" "}
          <Link href="/auth" className="underline">
            去登录
          </Link>
        </p>
      )}

      <button
        disabled={pending}
        className="w-full rounded-xl bg-linear-to-r from-cyan-500 to-blue-500 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
      >
        {pending ? "提交中..." : "确认重置密码"}
      </button>
    </form>
  );
}
