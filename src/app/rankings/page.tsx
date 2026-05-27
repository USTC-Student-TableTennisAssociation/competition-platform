import Link from "next/link";
import { Medal, Shield, Trophy } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { normalizeAvatarUrl } from "@/lib/utils";

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
  if (rank === 1) return "TOP 1";
  if (rank === 2) return "TOP 2";
  if (rank === 3) return "TOP 3";
  if (rank === 0) return "-";
  return `#${rank}`;
}

function rankTone(rank: number) {
  if (rank === 1) return "from-amber-300/30 to-yellow-500/8 ring-amber-200/18";
  if (rank === 2) return "from-slate-200/20 to-slate-400/7 ring-slate-200/16";
  if (rank === 3) return "from-orange-300/22 to-orange-500/7 ring-orange-200/16";
  return "from-white/[0.045] to-white/[0.02] ring-white/8";
}

function primaryLabel(tab: TabKey) {
  if (tab === "elo") return "ELO";
  if (tab === "points") return "积分";
  return "徽章";
}

function secondaryCopy(tab: TabKey) {
  if (tab === "elo") return "以实时 ELO 为主，积分为同分参考。";
  if (tab === "points") return "以累计积分为主，ELO 为同分参考。";
  return "以已获荣誉徽章数量为主，ELO 为同分参考。";
}

