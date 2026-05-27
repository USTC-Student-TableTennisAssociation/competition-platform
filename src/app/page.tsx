import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Clock3,
  ListChecks,
  MapPin,
  TrendingUp,
  UserRound,
  Users,
} from "lucide-react";
import { MatchStatus } from "@prisma/client";
import { isMatchAllResultsFinished } from "@/lib/match-status";
import EloTrendChart from "@/components/home/EloTrendChart";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeAvatarUrl } from "@/lib/utils";

const statusLabelMap: Record<MatchStatus, "报名中" | "进行中" | "已结束"> = {
  registration: "报名中",
  ongoing: "进行中",
  finished: "已结束",
};

const typeLabelMap = {
  single: "单打",
  double: "双打",
  team: "团体",
} as const;

type GroupingPayload = {
  groups?: Array<{ players: Array<{ id: string }> }>;
} | null;

type ResultLite = {
  winnerTeamIds: string[];
  loserTeamIds: string[];
  confirmed: boolean;
  score?: unknown;
  createdAt?: Date;
  resultVerifiedAt?: Date | null;
};

type PlayerSummary = {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  eloRating: number;
  points: number;
  wins: number;
  losses: number;
  matchesPlayed: number;
};

type MyMatchItem = {
  id: string;
  title: string;
  status: MatchStatus;
  dateTime: Date;
  phase: string;
  confirmedCount: number;
  pendingCount: number;
};

type RecentResultItem = {
  id: string;
  matchId: string;
  opponentLabel: string;
  isWin: boolean;
  eloDelta: number | null;
};

type OpenMatchItem = {
  id: string;
  title: string;
  type: keyof typeof typeLabelMap;
  dateTime: Date;
  deadline: Date;
  location: string;
  participants: number;
  maxParticipants: number;
  isRegistered: boolean;
};

type RankingItem = PlayerSummary & {
  rank: number;
};

function formatCompactDate(value: Date) {
  return value.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateOnly(value: Date) {
  return value.toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
}

function getCurrentTermStart() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  if (month >= 8) return new Date(year, 8, 1);
  if (month >= 1) return new Date(year, 1, 1);
  return new Date(year - 1, 8, 1);
}

function resultIncludesUser(result: ResultLite, userId: string) {
  return (
    result.winnerTeamIds.includes(userId) || result.loserTeamIds.includes(userId)
  );
}

function parseScoreText(score: unknown) {
  if (typeof score === "string") return score;
  if (typeof score === "object" && score) {
    if ("text" in score && score.text) return String(score.text);
    if ("myScore" in score && "opponentScore" in score) {
      return `${String(score.myScore)}:${String(score.opponentScore)}`;
    }
  }
  return "";
}

function stageLabel(input: {
  status: MatchStatus;
  format: "group_only" | "group_then_knockout";
  groupingPayload: GroupingPayload;
  userId: string;
  results: ResultLite[];
}) {
  const { status, format, groupingPayload, userId, results } = input;

  if (status === "registration") return "等待开赛";
  if (status === "finished") return "比赛已结束";
  if (!groupingPayload?.groups) return "等待分组";

  const group = groupingPayload.groups.find((item) =>
    item.players.some((player) => player.id === userId),
  );
  if (!group) return "等待编排赛程";

  const opponents = group.players.filter((player) => player.id !== userId);
  const done = opponents.filter((opponent) =>
    results.some(
      (result) =>
        result.confirmed &&
        resultIncludesUser(result, userId) &&
        resultIncludesUser(result, opponent.id),
    ),
  ).length;

  if (done >= opponents.length && format === "group_then_knockout") {
    return `小组赛 ${done}/${opponents.length}，等待淘汰赛`;
  }

  return `小组赛 ${done}/${opponents.length}`;
}

function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-lg border border-[#30363d] bg-[#0d1117] ${className}`}
    >
      {children}
    </section>
  );
}

function PanelHeader({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#30363d] px-4 py-3">
      <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
      {action}
    </div>
  );
}

