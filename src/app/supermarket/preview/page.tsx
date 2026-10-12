import { notFound } from 'next/navigation'
import { prisma } from '@/lib/prisma'
import { isLocalSupermarketDatabase } from '@/lib/server/supermarket/image-policy'
import SupermarketPreview from '@/components/supermarket/SupermarketPreview'

export const metadata = { title: '积分商店 · 本地预览' }
export const dynamic = 'force-dynamic'

export default async function LocalSupermarketPreviewPage() {
  // Never exposes a draft catalog on a deployed site or against a remote DB.
  if (process.env.NODE_ENV !== 'development' || !isLocalSupermarketDatabase()) notFound()
  const period = await prisma.supermarketPeriod.findFirst({
    where: { status: { in: ['DRAFT', 'OPEN'] } },
    orderBy: { sequence: 'desc' },
    include: { prizes: { where: { status: 'ACTIVE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  })
  return <div className="mx-auto max-w-5xl"><SupermarketPreview prizes={period?.prizes ?? []} sequence={period?.sequence ?? null} /></div>
}
