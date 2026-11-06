import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getAdminIdentity, isAdminReauthed } from '@/lib/server/admin/guard'
import { prisma } from '@/lib/prisma'
import { IdentityViewer } from './viewer'

export const dynamic = 'force-dynamic'

export default async function RegistrationIdentitiesPage({ searchParams }: { searchParams: Promise<{ match?: string }> }) {
  const actor = await getAdminIdentity()
  if (!actor.ok || !(await isAdminReauthed(actor.userId))) redirect('/admin')
  const matches = await prisma.match.findMany({
    where: { collectIdentityInfo: true }, select: { id: true, title: true }, orderBy: { dateTime: 'desc' },
  })
  const selectedId = (await searchParams).match
  const selected = matches.find(match => match.id === selectedId)
  const members = selected ? await prisma.matchRegistrationIdentity.findMany({
    where: { matchId: selected.id, user: { matchEntryMembers: { some: { matchId: selected.id, status: 'ACTIVE', entry: { status: 'ACTIVE' } } } } },
    select: { userId: true, user: { select: { nickname: true } } }, orderBy: [{ user: { nickname: 'asc' } }, { userId: 'asc' }],
  }) : []
  return <section className="surface-panel mx-auto max-w-3xl space-y-5 rounded-3xl p-6">
    <Link href="/admin" className="text-sm text-sky-300">返回管理员控制台</Link>
    <h1 className="text-2xl font-bold">报名身份资料</h1>
    <p className="text-sm text-slate-400">选择比赛后，可按参赛者查看本人为该场比赛提交的资料。每次查看都会记录在管理日志中。</p>
    {matches.length === 0 ? <p>暂无启用身份信息收集的比赛。</p> :
      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1">比赛<select name="match" defaultValue={selected?.id ?? ''} required className="rounded-lg border border-slate-600 bg-slate-900 p-2">
          <option value="" disabled>选择比赛</option>{matches.map(m => <option key={m.id} value={m.id}>{m.title}</option>)}
        </select></label><button className="btn-secondary rounded-lg px-4 py-2">查看参赛者</button>
      </form>}
    {selected && (members.length ? <IdentityViewer key={selected.id} matchId={selected.id} members={members.map(m => ({ id: m.userId, nickname: m.user.nickname }))}/> : <p>这场比赛暂无已完成报名并提交身份资料的参赛者。</p>)}
  </section>
}