function PlayerAvatar({ player }: { player: RankingPlayer }) {
  const avatarFallback = (player.nickname.trim().charAt(0) || "?").toUpperCase();
  const avatarUrl = normalizeAvatarUrl(player.avatarUrl);

  return (
    <div className="grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-2xl bg-teal-400/12 font-black text-teal-100 ring-1 ring-white/10 sm:h-12 sm:w-12">
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={avatarUrl}
          alt={player.nickname}
          className="h-full w-full object-cover"
        />
      ) : (
        avatarFallback
      )}
    </div>
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
  const podium = topTen.slice(0, 3);
  const rest = topTen.slice(3);

  return (
    <div className="mx-auto max-w-6xl space-y-6 sm:space-y-8">
      <section className="surface-panel relative overflow-hidden rounded-3xl p-5 sm:p-7">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_82%_4%,rgba(251,191,36,0.12),transparent_32%)]" />
        <div className="relative flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <div>
            <p className="eyebrow">Leaderboard</p>
            <div className="mt-2 flex items-center gap-3">
              <Trophy className="h-8 w-8 text-amber-200" />
              <h1 className="text-3xl font-black text-white sm:text-4xl">
                排行榜
              </h1>
            </div>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
              {secondaryCopy(tab)}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:min-w-80">
            <div className="rounded-2xl bg-white/[0.035] px-3 py-2 ring-1 ring-white/8">
              <p className="text-[11px] text-slate-500">上榜人数</p>
              <p className="mt-1 text-xl font-black text-white">{topTen.length}</p>
            </div>
            <div className="rounded-2xl bg-teal-400/8 px-3 py-2 ring-1 ring-teal-300/12">
              <p className="text-[11px] text-teal-100/60">当前榜单</p>
              <p className="mt-1 text-sm font-black text-teal-100">
                {primaryLabel(tab)}
              </p>
            </div>
            <div className="rounded-2xl bg-amber-400/8 px-3 py-2 ring-1 ring-amber-300/12">
              <p className="text-[11px] text-amber-100/60">榜首</p>
              <p className="mt-1 truncate text-sm font-black text-amber-100">
                {topTen[0]?.nickname ?? "暂无"}
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="surface-card flex gap-1 overflow-x-auto rounded-2xl p-1 text-sm">
        {[
          { key: "elo", label: "ELO 排名" },
          { key: "points", label: "积分排名" },
          { key: "honors", label: "荣誉榜" },
        ].map(({ key, label }) => (
          <Link
            key={key}
            href={`/rankings?tab=${key}`}
            className={`shrink-0 rounded-xl px-4 py-2.5 font-bold transition sm:px-6 ${
              tab === key
                ? "bg-teal-400/12 text-teal-100"
                : "text-slate-400 hover:bg-white/[0.035] hover:text-slate-200"
            }`}
          >
            {label}
          </Link>
        ))}
      </div>

      {podium.length > 0 ? (
        <section className="grid gap-3 lg:grid-cols-3">
          {podium.map((player, index) => {
            const rank = displayRanks[index];
            const total = player.matchesPlayed;
            const winRate =
              total > 0 ? Math.round((player.wins / total) * 100) : 0;

            return (
              <Link
                key={player.id}
                href={`/profile/${player.id}`}
                className={`surface-panel group relative overflow-hidden rounded-3xl bg-linear-to-br p-5 ring-1 transition hover:-translate-y-0.5 ${rankTone(rank)}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="rounded-full bg-white/[0.055] px-3 py-1 text-xs font-black tracking-[0.12em] text-slate-200">
                    {rankBadge(rank)}
                  </span>
                  <Medal className="h-5 w-5 text-amber-200/80" />
                </div>
                <div className="mt-6 flex items-center gap-3">
                  <PlayerAvatar player={player} />
                  <div className="min-w-0">
                    <p className="truncate text-lg font-black text-white">
                      {player.nickname}
                    </p>
                    <p className="text-xs text-slate-500">
                      {player.wins}胜 / {player.losses}负 · 胜率 {winRate}%
                    </p>
                  </div>
                </div>
                <div className="mt-5 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-2xl bg-slate-950/32 px-2 py-2 ring-1 ring-white/8">
                    <p className="text-[11px] text-slate-500">ELO</p>
                    <p className="text-lg font-black text-teal-100">
                      {player.eloRating}
                    </p>
                  </div>
                  <div className="rounded-2xl bg-slate-950/32 px-2 py-2 ring-1 ring-white/8">
                    <p className="text-[11px] text-slate-500">积分</p>
                    <p className="text-lg font-black text-sky-100">
                      {player.points}
                    </p>
                  </div>
                  <div className="rounded-2xl bg-slate-950/32 px-2 py-2 ring-1 ring-white/8">
                    <p className="text-[11px] text-slate-500">徽章</p>
                    <p className="text-lg font-black text-amber-100">
                      {player.awardedBadges.length}
                    </p>
                  </div>
                </div>
              </Link>
            );
          })}
        </section>
      ) : (
        <div className="surface-card rounded-3xl p-8 text-center text-sm text-slate-400">
          暂无排行数据。
        </div>
      )}

      {rest.length > 0 ? (
        <section className="surface-card rounded-3xl p-3 sm:p-4">
          <div className="mb-3 flex items-center gap-2 px-2">
            <Shield className="h-4 w-4 text-slate-500" />
            <h2 className="text-sm font-black tracking-wide text-slate-300">
              追赶席位
            </h2>
          </div>
          <div className="space-y-2">
            {rest.map((player, restIndex) => {
              const index = restIndex + 3;
              const total = player.matchesPlayed;
              const winRate =
                total > 0 ? Math.round((player.wins / total) * 100) : 0;
              const rank = displayRanks[index];

              return (
                <Link
                  key={player.id}
                  href={`/profile/${player.id}`}
                  className="grid gap-3 rounded-2xl bg-white/[0.025] p-3 ring-1 ring-white/7 transition hover:bg-white/[0.045] sm:grid-cols-[72px_1fr_88px_88px_120px_64px] sm:items-center"
                >
                  <div className="flex items-center justify-between sm:block">
                    <span className="text-sm font-black text-slate-400">
                      {rankBadge(rank)}
                    </span>
                    <span className="text-xs text-slate-600 sm:hidden">
                      胜率 {winRate}%
                    </span>
                  </div>
                  <div className="flex min-w-0 items-center gap-3">
                    <PlayerAvatar player={player} />
                    <div className="min-w-0">
                      <p className="truncate font-bold text-slate-100">
                        {player.nickname}
                      </p>
                      <p className="text-xs text-slate-500 sm:hidden">
                        ELO {player.eloRating} · 积分 {player.points}
                      </p>
                    </div>
                  </div>
                  <p className="hidden text-center font-black text-teal-100 sm:block">
                    {player.eloRating}
                  </p>
                  <p className="hidden text-center font-black text-sky-100 sm:block">
                    {player.points}
                  </p>
                  <p className="hidden text-center text-sm text-slate-300 sm:block">
                    <span className="text-emerald-300">{player.wins}胜</span> /{" "}
                    <span className="text-rose-300">{player.losses}负</span>
                  </p>
                  <p className="hidden text-center text-sm text-slate-300 sm:block">
                    {winRate}%
                  </p>
                </Link>
              );
            })}
          </div>
        </section>
      ) : null}
    </div>
  );
}
