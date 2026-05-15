import Link from "next/link";
import Image from "next/image";
import type { ReactNode } from "react";
import {
  Activity,
  ArrowRight,
  ChevronRight,
  Clock3,
  Swords,
  TrendingUp,
  Trophy,
} from "lucide-react";
import { MatchStatus } from "@prisma/client";
import { isMatchAllResultsFinished } from "@/lib/match-status";
import EloTrendChart from "@/components/home/EloTrendChart";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

const statusLabelMap: Record<MatchStatus, "报名中" | "进行中" | "已结束"> = {
  registration: "报名中",
  ongoing: "进行中",
  finished: "已结束",
};

function stageLabel(input: {
  status: MatchStatus;
  format: "group_only" | "group_then_knockout";
  groupingPayload: {
    groups?: Array<{ players: Array<{ id: string }> }>;
  } | null;
  userId: string;
  userConfirmedResults: Array<{
    winnerTeamIds: string[];
    loserTeamIds: string[];
  }>;
}) {
  const { status, format, groupingPayload, userId, userConfirmedResults } =
    input;

  if (status === "registration") return "报名中（等待开赛）";
  if (status === "finished") return "比赛已结束";
  if (!groupingPayload?.groups) return "分组待发布";

  const group = groupingPayload.groups.find((item) =>
    item.players.some((player) => player.id === userId),
  );
  if (!group) return "等待编排赛程";

  const opponents = group.players.filter((player) => player.id !== userId);
  const done = opponents.filter((opponent) =>
    userConfirmedResults.some((result) => {
      const ids = [...result.winnerTeamIds, ...result.loserTeamIds];
      return ids.includes(userId) && ids.includes(opponent.id);
    }),
  ).length;

  if (done >= opponents.length && format === "group_then_knockout") {
    return `小组赛 ${done}/${opponents.length}（已完成，等待淘汰赛）`;
  }

  return `小组赛 ${done}/${opponents.length}`;
}

function formatCompactDate(value: Date) {
  return value.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type DashboardMatchItem = {
  key: string;
  id: string;
  title: string;
  dateTime: Date;
  status: MatchStatus;
  phase: string;
};

type PlayerSummary = {
  nickname: string;
  avatarUrl: string | null;
  eloRating: number;
  points: number;
  wins: number;
  losses: number;
  matchesPlayed: number;
};

function CourtLineDecoration() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute left-8 right-8 top-1/2 h-px bg-white/[0.035]" />
      <div className="absolute bottom-8 top-8 left-[58%] w-px bg-white/[0.035]" />
      <div className="absolute -right-14 top-12 h-28 w-64 -skew-x-12 border-y border-white/[0.035]" />
      <div className="absolute bottom-10 left-8 h-px w-28 -skew-x-12 bg-orange-300/[0.12]" />
    </div>
  );
}

function PingPongBallDecoration() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute -right-10 -top-10 h-36 w-36 rounded-full border border-orange-200/20 bg-orange-400/[0.08] blur-[1px] sm:h-44 sm:w-44"
    >
      <span className="absolute left-8 top-10 h-16 w-px -rotate-45 bg-orange-100/[0.08]" />
    </div>
  );
}

function SectionTitle({
  label,
  title,
  action,
}: {
  label: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-3">
      <div className="flex items-end gap-3">
        <span className="mb-1 h-7 w-1.5 -skew-x-12 rounded-full bg-orange-400" />
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">
            {label}
          </p>
          <h2 className="mt-1 text-xl font-bold text-white sm:text-2xl">
            {title}
          </h2>
        </div>
      </div>
      {action}
    </div>
  );
}

