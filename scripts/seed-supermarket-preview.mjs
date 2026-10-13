import { readFile } from 'node:fs/promises'
import { PrismaClient } from '@prisma/client'

const url = new URL(process.env.DATABASE_URL ?? 'invalid:')
if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/ustctta_v2') {
  throw new Error('Preview seeding requires the named local ustctta_v2 database.')
}
const catalog = JSON.parse(await readFile(new URL('../assets/supermarket/catalog-preview.json', import.meta.url), 'utf8'))
const db = new PrismaClient()
try {
  const result = await db.$transaction(async (tx) => {
    const [database] = await tx.$queryRaw`SELECT current_database() AS name`
    if (database.name !== 'ustctta_v2') throw new Error('Unexpected local database')
    if (await tx.supermarketPeriod.findFirst({ where: { status: 'OPEN' } })) {
      throw new Error('An open local period exists; this script only prepares an unopened draft.')
    }
    let draft = await tx.supermarketPeriod.findFirst({ where: { status: 'DRAFT' } })
    if (!draft) {
      const highest = await tx.supermarketPeriod.aggregate({ _max: { sequence: true } })
      draft = await tx.supermarketPeriod.create({ data: { sequence: (highest._max.sequence ?? 0) + 1, status: 'DRAFT', openedAt: null } })
    }
    const catalogTime = Date.now() - catalog.length * 1000
    for (const [index, { key, ...prize }] of catalog.entries()) {
      const id = `preview-${draft.id}-${key}`
      const data = { ...prize, createdAt: new Date(catalogTime + index * 1000) }
      await tx.supermarketPrize.upsert({ where: { id }, create: { id, periodId: draft.id, ...data }, update: data })
    }
    return { sequence: draft.sequence, status: draft.status, prizes: catalog.length }
  }, { isolationLevel: 'Serializable' })
  console.log(JSON.stringify(result))
} finally {
  await db.$disconnect()
}
