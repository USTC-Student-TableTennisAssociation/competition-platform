"use client";

import { useActionState } from "react";
import { startCompetitionFixtureAction } from "@/app/matchs/v2-actions";

export default function StartFixtureForm({ matchId, fixtureId, version, stage }: {
  matchId: string; fixtureId: string; version: number; stage: "GROUP" | "KNOCKOUT";
}) {
  const [state, action, pending] = useActionState(startCompetitionFixtureAction.bind(null, matchId), {});
  return <form action={action} className="mt-3">
    <input type="hidden" name="csrfToken" defaultValue="" />
    <input type="hidden" name="fixtureId" value={fixtureId} />
    <input type="hidden" name="expectedFixtureVersion" value={version} />
    <input type="hidden" name="stage" value={stage} />
    <button disabled={pending} className="min-h-11 rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:border-slate-400 disabled:opacity-50">{pending ? "处理中…" : "开始比赛"}</button>
    <p className="mt-1 text-xs text-slate-400">开打时标记，之后换人不会影响本场名单。</p>
    {state.error ? <p role="alert" className="mt-1 text-xs text-rose-300">{state.error}</p> : null}
    {state.success ? <p className="mt-1 text-xs text-emerald-300">{state.success}</p> : null}
  </form>;
}
