import assert from 'node:assert/strict'
import test from 'node:test'
import type { Prisma } from '@prisma/client'

import {
  lockMatchForEngine,
  lockMatchResultForUpdate,
  MatchEngineGuardError,
  type LockedMatchEngine,
} from './engine-guard'

function createTransaction(result: LockedMatchEngine[]) {
  const queries: Prisma.Sql[] = []
  const tx = {
    $queryRaw: async (query: Prisma.Sql) => {
      queries.push(query)
      return result
    },
  } as unknown as Pick<Prisma.TransactionClient, '$queryRaw'>

  return { tx, queries }
}

test('locks the Match row and accepts the expected engine and quick invariant', async () => {
  const { tx, queries } = createTransaction([
    { id: 'match-1', engineVersion: 'LEGACY', isQuickMatch: false },
  ])

  const result = await lockMatchForEngine(tx, {
    matchId: 'match-1',
    expectedEngine: 'LEGACY',
    expectedQuickMatch: false,
  })

  assert.deepEqual(result, {
    id: 'match-1',
    engineVersion: 'LEGACY',
    isQuickMatch: false,
  })
  assert.equal(queries.length, 1)
  assert.deepEqual(queries[0].values, ['match-1'])
  assert.match(queries[0].strings.join('?'), /FROM "Match"[\s\S]*FOR UPDATE/)
})

test('returns a stable not-found error after attempting the row lock', async () => {
  const { tx, queries } = createTransaction([])

  await assert.rejects(
    lockMatchForEngine(tx, {
      matchId: 'missing',
      expectedEngine: 'LEGACY',
    }),
    (error: unknown) => {
      assert.ok(error instanceof MatchEngineGuardError)
      assert.equal(error.code, 'MATCH_NOT_FOUND')
      assert.equal(error.matchId, 'missing')
      return true
    },
  )
  assert.equal(queries.length, 1)
})

test('rejects an engine mismatch with expected and actual values', async () => {
  const { tx } = createTransaction([
    { id: 'match-v2', engineVersion: 'V2', isQuickMatch: false },
  ])

  await assert.rejects(
    lockMatchForEngine(tx, {
      matchId: 'match-v2',
      expectedEngine: 'LEGACY',
    }),
    (error: unknown) => {
      assert.ok(error instanceof MatchEngineGuardError)
      assert.equal(error.code, 'ENGINE_MISMATCH')
      assert.equal(error.expectedEngine, 'LEGACY')
      assert.equal(error.actualEngine, 'V2')
      return true
    },
  )
})

test('rejects a quick/formal mismatch independently of engine ownership', async () => {
  const { tx } = createTransaction([
    { id: 'quick-1', engineVersion: 'LEGACY', isQuickMatch: true },
  ])

  await assert.rejects(
    lockMatchForEngine(tx, {
      matchId: 'quick-1',
      expectedEngine: 'LEGACY',
      expectedQuickMatch: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof MatchEngineGuardError)
      assert.equal(error.code, 'QUICK_MATCH_MISMATCH')
      assert.equal(error.expectedQuickMatch, false)
      assert.equal(error.actualQuickMatch, true)
      return true
    },
  )
})

test('locks one legacy result row without reading or locking its Match', async () => {
  const { tx, queries } = createTransaction([])

  await lockMatchResultForUpdate(tx, 'result-1')

  assert.equal(queries.length, 1)
  assert.deepEqual(queries[0].values, ['result-1'])
  assert.match(queries[0].strings.join('?'), /FROM "MatchResult"[\s\S]*FOR UPDATE/)
  assert.doesNotMatch(queries[0].strings.join('?'), /FROM "Match"/)
})
