"use client";

import { useActionState } from "react";

import {
  withdrawV2EntryAction,
} from "@/app/matchs/v2-actions";
import type { V2EntryDisqualificationActionState } from "@/modules/competitions-v2/adapters/entry-disqualification-actions";

const INITIAL_STATE: V2EntryDisqualificationActionState = {};

export default function V2EntryDisqualificationForm({
  matchId,
  entryId,
  entryVersion,
  entryName,
}: Readonly<{
  matchId: string;
  entryId: string;
  entryVersion: number;
  entryName: string;
}>) {
  const [state, formAction, pending] = useActionState(
    withdrawV2EntryAction.bind(null, matchId),
    INITIAL_STATE,
  );
  return (
    <form action={formAction} className="rounded-lg border border-rose-500/25 bg-rose-500/5 p-3">
      <input type="hidden" name="csrfToken" defaultValue="" />
      <input type="hidden" name="entryId" value={entryId} />
      <input type="hidden" name="expectedEntryVersion" value={entryVersion} />
      <p className="text-sm font-medium text-slate-100">{entryName}</p>
      <p className="mt-2 text-xs leading-5 text-slate-400">已确认成绩保留；剩余场次按弃权处理，不增加个人积分、ELO 或胜负统计。报名奖励按退报规则回收。有待确认比分时，请先核实。</p>
      <label className="mt-2 block text-xs text-slate-300">
        退赛原因
        <input
          name="reason"
          required
          maxLength={500}
          className="mt-1 w-full rounded-md border border-slate-600 bg-slate-950 px-2.5 py-2 text-sm text-white"
          placeholder="例如：受伤，无法继续参赛"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="mt-2 rounded-md border border-rose-400/40 px-3 py-1.5 text-xs font-medium text-rose-100 disabled:opacity-50"
      >
        {pending ? "处理中…" : "确认安排退赛"}
      </button>
      {state.error ? <p className="mt-2 text-xs text-rose-300">{state.error}</p> : null}
      {state.success ? <p className="mt-2 text-xs text-emerald-300">{state.success}</p> : null}
    </form>
  );
}
