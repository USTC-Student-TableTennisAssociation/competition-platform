import Link from "next/link";
import { Calendar, LogOut } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { logoutAction } from "@/app/auth/actions";
import ProfileOverview from "@/components/auth/ProfileOverview";
import { prisma } from "@/lib/prisma";
import { toClubId } from "@/lib/club-id";

function formatScoreText(score: unknown) {
  if (typeof score === "string") return score;
  if (typeof score === "object" && score && "text" in score) {
    return String(score.text ?? "");
  }
  return "";
}

function getOpponentIds(result: {
  winnerTeamIds: string[];
  loserTeamIds: string[];
}, currentUserId: string) {
  return result.winnerTeamIds.includes(currentUserId)
    ? result.loserTeamIds
    : result.winnerTeamIds;
}

function formatOpponentLabel(
  opponentIds: string[],
  nicknameById: Map<string, string>,
) {
  return (
    opponentIds.map((id) => nicknameById.get(id) ?? id).join(" / ") ||
    "未知对手"
  );
}

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
    prisma.registration.count({
      where: {
        userId: currentUser.id,
        createdAt: { gte: termStart },
        match: { isQuickMatch: false },
      },
    }),
  ]);
  const opponentIds = Array.from(
    new Set(
      recentResults.flatMap((item) =>
        getOpponentIds(item, currentUser.id),
      ),
    ),
  );
  const opponentRows =
    opponentIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: opponentIds } },
          select: { id: true, nickname: true },
        })
      : [];
  const opponentNicknameById = new Map(
    opponentRows.map((user) => [user.id, user.nickname] as const),
  );

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
              const isWin = item.winnerTeamIds.includes(currentUser.id);
              const scoreText = formatScoreText(item.score);
              const opponentLabel = formatOpponentLabel(
                getOpponentIds(item, currentUser.id),
                opponentNicknameById,
              );

              return (
              <Link
                key={item.id}
                href={`/matchs/${item.match.id}`}
                className="grid gap-3 px-4 py-3 text-sm transition hover:bg-white/[0.025] sm:grid-cols-[minmax(220px,1.4fr)_minmax(120px,0.8fr)_150px_120px_70px_90px] sm:items-center"
              >
                <div className="min-w-0">
                  <p className="truncate font-semibold text-slate-100">
                    {item.match.title}
                  </p>
                </div>
                <span className="min-w-0 truncate text-sky-300/90">
                  vs {opponentLabel}
                </span>
                <span className="font-mono text-sm font-semibold tabular-nums text-slate-100">
                  {scoreText || "-"}
                </span>
                <span className="inline-flex items-center gap-1 text-xs text-sky-300/85">
                  <Calendar className="h-3.5 w-3.5" />
                  {new Date(item.match.dateTime).toLocaleDateString("zh-CN")}
                </span>
                <span className={isWin ? "font-semibold text-emerald-300" : "font-semibold text-rose-300"}>
                  {isWin ? "胜" : "负"}
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
