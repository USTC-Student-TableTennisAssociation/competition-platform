export default function Footer() {
  return (
    <footer className="border-t border-slate-800 bg-slate-950/90">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-6 text-sm text-slate-400 md:flex-row md:items-center md:justify-between md:px-6 lg:px-8">
        <p>© {new Date().getFullYear()} USTC TTA · 乒乓球竞技平台</p>
      </div>
    </footer>
  )
}
