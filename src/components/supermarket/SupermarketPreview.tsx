'use client'

import { useState } from 'react'
import { CircleCheck, RotateCcw } from 'lucide-react'
import type { SupermarketMemberPrize } from '@/app/supermarket/state'
import SupermarketPrizeCard from './SupermarketPrizeCard'
import SupermarketHero from './SupermarketHero'

export type CatalogPrize = Pick<SupermarketMemberPrize, 'id' | 'name' | 'description' | 'imageUrl' | 'pointsCost' | 'stock' | 'perUserLimit'>

export default function SupermarketPreview({ prizes, sequence }: { prizes: CatalogPrize[]; sequence: number | null }) {
  const [initialPoints, setInitialPoints] = useState(49)
  const [balance, setBalance] = useState(49)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [confirming, setConfirming] = useState<string | null>(null)
  const [notice, setNotice] = useState('模拟兑换不会扣除真实积分，也不会改变商品库存。')
  function redeem(data: FormData) {
    const id = String(data.get('prizeId') ?? '')
    const prize = prizes.find((item) => item.id === id)
    if (!prize) return
    const count = counts[id] ?? 0
    if (balance < prize.pointsCost || (prize.stock !== null && count >= prize.stock) || (prize.perUserLimit !== null && count >= prize.perUserLimit)) return
    setBalance(balance - prize.pointsCost)
    setCounts({ ...counts, [id]: count + 1 })
    setConfirming(null)
    setNotice(`模拟兑换成功：${prize.name}，剩余 ${balance - prize.pointsCost} 分。真实积分未改变。`)
  }
  function reset(points: number) {
    setInitialPoints(points)
    setBalance(points)
    setCounts({})
    setConfirming(null)
    setNotice('模拟兑换不会扣除真实积分，也不会改变商品库存。')
  }
  return (
    <div className="space-y-5 rounded-3xl bg-[#070A12] text-slate-100">
      <SupermarketHero balance={balance} sequence={sequence} preview>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <label className="mr-auto flex min-w-0 items-center gap-2 text-xs text-slate-400"><span className="shrink-0">预览积分</span><select value={initialPoints} onChange={(event) => reset(Number(event.target.value))} className="min-h-11 min-w-0 max-w-full rounded-xl input-dark border px-2 text-sm text-slate-200 outline-none focus-visible:ring-2 focus-visible:ring-orange-400/50 sm:px-3" aria-label="预览成员积分">
            {[80,49,44,20,8,4].map((points) => <option key={points} value={points}>{points} 分{points === 80 ? ' · 当前最高积分' : ''}</option>)}
          </select></label>
          <button type="button" onClick={() => reset(initialPoints)} className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl px-2 text-xs text-slate-400 transition hover:bg-white/[0.06] hover:text-slate-100 focus-visible:outline-2 focus-visible:outline-orange-400 sm:px-3 sm:text-sm"><RotateCcw className="h-3.5 w-3.5" aria-hidden />重置</button>
        </div>
      </SupermarketHero>
      <p role="status" aria-live="polite" className="flex items-start gap-2 px-1 text-xs leading-relaxed text-slate-400 sm:text-sm"><CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400/80" aria-hidden />{notice}</p>
      <div className="flex items-baseline justify-between gap-3 pt-1"><h2 className="text-lg font-semibold text-slate-100">本期好物</h2><span className="text-xs text-slate-400">{prizes.length} 款奖品</span></div>
      {prizes.length === 0 ? <p className="surface-card rounded-2xl p-6 text-sm text-slate-400">请先在草稿中添加商品，再预览会员页面。</p> : (
        <div className="grid grid-cols-2 gap-3 sm:gap-5 md:grid-cols-4">
          {prizes.map((prize) => {
            const count = counts[prize.id] ?? 0
            const stock = prize.stock === null ? null : prize.stock - count
            return <SupermarketPrizeCard key={prize.id} prize={{ ...prize, stock, redeemedCount: count, limitReached: prize.perUserLimit !== null && count >= prize.perUserLimit, affordable: balance >= prize.pointsCost, soldOut: stock !== null && stock <= 0 }} balance={balance} confirming={confirming === prize.id} pending={false} preview formAction={redeem} onRequest={() => setConfirming(prize.id)} onCancel={() => setConfirming(null)} />
          })}
        </div>
      )}
    </div>
  )
}
