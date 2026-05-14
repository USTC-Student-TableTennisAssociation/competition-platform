import Link from "next/link";
import Image from "next/image";
import {
  Activity,
  CalendarRange,
  ChevronRight,
  Swords,
  TrendingUp,
  Trophy,
} from "lucide-react";
import { MatchStatus } from "@prisma/client";
import MatchCard from "@/components/match/MatchCard";
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
  const homeFeedMatches =
    openMatches.length > 0 ? openMatches : sortedLatestMatches;

  return (
    <div className="space-y-6 sm:space-y-8">
      <section className="surface-panel relative overflow-hidden rounded-3xl p-4 sm:p-6 lg:p-7">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_82%_8%,rgba(45,212,191,0.12),transparent_34%)]" />
        <div className="relative grid gap-5 xl:grid-cols-[0.82fr_1.18fr] xl:items-stretch">
          <div className="flex flex-col justify-between gap-5">
            <div className="flex items-center gap-4">
              <div className="grid h-16 w-16 shrink-0 place-items-center rounded-3xl bg-white/[0.035] ring-1 ring-white/10 sm:h-20 sm:w-20">
                <Image
                  src="/SVG/乒协徽章.svg"
                  alt="中国科学技术大学校乒乓球协会徽章"
                  width={88}
                  height={88}
                  className="h-12 w-12 object-contain sm:h-16 sm:w-16"
                />
              </div>
              <div className="min-w-0">
                <p className="eyebrow">USTC Table Tennis Association</p>
                <Image
                  src="/SVG/乒协文字.svg"
                  alt="中国科学技术大学校乒乓球协会文字标识"
                  width={420}
                  height={72}
                  className="mt-2 h-auto w-full max-w-sm opacity-95"
                />
              </div>
            </div>
            <div>
              <h1 className="max-w-2xl text-2xl font-black leading-tight tracking-tight text-white sm:text-4xl">
                赛事报名、ELO 排名与成长记录都在这里。
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
                优先查看可报名比赛、个人竞技数据和近期赛程；后台能力保持完整，前台体验更聚焦。
              </p>
              <div className="mt-5 flex flex-col gap-2 sm:flex-row">
                <Link
                  href="/matchs"
                  className="btn-primary inline-flex items-center justify-center gap-2 rounded-2xl px-5 py-3 text-sm font-bold"
                >
                  <Swords className="h-4 w-4" />
                  进入赛事大厅
                </Link>
                <Link
                  href="/rankings"
                  className="btn-secondary inline-flex items-center justify-center gap-2 rounded-2xl px-5 py-3 text-sm font-bold"
                >
                  <Trophy className="h-4 w-4" />
                  查看排行榜
                </Link>
              </div>
            </div>
          </div>

          {currentUser ? (
            <div className="surface-card rounded-3xl p-4 sm:p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="h-14 w-14 overflow-hidden rounded-2xl bg-slate-800 ring-1 ring-white/10 sm:h-16 sm:w-16">
                    {currentUser.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={currentUser.avatarUrl}
                        alt={currentUser.nickname}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="grid h-full w-full place-items-center text-xl font-black text-slate-200">
                        {currentUser.nickname[0]?.toUpperCase() ?? "?"}
                      </div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="eyebrow">My Arena</p>
                    <h2 className="mt-1 truncate text-xl font-black text-white sm:text-2xl">
                      {currentUser.nickname}
                    </h2>
                    <p className="mt-1 text-xs text-slate-400">
                      近 7 条记录 ELO：
                      <span
                        className={
                          eloDelta7d >= 0 ? "text-emerald-300" : "text-rose-300"
                        }
                      >
                        {eloDelta7d >= 0 ? "+" : ""}
                        {eloDelta7d}
                      </span>
                    </p>
                  </div>
                </div>
                <Link
                  href="/profile"
                  className="btn-secondary inline-flex items-center justify-center gap-1.5 rounded-2xl px-3 py-2 text-xs font-bold"
                >
                  个人主页
                  <ChevronRight className="h-4 w-4" />
                </Link>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["ELO", currentUser.eloRating, "text-teal-100"],
                  ["积分", currentUser.points, "text-sky-100"],
                  ["胜负", `${currentUser.wins}/${currentUser.losses}`, "text-slate-100"],
                  ["胜率", `${winRate}%`, "text-emerald-100"],
                ].map(([label, value, color]) => (
                  <div
                    key={label}
                    className="rounded-2xl bg-white/[0.035] px-3 py-3 ring-1 ring-white/8"
                  >
                    <p className="text-[11px] text-slate-500">{label}</p>
                    <p className={`mt-1 text-xl font-black tabular-nums ${color}`}>
                      {value}
                    </p>
                  </div>
                ))}
              </div>

              <div className="mt-4 rounded-2xl bg-slate-950/38 p-3 ring-1 ring-white/8">
                <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
                  <span className="inline-flex items-center gap-1.5">
                    <TrendingUp className="h-3.5 w-3.5 text-teal-200" />
                    最近 ELO 走势
                  </span>
                  <span>
                    {eloValues.length > 0
                      ? `最新 ${eloValues[eloValues.length - 1]}`
                      : "暂无数据"}
                  </span>
                </div>
                <div className="h-24 w-full sm:h-28">
                  <EloTrendChart points={eloPoints} />
                </div>
              </div>
            </div>
          ) : (
            <div className="surface-card flex flex-col justify-between rounded-3xl p-5">
              <div>
                <p className="eyebrow">Guest Mode</p>
                <h2 className="mt-2 text-xl font-black text-white">
                  登录后解锁个人战绩面板
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-400">
                  可查看 ELO 走势、报名进度、个人比赛阶段和历史战绩。
                </p>
              </div>
              <Link
                href="/auth"
                className="btn-primary mt-5 inline-flex items-center justify-center rounded-2xl px-5 py-3 text-sm font-bold"
              >
                登录 / 注册
              </Link>
            </div>
          )}
        </div>
      </section>

      {currentUser && (
        <section>
          <div className="mb-4 flex items-end justify-between gap-3">
            <div>
              <p className="eyebrow">My Matches</p>
              <h2 className="mt-1 text-xl font-black text-white sm:text-2xl">
                我报名的比赛
              </h2>
            </div>
            <Link
              href="/matchs"
              className="inline-flex items-center gap-1 text-sm font-semibold text-teal-200 hover:text-teal-100"
            >
              查看全部
              <ChevronRight className="h-4 w-4" />
            </Link>
          </div>

          {myRegistrations.length === 0 ? (
            <div className="surface-card rounded-3xl p-6 text-center text-sm text-slate-400 sm:p-8">
              <CalendarRange className="mx-auto mb-3 h-8 w-8 text-slate-600" />
              你还没有报名比赛。可以先去赛事大厅看看当前可报名项目。
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {myRegistrations.map((registration) => {
                const payload = (registration.match.groupingResult?.payload ??
                  null) as {
                  groups?: Array<{ players: Array<{ id: string }> }>;
                } | null;
                const currentStatus = finishedRegistrationMatchIds.has(
                  registration.match.id,
                )
                  ? MatchStatus.finished
                  : registration.match.status;

                const phase = stageLabel({
                  status: currentStatus,
                  format: registration.match.format,
                  groupingPayload: payload,
                  userId: currentUser.id,
                  userConfirmedResults: registration.match.results,
                });
                const statusStyles = {
                  registration:
                    "bg-emerald-400/12 text-emerald-100 ring-emerald-300/16",
                  ongoing: "bg-sky-400/12 text-sky-100 ring-sky-300/16",
                  finished: "bg-slate-500/12 text-slate-300 ring-slate-300/12",
                } as const;

                return (
                  <Link
                    key={registration.id}
                    href={`/matchs/${registration.match.id}`}
                    className="surface-card group rounded-3xl p-4 text-slate-100 transition hover:border-teal-200/24 sm:p-5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate text-base font-black sm:text-lg">
                        {registration.match.title}
                      </h3>
                        <p className="mt-1 text-xs text-slate-500 sm:text-sm">
                          {formatCompactDate(registration.match.dateTime)}
                        </p>
                      </div>
                      <span
                        className={`status-pill shrink-0 ring-1 ${statusStyles[currentStatus]}`}
                      >
                        {statusLabelMap[currentStatus]}
                      </span>
                    </div>
                    <div className="mt-4 rounded-2xl bg-slate-950/35 px-3 py-2 ring-1 ring-white/8">
                      <p className="text-[11px] text-slate-500">当前阶段</p>
                      <p className="mt-1 text-sm font-semibold text-slate-100">
                        {phase}
                      </p>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      )}

      <section>
        <div className="mb-4 flex items-end justify-between gap-3">
          <div>
            <p className="eyebrow">
              {openMatches.length > 0 ? "Open Now" : "Tournament Feed"}
            </p>
            <h2 className="mt-1 text-xl font-black text-white sm:text-2xl">
              {openMatches.length > 0 ? "当前可报名比赛" : "近期比赛"}
            </h2>
          </div>
          <Link
            href="/matchs"
            className="inline-flex items-center gap-1 text-sm font-semibold text-teal-200 hover:text-teal-100"
          >
            查看全部
            <ChevronRight className="h-4 w-4" />
          </Link>
        </div>

        {homeFeedMatches.length === 0 ? (
          <div className="surface-card rounded-3xl p-6 text-center text-sm text-slate-400 sm:p-8">
            <Activity className="mx-auto mb-3 h-8 w-8 text-slate-600" />
            暂无比赛，快去发布第一场比赛吧。
          </div>
        ) : (
          <div className="grid gap-4 sm:gap-6 md:grid-cols-2 2xl:grid-cols-3">
            {homeFeedMatches.map((match) => (
              <MatchCard
                key={match.id}
                id={match.id}
                title={match.title}
                type={match.type}
                matchTime={match.dateTime.toISOString()}
                registrationDeadline={match.registrationDeadline.toISOString()}
                location={match.location ?? "待定"}
                participants={match._count.registrations}
                status={
                  statusLabelMap[
                    finishedMatchIds.has(match.id)
                      ? MatchStatus.finished
                      : match.status
                  ]
                }
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
