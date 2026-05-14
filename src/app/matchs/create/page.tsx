import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { getCurrentUser } from '@/lib/auth'
import CreateMatchForm from '@/components/match/CreateMatchForm'

export default async function CreateMatchPage() {
  const currentUser = await getCurrentUser()

  if (!currentUser) {
    return (
      <div className="mx-auto max-w-2xl rounded-2xl border border-slate-700 bg-slate-900/80 p-8 text-center">
        <h1 className="text-2xl font-bold text-white">请先登录</h1>
        <p className="mt-2 text-slate-300">登录后才能发布比赛。</p>
        <Link href="/auth" className="mt-5 inline-block rounded-lg bg-cyan-500/20 px-4 py-2 text-cyan-100">去登录</Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <Link href="/matchs" className="inline-flex items-center gap-2 text-slate-400 hover:text-slate-200">
        <ArrowLeft className="h-4 w-4" />
        返回比赛列表
      </Link>

      <div className="rounded-2xl border border-slate-700 bg-slate-900/80 p-8">
        <h1 className="text-3xl font-bold text-white">发布比赛</h1>
        <p className="mt-2 text-sm text-slate-300">创建后不会自动报名，发起人可后续手动报名。分组结果需在报名截止后由发起人/管理员确认发布。</p>
        <div className="mt-8">
          <CreateMatchForm />
        </div>
      </div>
    </div>
  )
}