function StatusBadge({ status }: { status: MatchStatus | "registered" }) {
  const styles = {
    registration: "border-orange-300/25 bg-orange-400/10 text-orange-100",
    ongoing: "border-sky-300/20 bg-sky-400/10 text-sky-100",
    finished: "border-slate-500/25 bg-slate-500/10 text-slate-400",
    registered: "border-emerald-300/20 bg-emerald-400/10 text-emerald-100",
  } as const;

  return (
    <span
      className={`inline-flex rounded-md border px-2 py-0.5 text-[11px] font-medium ${styles[status]}`}
    >
      {status === "registered" ? "已报名" : statusLabelMap[status]}
    </span>
  );
}

function Avatar({
  user,
  size = "h-10 w-10",
}: {
  user: { nickname: string; avatarUrl: string | null };
  size?: string;
}) {
  const avatarUrl = normalizeAvatarUrl(user.avatarUrl);
  const fallback = (user.nickname.trim().charAt(0) || "?").toUpperCase();

  return (
    <div
      className={`grid shrink-0 place-items-center overflow-hidden rounded-full border border-white/[0.08] bg-orange-400/[0.08] font-semibold text-orange-100 ${size}`}
    >
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={avatarUrl} alt={user.nickname} className="h-full w-full object-cover" />
      ) : (
        <span aria-hidden="true">{fallback}</span>
      )}
    </div>
  );
}

