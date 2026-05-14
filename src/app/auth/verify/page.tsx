import Link from "next/link";
import { verifyEmailTokenAction } from "@/app/auth/actions";

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  if (!token) {
    return (
      <div className="mx-auto max-w-2xl rounded-2xl border border-slate-700 bg-slate-900/75 p-8 text-center">
        <h1 className="text-2xl font-bold text-white">验证链接无效</h1>
        <p className="mt-3 text-slate-300">
          缺少验证参数，请返回登录页重新发送验证邮件。
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

  const result = await verifyEmailTokenAction(token);

  return (
    <div className="mx-auto max-w-2xl rounded-2xl border border-slate-700 bg-slate-900/75 p-8 text-center">
      <h1 className="text-2xl font-bold text-white">邮箱验证</h1>
      {result.error ? (
        <p className="mt-3 text-rose-300">{result.error}</p>
      ) : (
        <p className="mt-3 text-emerald-300">{result.success}</p>
      )}
      <Link
        href="/auth"
        className="mt-6 inline-block rounded-xl bg-linear-to-r from-cyan-500 to-blue-500 px-4 py-2 text-white"
      >
        {result.error ? "去登录页" : "去登录"}
      </Link>
    </div>
  );
}
