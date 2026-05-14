import Link from "next/link";
import Image from "next/image";
import { TrendingUp } from "lucide-react";
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

  return (
    <div className="space-y-6 sm:space-y-8 md:space-y-10">
      <section className="relative overflow-hidden rounded-2xl border border-slate-700/70 bg-linear-to-br from-slate-800 via-slate-800 to-slate-900 p-4 shadow-xl shadow-black/20 sm:rounded-3xl sm:p-6 md:p-10">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(34,211,238,0.18),transparent_48%)]" />
        <div className="relative space-y-4 sm:space-y-6 md:space-y-8">
          <div className="rounded-2xl border border-cyan-400/30 bg-slate-900/60 p-3 sm:p-5 md:p-6">
            <div className="grid gap-3 sm:gap-4 lg:grid-cols-[auto_1fr] lg:items-center">
              <Image
                src="/SVG/乒协徽章.svg"
                alt="中国科学技术大学校乒乓球协会徽章"
                width={120}
                height={120}
                className="mx-auto h-14 w-14 object-contain sm:h-20 sm:w-20 md:h-40 md:w-40 lg:mx-0"
              />

              <div>
                <Image
                  src="/SVG/乒协文字.svg"
                  alt="中国科学技术大学校乒乓球协会文字标识"
                  width={420}
                  height={72}
                  className="block w-full h-auto"
                />
                <p className="mt-2 max-w-4xl text-sm text-slate-300 sm:mt-4 sm:text-base">
                  <span className="font-medium">
                    协会赛事与成员成长平台：统一管理比赛发布、报名编排、结果上报与排名更新，让每一位选手都拥有清晰可追踪的参赛记录。
                  </span>
                </p>
              </div>
            </div>
          </div>

          {currentUser ? (
            <div className="rounded-2xl border border-cyan-400/30 bg-slate-900/60 p-3 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3 sm:gap-4">
                <div className="flex min-w-0 items-center gap-3 sm:gap-4">
                  <div className="h-14 w-14 overflow-hidden rounded-full border border-slate-600 bg-slate-800 sm:h-20 sm:w-20">
                    {currentUser.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={currentUser.avatarUrl}
                        alt={currentUser.nickname}
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="grid h-full w-full place-items-center text-lg font-semibold text-slate-200 sm:text-2xl">
                        {currentUser.nickname[0]?.toUpperCase() ?? "?"}
                      </div>
                    )}
                  </div>

                  <div className="min-w-0">
                    <p className="text-[10px] tracking-[0.12em] text-cyan-300 sm:text-xs sm:tracking-[0.2em]">
                      我的数据总览
                    </p>
                    <h2 className="mt-0.5 truncate text-lg font-bold text-white sm:mt-1 sm:text-2xl">
                      {currentUser.nickname}
                    </h2>
                    <p className="mt-0.5 text-xs text-slate-300 sm:mt-1 sm:text-sm">
                      本周 ELO 变化：
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
                <div className="grid w-full grid-cols-3 gap-2 sm:w-auto sm:gap-3">
                  <div className="rounded-xl border border-slate-700 bg-slate-800/80 px-2 py-2 text-center sm:px-4 sm:py-3">
                    <p className="text-[10px] text-slate-400 sm:text-xs">ELO</p>
                    <p className="mt-1 text-base font-bold text-cyan-100 sm:text-xl">
                      {currentUser.eloRating}
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-700 bg-slate-800/80 px-2 py-2 text-center sm:px-4 sm:py-3">
                    <p className="text-[10px] text-slate-400 sm:text-xs">
                      积分
                    </p>
                    <p className="mt-1 text-base font-bold text-cyan-100 sm:text-xl">
                      {currentUser.points}
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-700 bg-slate-800/80 px-2 py-2 text-center sm:px-4 sm:py-3">
                    <p className="text-[10px] text-slate-400 sm:text-xs">
                      战绩
                    </p>
                    <p className="mt-1 text-sm font-bold text-cyan-100 sm:text-xl">
                      {currentUser.wins} / {currentUser.losses}
                    </p>
                  </div>
                </div>
              </div>

              <div className="mt-3 rounded-xl border border-slate-700 bg-slate-900/70 p-2.5 sm:mt-4 sm:p-3">
                <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
                  <span className="inline-flex items-center gap-1">
                    <TrendingUp className="h-3.5 w-3.5" />
                    最近 ELO 走势
                  </span>
                  <span>
                    {eloValues.length > 0
                      ? `最新 ${eloValues[eloValues.length - 1]}`
                      : "暂无数据"}
                  </span>
                </div>
                <div className="h-20 w-full sm:h-24">
                  <EloTrendChart points={eloPoints} />
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-slate-700 bg-slate-900/60 p-4 text-sm text-slate-300 sm:p-5">
              当前处于待登录状态。登录后可查看你的 ELO
              走势、报名进度和个人比赛阶段。
              <Link
                href="/auth"
                className="ml-2 text-cyan-300 hover:text-cyan-200"
              >
                去登录
              </Link>
            </div>
          )}
        </div>
      </section>

      {currentUser && (
        <section>
          <div className="mb-3 flex items-center justify-between sm:mb-5">
            <h2 className="text-xl font-bold text-white sm:text-2xl">
              我报名的比赛
            </h2>
            <Link
              href="/matchs"
              className="text-sm text-cyan-300 hover:text-cyan-200"
            >
              查看全部 →
            </Link>
          </div>

          {myRegistrations.length === 0 ? (
            <div className="rounded-2xl border border-slate-700 bg-slate-800/60 p-5 text-center text-sm text-slate-300 sm:p-8 sm:text-base">
              你还没有报名比赛。
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
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

                return (
                  <Link
                    key={registration.id}
                    href={`/matchs/${registration.match.id}`}
                    className="rounded-2xl border border-slate-700 bg-slate-800/80 p-4 text-slate-100 transition hover:border-cyan-400/45 sm:p-5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-base font-semibold sm:text-lg">
                        {registration.match.title}
                      </h3>
                      <span className="rounded-full bg-cyan-500/15 px-2.5 py-1 text-xs text-cyan-200">
                        {statusLabelMap[currentStatus]}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-400 sm:text-sm">
                      比赛时间：
                      {registration.match.dateTime.toLocaleString("zh-CN")}
                    </p>
                    <p className="mt-2 text-xs text-slate-300 sm:mt-3 sm:text-sm">
                      当前阶段：
                      <span className="font-medium text-cyan-100">{phase}</span>
                    </p>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      )}

      <section>
        <div className="mb-3 flex items-center justify-between sm:mb-5">
          <h2 className="text-xl font-bold text-white sm:text-2xl">近期比赛</h2>
          <Link
            href="/matchs"
            className="text-sm text-cyan-300 hover:text-cyan-200"
          >
            查看全部 →
          </Link>
        </div>

        {latestMatches.length === 0 ? (
          <div className="rounded-2xl border border-slate-700 bg-slate-800/60 p-5 text-center text-sm text-slate-300 sm:p-8 sm:text-base">
            暂无比赛，快去发布第一场比赛吧。
          </div>
        ) : (
          <div className="grid gap-4 sm:gap-6 md:grid-cols-2 2xl:grid-cols-3">
            {sortedLatestMatches.map((match) => (
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
