'use client'

import { startTransition, useActionState, useEffect, useMemo, useState } from 'react'

import {
  INITIAL_SUPERMARKET_MEMBER_STATE,
  type SupermarketMemberRedemption,
  type SupermarketMemberState,
} from '@/app/supermarket/state'
import { supermarketMemberAction } from '@/app/supermarket/actions'

const STATUS_LABEL: Record<SupermarketMemberRedemption['status'], string> = {
  PENDING: '待发放',
  FULFILLED: '已发放',
  VOIDED: '未履行',
}

const STATUS_CLASS: Record<SupermarketMemberRedemption['status'], string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  FULFILLED: 'bg-emerald-100 text-emerald-800',
  VOIDED: 'bg-neutral-200 text-neutral-600',
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
      <div className="rounded-2xl border border-neutral-200 bg-white p-8 text-center text-sm text-neutral-500">
        {state.error ?? '正在加载积分超市…'}
      </div>
    )
  }

  const open = state.periodSequence !== null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-100">积分超市</h1>
        <p className="mt-1 text-sm text-slate-400">
          用积分兑换奖品。超市按期开放，本期未使用的超市积分在闭期后作废。
        </p>
      </div>

      {state.error ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {state.success}
        </p>
      ) : null}

      <section className="rounded-2xl border border-neutral-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-neutral-900">我的积分</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl bg-neutral-50 px-4 py-3">
            <p className="text-sm text-neutral-500">超市积分</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-neutral-900">
              {open ? (state.balance ?? 0) : '—'}
            </p>
            <p className="mt-0.5 text-xs text-neutral-400">
              {open ? `第 ${state.periodSequence} 期` : '当前没有开放的期次'}
            </p>
          </div>
          <div className="rounded-xl bg-neutral-50 px-4 py-3">
            <p className="text-sm text-neutral-500">比赛积分</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-neutral-900">
              {state.matchPoints ?? 0}
            </p>
            <p className="mt-0.5 text-xs text-neutral-400">
              结算后转入超市积分
            </p>
          </div>
          <div className="rounded-xl bg-neutral-50 px-4 py-3">
            <p className="text-sm text-neutral-500">已兑换</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-neutral-900">
              {
                state.redemptions.filter((row) => row.status !== 'VOIDED').length
              }
            </p>
            <p className="mt-0.5 text-xs text-neutral-400">累计有效兑换笔数</p>
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-slate-100">本期奖品</h2>
        {!open ? (
          <p className="rounded-2xl border border-neutral-200 bg-white p-6 text-sm text-neutral-500">
            积分超市当前未开放，请留意后续通知。
          </p>
        ) : state.prizes.length === 0 ? (
          <p className="rounded-2xl border border-neutral-200 bg-white p-6 text-sm text-neutral-500">
            本期暂时还没有上架奖品。
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {[...grouped.affordable, ...grouped.soldOut].map((prize) => (
              <div
                key={prize.id}
                className="flex flex-col rounded-2xl border border-neutral-200 bg-white p-5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium text-neutral-900">{prize.name}</p>
                    {prize.description ? (
                      <p className="mt-1 text-sm text-neutral-500">
                        {prize.description}
                      </p>
                    ) : null}
                    <p className="mt-1 text-sm text-neutral-600">
                      {prize.pointsCost} 分 ·{' '}
                      {prize.stock === null ? '不限量' : `剩余 ${prize.stock}`}
                    </p>
                  </div>
                  {prize.soldOut ? (
                    <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-xs text-neutral-600">
                      已兑完
                    </span>
                  ) : null}
                </div>

                <div className="mt-4">
                  {prize.soldOut ? (
                    <button
                      type="button"
                      disabled
                      className="w-full rounded-xl bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-400"
                    >
                      已兑完
                    </button>
                  ) : !prize.affordable ? (
                    <button
                      type="button"
                      disabled
                      className="w-full rounded-xl bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-400"
                    >
                      积分不足（还差 {prize.pointsCost - (state.balance ?? 0)} 分）
                    </button>
                  ) : confirmingPrizeId === prize.id ? (
                    <form action={formAction} className="flex gap-2">
                      <input type="hidden" name="intent" value="redeem" />
                      <input type="hidden" name="prizeId" value={prize.id} />
                      <button
                        type="submit"
                        disabled={pending}
                        className="flex-1 rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700 disabled:opacity-50"
                      >
                        {pending ? '兑换中…' : `确认兑换（${prize.pointsCost} 分）`}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingPrizeId(null)}
                        className="rounded-xl bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-600 transition hover:bg-neutral-200"
                      >
                        取消
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmingPrizeId(prize.id)}
                      className="w-full rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-700"
                    >
                      兑换（{prize.pointsCost} 分）
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-neutral-200 bg-white p-6">
        <h2 className="text-lg font-semibold text-neutral-900">我的兑换记录</h2>
        {state.redemptions.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">还没有兑换记录。</p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-100">
            {state.redemptions.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-sm"
              >
                <span className="font-medium text-neutral-900">{row.prizeName}</span>
                <span className="text-neutral-500">{row.pointsSpent} 分</span>
                <span className="text-neutral-400">第 {row.periodSequence} 期</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[row.status]}`}
                >
                  {STATUS_LABEL[row.status]}
                </span>
                <span className="ml-auto text-xs text-neutral-400">
                  {formatDateTime(row.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-xs text-neutral-400">
          未履行表示该笔兑换最终未发放。原期次仍开放时积分自动退回；已闭期时请联系管理员处理补偿。
        </p>
      </section>
    </div>
  )
}
