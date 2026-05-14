"use client";

import { useActionState, useState } from "react";
import {
  accountHelpAction,
  type AuthFormState,
  loginAction,
  registerAction,
} from "@/app/auth/actions";

const initialState: AuthFormState = {};

export default function AuthForms() {
  const [tab, setTab] = useState<"login" | "register">("login");
  const [loginState, loginFormAction, loginPending] = useActionState(
    loginAction,
    initialState,
  );
  const [registerState, registerFormAction, registerPending] = useActionState(
    registerAction,
    initialState,
  );
  const [helpState, helpFormAction, helpPending] = useActionState(
    accountHelpAction,
    initialState,
  );
  const [helpOpen, setHelpOpen] = useState(false);

  return (
    <div className="w-full rounded-2xl border border-slate-700/70 bg-slate-900/75 p-6 shadow-xl shadow-black/20">
      <div className="mb-4 rounded-xl border border-amber-400/60 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
        本平台仅面向中国科学技术大学校学生乒乓球协会内部成员使用，非协会成员请勿注册或登录。
      </div>
      <div className="mb-6 grid grid-cols-2 rounded-xl border border-slate-700 bg-slate-800 p-1 text-sm">
        <button
          type="button"
          onClick={() => setTab("login")}
          className={`rounded-lg px-3 py-2 ${tab === "login" ? "bg-cyan-500/20 text-cyan-100" : "text-slate-300"}`}
        >
          登录
        </button>
        <button
          type="button"
          onClick={() => setTab("register")}
          className={`rounded-lg px-3 py-2 ${tab === "register" ? "bg-cyan-500/20 text-cyan-100" : "text-slate-300"}`}
        >
          注册
        </button>
      </div>

      {tab === "login" ? (
        <>
          <form action={loginFormAction} className="space-y-4">
            <input type="hidden" name="csrfToken" defaultValue="" />
            <div>
              <label
                htmlFor="login-email"
                className="mb-1 block text-sm text-slate-300"
              >
                邮箱
              </label>
              <input
                id="login-email"
                name="email"
                type="email"
                className="w-full rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-slate-100 outline-none ring-cyan-400/40 focus:ring"
              />
            </div>
            <div>
              <label
                htmlFor="login-password"
                className="mb-1 block text-sm text-slate-300"
              >
                密码
              </label>
              <input
                id="login-password"
                name="password"
                type="password"
                className="w-full rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-slate-100 outline-none ring-cyan-400/40 focus:ring"
              />
            </div>
            {loginState.error && (
              <p className="text-sm text-rose-300">{loginState.error}</p>
            )}
            {loginState.success && (
              <p className="text-sm text-emerald-300">{loginState.success}</p>
            )}
            <button
              disabled={loginPending}
              className="w-full rounded-xl bg-linear-to-r from-cyan-500 to-blue-500 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              {loginPending ? "登录中..." : "登录"}
            </button>
          </form>

          <div className="mt-4">
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              className="text-xs text-cyan-200 underline-offset-4 hover:underline"
            >
              忘记密码或未收到验证邮件？点击打开
            </button>
          </div>
        </>
      ) : (
        <form action={registerFormAction} className="space-y-4">
          <input type="hidden" name="csrfToken" defaultValue="" />
          <div>
            <label
              htmlFor="register-nickname"
              className="mb-1 block text-sm text-slate-300"
            >
              昵称
            </label>
            <input
              id="register-nickname"
              name="nickname"
              type="text"
              className="w-full rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-slate-100 outline-none ring-cyan-400/40 focus:ring"
            />
          </div>
          <div>
            <label
              htmlFor="register-email"
              className="mb-1 block text-sm text-slate-300"
            >
              邮箱
            </label>
            <input
              id="register-email"
              name="email"
              type="email"
              placeholder="示例：yourname@mail.ustc.edu.cn"
              className="w-full rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-slate-100 outline-none ring-cyan-400/40 focus:ring"
            />
            <p className="mt-1 text-xs text-slate-400">
              仅支持 ustc.edu.cn、mail.ustc.edu.cn 域名邮箱注册。
            </p>
          </div>
          <div>
            <label
              htmlFor="register-password"
              className="mb-1 block text-sm text-slate-300"
            >
              密码
            </label>
            <input
              id="register-password"
              name="password"
              type="password"
              className="w-full rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-slate-100 outline-none ring-cyan-400/40 focus:ring"
            />
          </div>
          {registerState.error && (
            <p className="text-sm text-rose-300">{registerState.error}</p>
          )}
          {registerState.success && (
            <p className="text-sm text-emerald-300">{registerState.success}</p>
          )}
          <p className="text-xs text-slate-400">
            注册后需点击邮箱中的验证链接，才可登录。
          </p>
          <button
            disabled={registerPending}
            className="w-full rounded-xl bg-linear-to-r from-cyan-500 to-blue-500 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
          >
            {registerPending ? "注册中..." : "注册并发送验证邮件"}
          </button>
        </form>
      )}

      {helpOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 px-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <h3 className="text-base font-semibold text-white">账号帮助</h3>
            <p className="mt-1 text-xs text-slate-300">
              输入邮箱后，系统会自动发送验证邮件或重置密码链接。
            </p>

            <form action={helpFormAction} className="mt-4 space-y-3">
              <input type="hidden" name="csrfToken" defaultValue="" />
              <input
                name="email"
                type="email"
                title="账号帮助邮箱"
                placeholder="请输入注册邮箱"
                className="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none ring-cyan-400/40 focus:ring"
              />

              {helpState.error && (
                <p className="text-sm text-rose-300">{helpState.error}</p>
              )}
              {helpState.success && (
                <p className="text-sm text-emerald-300">{helpState.success}</p>
              )}

              <div className="mt-1 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setHelpOpen(false)}
                  className="rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
                >
                  关闭
                </button>
                <button
                  disabled={helpPending}
                  className="rounded-lg border border-cyan-300/40 px-3 py-2 text-sm text-cyan-100 hover:bg-cyan-500/10 disabled:opacity-60"
                >
                  {helpPending ? "发送中..." : "发送邮件"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
