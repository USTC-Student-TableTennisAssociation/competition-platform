import Link from "next/link";
import ResetPasswordForm from "@/components/auth/ResetPasswordForm";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <div className="mx-auto max-w-2xl rounded-2xl border border-slate-700 bg-slate-900/75 p-8 text-center">
        <h1 className="text-2xl font-bold text-white">重置链接无效</h1>
        <p className="mt-3 text-slate-300">
          缺少重置参数，请返回登录页重新发起。
        </p>
        <Link
          href="/auth"
          className="mt-6 inline-block rounded-xl bg-cyan-500/20 px-4 py-2 text-cyan-100"
        >
          返回登录页
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900/75 p-6">
      <h1 className="text-xl font-semibold text-white">重置密码</h1>
      <p className="mt-1 text-sm text-slate-300">请输入新的登录密码。</p>
      <div className="mt-5">
        <ResetPasswordForm token={token} />
      </div>
    </div>
  );
}
