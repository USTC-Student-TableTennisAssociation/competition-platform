"use client";

import { useActionState, useId, useRef } from "react";
import {
  freezeGroupQualificationAction,
  publishEarlyKnockoutScheduleAction,
} from "@/app/matchs/progressive-knockout-actions";

type State = Readonly<{ error?: string; success?: string }>;
const INITIAL_STATE: State = {};

function ActionMessage({ state }: { state: State }) {
  return <>
    {state.error ? <p role="alert" className="text-sm text-rose-300">{state.error}</p> : null}
    {state.success ? <p role="status" className="text-sm text-emerald-300">{state.success}</p> : null}
  </>;
}

export function PublishEarlyKnockoutScheduleForm({ matchId }: { matchId: string }) {
  const [state, action, pending] = useActionState(publishEarlyKnockoutScheduleAction, INITIAL_STATE);
  return <form action={action} className="space-y-3 rounded-xl border border-sky-400/25 bg-sky-400/5 p-4">
    <input type="hidden" name="csrfToken" defaultValue="" />
    <input type="hidden" name="matchId" value={matchId} />
    <p className="text-sm leading-6 text-slate-300">
      现在就能发布完整淘汰签表并安排场地。各组完成后分别确认晋级，双方确定的淘汰对局即可开打。
    </p>
    <button type="submit" disabled={pending} className="min-h-11 rounded-lg border border-sky-400/40 px-4 py-2 text-sm font-medium text-sky-100 hover:bg-sky-400/10 focus-visible:outline-2 focus-visible:outline-orange-300 disabled:cursor-not-allowed disabled:opacity-50">
      {pending ? "发布中…" : "提前发布淘汰赛程"}
    </button>
    <ActionMessage state={state} />
  </form>;
}

export function FreezeGroupQualificationForm({ matchId, groupId, groupName }: {
  matchId: string; groupId: string; groupName: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [state, action, pending] = useActionState(async (previous: State, formData: FormData) => {
    const result = await freezeGroupQualificationAction(previous, formData);
    if (result.success) dialog.current?.close();
    return result;
  }, INITIAL_STATE);

  return <div className="space-y-2">
    <button type="button" onClick={() => dialog.current?.showModal()} className="min-h-11 rounded-lg border border-amber-400/40 px-4 py-2 text-sm font-medium text-amber-100 hover:bg-amber-400/10 focus-visible:outline-2 focus-visible:outline-orange-300">
      确认{groupName}晋级
    </button>
    <ActionMessage state={state} />
    <dialog ref={dialog} aria-labelledby={titleId}
      onCancel={(event) => { if (pending) event.preventDefault(); }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-md overflow-y-auto rounded-2xl border border-white/15 bg-[#0b1019] p-5 text-slate-100 shadow-2xl backdrop:bg-black/75 sm:p-6">
      <h2 id={titleId} className="text-lg font-semibold">确认{groupName}晋级？</h2>
      <p className="mt-3 text-sm leading-6 text-slate-300">
        确认后，本组成绩和晋级名次将锁定，不能再更正。晋级选手将进入淘汰签位，对手也确定的对局即可开始比赛。
      </p>
      <form action={action} className="mt-5 space-y-4">
        <input type="hidden" name="csrfToken" defaultValue="" />
        <input type="hidden" name="matchId" value={matchId} />
        <input type="hidden" name="groupId" value={groupId} />
        <ActionMessage state={state.error ? state : INITIAL_STATE} />
        <div className="grid grid-cols-2 gap-3">
          <button type="button" autoFocus disabled={pending} onClick={() => dialog.current?.close()} className="min-h-11 rounded-lg border border-white/15 px-3 py-2 text-sm text-slate-300 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-orange-300 disabled:opacity-50">取消</button>
          <button type="submit" disabled={pending} className="min-h-11 rounded-lg bg-amber-500 px-3 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400 focus-visible:outline-2 focus-visible:outline-orange-300 disabled:cursor-not-allowed disabled:opacity-50">
            {pending ? "确认中…" : "确认并锁定本组"}
          </button>
        </div>
      </form>
    </dialog>
  </div>;
}