function StatusBadge({ status }: { status: MatchStatus }) {
  const styles = {
    registration:
      "border-orange-300/20 bg-orange-400/12 text-orange-100",
    ongoing: "border-sky-300/18 bg-sky-400/10 text-sky-100",
    finished: "border-white/[0.08] bg-white/[0.04] text-slate-400",
  } as const;

  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ${styles[status]}`}
    >
      {statusLabelMap[status]}
    </span>
  );
}

function PrimaryActionPanel({
  openCount,
}: {
  openCount: number;
}) {
  return (
    <section className="relative overflow-hidden rounded-[2rem] border border-white/[0.08] bg-[#171D2B] p-5 shadow-2xl shadow-black/20 sm:p-7 lg:col-span-8 lg:p-8">
      <CourtLineDecoration />
      <PingPongBallDecoration />

      <div className="relative z-10 flex h-full min-h-[360px] flex-col justify-between gap-10">
        <div className="flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-black/[0.18] ring-1 ring-white/[0.08]">
            <Image
              src="/SVG/乒协徽章.svg"
              alt="中国科学技术大学校乒乓球协会徽章"
              width={56}
              height={56}
              className="h-9 w-9 object-contain opacity-90"
            />
          </div>
          <div>
            <p className="text-xs font-semibold text-orange-200/90">
              USTC Table Tennis Association
            </p>
            <p className="mt-0.5 text-xs text-slate-500">
              夜间球馆 · 校园积分赛
            </p>
          </div>
        </div>

        <div>
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-orange-300/18 bg-orange-400/10 px-3 py-1.5 text-xs font-semibold text-orange-100">
            <span className="h-1.5 w-1.5 rounded-full bg-orange-400" />
            当前 {openCount} 场比赛开放报名
          </div>
          <h1 className="max-w-3xl text-4xl font-extrabold leading-tight tracking-tight text-white sm:text-5xl lg:text-6xl">
            赛事报名、ELO 排名与成长记录
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-300 sm:text-base sm:leading-7">
            优先查看可报名比赛、个人竞技数据和近期赛程，把每一次校内对局都沉淀成可追踪的成长记录。
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <Link
            href="/matchs"
            className="btn-primary inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-bold"
          >
            <Swords className="h-4 w-4" />
            进入赛事大厅
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href="/rankings"
            className="btn-secondary inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-bold"
          >
            <Trophy className="h-4 w-4" />
            查看排行榜
          </Link>
        </div>
      </div>
    </section>
  );
}

function StatItem({
  label,
  value,
  tone = "text-slate-100",
}: {
  label: string;
  value: string | number;
  tone?: string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-[#080B12]/72 px-3 py-3">
      <p className="text-[11px] font-medium text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-extrabold tabular-nums ${tone}`}>
        {value}
      </p>
    </div>
  );
}

function PlayerSummaryPanel({
  user,
  winRate,
  eloDelta7d,
  eloValues,
  eloPoints,
}: {
  user: PlayerSummary | null;
  winRate: number;
  eloDelta7d: number;
  eloValues: number[];
  eloPoints: Array<{ elo: number; createdAt: string }>;
}) {
  if (!user) {
    return (
      <aside className="rounded-[2rem] border border-white/[0.06] bg-[#101520]/72 p-5 lg:col-span-4">
        <p className="text-xs font-semibold text-slate-500">Player Summary</p>
        <h2 className="mt-3 text-2xl font-bold text-white">
          登录后解锁个人战绩面板
        </h2>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          可查看 ELO 走势、报名进度、个人比赛阶段和历史战绩。
        </p>
        <Link
          href="/auth"
          className="btn-primary mt-6 inline-flex w-full items-center justify-center rounded-xl px-5 py-3 text-sm font-bold"
        >
          登录 / 注册
        </Link>
      </aside>
    );
  }

  return (
    <aside className="rounded-[2rem] border border-white/[0.06] bg-[#101520]/72 p-5 lg:col-span-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="h-12 w-12 overflow-hidden rounded-full bg-[#171D2B] ring-1 ring-white/[0.08]">
            {user.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={user.avatarUrl}
                alt={user.nickname}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="grid h-full w-full place-items-center text-lg font-black text-orange-100">
                {user.nickname[0]?.toUpperCase() ?? "?"}
              </div>
            )}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-slate-500">
              Player Summary
            </p>
            <h2 className="truncate text-xl font-bold text-white">
              {user.nickname}
            </h2>
          </div>
        </div>
        <Link
          href="/profile"
          className="inline-flex shrink-0 items-center gap-1 rounded-xl border border-white/[0.08] px-3 py-2 text-xs font-semibold text-slate-300 transition hover:border-orange-300/30 hover:text-orange-100"
        >
          个人主页
          <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2">
        <StatItem label="ELO" value={user.eloRating} tone="text-sky-200" />
        <StatItem label="积分" value={user.points} />
        <StatItem label="胜负" value={`${user.wins}/${user.losses}`} />
        <StatItem label="胜率" value={`${winRate}%`} tone="text-orange-100" />
      </div>

      <div className="mt-5 border-t border-white/[0.06] pt-4">
        <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
          <span className="inline-flex items-center gap-1.5">
            <TrendingUp className="h-3.5 w-3.5 text-sky-300" />
            最近 ELO 走势
          </span>
          <span className={eloDelta7d >= 0 ? "text-sky-300" : "text-rose-300"}>
            {eloDelta7d >= 0 ? "+" : ""}
            {eloDelta7d}
          </span>
        </div>
        <div className="h-20 min-w-0">
          <EloTrendChart points={eloPoints} compact />
        </div>
        <p className="mt-2 text-right text-xs text-slate-500">
          {eloValues.length > 0
            ? `最新 ${eloValues[eloValues.length - 1]}`
            : "暂无数据"}
        </p>
      </div>
    </aside>
  );
}

