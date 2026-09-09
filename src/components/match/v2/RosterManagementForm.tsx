"use client";

import { useActionState, useEffect, useState } from "react";
import { replaceCompetitionRosterAction } from "@/app/matchs/v2-actions";
import type { RosterManagementState } from "@/modules/competitions-v2/adapters/roster-management";

type Person = { id: string; nickname: string; email?: string };

export default function RosterManagementForm({ matchId, entryId, entryVersion, entryName, team, initialMembers, initialCaptainId, futureCount, protectedCount }: {
  matchId: string; entryId: string; entryVersion: number; entryName: string; team: boolean;
  initialMembers: readonly Person[]; initialCaptainId?: string; futureCount: number; protectedCount: number;
}) {
  const [members, setMembers] = useState<readonly Person[]>(initialMembers);
  const [captainId, setCaptainId] = useState(initialCaptainId ?? initialMembers[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<Person[]>([]);
  const [searchError, setSearchError] = useState("");
  const [state, action, pending] = useActionState<RosterManagementState, FormData>(replaceCompetitionRosterAction.bind(null, matchId), {});
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (!query.trim()) { setCandidates([]); setSearchError(""); return; }
      try {
        const response = await fetch(`/api/matchs/${matchId}/roster-candidates?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (!response.ok) throw new Error("查询失败，请重试。");
        const data = await response.json() as { users: Person[] };
        setCandidates(data.users); setSearchError("");
      } catch (error) { if (!controller.signal.aborted) { setCandidates([]); setSearchError(error instanceof Error ? error.message : "查询失败"); } }
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, matchId]);
  const currentCaptain = members.some(member => member.id === captainId) ? captainId : members[0]?.id ?? "";
  return <form action={action} className="mt-3 space-y-3 rounded-xl border border-slate-700 p-4">
    <input type="hidden" name="csrfToken" defaultValue="" />
    <input type="hidden" name="entryId" value={entryId} />
    <input type="hidden" name="expectedEntryVersion" value={entryVersion} />
    <input type="hidden" name="memberIds" value={JSON.stringify(members.map(member => member.id))} />
    <h4 className="font-semibold text-slate-100">{entryName}</h4>
    <p className="text-xs leading-5 text-slate-400">将更新 {futureCount} 场尚未开始的对局；{protectedCount} 场已开始或已有比分的对局保留原名单。签位和队伍成绩保留，新成员不继承之前的个人成绩。</p>
    <div className="flex flex-wrap gap-2">{members.map(member => <span key={member.id} className="inline-flex items-center gap-2 rounded-lg bg-slate-800 px-3 py-2 text-sm text-slate-100">
      {member.nickname}<button type="button" disabled={pending} aria-label={`移除 ${member.nickname}`} onClick={() => setMembers(previous => previous.filter(person => person.id !== member.id))} className="text-rose-300">移除</button>
    </span>)}</div>
    <label className="block text-xs text-slate-300">添加成员<input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索昵称或邮箱" className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm" /></label>
    {searchError ? <p role="alert" className="text-xs text-rose-300">{searchError}</p> : null}
    {candidates.filter(person => !members.some(member => member.id === person.id)).map(person => <button key={person.id} type="button" disabled={pending || members.length >= (team ? 50 : 2)} onClick={() => { setMembers(previous => [...previous, person]); setQuery(""); setCandidates([]); }} className="block w-full rounded-lg border border-slate-700 px-3 py-2 text-left text-sm text-slate-200 disabled:opacity-40">{person.nickname}<span className="ml-2 text-xs text-slate-400">{person.email}</span></button>)}
    {team ? <label className="block text-xs text-slate-300">队长<select name="captainId" value={currentCaptain} onChange={event => setCaptainId(event.target.value)} className="ml-2 rounded-lg border border-slate-600 bg-slate-950 p-2">{members.map(member => <option key={member.id} value={member.id}>{member.nickname}</option>)}</select></label> : <p className="text-xs text-slate-400">双打必须保留两名不同成员。</p>}
    <label className="block text-xs text-slate-300">换人原因<input name="reason" required maxLength={500} className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm" placeholder="例如：原成员受伤，调整后续参赛名单" /></label>
    <button disabled={pending || (team ? members.length === 0 : members.length !== 2)} className="rounded-lg bg-teal-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{pending ? "更新中…" : "确认更换成员"}</button>
    {state.error ? <p role="alert" className="text-xs text-rose-300">{state.error}</p> : null}
    {state.success ? <p role="status" className="text-xs text-emerald-300">{state.success}</p> : null}
  </form>;
}
