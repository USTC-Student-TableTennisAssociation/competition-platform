import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import BackLinkButton from "@/components/navigation/BackLinkButton";
import { prisma } from "@/lib/prisma";
import { formatV2CompetitionDateTime } from "@/modules/competitions-v2/competition-time";

const PAGE_SIZE = 20;

function scoreLabel(score: unknown) {
  if (typeof score === "string") return score;
  if (score && typeof score === "object" && "text" in score && typeof score.text === "string") return score.text;
  return "比分未记录";
}

/** Historical formal competitions expose confirmed results only. */
export default async function ArchivedMatchDetail({ matchId, page = 1 }: { matchId: string; page?: number }) {
  const match = await prisma.match.findUnique({
    where: { id: matchId, engineVersion: "LEGACY" },
    select: { id: true, title: true, description: true, dateTime: true, location: true, type: true, isQuickMatch: true },
  });
  if (!match) notFound();
  if (match.isQuickMatch) redirect("/quick-match");
  const count = await prisma.matchResult.count({ where: { matchId, confirmed: true } });
  const pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
  const currentPage = Math.min(pages, Math.max(1, Number.isSafeInteger(page) ? page : 1));
  const results = await prisma.matchResult.findMany({
    where: { matchId, confirmed: true },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    skip: (currentPage - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    select: { id: true, winnerTeamIds: true, loserTeamIds: true, score: true },
  });
  const userIds = [...new Set(results.flatMap(result => [...result.winnerTeamIds, ...result.loserTeamIds]))];
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, nickname: true } });
  const names = new Map(users.map(user => [user.id, user.nickname]));
  const members = (ids: string[]) => ids.length ? ids.map(id => (
    <Link key={id} href={`/profile/${id}`} className="mr-2 hover:text-teal-200">{names.get(id) ?? "历史选手"}</Link>
  )) : "历史参赛方";

  return (
    <div className="mx-auto max-w-5xl space-y-5 sm:space-y-8">
      <BackLinkButton fallbackHref="/matchs" />
      <section className="surface-panel rounded-3xl p-5 sm:p-8">
        <span className="status-pill">历史比赛</span>
        <h1 className="mt-3 text-2xl font-black text-white sm:text-4xl">{match.title}</h1>
        <p className="mt-3 text-sm text-slate-400">{formatV2CompetitionDateTime(match.dateTime)} · {match.location ?? "地点未记录"} · {{ single: "单打", double: "双打", team: "团体" }[match.type]}</p>
        {match.description ? <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-slate-300">{match.description}</p> : null}
        <p className="mt-4 text-sm text-slate-400">本场比赛已归档，保留比赛信息和已确认成绩。</p>
      </section>
      <section className="surface-panel rounded-3xl p-5 sm:p-8">
        <h2 className="text-lg font-bold text-white">比赛成绩（{count} 场）</h2>
        {results.length === 0 ? <p className="mt-4 text-sm text-slate-400">暂无已确认的成绩记录。</p> : (
          <ul className="mt-4 divide-y divide-white/10">
            {results.map(result => <li key={result.id} className="py-4 text-sm text-slate-200">
              <div className="flex flex-wrap items-center gap-2"><span>{members(result.winnerTeamIds)}</span><span className="text-emerald-300">胜</span><span>{members(result.loserTeamIds)}</span></div>
              <p className="mt-2 text-slate-400">{scoreLabel(result.score)}</p>
            </li>)}
          </ul>
        )}
        {pages > 1 ? <nav aria-label="历史成绩分页" className="mt-5 flex items-center justify-between text-sm text-teal-200">
          {currentPage > 1 ? <Link href={`/matchs/${matchId}?resultsPage=${currentPage - 1}`}>上一页</Link> : <span />}
          <span className="text-slate-400">{currentPage} / {pages}</span>
          {currentPage < pages ? <Link href={`/matchs/${matchId}?resultsPage=${currentPage + 1}`}>下一页</Link> : <span />}
        </nav> : null}
      </section>
    </div>
  );
}
