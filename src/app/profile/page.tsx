import Link from "next/link";
import { Calendar, LogOut } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { logoutAction } from "@/app/auth/actions";
import ProfileOverview from "@/components/auth/ProfileOverview";
import { prisma } from "@/lib/prisma";
import { toClubId } from "@/lib/club-id";
import {
  getTermRegistrationCount,
  getUserCompetitionHistory,
} from "@/modules/competitions-v2/read-model/user-competition-history";

function getCurrentTermStart() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  if (month >= 8) return new Date(year, 8, 1);
  if (month >= 1) return new Date(year, 1, 1);
  return new Date(year - 1, 8, 1);
}

export default async function ProfilePage() {
  const currentUser = await getCurrentUser();

  if (!currentUser) {
    return (
      <div className="mx-auto max-w-3xl rounded-lg border border-[#30363d] bg-[#0d1117] p-8 text-center">
        <h1 className="text-2xl font-semibold text-white">个人中心</h1>
        <p className="mt-3 text-slate-400">
          当前状态：待登录。登录后即可查看和编辑个人资料。
        </p>
        <Link
          href="/auth"
          className="btn-primary mt-6 inline-block rounded-md px-5 py-2.5 text-sm font-semibold"
        >
          去登录 / 注册
        </Link>
      </div>
    );
  }

  const termStart = getCurrentTermStart();
  const [
    eloHistory,
    recentResults,
    badgeRows,
    betterRankCount,
    termRegistrationCount,
  ] = await Promise.all([
    prisma.eloHistory.findMany({
      where: { userId: currentUser.id },
      orderBy: { createdAt: "asc" },
      take: 20,
      select: { eloAfter: true, createdAt: true },
    }),
    getUserCompetitionHistory(prisma, currentUser.id, {
      legacyOrder: "createdAt",
      limit: 5,
    }),
    prisma.userBadge.findMany({
      where: { userId: currentUser.id },
      include: {
        badge: {
          select: {
            id: true,
            title: true,
            description: true,
            iconUrl: true,
          },
        },
      },
      orderBy: { awardedAt: "desc" },
      take: 12,
    }),
    prisma.user.count({
      where: {
        isBanned: false,
        OR: [
          { eloRating: { gt: currentUser.eloRating } },
          {
            eloRating: currentUser.eloRating,
            points: { gt: currentUser.points },
          },
        ],
      },
    }),
    getTermRegistrationCount(prisma, currentUser.id, termStart),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-slate-500">Profile</p>
          <h1 className="mt-1 text-2xl font-semibold text-white">个人中心</h1>
        </div>
        <form action={logoutAction}>
          <input type="hidden" name="csrfToken" defaultValue="" />
          <button className="btn-secondary inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold">
            <LogOut className="h-4 w-4" />
            退出登录
          </button>
        </form>
      </div>

      <section className="rounded-lg border border-[#30363d] bg-[#0d1117] px-4 py-3">
        <p className="text-sm text-slate-400">
          账号邮箱：
          <span className="text-slate-200">{currentUser.email}</span>
        </p>
      </section>

      <ProfileOverview
        user={{
          id: currentUser.id,
          nickname: currentUser.nickname,
          bio: currentUser.bio,
          avatarUrl: currentUser.avatarUrl,
          points: currentUser.points,
          eloRating: currentUser.eloRating,
          wins: currentUser.wins,
          losses: currentUser.losses,
        }}
        clubId={toClubId(currentUser.id)}
        rank={betterRankCount + 1}
        termCount={termRegistrationCount}
        eloPoints={eloHistory.map((item) => ({
          eloAfter: item.eloAfter,
          createdAt: item.createdAt.toISOString(),
        }))}
        badges={badgeRows.map((item) => ({
          id: item.badge.id,
          title: item.badge.title,
          description: item.badge.description,
          iconUrl: item.badge.iconUrl,
          awardedAt: item.awardedAt.toISOString(),
        }))}
      />

      <section className="overflow-hidden rounded-lg border border-[#30363d] bg-[#0d1117]">
        <div className="flex items-center justify-between gap-3 border-b border-[#30363d] px-4 py-3">
          <h2 className="text-sm font-semibold text-white">我的历史战绩</h2>
          <Link
            href="/profile/history"
            className="text-xs font-semibold text-orange-200 hover:text-orange-100"
          >
            查看全部
          </Link>
        </div>
        <div className="divide-y divide-[#30363d]">
          {recentResults.length === 0 ? (
            <p className="px-4 py-4 text-sm text-slate-400">
              暂无已确认比赛成绩。
            </p>
          ) : (
            recentResults.map((item) => {
              return (
              <Link
                key={item.id}
                href={`/matchs/${item.matchId}`}
                className="grid gap-3 px-4 py-3 text-sm transition hover:bg-white/[0.025] sm:grid-cols-[minmax(220px,1.4fr)_minmax(120px,0.8fr)_150px_120px_70px_90px] sm:items-center"
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