function ActiveMatchCard({ match }: { match: DashboardMatchItem }) {
  const actionText =
    match.status === MatchStatus.registration ? "前往报名" : "查看详情";

  return (
    <Link
      href={`/matchs/${match.id}`}
      className="group relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[#171D2B]/86 p-4 transition hover:border-orange-300/30 hover:bg-[#1B2233] sm:p-5"
    >
      <div className="absolute inset-y-4 left-0 w-1.5 -skew-y-12 rounded-r-full bg-orange-400" />
      <div className="flex items-start justify-between gap-3 pl-2">
        <div className="min-w-0">
          <h3 className="line-clamp-2 text-lg font-bold text-white">
            {match.title}
          </h3>
          <p className="mt-2 flex items-center gap-1.5 text-sm text-slate-400">
            <Clock3 className="h-4 w-4 text-slate-500" />
            {formatCompactDate(match.dateTime)}
          </p>
        </div>
        <StatusBadge status={match.status} />
      </div>
      <div className="mt-5 flex flex-col gap-3 border-t border-white/[0.06] pt-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-[11px] text-slate-500">当前阶段</p>
          <p className="mt-1 text-sm font-semibold text-slate-200">
            {match.phase}
          </p>
        </div>
        <span className="inline-flex items-center justify-center gap-1 rounded-xl bg-orange-400 px-3 py-2 text-xs font-bold text-slate-950 transition group-hover:bg-orange-300">
          {actionText}
          <ArrowRight className="h-3.5 w-3.5" />
        </span>
      </div>
    </Link>
  );
}

function HistoryMatchRow({ match }: { match: DashboardMatchItem }) {
  return (
    <Link
      href={`/matchs/${match.id}`}
      className="grid gap-3 border-b border-white/[0.06] px-3 py-3 text-sm transition last:border-b-0 hover:bg-white/[0.025] sm:grid-cols-[1.4fr_120px_1fr_86px_64px] sm:items-center"
    >
      <div className="min-w-0">
        <p className="truncate font-semibold text-slate-300">{match.title}</p>
        <p className="mt-1 text-xs text-slate-500 sm:hidden">
          {formatCompactDate(match.dateTime)}
        </p>
      </div>
      <p className="hidden text-slate-500 sm:block">
        {formatCompactDate(match.dateTime)}
      </p>
      <p className="text-xs text-slate-500 sm:text-sm">{match.phase}</p>
      <StatusBadge status={match.status} />
      <span className="text-xs font-semibold text-slate-400 sm:text-right">
        查看
      </span>
    </Link>
  );
}

function ActiveMatchesSection({
  title,
  matches,
  emptyCopy,
}: {
  title: string;
  matches: DashboardMatchItem[];
  emptyCopy: string;
}) {
  return (
    <section>
      <SectionTitle
        label="On Court"
        title={title}
        action={
          <Link
            href="/matchs"
            className="inline-flex items-center gap-1 text-sm font-semibold text-sky-300 hover:text-sky-200"
          >
            赛事大厅
            <ChevronRight className="h-4 w-4" />
          </Link>
        }
      />
      {matches.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/[0.08] bg-[#101520]/48 p-6 text-center text-sm text-slate-400">
          <Activity className="mx-auto mb-3 h-8 w-8 text-slate-600" />
          {emptyCopy}
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {matches.slice(0, 4).map((match) => (
            <ActiveMatchCard key={match.key} match={match} />
          ))}
        </div>
      )}
    </section>
  );
}

