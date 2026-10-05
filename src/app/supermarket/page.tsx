import { redirect } from 'next/navigation'

import { getCurrentUser } from '@/lib/auth'
import SupermarketClient from '@/app/supermarket/SupermarketClient'

export const metadata = {
  title: '积分超市',
}

export default async function SupermarketPage() {
  const currentUser = await getCurrentUser()

  if (!currentUser) {
    redirect('/auth')
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <SupermarketClient />
    </div>
  )
}
