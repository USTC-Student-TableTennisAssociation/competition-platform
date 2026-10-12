'use client'

import { startTransition, useActionState, useEffect, useMemo, useState } from 'react'

import {
  INITIAL_SUPERMARKET_MEMBER_STATE,
  type SupermarketMemberRedemption,
  type SupermarketMemberState,
} from '@/app/supermarket/state'
import { supermarketMemberAction } from '@/app/supermarket/actions'
import SupermarketPrizeCard from '@/components/supermarket/SupermarketPrizeCard'
import SupermarketHero from '@/components/supermarket/SupermarketHero'

const STATUS_LABEL: Record<SupermarketMemberRedemption['status'], string> = {
  PENDING: '待发放',
  FULFILLED: '已发放',
  VOIDED: '未履行',
}

const STATUS_CLASS: Record<SupermarketMemberRedemption['status'], string> = {
  PENDING: 'bg-amber-400/10 text-amber-300',
  FULFILLED: 'bg-emerald-400/10 text-emerald-300',
  VOIDED: 'bg-white/[0.06] text-slate-400',
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString('zh-CN')
}

export default function SupermarketClient() {
  const [state, formAction, pending] = useActionState<
    SupermarketMemberState,
    FormData
  >(supermarketMemberAction, INITIAL_SUPERMARKET_MEMBER_STATE)
  const [confirmingPrizeId, setConfirmingPrizeId] = useState<string | null>(null)

  useEffect(() => {
    const formData = new FormData()
    formData.set('intent', 'bootstrap')
    startTransition(() => formAction(formData))
  }, [formAction])

  const grouped = useMemo(() => {
    const affordable = state.prizes.filter((prize) => !prize.soldOut)
    const soldOut = state.prizes.filter((prize) => prize.soldOut)
    return { affordable, soldOut }
  }, [state.prizes])

  if (!state.signedIn) {
    return (
      <div className="rounded-2xl border border-white/[0.08] bg-[#101520] p-8 text-center text-sm text-slate-400">
        {state.error ?? '正在加载积分商店…'}
      </div>
    )
  }

  const open = state.periodSequence !== null

  return (
    <div className="space-y-5 text-slate-100">
      <SupermarketHero balance={open ? (state.balance ?? 0) : '—'} sequence={state.periodSequence}>
        <p className="text-xs leading-relaxed text-slate-400">
          {open ? '本期未使用的商店积分在闭期后作废，请在本期内兑换。' : '商店按期开放，请留意后续通知。'}
        </p>
      </SupermarketHero>

      {state.error ? (
        <p className="rounded-xl border border-red-400/20 bg-red-400/10 px-4 py-3 text-sm text-red-300">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p className="rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-300">
          {state.success}
        </p>
      ) : null}

      <section aria-label="积分与兑换概况" className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-white/[0.08] bg-[#101520] px-4 py-3">
            <p className="text-xs text-slate-400">比赛积分</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-100">
              {state.matchPoints ?? 0}
            </p>
            <p className="mt-1 text-[11px] text-slate-400">
              结算后转入商店积分
            </p>
          </div>
          <div className="rounded-2xl border border-white/[0.08] bg-[#101520] px-4 py-3">
            <p className="text-xs text-slate-400">已兑换</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-slate-100">
              {
                state.redemptions.filter((row) => row.status !== 'VOIDED').length
              }
            </p>
            <p className="mt-1 text-[11px] text-slate-400">累计有效兑换笔数</p>
          </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-100">本期好物</h2>
        {!open ? (
          <p className="rounded-2xl border border-white/[0.08] bg-[#101520] p-6 text-sm text-slate-400">
            积分商店当前未开放，请留意后续通知。
          </p>
        ) : state.prizes.length === 0 ? (
          <p className="rounded-2xl border border-white/[0.08] bg-[#101520] p-6 text-sm text-slate-400">
            本期暂时还没有上架奖品。
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:gap-5 md:grid-cols-4">
            {[...grouped.affordable, ...grouped.soldOut].map((prize) => (
              <SupermarketPrizeCard
                key={prize.id}
                prize={prize}
                balance={state.balance ?? 0}
                confirming={confirmingPrizeId === prize.id}
                pending={pending}
                formAction={formAction}
                onRequest={() => setConfirmingPrizeId(prize.id)}
                onCancel={() => setConfirmingPrizeId(null)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="rounded-[20px] border border-white/[0.08] bg-[#101520] p-4 sm:p-6">
        <h2 className="text-lg font-semibold text-slate-100">我的兑换记录</h2>
        {state.redemptions.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">还没有兑换记录。</p>
        ) : (
          <ul className="mt-3 divide-y divide-white/[0.06]">
            {state.redemptions.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-sm"
              >
                <span className="font-medium text-slate-100">{row.prizeName}</span>
                <span className="text-slate-400">{row.pointsSpent} 分</span>
                <span className="text-slate-400">第 {row.periodSequence} 期</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[row.status]}`}
                >
                  {STATUS_LABEL[row.status]}
                </span>
                <span className="ml-auto text-xs text-slate-400">
                  {formatDateTime(row.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-xs text-slate-400">
          未履行表示该笔兑换最终未发放。原期次仍开放时积分自动退回；已闭期时请联系管理员处理补偿。
        </p>
      </section>
    </div>
  )
}
