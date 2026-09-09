import assert from 'node:assert/strict'
import test from 'node:test'
import { type Prisma } from '@prisma/client'
import { removeUserFromMatch } from './remove-participant'

function mock(quick: boolean, banned = false) {
  const writes: unknown[] = []
  const tx = {
    $queryRaw: async (query: Prisma.Sql) => query.strings.join('').includes('FROM "Match"')
      ? [{ id: 'm', engineVersion: 'LEGACY', isQuickMatch: quick }]
      : query.values.map(id => ({ id })),
    match: { findUniqueOrThrow: async () => ({ title: 'Quick', status: 'ongoing', createdBy: 'admin' }) },
    user: { findUnique: async () => ({ role: 'admin', isBanned: banned, emailVerifiedAt: new Date() }) },
    matchResult: { deleteMany: async (args: unknown) => { writes.push(args); return { count: 1 } } },
    registration: { deleteMany: async () => ({ count: 1 }) },
    auditLog: { create: async () => ({}) },
  } as unknown as Prisma.TransactionClient
  return { tx, writes }
}
const target = { matchId: 'm', userId: 'u', actorId: 'admin', reason: 'user_banned' as const }

test('quick participant cleanup rejects formal archives before any write', async () => {
  const { tx, writes } = mock(false)
  await assert.rejects(removeUserFromMatch(tx, target))
  assert.equal(writes.length, 0)
})
test('quick participant cleanup rechecks the locked actor and excludes confirmed history', async () => {
  const denied = mock(true, true)
  await assert.rejects(removeUserFromMatch(denied.tx, target))
  assert.equal(denied.writes.length, 0)
  const allowed = mock(true)
  assert.equal((await removeUserFromMatch(allowed.tx, target)).removed, true)
  assert.deepEqual(allowed.writes, [{ where: { matchId: 'm', confirmed: false, OR: [{ winnerTeamIds: { has: 'u' } }, { loserTeamIds: { has: 'u' } }] } }])
})
