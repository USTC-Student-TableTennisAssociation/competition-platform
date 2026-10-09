"use client";

import Link from "next/link";
import { useActionState, useEffect, useId, useRef } from "react";
import { finishV2MatchAction, previewV2MatchClosureAction } from "@/app/matchs/v2-actions";
import type { V2MatchClosureActionState } from "@/modules/competitions-v2/adapters/match-closure-actions";

type FinishState = V2MatchClosureActionState & Readonly<{ reviewedFingerprint?: string }>;

export default function V2MatchClosureForm({ matchId }: Readonly<{ matchId: string }>) {
  const [previewState, previewAction, previewPending] = useActionState<V2MatchClosureActionState, FormData>(previewV2MatchClosureAction.bind(null, matchId), {});
  const [finishState, finishAction, finishPending] = useActionState<FinishState, FormData>(async (previous, form) => ({
    ...await finishV2MatchAction(matchId, previous, form),
    reviewedFingerprint: String(form.get("fingerprint") ?? ""),
  }), {});
  const dialog = useRef<HTMLDialogElement>(null);
  const previewForm = useRef<HTMLFormElement>(null);
  const finishForm = useRef<HTMLFormElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const preview = previewState.preview;
  const finishError = finishState.reviewedFingerprint === preview?.fingerprint ? finishState.error : undefined;
  const finishSuccess = finishState.reviewedFingerprint === preview?.fingerprint ? finishState.success : undefined;
  useEffect(() => {
    if (!preview) return;
    finishForm.current?.reset();
    if (!dialog.current?.open) dialog.current?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; };
  }, [preview]);

  return (
    <section className="border-t border-white/10 pt-5">
      <h3 className="text-base font-semibold text-white">结束比赛</h3>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-400">赛事收尾时，将未提交有效成绩的对局作废，保留已确认成绩。需要先处理待确认成绩和待处理更正。</p>
      <form ref={previewForm} action={previewAction} className="mt-3">
        <input type="hidden" name="csrfToken" defaultValue="" />
        <button ref={trigger} type="submit" disabled={previewPending || finishPending} aria-haspopup="dialog" className="min-h-11 rounded-lg border border-rose-400/35 px-4 py-2 text-sm font-medium text-rose-100 hover:bg-rose-400/10 disabled:opacity-50">
          {previewPending ? "正在核对对局…" : "结束比赛"}
        </button>
        {previewState.error ? <p role="alert" className="mt-3 text-sm text-rose-300">{previewState.error}</p> : null}
      </form>
      <dialog ref={dialog} aria-labelledby={titleId} onCancel={event => { if (finishPending) event.preventDefault(); }} onClose={() => { document.body.style.overflow = ""; trigger.current?.focus({ preventScroll: true }); }} className="fixed inset-0 m-auto max-h-[calc(100dvh_-_2rem)] w-[calc(100%_-_2rem)] max-w-xl overflow-y-auto rounded-2xl border border-white/15 bg-[#0b1019] p-5 text-slate-100 shadow-2xl backdrop:bg-black/75 sm:p-6">
        <h2 id={titleId} className="text-xl font-semibold text-white">结束比赛前核对</h2>
        {preview ? (
          <div className="mt-4 space-y-4">
            <p className="break-words text-sm font-medium text-slate-200">{preview.title}</p>
            <p className="text-sm text-slate-400">共 {preview.totalCount} 场 · 已完成 {preview.completedCount} 场 · 已作废 {preview.voidedCount} 场</p>
            {preview.alreadyFinished ? <p role="status" className="text-sm text-emerald-300">比赛已结束，无需重复操作。</p> : (
              <>
                {preview.pending.length ? <section className="rounded-lg border border-amber-400/25 bg-amber-400/5 p-3">
                  <h3 className="text-sm font-semibold text-amber-200">先处理 {preview.pending.length} 场待确认成绩或更正</h3>
                  <ul className="mt-2 max-h-48 space-y-2 overflow-y-auto text-sm text-slate-300">{preview.pending.map(fixture => <li key={fixture.fixtureId} className="break-words">{fixture.group} · {fixture.sideA} vs {fixture.sideB} · {fixture.correction ? "待处理更正" : "待确认成绩"}</li>)}</ul>
                  <Link href="#personal" onClick={() => {
                    dialog.current?.close();
                    // Notify the tab store; Link also keeps Next's URL current during live refreshes.
                    window.location.hash = "personal";
                  }} className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-amber-100 underline underline-offset-4">前往待确认成绩</Link>
                </section> : null}
                <section>
                  <h3 className="text-sm font-semibold text-rose-100">{preview.pending.length ? "未提交有效成绩的对局" : "将作废的未提交有效成绩对局"}（{preview.unsubmitted.length} 场）</h3>
                  {preview.unsubmitted.length ? <ul className="mt-3 max-h-64 overflow-y-auto divide-y divide-white/8 rounded-lg border border-white/10 px-3">
                    {preview.unsubmitted.map(fixture => <li key={fixture.fixtureId} className="py-3 text-sm">
                      <span className="text-xs text-slate-400">{fixture.group}{fixture.started ? " · 已标记开赛，尚无有效成绩" : ""}</span>
                      <p className="mt-1 break-words">{fixture.sideA} <span className="text-slate-500">vs</span> {fixture.sideB}</p>
                    </li>)}
                  </ul> : <p className="mt-2 text-sm text-slate-400">没有需要作废的对局。</p>}
                </section>
                <p className="text-xs leading-5 text-slate-400">已确认成绩与积分、ELO 保留。作废对局不计胜负、不增加比赛积分，原记录仍可查看。</p>
                {!preview.pending.length ? <form ref={finishForm} action={finishAction} className="space-y-4">
                  <input type="hidden" name="csrfToken" defaultValue="" />
                  <input type="hidden" name="fingerprint" value={preview.fingerprint} />
                  <label className="block text-sm text-slate-300">结束原因（选填）<input name="reason" maxLength={500} disabled={finishPending || preview.pending.length > 0} placeholder="例如：赛事已实际结束，清理未提交成绩" className="mt-2 min-h-11 w-full rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm disabled:opacity-50" /></label>
                  <label className="flex cursor-pointer items-start gap-3 text-sm leading-6 text-slate-200"><input type="checkbox" name="confirm" value="yes" required disabled={finishPending || preview.pending.length > 0} className="mt-1 h-4 w-4 shrink-0 accent-rose-500" />我确认将上述 {preview.unsubmitted.length} 场对局作废，并结束本赛事。</label>
                  {finishError ? <p role="alert" className="text-sm text-rose-300">{finishError}</p> : null}
                  {finishSuccess ? <p role="status" className="text-sm text-emerald-300">{finishSuccess}</p> : null}
                  <div className="flex flex-wrap gap-3">
                    <button type="submit" disabled={finishPending || preview.pending.length > 0} className="min-h-11 rounded-lg bg-rose-800 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-40">{finishPending ? "正在结束比赛…" : "确认作废并结束比赛"}</button>
                    {finishError ? <button type="button" disabled={finishPending || previewPending} onClick={() => { dialog.current?.close(); previewForm.current?.requestSubmit(); }} className="min-h-11 rounded-lg border border-slate-600 px-4 py-2 text-sm">重新核对对局</button> : null}
                  </div>
                </form> : null}
              </>
            )}
            <button type="button" disabled={finishPending} onClick={() => dialog.current?.close()} className="min-h-11 rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200 disabled:opacity-50">返回比赛详情</button>
          </div>
        ) : null}
      </dialog>
    </section>
  );
}
