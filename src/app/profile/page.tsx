import Link from "next/link";
import { Calendar, LogOut } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { logoutAction } from "@/app/auth/actions";
import ProfileOverview from "@/components/auth/ProfileOverview";
import { prisma } from "@/lib/prisma";
import { toClubId } from "@/lib/club-id";

export default async function ProfilePage() {
  const currentUser = await getCurrentUser();

  if (!currentUser) {
    return (
      <div className="mx-auto max-w-3xl rounded-2xl border border-slate-700/70 bg-slate-900/75 p-8 text-center">
        <h1 className="text-3xl font-bold text-white">个人中心</h1>
        <p className="mt-3 text-slate-300">
          当前状态：待登录。登录后即可查看和编辑个人资料。
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

  const myMatches = await prisma.registration.findMany({
    where: { userId: currentUser.id },
    include: { match: true },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  const [eloHistory, recentResults, badgeRows] = await Promise.all([
    prisma.eloHistory.findMany({
      where: { userId: currentUser.id },
      orderBy: { createdAt: "asc" },
      take: 20,
      select: { eloAfter: true, createdAt: true },
    }),
    prisma.matchResult.findMany({
      where: {
        confirmed: true,
        OR: [
          { winnerTeamIds: { has: currentUser.id } },
          { loserTeamIds: { has: currentUser.id } },
        ],
      },
      include: {
        match: {
          select: {
            id: true,
            title: true,
            dateTime: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
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
  ]);

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-white">个人中心</h1>
        <form action={logoutAction}>
          <input type="hidden" name="csrfToken" defaultValue="" />
          <button className="inline-flex items-center gap-2 rounded-xl border border-slate-600 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800">
            <LogOut className="h-4 w-4" />
            退出登录
          </button>
        </form>
      </div>

      <section className="rounded-2xl border border-slate-700/70 bg-slate-900/75 p-6">
        <p className="text-sm text-slate-400">账号邮箱：{currentUser.email}</p>
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
        eloPoints={eloHistory.map((item) => ({
          eloAfter: item.eloAfter,
          createdAt: item.createdAt.toISOString(),
        }))}
        recentResults={recentResults.map((item) => ({
          id: item.id,
          matchId: item.match.id,
          matchTitle: item.match.title,
          matchDate: item.match.dateTime.toISOString(),
          isWin: item.winnerTeamIds.includes(currentUser.id),
          scoreText:
            typeof item.score === "object" && item.score && "text" in item.score
              ? String(item.score.text ?? "")
              : typeof item.score === "string"
                ? item.score
                : "",
        }))}
        badges={badgeRows.map((item) => ({
          id: item.badge.id,
          title: item.badge.title,
          description: item.badge.description,
          iconUrl: item.badge.iconUrl,
          awardedAt: item.awardedAt.toISOString(),
        }))}
      />

      <section className="rounded-2xl border border-slate-700/70 bg-slate-900/75 p-6">
        <h2 className="mb-4 text-xl font-semibold text-white">我的比赛</h2>
        <div className="space-y-3">
          {myMatches.length === 0 ? (
            <p className="text-sm text-slate-400">你还没有报名任何比赛。</p>
          ) : (
            myMatches.map((item) => (
              <Link
                key={item.id}
                href={`/matchs/${item.matchId}`}
                className="flex items-center justify-between rounded-xl border border-slate-700 bg-slate-800/70 p-4 text-slate-100 hover:border-cyan-400/45"
              >
                <div>
                  <p className="font-medium">{item.match.title}</p>
                  <p className="text-sm text-slate-400">角色：{item.role}</p>
                </div>
                <span className="inline-flex items-center gap-1 text-xs text-slate-300">
                  <Calendar className="h-3.5 w-3.5" />
                  {new Date(item.match.dateTime).toLocaleDateString("zh-CN")}
                </span>
              </Link>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
