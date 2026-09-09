import Link from "next/link";
import { Calendar, ChevronLeft } from "lucide-react";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getUserCompetitionHistory } from "@/modules/competitions-v2/read-model/user-competition-history";

export default async function ProfileHistoryPage() {
  const currentUser = await getCurrentUser();

  if (!currentUser) {
    redirect("/auth");
  }

  const results = await getUserCompetitionHistory(prisma, currentUser.id, {
    legacyOrder: "verifiedAt",
  });

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Link
            href="/profile"
            className="inline-flex items-center gap-1 text-sm font-semibold text-slate-400 hover:text-slate-100"
          >
            <ChevronLeft className="h-4 w-4" />
            返回个人中心
          </Link>
          <h1 className="mt-3 text-2xl font-semibold text-white">
            我的全部比赛记录
          </h1>
        </div>
      </div>

      <section className="overflow-hidden rounded-lg border border-[#30363d] bg-[#0d1117]">
        <div className="grid border-b border-[#30363d] px-4 py-2 text-xs font-medium text-slate-500 sm:grid-cols-[minmax(220px,1.4fr)_minmax(120px,0.8fr)_150px_140px_90px_110px]">
          <span>比赛</span>
          <span>对手</span>
          <span>比分</span>
          <span>时间</span>
          <span>结果</span>
          <span className="text-right">入口</span>
        </div>

        <div className="divide-y divide-[#30363d]">
          {results.length === 0 ? (
            <p className="px-4 py-4 text-sm text-slate-400">
              暂无已确认比赛成绩。
            </p>
          ) : (
            results.map((item) => {
              return (
                <Link
                  key={item.id}
                  href={`/matchs/${item.matchId}`}
                  className="grid gap-3 px-4 py-3 text-sm transition hover:bg-white/[0.025] sm:grid-cols-[minmax(220px,1.4fr)_minmax(120px,0.8fr)_150px_140px_90px_110px] sm:items-center"
                >
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-100">
                      {item.matchTitle}
                    </p>
                  </div>
                  <span className="min-w-0 truncate text-sky-300/90">
                    vs {item.opponentLabel}
                  </span>
                  <span className="font-mono text-sm font-semibold tabular-nums text-slate-100">
                    {item.scoreText || "-"}
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs text-sky-300/85">
                    <Calendar className="h-3.5 w-3.5" />
                    {item.matchDateTime.toLocaleDateString("zh-CN")}
                  </span>
                  <span className={item.isWin ? "font-semibold text-emerald-300" : "font-semibold text-rose-300"}>
                    {item.isWin ? "胜" : "负"}
                  </span>
                  <span className="text-xs font-semibold text-orange-200 sm:text-right">
                    查看详情
                  </span>
                </Link>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
