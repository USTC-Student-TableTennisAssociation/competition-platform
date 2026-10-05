'use client'

import { startTransition, useActionState, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

import {
  INITIAL_SUPERMARKET_ADMIN_STATE,
  type SupermarketAdminState,
  type SupermarketPrizeView,
  type SupermarketRedemptionView,
} from '@/app/admin/supermarket/state'
import { supermarketAdminAction } from '@/app/admin/supermarket/actions'

type TabKey = 'period' | 'prizes' | 'redemptions' | 'adjustments'

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'period', label: '期次与结算' },
  { key: 'prizes', label: '奖品' },
  { key: 'redemptions', label: '兑换记录' },
  { key: 'adjustments', label: '积分调整' },
]

const REDEMPTION_STATUS_LABEL: Record<SupermarketRedemptionView['status'], string> = {
  PENDING: '待发放',
  FULFILLED: '已发放',
  VOIDED: '已作废',
}

const REDEMPTION_STATUS_CLASS: Record<SupermarketRedemptionView['status'], string> = {
  PENDING: 'bg-amber-100 text-amber-800',
  FULFILLED: 'bg-emerald-100 text-emerald-800',
  VOIDED: 'bg-neutral-200 text-neutral-600',
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString('zh-CN')
}

function TabButton({
  active,
  onClick,
  children,
  badge,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  badge?: number
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium transition ${
        active
          ? 'bg-neutral-900 text-white'
          : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
      }`}
    >
      {children}
      {badge !== undefined && badge > 0 ? (
        <span
          className={`rounded-full px-1.5 text-xs ${
            active ? 'bg-white/20' : 'bg-amber-500 text-white'
          }`}
        >
          {badge}
        </span>
      ) : null}
    </button>
  )
}

function Banner({ error, success }: { error?: string; success?: string }) {
  if (!error && !success) return null
  return (
    <div className="space-y-2">
      {error ? (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      ) : null}
      {success ? (
        <p className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {success}
        </p>
      ) : null}
    </div>
  )
}

function SubmitButton({
  pending,
  children,
  variant = 'primary',
  confirm,
  name,
  value,
  className,
}: {
  pending: boolean
  children: React.ReactNode
  variant?: 'primary' | 'secondary' | 'danger'
  confirm?: string
  name?: string
  value?: string
  className?: string
}) {
  const styles = {
    primary: 'bg-neutral-900 text-white hover:bg-neutral-700',
    secondary: 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200',
    danger: 'bg-red-50 text-red-700 hover:bg-red-100',
  }[variant]

  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending}
      onClick={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault()
      }}
      className={`rounded-xl px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className ?? ''}`}
    >
      {children}
    </button>
  )
}

const inputClass =
  'w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 outline-none transition focus:border-neutral-400'

export default function SupermarketAdminClient() {
  const [state, formAction, pending] = useActionState<SupermarketAdminState, FormData>(
    supermarketAdminAction,
    INITIAL_SUPERMARKET_ADMIN_STATE,
  )
  const [tab, setTab] = useState<TabKey>('period')

  useEffect(() => {
    const formData = new FormData()
    formData.set('intent', 'bootstrap')
    startTransition(() => formAction(formData))
  }, [formAction])

  const [editingPrizeId, setEditingPrizeId] = useState<string | null>(null)
  const [redemptionFilter, setRedemptionFilter] = useState<
    'ALL' | SupermarketRedemptionView['status']
  >('PENDING')

  const filteredRedemptions = useMemo(
    () =>
      redemptionFilter === 'ALL'
        ? state.redemptions
        : state.redemptions.filter((row) => row.status === redemptionFilter),
    [state.redemptions, redemptionFilter],
  )

  if (!state.unlocked) {
    return (
      <div className="space-y-4">
        <Banner error={state.error} />
        <div className="rounded-2xl border border-neutral-200 bg-white p-8 text-center text-sm text-neutral-500">
          {state.error ? (
            <Link href="/admin" className="font-medium text-neutral-900 underline">
              返回控制台完成二次验证
            </Link>
          ) : (
            '正在校验管理员权限…'
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-100">积分超市管理</h1>
        <p className="mt-1 text-sm text-slate-400">
          超市按期开放。结算会把所有人的比赛积分转入本期超市积分并将比赛积分清零（ELO 不受影响），
          关闭后未使用积分作废，兑换记录长期保留。
        </p>
      </div>

      <Banner error={state.error} success={state.success} />

      <div className="flex flex-wrap gap-2">
        {TABS.map((item) => (
          <TabButton
            key={item.key}
            active={tab === item.key}
            onClick={() => setTab(item.key)}
            badge={item.key === 'redemptions' ? state.pendingCount : undefined}
          >
            {item.label}
          </TabButton>
        ))}
      </div>

      {/* ---------------------------------------------------------------- */}
      {tab === 'period' ? (
        <div className="space-y-4">
          <section className="rounded-2xl border border-neutral-200 bg-white p-6">
            <h2 className="text-lg font-semibold text-neutral-900">当前期次</h2>
            {state.openPeriod ? (
              <div className="mt-4 space-y-4">
                <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <dt className="text-neutral-500">期号</dt>
                    <dd className="mt-0.5 font-medium text-neutral-900">
                      第 {state.openPeriod.sequence} 期
                    </dd>
                  </div>
                  <div>
                    <dt className="text-neutral-500">开放时间</dt>
                    <dd className="mt-0.5 font-medium text-neutral-900">
                      {formatDateTime(state.openPeriod.openedAt)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-neutral-500">持有积分人数</dt>
                    <dd className="mt-0.5 font-medium text-neutral-900">
                      {state.memberCountInPeriod} 人
                    </dd>
                  </div>
                  <div>
                    <dt className="text-neutral-500">本期积分总量</dt>
                    <dd className="mt-0.5 font-medium text-neutral-900">
                      {state.totalBalanceInPeriod} 分
                    </dd>
                  </div>
                </dl>

                <div className="flex flex-wrap gap-3 border-t border-neutral-100 pt-4">
                  <form action={formAction}>
                    <input type="hidden" name="intent" value="settle" />
                    <SubmitButton
                      pending={pending}
                      confirm="结算会把所有会员的比赛积分转入本期超市积分，并把比赛积分清零。ELO 不受影响。确定继续？"
                    >
                      一键结算比赛积分
                    </SubmitButton>
                  </form>
                  <form action={formAction}>
                    <input type="hidden" name="intent" value="closePeriod" />
                    <SubmitButton
                      pending={pending}
                      variant="danger"
                      confirm="关闭本期会把所有未使用的超市积分作废，且不可撤销。兑换记录会保留，仍可继续处理待发放的兑换。确定关闭？"
                    >
                      关闭本期
                    </SubmitButton>
                  </form>
                </div>
                <p className="text-xs text-neutral-500">
                  关闭不受待发放兑换的限制；关期后仍可在「兑换记录」中标记已发放或已作废。
                </p>
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                <p className="text-sm text-neutral-600">
                  当前没有开放的期次。开启新期后，本期奖品与库存从零开始，不会继承上一期。
                </p>
                <form action={formAction}>
                  <input type="hidden" name="intent" value="openPeriod" />
                  <SubmitButton pending={pending}>开启新一期积分超市</SubmitButton>
                </form>
              </div>
            )}
          </section>

          {state.lastClosedPeriod ? (
            <section className="rounded-2xl border border-neutral-200 bg-white p-6">
              <h2 className="text-lg font-semibold text-neutral-900">上一期</h2>
              <p className="mt-2 text-sm text-neutral-600">
                第 {state.lastClosedPeriod.sequence} 期 · 开放于{' '}
                {formatDateTime(state.lastClosedPeriod.openedAt)}
                {state.lastClosedPeriod.closedAt
                  ? ` · 关闭于 ${formatDateTime(state.lastClosedPeriod.closedAt)}`
                  : ''}
              </p>
            </section>
          ) : null}
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {tab === 'prizes' ? (
        <div className="space-y-4">
          {!state.openPeriod ? (
            <p className="rounded-2xl border border-neutral-200 bg-white p-6 text-sm text-neutral-500">
              需要先开启一期积分超市才能设置奖品。
            </p>
          ) : (
            <>
              <section className="rounded-2xl border border-neutral-200 bg-white p-6">
                <h2 className="text-lg font-semibold text-neutral-900">新增奖品</h2>
                <form action={formAction} className="mt-4 grid gap-3 sm:grid-cols-2">
                  <input type="hidden" name="intent" value="createPrize" />
                  <label className="space-y-1 text-sm">
                    <span className="text-neutral-600">奖品名称</span>
                    <input name="name" required maxLength={60} className={inputClass} />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-neutral-600">需要积分</span>
                    <input
                      name="pointsCost"
                      type="number"
                      min={1}
                      step={1}
                      required
                      className={inputClass}
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-neutral-600">库存（留空为不限量）</span>
                    <input
                      name="stock"
                      type="number"
                      min={0}
                      step={1}
                      className={inputClass}
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-neutral-600">说明（可选）</span>
                    <input
                      name="description"
                      maxLength={200}
                      className={inputClass}
                    />
                  </label>
                  <div className="sm:col-span-2">
                    <SubmitButton pending={pending}>添加奖品</SubmitButton>
                  </div>
                </form>
              </section>

              <section className="space-y-3">
                {state.prizes.length === 0 ? (
                  <p className="rounded-2xl border border-neutral-200 bg-white p-6 text-sm text-neutral-500">
                    本期还没有奖品。
                  </p>
                ) : (
                  state.prizes.map((prize) => (
                    <PrizeCard
                      key={prize.id}
                      prize={prize}
                      pending={pending}
                      formAction={formAction}
                      editing={editingPrizeId === prize.id}
                      onEdit={() =>
                        setEditingPrizeId(
                          editingPrizeId === prize.id ? null : prize.id,
                        )
                      }
                    />
                  ))
                )}
              </section>
            </>
          )}
        </div>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {tab === 'redemptions' ? (
        <section className="rounded-2xl border border-neutral-200 bg-white p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-neutral-900">兑换记录</h2>
            <div className="flex flex-wrap gap-2">
              {(['PENDING', 'FULFILLED', 'VOIDED', 'ALL'] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setRedemptionFilter(key)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                    redemptionFilter === key
                      ? 'bg-neutral-900 text-white'
                      : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200'
                  }`}
                >
                  {key === 'ALL' ? '全部' : REDEMPTION_STATUS_LABEL[key]}
                </button>
              ))}
            </div>
          </div>

          {filteredRedemptions.length === 0 ? (
            <p className="mt-4 text-sm text-neutral-500">没有符合条件的兑换记录。</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b border-neutral-200 text-neutral-500">
                  <tr>
                    <th className="py-2 pr-3 font-medium">期号</th>
                    <th className="py-2 pr-3 font-medium">会员</th>
                    <th className="py-2 pr-3 font-medium">奖品</th>
                    <th className="py-2 pr-3 font-medium">积分</th>
                    <th className="py-2 pr-3 font-medium">兑换时间</th>
                    <th className="py-2 pr-3 font-medium">状态</th>
                    <th className="py-2 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {filteredRedemptions.map((row) => (
                    <tr key={row.id}>
                      <td className="py-2 pr-3 text-neutral-500">
                        第 {row.periodSequence} 期
                      </td>
                      <td className="py-2 pr-3">
                        <div className="font-medium text-neutral-900">
                          {row.memberNickname}
                        </div>
                        <div className="text-xs text-neutral-500">{row.memberEmail}</div>
                      </td>
                      <td className="py-2 pr-3 text-neutral-900">{row.prizeName}</td>
                      <td className="py-2 pr-3 text-neutral-900">{row.pointsSpent}</td>
                      <td className="py-2 pr-3 text-neutral-500">
                        {formatDateTime(row.createdAt)}
                      </td>
                      <td className="py-2 pr-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${REDEMPTION_STATUS_CLASS[row.status]}`}
                        >
                          {REDEMPTION_STATUS_LABEL[row.status]}
                        </span>
                      </td>
                      <td className="py-2">
                        {row.status === 'PENDING' ? (
                          <div className="flex gap-2">
                            <form action={formAction}>
                              <input
                                type="hidden"
                                name="intent"
                                value="resolveRedemption"
                              />
                              <input
                                type="hidden"
                                name="redemptionId"
                                value={row.id}
                              />
                              <input type="hidden" name="resolution" value="FULFILLED" />
                              <button
                                type="submit"
                                disabled={pending}
                                className="rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-50"
                              >
                                标记已发放
                              </button>
                            </form>
                            <form action={formAction}>
                              <input
                                type="hidden"
                                name="intent"
                                value="resolveRedemption"
                              />
                              <input
                                type="hidden"
                                name="redemptionId"
                                value={row.id}
                              />
                              <input type="hidden" name="resolution" value="VOIDED" />
                              <button
                                type="submit"
                                disabled={pending}
                                onClick={(event) => {
                                  if (
                                    !window.confirm(
                                      '作废表示这笔兑换未履行。原期次仍开放时自动退回积分；已闭期时补偿请手工处理。库存不会自动恢复。确定作废？',
                                    )
                                  ) {
                                    event.preventDefault()
                                  }
                                }}
                                className="rounded-lg bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-600 transition hover:bg-neutral-200 disabled:opacity-50"
                              >
                                标记已作废
                              </button>
                            </form>
                          </div>
                        ) : (
                          <span className="text-xs text-neutral-400">
                            {row.resolvedAt ? formatDateTime(row.resolvedAt) : '—'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {tab === 'adjustments' ? (
        <div className="space-y-4">
          <section className="rounded-2xl border border-neutral-200 bg-white p-6">
            <h2 className="text-lg font-semibold text-neutral-900">手工调整积分</h2>
            {state.openPeriod ? (
              <>
                <p className="mt-1 text-sm text-neutral-500">
                  用于运营兜底（例如补偿未履行的兑换）。只能调整当前开放期的积分，必须填写原因，
                  不能减为负数，且会留下审计记录。
                </p>
                <form action={formAction} className="mt-4 grid gap-3 sm:grid-cols-3">
                  <input type="hidden" name="intent" value="adjustPoints" />
                  <label className="space-y-1 text-sm">
                    <span className="text-neutral-600">会员邮箱</span>
                    <input
                      name="userId"
                      required
                      placeholder="member@example.com"
                      className={inputClass}
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-neutral-600">调整分数（可为负）</span>
                    <input
                      name="amount"
                      type="number"
                      step={1}
                      required
                      className={inputClass}
                    />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-neutral-600">原因</span>
                    <input name="reason" required maxLength={200} className={inputClass} />
                  </label>
                  <div className="sm:col-span-3">
                    <SubmitButton pending={pending}>提交调整</SubmitButton>
                  </div>
                </form>
              </>
            ) : (
              <p className="mt-2 text-sm text-neutral-500">
                当前没有开放的期次，无法调整积分。
              </p>
            )}
          </section>

          <section className="rounded-2xl border border-neutral-200 bg-white p-6">
            <h2 className="text-lg font-semibold text-neutral-900">调整记录</h2>
            {state.adjustments.length === 0 ? (
              <p className="mt-3 text-sm text-neutral-500">暂无手工调整记录。</p>
            ) : (
              <ul className="mt-3 divide-y divide-neutral-100 text-sm">
                {state.adjustments.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap gap-x-3 gap-y-1 py-2.5">
                    <span className="font-medium text-neutral-900">
                      {entry.memberNickname}
                    </span>
                    <span className="text-neutral-500">{entry.memberEmail}</span>
                    <span
                      className={
                        entry.amount > 0
                          ? 'font-medium text-emerald-700'
                          : 'font-medium text-red-700'
                      }
                    >
                      {entry.amount > 0 ? '+' : ''}
                      {entry.amount}
                    </span>
                    <span className="text-neutral-500">→ {entry.balanceAfter} 分</span>
                    <span className="text-neutral-500">{entry.reason}</span>
                    <span className="ml-auto text-xs text-neutral-400">
                      {formatDateTime(entry.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </div>
  )
}

function PrizeCard({
  prize,
  pending,
  formAction,
  editing,
  onEdit,
}: {
  prize: SupermarketPrizeView
  pending: boolean
  formAction: (formData: FormData) => void
  editing: boolean
  onEdit: () => void
}) {
  const withdrawn = prize.status === 'WITHDRAWN'

  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-neutral-900">{prize.name}</span>
            {withdrawn ? (
              <span className="rounded-full bg-neutral-200 px-2 py-0.5 text-xs text-neutral-600">
                已下架
              </span>
            ) : null}
          </div>
          {prize.description ? (
            <p className="mt-1 text-sm text-neutral-500">{prize.description}</p>
          ) : null}
          <p className="mt-1 text-sm text-neutral-600">
            {prize.pointsCost} 分 ·{' '}
            {prize.stock === null ? '不限量' : `库存 ${prize.stock}`} · 已兑换{' '}
            {prize.redemptionCount} 次
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onEdit}
            className="rounded-xl bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-200"
          >
            {editing ? '收起' : '编辑'}
          </button>
          <form action={formAction}>
            <input type="hidden" name="intent" value="togglePrizeStatus" />
            <input type="hidden" name="prizeId" value={prize.id} />
            <input
              type="hidden"
              name="status"
              value={withdrawn ? 'ACTIVE' : 'WITHDRAWN'}
            />
            <button
              type="submit"
              disabled={pending}
              className="rounded-xl bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-700 transition hover:bg-neutral-200 disabled:opacity-50"
            >
              {withdrawn ? '重新上架' : '下架'}
            </button>
          </form>
          {prize.redemptionCount === 0 ? (
            <form action={formAction}>
              <input type="hidden" name="intent" value="deletePrize" />
              <input type="hidden" name="prizeId" value={prize.id} />
              <button
                type="submit"
                disabled={pending}
                onClick={(event) => {
                  if (!window.confirm(`确定删除「${prize.name}」？`)) {
                    event.preventDefault()
                  }
                }}
                className="rounded-xl bg-red-50 px-3 py-1.5 text-sm font-medium text-red-700 transition hover:bg-red-100 disabled:opacity-50"
              >
                删除
              </button>
            </form>
          ) : null}
        </div>
      </div>

      {editing ? (
        <form
          action={formAction}
          className="mt-4 grid gap-3 border-t border-neutral-100 pt-4 sm:grid-cols-2"
        >
          <input type="hidden" name="intent" value="updatePrize" />
          <input type="hidden" name="prizeId" value={prize.id} />
          <label className="space-y-1 text-sm">
            <span className="text-neutral-600">奖品名称</span>
            <input
              name="name"
              defaultValue={prize.name}
              required
              maxLength={60}
              className={inputClass}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-neutral-600">需要积分</span>
            <input
              name="pointsCost"
              type="number"
              min={1}
              step={1}
              defaultValue={prize.pointsCost}
              required
              className={inputClass}
            />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-neutral-600">库存（留空为不限量）</span>
            <input
              name="stock"
              type="number"
              min={0}
              step={1}
              defaultValue={prize.stock ?? ''}
              className={inputClass}
            />
          </label>
          <div className="flex items-end">
            <SubmitButton pending={pending} variant="secondary">
              保存修改
            </SubmitButton>
          </div>
        </form>
      ) : null}
    </div>
  )
}
