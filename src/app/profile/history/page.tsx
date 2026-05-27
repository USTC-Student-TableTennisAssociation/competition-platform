import Link from "next/link";
import { Calendar, ChevronLeft } from "lucide-react";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

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

export default async function ProfileHistoryPage() {
  const currentUser = await getCurrentUser();

  if (!currentUser) {
    redirect("/auth");
  }

  const results = await prisma.matchResult.findMany({
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
    orderBy: [{ resultVerifiedAt: "desc" }, { createdAt: "desc" }],
  });
  const opponentIds = Array.from(
    new Set(
      results.flatMap((item) =>
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
                  className="grid gap-3 px-4 py-3 text-sm transition hover:bg-white/[0.025] sm:grid-cols-[minmax(220px,1.4fr)_minmax(120px,0.8fr)_150px_140px_90px_110px] sm:items-center"
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
                    {item.match.dateTime.toLocaleDateString("zh-CN")}
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