function HistoryMatchesSection({
  matches,
}: {
  matches: DashboardMatchItem[];
}) {
  return (
    <section>
      <SectionTitle
        label="Archive"
        title="历史比赛记录"
        action={
          <Link
            href="/matchs"
            className="inline-flex items-center gap-1 text-sm font-semibold text-slate-400 hover:text-slate-200"
          >
            查看全部
            <ChevronRight className="h-4 w-4" />
          </Link>
        }
      />
      {matches.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.06] bg-[#101520]/38 p-5 text-sm text-slate-500">
          暂无历史比赛记录。
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-white/[0.06] bg-[#101520]/46">
          <div className="hidden border-b border-white/[0.06] px-3 py-2 text-[11px] font-semibold text-slate-600 sm:grid sm:grid-cols-[1.4fr_120px_1fr_86px_64px]">
            <span>比赛</span>
            <span>时间</span>
            <span>阶段</span>
            <span>状态</span>
            <span className="text-right">入口</span>
          </div>
          {matches.slice(0, 6).map((match) => (
            <HistoryMatchRow key={match.key} match={match} />
          ))}
        </div>
      )}
    </section>
  );
}

export default async function Home() {
  const [orderedMatchIds, currentUser] = await Promise.all([
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "Match"
      WHERE "isQuickMatch" = false
      ORDER BY ABS(EXTRACT(EPOCH FROM ("dateTime" - NOW()))) ASC, "dateTime" DESC, "createdAt" DESC
      LIMIT 6
    `,
    getCurrentUser(),
  ]);

  const latestMatches = await prisma.match.findMany({
    where: {
      id: {
        in: orderedMatchIds.map((match) => match.id),
      },
    },
    include: {
      _count: { select: { registrations: true } },
      groupingResult: { select: { payload: true } },
      results: {
        where: { confirmed: true },
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
  });

  const latestMatchesById = new Map(
    latestMatches.map((match) => [match.id, match] as const),
  );
  const sortedLatestMatches = orderedMatchIds
    .map((match) => latestMatchesById.get(match.id))
    .filter((match): match is (typeof latestMatches)[number] => Boolean(match));

  const latestMatchesToFinish = sortedLatestMatches.filter(
    (match) =>
      match.status !== MatchStatus.finished &&
      isMatchAllResultsFinished({
        format: match.format,
        groupingGeneratedAt: match.groupingGeneratedAt,
        groupingResult: match.groupingResult,
        results: match.results,
      }),
  );

  if (latestMatchesToFinish.length > 0) {
    await prisma.$transaction(
      latestMatchesToFinish.map((match) =>
        prisma.match.update({
          where: { id: match.id },
          data: { status: MatchStatus.finished },
        }),
      ),
    );
  }

  const finishedMatchIds = new Set(
    latestMatchesToFinish.map((match) => match.id),
  );

  let myRegistrations: Array<{
    id: string;
    createdAt: Date;
    match: {
      id: string;
      title: string;
      dateTime: Date;
      format: "group_only" | "group_then_knockout";
      status: MatchStatus;
      groupingGeneratedAt: Date | null;
      groupingResult: { payload: unknown } | null;
      results: Array<{
        winnerTeamIds: string[];
        loserTeamIds: string[];
        confirmed: boolean;
        score: unknown;
        createdAt: Date;
        resultVerifiedAt: Date | null;
      }>;
    };
  }> = [];
  let finishedRegistrationMatchIds = new Set<string>();
  let eloPoints: Array<{ elo: number; createdAt: string }> = [];
  let eloValues: number[] = [];
  let eloDelta7d = 0;

  if (currentUser) {
    const [registrations, histories] = await Promise.all([
      prisma.registration.findMany({
        where: {
          userId: currentUser.id,
          match: {
            isQuickMatch: false,
          },
        },
        orderBy: { createdAt: "desc" },
        take: 8,
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
                where: {
                  confirmed: true,
                },
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
      }),
      prisma.eloHistory.findMany({
        where: { userId: currentUser.id },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { eloAfter: true, createdAt: true },
      }),
    ]);

    myRegistrations = registrations;

    const registrationMatchesToFinish = registrations
      .map((registration) => registration.match)
      .filter(
        (match) =>
          match.status !== MatchStatus.finished &&
          isMatchAllResultsFinished({
            format: match.format,
            groupingGeneratedAt: match.groupingGeneratedAt,
            groupingResult: match.groupingResult,
            results: match.results,
          }),
      );

    if (registrationMatchesToFinish.length > 0) {
      await prisma.$transaction(
        registrationMatchesToFinish.map((match) =>
          prisma.match.update({
            where: { id: match.id },
            data: { status: MatchStatus.finished },
          }),
        ),
      );
    }

    finishedRegistrationMatchIds = new Set(
      registrationMatchesToFinish.map((match) => match.id),
    );

    const asc = [...histories].reverse();
    eloValues = asc.map((item) => item.eloAfter);
    eloPoints = asc.map((item) => ({
      elo: item.eloAfter,
      createdAt: item.createdAt.toISOString(),
    }));
    if (eloValues.length > 1) {
      const baseline = eloValues[Math.max(0, eloValues.length - 8)];
      eloDelta7d = eloValues[eloValues.length - 1] - baseline;
    }
  }

  const openMatches = sortedLatestMatches.filter((match) => {
    const resolvedStatus = finishedMatchIds.has(match.id)
      ? MatchStatus.finished
      : match.status;
    return resolvedStatus === MatchStatus.registration;
  });
  const winRate =
    currentUser && currentUser.matchesPlayed > 0
      ? Math.round((currentUser.wins / currentUser.matchesPlayed) * 100)
      : 0;
  const feedMatchItems: DashboardMatchItem[] = sortedLatestMatches.map(
    (match) => {
      const status = finishedMatchIds.has(match.id)
        ? MatchStatus.finished
        : match.status;

      return {
        key: `feed-${match.id}`,
        id: match.id,
        title: match.title,
        dateTime: match.dateTime,
        status,
        phase:
          status === MatchStatus.registration
            ? "报名开放中"
            : status === MatchStatus.ongoing
              ? "赛程进行中"
              : "比赛已结束",
      };
    },
  );
  const registrationMatchItems: DashboardMatchItem[] = currentUser
    ? myRegistrations.map((registration) => {
        const payload = (registration.match.groupingResult?.payload ??
          null) as {
          groups?: Array<{ players: Array<{ id: string }> }>;
        } | null;
        const status = finishedRegistrationMatchIds.has(registration.match.id)
          ? MatchStatus.finished
          : registration.match.status;

        return {
          key: `registration-${registration.id}`,
          id: registration.match.id,
          title: registration.match.title,
          dateTime: registration.match.dateTime,
          status,
          phase: stageLabel({
            status,
            format: registration.match.format,
            groupingPayload: payload,
            userId: currentUser.id,
            userConfirmedResults: registration.match.results,
          }),
        };
      })
    : [];
  const hasRegistrationList = Boolean(currentUser && myRegistrations.length > 0);
  const sourceMatchItems =
    hasRegistrationList ? registrationMatchItems : feedMatchItems;
  const activeMatchItems = sourceMatchItems.filter(
    (match) => match.status !== MatchStatus.finished,
  );
  const historyMatchItems = sourceMatchItems.filter(
    (match) => match.status === MatchStatus.finished,
  );

  return (
    <div className="space-y-8 sm:space-y-10">
      <div className="grid gap-4 lg:grid-cols-12 lg:gap-5">
        <PrimaryActionPanel openCount={openMatches.length} />
        <PlayerSummaryPanel
          user={currentUser}
          winRate={winRate}
          eloDelta7d={eloDelta7d}
          eloValues={eloValues}
          eloPoints={eloPoints}
        />
      </div>

      <ActiveMatchesSection
        title={hasRegistrationList ? "我的报名赛程" : "当前赛事行动"}
        matches={activeMatchItems}
        emptyCopy={
          hasRegistrationList
            ? "你当前没有进行中或待开始的报名比赛。"
            : "当前暂无开放或进行中的比赛，可以进入赛事大厅查看全部赛事。"
        }
      />

      <HistoryMatchesSection matches={historyMatchItems} />
    </div>
  );
}
