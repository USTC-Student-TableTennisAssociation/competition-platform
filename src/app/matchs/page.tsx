import Link from "next/link";
import { MatchStatus, Prisma } from "@prisma/client";
import { CalendarDays, Search, ShieldPlus, Sparkles } from "lucide-react";
import MatchCard from "@/components/match/MatchCard";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isMatchAllResultsFinished } from "@/lib/match-status";

const statusLabelMap = {
  registration: "报名中",
  ongoing: "进行中",
  finished: "已结束",
} as const;

type MatchesPageProps = {
  searchParams?:
    | {
        q?: string | string[];
      }
    | Promise<{
        q?: string | string[];
      }>;
};

export default async function MatchesPage({ searchParams }: MatchesPageProps) {
  const currentUser = await getCurrentUser();

  const resolvedSearchParams = searchParams
    ? await Promise.resolve(searchParams)
    : undefined;

  const rawQuery = Array.isArray(resolvedSearchParams?.q)
    ? resolvedSearchParams.q[0]
    : resolvedSearchParams?.q;
  const query = (rawQuery ?? "").trim();
  const queryFilter =
    query === ""
      ? Prisma.empty
      : Prisma.sql`AND "title" ILIKE ${`%${query}%`}`;

  const orderedMatchIds = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "Match"
    WHERE "isQuickMatch" = false
      ${queryFilter}
    ORDER BY ABS(EXTRACT(EPOCH FROM ("dateTime" - NOW()))) ASC, "dateTime" DESC, "createdAt" DESC
  `;

  const matches = await prisma.match.findMany({
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

  const matchesById = new Map(matches.map((match) => [match.id, match] as const));
  const sortedMatches = orderedMatchIds
    .map((match) => matchesById.get(match.id))
    .filter((match): match is (typeof matches)[number] => Boolean(match));

  const matchesToFinish = sortedMatches.filter(
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
  const resolvedMatches = sortedMatches.map((match) => ({
    ...match,
    resolvedStatus: finishedMatchIds.has(match.id)
      ? MatchStatus.finished
      : match.status,
  }));
  const registrationMatches = resolvedMatches.filter(
    (match) => match.resolvedStatus === MatchStatus.registration,
  );
  const runningMatches = resolvedMatches.filter(
    (match) => match.resolvedStatus === MatchStatus.ongoing,
  );
  const finishedMatches = resolvedMatches.filter(
    (match) => match.resolvedStatus === MatchStatus.finished,
  );
  const prioritizedMatches = [
    ...registrationMatches,
    ...runningMatches,
    ...finishedMatches,
  ];

  return (
    <div className="space-y-6 sm:space-y-8">
      <section className="surface-panel relative overflow-hidden rounded-3xl p-5 sm:p-7">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_86%_12%,rgba(45,212,191,0.12),transparent_36%)]" />
        <div className="relative flex flex-col justify-between gap-5 lg:flex-row lg:items-end">
          <div>
            <p className="eyebrow">Tournament Lobby</p>
            <h1 className="mt-2 text-3xl font-black tracking-tight text-white sm:text-4xl">
              比赛大厅
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">
              优先展示可报名赛事；已结束比赛会降低权重，但仍保留入口方便复盘战绩和签表。
            </p>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center sm:max-w-md">
              <div className="rounded-2xl bg-emerald-400/8 px-3 py-2 ring-1 ring-emerald-300/12">
                <p className="text-lg font-black tabular-nums text-emerald-100">
                  {registrationMatches.length}
                </p>
                <p className="text-[11px] text-emerald-100/60">可报名</p>
              </div>
              <div className="rounded-2xl bg-sky-400/8 px-3 py-2 ring-1 ring-sky-300/12">
                <p className="text-lg font-black tabular-nums text-sky-100">
                  {runningMatches.length}
                </p>
                <p className="text-[11px] text-sky-100/60">进行中</p>
              </div>
              <div className="rounded-2xl bg-white/[0.035] px-3 py-2 ring-1 ring-white/8">
                <p className="text-lg font-black tabular-nums text-slate-100">
                  {finishedMatches.length}
                </p>
                <p className="text-[11px] text-slate-500">已结束</p>
              </div>
            </div>
          </div>

          <div className="flex w-full flex-col gap-2 sm:flex-row lg:w-auto lg:items-center">
          <form
            action="/matchs"
            method="get"
              className="flex min-w-0 flex-1 items-center gap-2 lg:min-w-80"
          >
            <input type="hidden" name="csrfToken" defaultValue="" />
              <label className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  name="q"
                  defaultValue={query}
                  title="搜索比赛名称"
                  placeholder="搜索比赛名称"
                  className="input-dark h-11 w-full appearance-none rounded-2xl pl-9 pr-3 text-sm placeholder:text-slate-600"
                />
              </label>
            <button
              type="submit"
                className="btn-secondary inline-flex h-11 shrink-0 items-center rounded-2xl px-4 text-sm font-semibold"
            >
              搜索
            </button>
          </form>
          {currentUser?.role === "admin" ? (
            <Link
              href="/matchs/create"
                className="btn-primary inline-flex h-11 items-center justify-center gap-2 rounded-2xl px-5 text-center text-sm font-bold"
            >
                <ShieldPlus className="h-4 w-4" />
                发布比赛
            </Link>
          ) : null}
          </div>
        </div>
      </section>

      {registrationMatches.length > 0 ? (
        <section className="surface-card rounded-3xl p-4 sm:p-5">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="eyebrow">Open Registration</p>
              <h2 className="mt-1 text-xl font-black text-white">
                当前可报名比赛
              </h2>
            </div>
            <Sparkles className="h-5 w-5 text-emerald-200/80" />
          </div>
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {registrationMatches.map((match) => (
              <MatchCard
                key={match.id}
                id={match.id}
                title={match.title}
                type={match.type}
                matchTime={match.dateTime.toISOString()}
                registrationDeadline={match.registrationDeadline.toISOString()}
                location={match.location ?? "待定"}
                participants={match._count.registrations}
                status={statusLabelMap[match.resolvedStatus]}
              />
            ))}
          </div>
        </section>
      ) : null}

      {prioritizedMatches.length > 0 ? (
        <section>
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <p className="eyebrow">All Matches</p>
              <h2 className="mt-1 text-xl font-black text-white">
                {query ? "搜索结果" : "全部比赛"}
              </h2>
            </div>
            <div className="hidden items-center gap-2 text-xs text-slate-500 sm:flex">
              <CalendarDays className="h-4 w-4" />
              按赛事时间接近度排序
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {prioritizedMatches.map((match) => (
            <MatchCard
              key={match.id}
              id={match.id}
              title={match.title}
              type={match.type}
              matchTime={match.dateTime.toISOString()}
              registrationDeadline={match.registrationDeadline.toISOString()}
              location={match.location ?? "待定"}
              participants={match._count.registrations}
                status={statusLabelMap[match.resolvedStatus]}
            />
          ))}
          </div>
        </section>
      ) : (
        <div className="surface-card rounded-3xl px-5 py-16 text-center text-slate-400">
          <p className="mb-2 text-xl font-bold text-slate-200">
            {query ? "未找到匹配的比赛" : "当前还没有比赛"}
          </p>
          <p>
            {query ? "试试更短的关键词或清空搜索条件" : "快去创建第一场比赛吧"}
          </p>
        </div>
      )}
    </div>
  );
}
