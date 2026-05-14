import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import ProfileEditorForm from "@/components/auth/ProfileEditorForm";

export default async function ProfileEditPage() {
  const currentUser = await getCurrentUser();

  if (!currentUser) {
    return (
      <div className="mx-auto max-w-3xl rounded-2xl border border-slate-700/70 bg-slate-900/75 p-8 text-center">
        <h1 className="text-3xl font-bold text-white">编辑资料</h1>
        <p className="mt-3 text-slate-300">
          当前状态：待登录。登录后即可编辑资料。
        </p>
        <Link
          href="/auth"
          className="mt-6 inline-block rounded-xl bg-linear-to-r from-cyan-500 to-blue-500 px-5 py-2.5 text-sm font-semibold text-white"
        >
          去登录 / 注册
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        href="/profile"
        className="inline-flex items-center gap-2 text-sm text-slate-300 transition hover:text-cyan-300"
      >
        <ArrowLeft className="h-4 w-4" />
        返回个人中心
      </Link>

      <section className="rounded-2xl border border-slate-700/70 bg-slate-900/75 p-6">
        <h1 className="text-2xl font-bold text-white">编辑资料</h1>
        <p className="mt-1 text-sm text-slate-400">
          修改昵称、头像和个人描述。
        </p>

        <div className="mt-5">
          <ProfileEditorForm
            nickname={currentUser.nickname}
            bio={currentUser.bio ?? ""}
            avatarUrl={currentUser.avatarUrl ?? ""}
          />
        </div>
      </section>
    </div>
  );
}
