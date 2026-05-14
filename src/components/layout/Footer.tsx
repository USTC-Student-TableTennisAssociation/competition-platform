export default function Footer() {
  return (
    <footer className="border-t border-white/8 bg-slate-950/65">
      <div className="mx-auto flex max-w-[1440px] flex-col gap-3 px-4 py-6 text-xs text-slate-500 md:flex-row md:items-center md:justify-between md:px-7 xl:px-10">
        <p>© {new Date().getFullYear()} USTC TTA · 竞技赛事与成员成长平台</p>
        <p className="tracking-[0.16em] text-slate-600">PLAY · RECORD · CLIMB</p>
      </div>
    </footer>
  )
}