function MyMatchContextPanel({
  currentMatch,
  pendingCount,
  recentResults,
}: {
  currentMatch: MyMatchItem | null;
  pendingCount: number;
  recentResults: RecentResultItem[];
}) {
  return (
    <section className="border-b border-[#30363d] bg-[#0d1117] lg:min-h-[calc(100vh-3.5rem)] lg:border-b-0 lg:border-r">
      <div className="border-b border-[#30363d] px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-100">我的比赛</h2>
      </div>
      <div className="space-y-5 p-4">
        <div>
          <p className="mb-2 text-xs font-medium text-slate-500">当前参与</p>
          {currentMatch ? (
            <div className="border-l-2 border-orange-300/60 pl-3">
              <Link
                href={`/matchs/${currentMatch.id}`}
                className="line-clamp-2 text-sm font-semibold text-slate-100 hover:text-orange-200"
              >
                {currentMatch.title}
              </Link>
              <p className="mt-2 text-xs text-slate-400">{currentMatch.phase}</p>
              <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
                {currentMatch.confirmedCount} 场已完成
                {currentMatch.pendingCount > 0 ? (
                  <span className="text-orange-200">
                    · {currentMatch.pendingCount} 场待确认
                  </span>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="border-l-2 border-white/[0.08] pl-3 text-sm text-slate-400">
              当前没有进行中的报名比赛。
            </div>
          )}
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-slate-500">待处理</p>
          <Link
            href={currentMatch ? `/matchs/${currentMatch.id}` : "/quick-match"}
            className="flex items-center justify-between border-y border-[#30363d] py-2 text-sm text-slate-300 hover:text-slate-100"
          >
            <span>{pendingCount > 0 ? `${pendingCount} 场赛果待确认` : "暂无待确认赛果"}</span>
            <ListChecks className="h-4 w-4 text-slate-500" />
          </Link>
        </div>

        <div>
          <p className="mb-2 text-xs font-medium text-slate-500">最近战绩</p>
          <div className="space-y-2">
            {recentResults.length > 0 ? (
              recentResults.map((result) => (
                <Link
                  key={result.id}
                  href={`/matchs/${result.matchId}`}
                  className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-white/[0.035]"
                >
                  <span className="min-w-0 truncate text-slate-300">
                    <span
                      className={
                        result.isWin ? "text-emerald-300" : "text-rose-300"
                      }
                    >
                      {result.isWin ? "胜" : "负"}
                    </span>{" "}
                    {result.opponentLabel}
                  </span>
                  <span
                    className={
                      result.eloDelta === null
                        ? "text-slate-500"
                        : result.eloDelta >= 0
                          ? "text-emerald-300"
                          : "text-rose-300"
                    }
                  >
                    {result.eloDelta === null
                      ? "-"
                      : `${result.eloDelta >= 0 ? "+" : ""}${result.eloDelta}`}
                  </span>
                </Link>
              ))
            ) : (
              <p className="py-1.5 text-sm text-slate-500">
                暂无已确认战绩。
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function PlayerStatusCard({
  user,
  winRate,
  rank,
  termCount,
  eloDelta,
  eloPoints,
}: {
  user: PlayerSummary | null;
  winRate: number;
  rank: number | null;
  termCount: number;
  eloDelta: number;
  eloPoints: Array<{ elo: number; createdAt: string }>;
}) {
  if (!user) {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-full border border-white/[0.08] bg-[#010409]">
            <UserRound className="h-5 w-5 text-slate-500" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-white">竞技概览</h2>
            <p className="mt-1 text-sm text-slate-400">
              登录后展示 ELO、排名和近期走势。
            </p>
          </div>
        </div>
      </Card>
    );
  }

  const metrics = [
    { label: "ELO", value: user.eloRating, tone: "text-orange-100" },
    { label: "积分", value: user.points, tone: "text-slate-100" },
    { label: "排名", value: rank ? `#${rank}` : "-", tone: "text-slate-100" },
    { label: "战绩", value: `${user.wins}/${user.losses}`, tone: "text-slate-100" },
    { label: "胜率", value: `${winRate}%`, tone: "text-emerald-200" },
    { label: "本学期参赛", value: termCount, tone: "text-slate-100" },
  ];

  return (
  <Card className="overflow-hidden">
    <div className="grid md:grid-cols-[180px_minmax(0,1fr)] xl:grid-cols-[190px_minmax(0,1fr)]">
      <div className="flex min-w-0 items-center gap-4 border-b border-[#30363d] p-4 text-center md:flex-col md:items-center md:justify-center md:border-b-0 md:border-r">
        <Avatar user={user} size="h-20 w-20 text-2xl md:h-[160px] md:w-[160px]" />

        <div className="min-w-0 md:mt-2 md:w-full">
          <h2 className="mt-1 truncate text-2xl font-semibold leading-none text-white md:text-[28px]">
            {user.nickname}
          </h2>
        </div>
      </div>

      <div className="flex min-w-0 flex-col px-4 py-4">
        <div className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3">
          {metrics.map((item) => (
            <div key={item.label} className="min-w-0 border-b border-[#30363d] pb-2">
              <p className="text-[11px] font-medium text-slate-500">{item.label}</p>
              <p className={`mt-1 truncate text-lg font-semibold tabular-nums leading-tight ${item.tone}`}>
                {item.value}
              </p>
            </div>
          ))}
        </div>

        <div className="mt-3 min-w-0">
          <div className="mb-1.5 flex items-center justify-between text-xs text-slate-400">
            <span className="inline-flex items-center gap-1.5">
              <TrendingUp className="h-3.5 w-3.5 text-orange-200" />
              最近 ELO 走势
            </span>
          </div>

          <div className="h-[112px] w-full min-w-0">
            <EloTrendChart points={eloPoints} compact />
          </div>
        </div>
      </div>
    </div>
  </Card>
 );
}

function OpenRegistrationList({ matches }: { matches: OpenMatchItem[] }) {
  return (
    <Card>
      <PanelHeader
        title="可报名比赛"
        action={
          <Link
            href="/matchs"
            className="text-xs font-semibold text-orange-200 hover:text-orange-100"
          >
            查看更多
          </Link>
        }
      />
      <div className="divide-y divide-[#30363d]">
        {matches.length > 0 ? (
          matches.map((match) => {
            const remaining = Math.max(match.maxParticipants - match.participants, 0);
            const actionText = match.isRegistered ? "查看详情" : "立即报名";

            return (
              <Link
                key={match.id}
                href={`/matchs/${match.id}`}
                className="block p-3.5 transition hover:bg-white/[0.025]"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <StatusBadge status={match.isRegistered ? "registered" : MatchStatus.registration} />
                      <span className="rounded-md border border-white/[0.07] px-2 py-0.5 text-[11px] text-slate-400">
                        {typeLabelMap[match.type]}
                      </span>
                    </div>
                    <h3 className="line-clamp-2 text-sm font-semibold text-slate-100">
                      {match.title}
                    </h3>
                  </div>
                  <span className="btn-primary inline-flex shrink-0 items-center justify-center gap-1 rounded-md px-3 py-2 text-xs font-semibold">
                    {actionText}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </span>
                </div>
                <div className="mt-3 grid gap-2 text-xs text-slate-400 sm:grid-cols-4">
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarDays className="h-3.5 w-3.5 text-slate-500" />
                    {formatDateOnly(match.dateTime)}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <MapPin className="h-3.5 w-3.5 text-slate-500" />
                    <span className="truncate">{match.location}</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <Users className="h-3.5 w-3.5 text-slate-500" />
                    {match.participants}/{match.maxParticipants}，余 {remaining}
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <Clock3 className="h-3.5 w-3.5 text-slate-500" />
                    截止 {formatCompactDate(match.deadline)}
                  </span>
                </div>
              </Link>
            );
          })
        ) : (
          <div className="p-4 text-sm text-slate-400">
            当前暂无开放报名的比赛。
          </div>
        )}
      </div>
    </Card>
  );
}

function LeaderboardPreview({
  players,
  myRank,
}: {
  players: RankingItem[];
  myRank: number | null;
}) {
  return (
    <section className="border-t border-[#30363d]">
      <div className="flex items-center justify-between gap-3 border-b border-[#30363d] px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-100">排行榜预览</h2>
          <Link
            href="/rankings"
            className="text-xs font-semibold text-orange-200 hover:text-orange-100"
          >
            完整榜单
          </Link>
      </div>
      <div className="p-4">
        <div className="divide-y divide-[#30363d]">
          {players.map((player) => (
            <Link
              key={player.id}
              href={`/profile/${player.id}`}
              className="grid grid-cols-[34px_1fr_auto] items-center gap-2 py-2 text-sm hover:bg-white/[0.025]"
            >
              <span className="text-xs font-semibold text-slate-500">
                #{player.rank}
              </span>
              <span className="flex min-w-0 items-center gap-2">
                <Avatar user={player} size="h-7 w-7 text-xs" />
                <span className="truncate text-slate-300">{player.nickname}</span>
              </span>
              <span className="font-semibold tabular-nums text-slate-100">
                {player.eloRating}
              </span>
            </Link>
          ))}
        </div>
        <div className="mt-4 border-t border-[#30363d] pt-3 text-sm text-slate-400">
          我的当前排名：
          <span className="font-semibold text-slate-100">
            {myRank ? `#${myRank}` : "登录后查看"}
          </span>
        </div>
      </div>
    </section>
  );
}

function AssociationBrandCard() {
  return (
    <section className="px-4 py-5">
      <div className="flex items-center gap-3">
        <div className="grid h-14 w-14 shrink-0 place-items-center rounded-lg border border-white/[0.08] bg-white/[0.035]">
          <Image
            src="/SVG/乒协徽章.svg"
            alt="USTC TTA"
            width={48}
            height={48}
            className="h-12 w-12 object-contain"
          />
        </div>
        <div className="min-w-0">
          <p className="text-lg font-semibold tracking-normal text-white">
            USTC TTA
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            乒协赛事平台
          </p>
        </div>
      </div>
    </section>
  );
}

export default async function Home() {
  const currentUser = await getCurrentUser();
  const termStart = getCurrentTermStart();
  const openRegistrationUserId = currentUser?.id ?? "__guest__";

  const [
    openMatches,
    myRegistrations,
    eloHistories,
    topPlayersRaw,
    recentResultsRaw,
    pendingResultCount,
    termRegistrationCount,
    betterRankCount,
  ] = await Promise.all([
    prisma.match.findMany({
      where: {
        isQuickMatch: false,
        status: MatchStatus.registration,
      },
      orderBy: [{ registrationDeadline: "asc" }, { dateTime: "asc" }],
      take: 3,
      include: {
        _count: { select: { registrations: true } },
        registrations: {
          where: { userId: openRegistrationUserId },
          select: { id: true },
        },
      },
    }),
    currentUser
      ? prisma.registration.findMany({
          where: {
            userId: currentUser.id,
            match: { isQuickMatch: false },
          },
          orderBy: { createdAt: "desc" },
          take: 10,
          include: {
            match: {
              select: {
                id: true,
                title: true,
                dateTime: true,
                format: true,
                status: true,
                groupingGeneratedAt: true,
                groupingResult: { select: { payload: true } },
                results: {
                  select: {
                    winnerTeamIds: true,
                    loserTeamIds: true,
                    confirmed: true,
                    score: true,
                    createdAt: true,
                    resultVerifiedAt: true,
                  },
                },
              },
            },
          },
        })
      : Promise.resolve([]),
    currentUser
      ? prisma.eloHistory.findMany({
          where: { userId: currentUser.id },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: { eloAfter: true, createdAt: true },
        })
      : Promise.resolve([]),
    prisma.user.findMany({
      where: { isBanned: false },
      orderBy: [{ eloRating: "desc" }, { points: "desc" }],
      take: 10,
      select: {
        id: true,
        nickname: true,
        avatarUrl: true,
        eloRating: true,
        points: true,
        wins: true,
        losses: true,
        matchesPlayed: true,
      },
    }),
    currentUser
      ? prisma.matchResult.findMany({
          where: {
            confirmed: true,
            OR: [
              { winnerTeamIds: { has: currentUser.id } },
              { loserTeamIds: { has: currentUser.id } },
            ],
            match: { isQuickMatch: false },
          },
          orderBy: { resultVerifiedAt: "desc" },
          take: 4,
          select: {
            id: true,
            matchId: true,
            winnerTeamIds: true,
            loserTeamIds: true,
            score: true,
            match: { select: { id: true, title: true } },
          },
        })
      : Promise.resolve([]),
    currentUser
      ? prisma.matchResult.count({
          where: {
            confirmed: false,
            reportedBy: { not: currentUser.id },
            OR: [
              { winnerTeamIds: { has: currentUser.id } },
              { loserTeamIds: { has: currentUser.id } },
            ],
            match: { isQuickMatch: false },
          },
        })
      : Promise.resolve(0),
    currentUser
      ? prisma.registration.count({
          where: {
            userId: currentUser.id,
            createdAt: { gte: termStart },
            match: { isQuickMatch: false },
          },
        })
      : Promise.resolve(0),
    currentUser
      ? prisma.user.count({
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
        })
      : Promise.resolve(null),
  ]);

  const uniqueRegisteredMatches = new Map(
    myRegistrations.map((registration) => [
      registration.match.id,
      registration.match,
    ]),
  );
  const matchesToFinish = Array.from(uniqueRegisteredMatches.values()).filter(
    (match) =>
      match.status !== MatchStatus.finished &&
      isMatchAllResultsFinished({
        format: match.format,
        groupingGeneratedAt: match.groupingGeneratedAt,
        groupingResult: match.groupingResult,
        results: match.results,
      }),
  );

  if (matchesToFinish.length > 0) {
    await prisma.$transaction(
      matchesToFinish.map((match) =>
        prisma.match.update({
          where: { id: match.id },
          data: { status: MatchStatus.finished },
        }),
      ),
    );
  }

  const finishedMatchIds = new Set(matchesToFinish.map((match) => match.id));
  const eloAsc = [...eloHistories].reverse();
  const eloPoints = eloAsc.map((item) => ({
    elo: item.eloAfter,
    createdAt: item.createdAt.toISOString(),
  }));
  const eloDelta =
    eloAsc.length > 1
      ? eloAsc[eloAsc.length - 1].eloAfter -
        eloAsc[Math.max(0, eloAsc.length - 8)].eloAfter
      : 0;

  const winRate =
    currentUser && currentUser.matchesPlayed > 0
      ? Math.round((currentUser.wins / currentUser.matchesPlayed) * 100)
      : 0;
  const myRank = betterRankCount === null ? null : betterRankCount + 1;

  const myMatchItems: MyMatchItem[] = currentUser
    ? myRegistrations.map((registration) => {
        const match = registration.match;
        const status = finishedMatchIds.has(match.id)
          ? MatchStatus.finished
          : match.status;
        const results = match.results;

        return {
          id: match.id,
          title: match.title,
          status,
          dateTime: match.dateTime,
          phase: stageLabel({
            status,
            format: match.format,
            groupingPayload: (match.groupingResult?.payload ?? null) as GroupingPayload,
            userId: currentUser.id,
            results,
          }),
          confirmedCount: results.filter(
            (result) => result.confirmed && resultIncludesUser(result, currentUser.id),
          ).length,
          pendingCount: results.filter(
            (result) => !result.confirmed && resultIncludesUser(result, currentUser.id),
          ).length,
        };
      })
    : [];

  const currentMatch =
    myMatchItems.find((match) => match.status !== MatchStatus.finished) ??
    myMatchItems[0] ??
    null;

  const opponentIds = Array.from(
    new Set(
      recentResultsRaw.flatMap((result) => {
        if (!currentUser) return [];
        const isWin = result.winnerTeamIds.includes(currentUser.id);
        return isWin ? result.loserTeamIds : result.winnerTeamIds;
      }),
    ),
  );
  const opponentRows =
    opponentIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: opponentIds } },
          select: { id: true, nickname: true },
        })
      : [];
  const opponentNameById = new Map(
    opponentRows.map((user) => [user.id, user.nickname] as const),
  );
  const eloDeltasDesc = eloHistories.map((item, index) => {
    const previous = eloHistories[index + 1];
    return previous ? item.eloAfter - previous.eloAfter : null;
  });
  const recentResults: RecentResultItem[] = currentUser
    ? recentResultsRaw.map((result, index) => {
        const isWin = result.winnerTeamIds.includes(currentUser.id);
        const opponentTeamIds = isWin ? result.loserTeamIds : result.winnerTeamIds;
        const opponentLabel =
          opponentTeamIds
            .map((id) => opponentNameById.get(id) ?? id)
            .join(" / ") || "未知对手";
        const scoreText = parseScoreText(result.score);

        return {
          id: result.id,
          matchId: result.matchId,
          opponentLabel: scoreText
            ? `${opponentLabel} · ${scoreText}`
            : opponentLabel,
          isWin,
          eloDelta: eloDeltasDesc[index] ?? null,
        };
      })
    : [];

  const openMatchItems: OpenMatchItem[] = openMatches.map((match) => ({
    id: match.id,
    title: match.title,
    type: match.type,
    dateTime: match.dateTime,
    deadline: match.registrationDeadline,
    location: match.location ?? "待定",
    participants: match._count.registrations,
    maxParticipants: match.maxParticipants,
    isRegistered: match.registrations.length > 0,
  }));

  const leaderboardPlayers: RankingItem[] = topPlayersRaw.map((player, index) => ({
    ...player,
    rank: index + 1,
  }));

  return (
    <div className="relative left-1/2 -mt-4 w-screen -translate-x-1/2 sm:-mt-6 md:-mt-8">
      <div className="grid lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_320px]">
        <aside className="xl:sticky xl:top-14 xl:self-start">
          <MyMatchContextPanel
            currentMatch={currentMatch}
            pendingCount={pendingResultCount}
            recentResults={recentResults}
          />
        </aside>

        <main className="min-w-0 space-y-5 px-3 py-4 sm:px-5 md:px-7 xl:px-8">
          <PlayerStatusCard
            user={currentUser}
            winRate={winRate}
            rank={myRank}
            termCount={termRegistrationCount}
            eloDelta={eloDelta}
            eloPoints={eloPoints}
          />
          <OpenRegistrationList matches={openMatchItems} />
        </main>

        <aside className="border-t border-[#30363d] bg-[#0d1117] lg:col-span-2 xl:sticky xl:top-14 xl:col-span-1 xl:min-h-[calc(100vh-3.5rem)] xl:self-start xl:border-l xl:border-t-0">
          <AssociationBrandCard />
          <LeaderboardPreview players={leaderboardPlayers} myRank={myRank} />
        </aside>
      </div>
    </div>
  );
}
