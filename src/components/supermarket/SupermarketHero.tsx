import type { ReactNode } from 'react'

export default function SupermarketHero({ balance, sequence, preview = false, children }: {
  balance: ReactNode
  sequence: number | null
  preview?: boolean
  children?: ReactNode
}) {
  return (
    <section className="surface-panel overflow-hidden rounded-3xl p-4 sm:p-7">
      <div className="flex items-center justify-between gap-4 sm:gap-8">
        <div className="min-w-0">
          <p className="mb-3 text-xs font-medium tracking-wide text-slate-400">
            科大乒协{sequence ? ` · 第 ${sequence} 期` : ''}{preview ? ' · 预览' : ''}
          </p>
          <h1 className="text-[28px] font-bold leading-tight tracking-tight text-slate-50 sm:text-4xl">积分商店</h1>
          <p className="mt-3 max-w-md text-xs leading-relaxed text-slate-400 sm:text-sm">把每一次上场，换成一份喜欢的礼物。</p>
        </div>
        <div className="shrink-0 rounded-2xl border border-white/[0.08] bg-[#080d18] px-4 py-4 text-center sm:min-w-36 sm:px-6">
          <p className="text-[11px] text-slate-400 sm:text-xs">{preview ? '模拟可用积分' : '可用积分'}</p>
          <p className="mt-1 text-[36px] font-semibold leading-tight tracking-tight text-orange-300 tabular-nums sm:text-5xl">
            {balance}<span className="ml-1 text-xs font-normal tracking-normal sm:text-sm">分</span>
          </p>
        </div>
      </div>
      {children ? <div className="mt-5 border-t border-white/[0.08] pt-4">{children}</div> : null}
    </section>
  )
}
