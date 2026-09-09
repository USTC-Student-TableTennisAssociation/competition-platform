"use client";

import { useActionState, useState } from "react";

import { updateV2KnockoutTableLabelsAction } from "@/app/matchs/v2-actions";

const INITIAL_STATE: Readonly<{ error?: string; success?: string }> = {};

export default function V2KnockoutTableLabelsForm({
  matchId,
  fixtureId,
  fixtureVersion,
  roundNumber,
  position,
  tableLabels,
}: Readonly<{
  matchId: string;
  fixtureId: string;
  fixtureVersion: number;
  roundNumber: number;
  position: number;
  tableLabels: readonly string[];
}>) {
  const [state, formAction, pending] = useActionState(
    updateV2KnockoutTableLabelsAction.bind(null, matchId),
    INITIAL_STATE,
  );
  const [value, setValue] = useState(() => tableLabels.join("\n"));
  const labels = value
    .split(/\r?\n/)
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
  const duplicate = new Set(labels).size !== labels.length;
  const tooMany = labels.length > 32;
  const tooLong = labels.some((label) => label.length > 64);
  const invalid = duplicate || tooMany || tooLong;

  return (
    <form
      action={formAction}
      className="mt-3 space-y-2 rounded-lg border border-fuchsia-500/20 bg-fuchsia-500/5 p-3"
    >
      <input type="hidden" name="csrfToken" defaultValue="" />
      <input type="hidden" name="fixtureId" value={fixtureId} />
      <input
        type="hidden"
        name="expectedFixtureVersion"
        value={fixtureVersion}
      />
      <input type="hidden" name="labelsJson" value={JSON.stringify(labels)} />
      <label
        htmlFor={`v2-knockout-table-labels-${fixtureId}`}
        className="text-xs font-medium text-fuchsia-100"
      >
        第 {roundNumber} 轮第 {position} 场桌号/场地
      </label>
      <textarea
        id={`v2-knockout-table-labels-${fixtureId}`}
        value={value}
        rows={Math.max(2, Math.min(4, labels.length || 2))}
        onChange={(event) => setValue(event.target.value)}
        placeholder={"每行一个桌号或场地标签\n例如：3 号台"}
        className="w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100"
      />
      <p className="text-xs text-slate-400">每行一个标签；留空可清除。</p>
      {duplicate ? <p className="text-xs text-rose-300">标签不能重复。</p> : null}
      {tooMany ? <p className="text-xs text-rose-300">每场最多 32 个标签。</p> : null}
      {tooLong ? <p className="text-xs text-rose-300">每个标签最多 64 个字符。</p> : null}
      <button
        type="submit"
        disabled={pending || invalid}
        className="rounded-lg border border-fuchsia-400/40 px-3 py-1.5 text-xs font-medium text-fuchsia-100 hover:bg-fuchsia-500/10 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "保存中..." : "保存桌号/场地"}
      </button>
      {state.error ? <p className="text-xs text-rose-300">{state.error}</p> : null}
      {state.success ? (
        <p className="text-xs text-emerald-300">{state.success}</p>
      ) : null}
    </form>
  );
}
