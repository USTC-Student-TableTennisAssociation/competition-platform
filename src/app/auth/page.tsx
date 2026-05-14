import Image from "next/image";
import { redirect } from "next/navigation";
import AuthForms from "@/components/auth/AuthForms";
import { getCurrentUser } from "@/lib/auth";

export default async function AuthPage() {
  const currentUser = await getCurrentUser();
  if (currentUser) {
    redirect("/");
  }

  return (
    <div className="mx-auto w-full max-w-screen-xl px-4 sm:px-6 lg:px-8">
      <div className="w-full">
        <div className="mb-6 flex flex-col items-center gap-4 overflow-hidden rounded-2xl border border-slate-700/70 bg-slate-900/85 p-4 shadow-lg shadow-black/20 sm:flex-row sm:justify-start sm:p-6">
          <div className="flex shrink-0 items-center justify-center">
            <Image
              src="/SVG/乒协徽章.svg"
              alt="USTC TTA 徽章"
              width={80}
              height={80}
              className="h-16 w-16 sm:h-20 sm:w-20 lg:h-24 lg:w-24"
              priority
            />
          </div>
          <div className="flex min-w-0 w-full items-center sm:justify-start">
            <Image
              src="/SVG/乒协文字.svg"
              alt="中国科学技术大学乒乓球协会"
              width={480}
              height={120}
              className="h-auto w-full max-w-full object-contain object-left"
              priority
            />
          </div>
        </div>
        <div className="grid gap-8 lg:grid-cols-[1.1fr_1fr]">
          <section className="hidden rounded-3xl border border-slate-700/70 bg-linear-to-br from-slate-800 via-slate-800 to-slate-900 p-8 shadow-xl shadow-black/20 lg:block">
            <h1 className="text-3xl font-bold text-white">登录 USTC TTA</h1>
            <p className="mt-4 text-slate-300">
              注册后将发送邮箱验证邮件，点击链接激活账号后方可登录。
            </p>
            <ul className="mt-6 space-y-3 text-sm text-slate-200">
              <li className="rounded-xl border border-slate-700 bg-slate-800/70 px-4 py-3">
                ✅ 参与乒协内部比赛报名
              </li>
              <li className="rounded-xl border border-slate-700 bg-slate-800/70 px-4 py-3">
                ✅ 查看完整个人战绩与 ELO 变化
              </li>
              <li className="rounded-xl border border-slate-700 bg-slate-800/70 px-4 py-3">
                ✅ 个性化编辑头像与个人描述
              </li>
            </ul>
          </section>

          <AuthForms />
        </div>
      </div>
    </div>
  );
}
