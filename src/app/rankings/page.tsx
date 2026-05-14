import Link from "next/link";
import { Trophy } from "lucide-react";
import { prisma } from "@/lib/prisma";

type TabKey = "elo" | "points" | "honors";

type RankingPlayer = {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  eloRating: number;
  points: number;
  wins: number;
  losses: number;
  matchesPlayed: number;
  awardedBadges: { id: string }[];
};

function rankBadge(rank: number) {
  if (rank === 1) return <span className="text-2xl">🥇</span>;
  if (rank === 2) return <span className="text-2xl">🥈</span>;
  if (rank === 3) return <span className="text-2xl">🥉</span>;
  return (
    <span className="w-8 text-center font-mono text-lg text-gray-500">
      {rank}
    </span>
  );
}

function getPrimaryValue(tab: TabKey, player: RankingPlayer) {
  if (tab === "elo") return player.eloRating;
  if (tab === "points") return player.points;
  return player.awardedBadges.length;
}

function buildDisplayRanks(tab: TabKey, players: RankingPlayer[]) {
  return players.map((player, index) => {
    if (index === 0) return 1;
    return getPrimaryValue(tab, player) ===
      getPrimaryValue(tab, players[index - 1])
      ? 0
      : index + 1;
  });
}

export default async function RankingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab: rawTab } = await searchParams;
  const tab: TabKey =
    rawTab === "points" || rawTab === "honors" ? rawTab : "elo";

  const users = await prisma.user.findMany({
    where: {
      isBanned: false,
    },
    select: {
      id: true,
      nickname: true,
      avatarUrl: true,
      eloRating: true,
      points: true,
      wins: true,
      losses: true,
      matchesPlayed: true,
      awardedBadges: { select: { id: true } },
    },
  });

  const sorted: RankingPlayer[] = [...users].sort((a, b) => {
    if (tab === "elo") return b.eloRating - a.eloRating || b.points - a.points;
    if (tab === "points")
      return b.points - a.points || b.eloRating - a.eloRating;
    return (
      b.awardedBadges.length - a.awardedBadges.length ||
      b.eloRating - a.eloRating
    );
  });

  const topTen = sorted.slice(0, 10);

  const displayRanks = buildDisplayRanks(tab, topTen);

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="flex items-center gap-3">
        <Trophy className="h-8 w-8 text-yellow-400" />
        <h1 className="text-3xl font-bold text-white">排行榜</h1>
      </div>

      <div className="flex gap-2 border-b border-gray-600">
        {[
          { key: "elo", label: "ELO 排名" },
          { key: "points", label: "积分排名" },
          { key: "honors", label: "荣誉榜" },
        ].map(({ key, label }) => (
          <Link
            key={key}
            href={`/rankings?tab=${key}`}
            className={`-mb-px border-b-2 px-6 py-3 font-medium transition ${
              tab === key
                ? "border-cyan-500 text-cyan-400"
                : "border-transparent text-gray-400 hover:text-gray-300"
            }`}
          >
            {label}
          </Link>
        ))}
      </div>

      <div className="overflow-hidden rounded-lg border border-gray-600 bg-gray-700">
        <table className="w-full">
          <thead className="bg-gray-800">
            <tr className="text-sm text-gray-300">
              <th className="w-16 px-6 py-4 text-left">排名</th>
              <th className="px-6 py-4 text-left">选手</th>
              <th className="px-6 py-4 text-center">ELO</th>
              <th className="px-6 py-4 text-center">积分</th>
              <th className="px-6 py-4 text-center">胜/负</th>
              <th className="px-6 py-4 text-center">胜率</th>
              <th className="px-6 py-4 text-center">徽章</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-600">
            {topTen.map((player, index) => {
              const total = player.matchesPlayed;
              const winRate =
                total > 0 ? Math.round((player.wins / total) * 100) : 0;
              const avatarFallback = (
                player.nickname.trim().charAt(0) || "?"
              ).toUpperCase();

              return (
                <tr
                  key={player.id}
                  className="text-white transition hover:bg-gray-600"
                >
                  <td className="px-6 py-4">
                    {displayRanks[index] === 0 ? (
                      <span className="w-8 text-center font-mono text-lg text-gray-500">
                        -
                      </span>
                    ) : (
                      rankBadge(displayRanks[index])
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <Link
                      href={`/profile/${player.id}`}
                      className="flex items-center gap-3 transition hover:text-cyan-400"
                    >
                      <div className="grid h-10 w-10 place-items-center overflow-hidden rounded-full bg-cyan-600 font-bold text-white">
                        {player.avatarUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={player.avatarUrl}
                            alt={player.nickname}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          avatarFallback
                        )}
                      </div>
                      <span className="font-medium">{player.nickname}</span>
                    </Link>
                  </td>
                  <td className="px-6 py-4 text-center font-bold">
                    {player.eloRating}
                  </td>
                  <td className="px-6 py-4 text-center font-bold text-cyan-300">
                    {player.points}
                  </td>
                  <td className="px-6 py-4 text-center">
                    <span className="text-green-400">{player.wins}胜</span> /{" "}
                    <span className="text-red-400">{player.losses}负</span>
                  </td>
                  <td className="px-6 py-4 text-center text-sm text-gray-300">
                    {winRate}%
                  </td>
                  <td className="px-6 py-4 text-center text-amber-300">
                    {player.awardedBadges.length}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
