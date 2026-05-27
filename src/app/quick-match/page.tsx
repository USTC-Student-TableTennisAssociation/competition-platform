import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import QuickMatchPanel from "@/components/quick-match/QuickMatchPanel";
import { cleanupExpiredQuickResultsForUser } from "@/app/quick-match/actions";
import { toClubId } from "@/lib/club-id";

const QUICK_MATCH_TIMEOUT_HOURS = 24;
const QUICK_MATCH_VOID_DESC = "由快速比赛功能创建（已作废）";
const QUICK_MATCH_HISTORY_DAYS = 7;

export default async function QuickMatchPage() {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    redirect("/auth");
  }

  await cleanupExpiredQuickResultsForUser(currentUser.id);
  const myClubId = toClubId(currentUser.id);
  const historySince = new Date();
  historySince.setDate(historySince.getDate() - QUICK_MATCH_HISTORY_DAYS);

  const [opponents, pending, history] = await Promise.all([
    prisma.user.findMany({
      where: {
        id: { not: currentUser.id },
        isBanned: false,
      },
      orderBy: [{ nickname: "asc" }],
      select: {
        id: true,
        nickname: true,
        email: true,
      },
      take: 200,
    }),
    prisma.matchResult.findMany({
      where: {
        confirmed: false,
        OR: [
          { winnerTeamIds: { has: currentUser.id } },
          { loserTeamIds: { has: currentUser.id } },
        ],
        match: {
          isQuickMatch: true,
        },
      },
      include: {
        reporter: {
          select: {
            id: true,
            nickname: true,
          },
        },
        winner: {
          select: {
            nickname: true,
          },
        },
        loser: {
          select: {
            nickname: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.matchResult.findMany({
      where: {
        createdAt: {
          gte: historySince,
        },
        OR: [
          { winnerTeamIds: { has: currentUser.id } },
          { loserTeamIds: { has: currentUser.id } },
        ],
        match: {
          isQuickMatch: true,
        },
      },
      include: {
        reporter: {
          select: {
            nickname: true,
          },
        },
        winner: {
          select: {
            nickname: true,
          },
        },
        loser: {
          select: {
            nickname: true,
          },
        },
        match: {
          select: {
            description: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);

  const pendingItems = pending.map((item) => {
    const expiresAt = new Date(
      item.createdAt.getTime() + QUICK_MATCH_TIMEOUT_HOURS * 60 * 60 * 1000,
    );
    const canReview = item.reportedBy !== currentUser.id;

    let scoreText = "未填写";
    if (typeof item.score === "string") {
      scoreText = item.score;
    } else if (typeof item.score === "object" && item.score) {
      if ("text" in item.score && item.score.text) {
        scoreText = String(item.score.text);
      } else if ("myScore" in item.score && "opponentScore" in item.score) {
        scoreText = `${String(item.score.myScore)}:${String(item.score.opponentScore)}`;
      }
    }

    return {
      id: item.id,
      reportedBy: item.reportedBy,
      reportedByNickname: item.reporter.nickname,
      winnerNickname: item.winner?.nickname ?? "未知",
      loserNickname: item.loser?.nickname ?? "未知",
      scoreText,
      createdAtText: item.createdAt.toLocaleString("zh-CN"),
      expiresAtText: expiresAt.toLocaleString("zh-CN"),
      canReview,
    };
  });

  const historyItems = history
    .filter(
      (item) =>
        item.confirmed || item.match.description === QUICK_MATCH_VOID_DESC,
    )
    .map((item) => {
      let scoreText = "未填写";
      let invalidReason = "";

      if (typeof item.score === "string") {
        scoreText = item.score;
      } else if (typeof item.score === "object" && item.score) {
        if ("text" in item.score && item.score.text) {
          scoreText = String(item.score.text);
        } else if ("myScore" in item.score && "opponentScore" in item.score) {
          scoreText = `${String(item.score.myScore)}:${String(item.score.opponentScore)}`;
        }
        if ("invalidReason" in item.score) {
          invalidReason = String(item.score.invalidReason ?? "");
        }
      }

      const status = item.confirmed ? "confirmed" : "voided";
      const statusLabel =
        status === "confirmed"
          ? "已确认"
          : invalidReason === "timeout"
            ? "已作废（超时未确认）"
            : "已作废（对手拒绝）";

      return {
        id: item.id,
        winnerNickname: item.winner?.nickname ?? "未知",
        loserNickname: item.loser?.nickname ?? "未知",
        reportedByNickname: item.reporter.nickname,
        scoreText,
        statusLabel,
        createdAtText: item.createdAt.toLocaleString("zh-CN"),
      };
    });

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <section className="rounded-2xl border border-slate-700 bg-slate-900/80 p-6">
        <h1 className="text-2xl font-bold text-white">快速比赛</h1>
        <p className="mt-2 text-sm text-slate-300">
          快速录入对局结果，并由对手确认。若对手拒绝或{" "}
          {QUICK_MATCH_TIMEOUT_HOURS} 小时内未确认，赛果自动作废。
        </p>
        <div className="mt-4 rounded-xl border border-cyan-400/40 bg-cyan-500/10 px-4 py-3">
          <p className="text-xs text-cyan-200">我的 Club ID（用于对战匹配）</p>
          <p className="mt-1 text-2xl font-bold tracking-wider text-cyan-100">
            {myClubId}
          </p>
        </div>
      </section>

      <QuickMatchPanel
        currentUserId={currentUser.id}
        currentUserClubId={myClubId}
        opponents={opponents.map((item) => ({
          ...item,
          clubId: toClubId(item.id),
        }))}
        pendingItems={pendingItems}
        historyItems={historyItems}
        historyDays={QUICK_MATCH_HISTORY_DAYS}
        timeoutHours={QUICK_MATCH_TIMEOUT_HOURS}
      />
    </div>
  );
}
