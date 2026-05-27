import Link from "next/link";
import { ArrowLeft, CalendarPlus } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import CreateMatchForm from "@/components/match/CreateMatchForm";

export default async function CreateMatchPage() {
  const currentUser = await getCurrentUser();

  if (!currentUser) {
    return (
      <div className="surface-panel mx-auto max-w-2xl rounded-3xl p-8 text-center">
        <h1 className="text-2xl font-black text-white">请先登录</h1>
        <p className="mt-2 text-slate-300">登录后才能发布比赛。</p>
        <Link
          href="/auth"
          className="btn-primary mt-5 inline-block rounded-2xl px-4 py-2 text-sm font-bold"
        >
          去登录
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link
        href="/matchs"
        className="inline-flex items-center gap-2 text-sm font-semibold text-slate-400 hover:text-teal-200"
      >
        <ArrowLeft className="h-4 w-4" />
        返回比赛列表
      </Link>

      <div className="surface-panel rounded-3xl p-5 sm:p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="grid h-14 w-14 place-items-center rounded-3xl bg-teal-400/10 text-teal-100 ring-1 ring-teal-200/12">
            <CalendarPlus className="h-7 w-7" />
          </div>
          <div>
            <p className="eyebrow">Create Match</p>
            <h1 className="mt-1 text-3xl font-black text-white">发布比赛</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
              创建后不会自动报名，发起人可后续手动报名。分组结果需在报名截止后由发起人/管理员确认发布。
            </p>
          </div>
        </div>
        <div className="mt-8">
          <CreateMatchForm />
        </div>
      </div>
    </div>
  );
}
