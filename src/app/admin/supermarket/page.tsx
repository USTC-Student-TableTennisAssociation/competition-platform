import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

import { getCurrentUser } from '@/lib/auth'
import SupermarketAdminClient from '@/app/admin/supermarket/SupermarketAdminClient'

export default async function SupermarketAdminPage() {
  const currentUser = await getCurrentUser()

  if (!currentUser) {
    redirect('/auth')
  }

  if (currentUser.role !== 'admin') {
    redirect('/')
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <Link
        href="/admin"
        className="inline-flex items-center gap-1 text-sm text-slate-400 transition hover:text-slate-100"
      >
        <ArrowLeft className="h-4 w-4" />
        返回控制台
      </Link>
      <SupermarketAdminClient />
    </div>
  )
}
