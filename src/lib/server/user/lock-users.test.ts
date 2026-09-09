import assert from 'node:assert/strict'
import test from 'node:test'
import type { Prisma } from '@prisma/client'

import { lockUsersForUpdate } from './lock-users'

test('user row locks de-duplicate ids and use one stable order', async () => {
  const queries: Prisma.Sql[] = []
  const tx = {
    $queryRaw: async (query: Prisma.Sql) => {
      queries.push(query)
      return query.values.map((id) => ({ id }))
    },
  } as unknown as Pick<Prisma.TransactionClient, '$queryRaw'>

  const lockedIds = await lockUsersForUpdate(tx, [
    'user-z',
    'user-a',
    'user-z',
    'user-m',
  ])

  assert.deepEqual(lockedIds, ['user-a', 'user-m', 'user-z'])
  assert.equal(queries.length, 1)
  assert.deepEqual(queries[0].values, ['user-a', 'user-m', 'user-z'])
  assert.match(queries[0].strings.join('?'), /ORDER BY "id"\s+FOR UPDATE/)
})

test('an empty user set does not issue invalid SQL', async () => {
  let queryCount = 0
  const tx = {
    $queryRaw: async () => {
      queryCount += 1
      return []
    },
  } as unknown as Pick<Prisma.TransactionClient, '$queryRaw'>

  assert.deepEqual(await lockUsersForUpdate(tx, []), [])
  assert.equal(queryCount, 0)
})
