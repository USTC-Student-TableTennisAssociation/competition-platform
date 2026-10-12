'use client'

import type { SupermarketMemberPrize } from '@/app/supermarket/state'
import { ArrowRight, Check } from 'lucide-react'
import PrizeImage from './PrizeImage'

export default function SupermarketPrizeCard({ prize, balance, confirming, pending, formAction, onRequest, onCancel, preview = false }: {
  prize: SupermarketMemberPrize
  balance: number
  confirming: boolean
  pending: boolean
  formAction: (data: FormData) => void
  onRequest: () => void
  onCancel: () => void
  preview?: boolean
}) {
  const disabledLabel = prize.limitReached ? '已达本期限兑上限'
    : prize.soldOut ? '已兑完'
    : !prize.affordable ? `积分不足（还差 ${prize.pointsCost - balance} 分）` : null
  const buttonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl btn-primary px-3 py-2 text-xs font-medium text-slate-950 transition active:bg-orange-300 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange-400 disabled:opacity-50 sm:text-sm'
  return (
    <article className="flex min-w-0 flex-col overflow-hidden rounded-[20px] border border-white/[0.08] bg-[#101520]">
      <PrizeImage imageUrl={prize.imageUrl} name={prize.name} illustration={prize.name.includes('胶皮') ? 'rubber' : prize.name === '乒乓球' ? 'ball' : undefined} />
      <div className="flex flex-1 flex-col p-3 sm:p-4">
        <h3 className="min-w-0 text-sm font-semibold leading-relaxed text-slate-100 sm:text-base">{prize.name}</h3>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <p className="shrink-0 whitespace-nowrap text-xs text-orange-300"><strong className="text-[26px] font-semibold leading-tight tabular-nums">{prize.pointsCost}</strong> 积分</p>
          {prize.perUserLimit !== null ? <span className="rounded-md bg-orange-400/[0.08] px-1.5 py-1 text-[10px] text-orange-200/80 sm:text-[11px]">每人限 {prize.perUserLimit} 件</span> : null}
        </div>
        {prize.description ? <p className="mt-2 whitespace-pre-line text-xs leading-relaxed text-slate-400 sm:text-[13px]">{prize.description}</p> : null}
        <div className="mb-3 mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-400 sm:text-xs">
          <span>{prize.stock === null ? '库存不限量' : `剩余 ${prize.stock} 件`}</span>
          {prize.perUserLimit === null ? <span>不限兑</span> : null}
          {prize.redeemedCount > 0 ? <span className="inline-flex items-center gap-1 text-emerald-300"><Check className="h-3 w-3" aria-hidden />已兑 {prize.redeemedCount} 件</span> : null}
        </div>
        <div className="mt-auto">
          {disabledLabel ? <button type="button" disabled className="min-h-11 w-full rounded-xl border border-white/[0.06] bg-white/[0.04] px-2 py-2 text-xs leading-relaxed text-slate-500 sm:text-sm">{disabledLabel}</button>
            : confirming ? (
              <form action={formAction} className="flex flex-wrap gap-2">
                <input type="hidden" name="intent" value="redeem" />
                <input type="hidden" name="prizeId" value={prize.id} />
                <button type="submit" disabled={pending} className={`${buttonClass} w-full`} aria-label={`${preview ? '确认试兑' : '确认兑换'}（${prize.pointsCost} 分）`}>{pending ? '兑换中…' : `确认${preview ? '试兑' : '兑换'} · ${prize.pointsCost} 分`}</button>
                <button type="button" disabled={pending} onClick={onCancel} className="min-h-11 w-full rounded-xl border border-white/[0.06] bg-white/[0.04] px-3 py-2 text-xs text-slate-300 hover:bg-white/[0.08] sm:text-sm">取消</button>
              </form>
            ) : <button type="button" onClick={onRequest} className={`${buttonClass} w-full`} aria-label={`${preview ? '试兑' : '兑换'}（${prize.pointsCost} 分）`}>{preview ? '试兑' : '兑换'}<ArrowRight className="h-3.5 w-3.5" aria-hidden /></button>}
        </div>
      </div>
    </article>
  )
}
