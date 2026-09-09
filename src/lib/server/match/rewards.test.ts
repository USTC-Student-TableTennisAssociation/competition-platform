import assert from 'node:assert/strict'
import test from 'node:test'
import type { Prisma } from '@prisma/client'

import {
  grantRegistrationRewardPoints,
  refundRegistrationRewardPoints,
} from './rewards'

function rewardTransaction(options: {
  registrationTotal: number
  matchTotal: number
  points: number
}) {
  const calls: string[] = []
  let aggregateCall = 0
  const tx = {
    $queryRaw: async () => {
      calls.push('lock-user')
      return [{ id: 'user-1' }]
    },
    pointsTransaction: {
      aggregate: async () => {
        calls.push('aggregate-points')
        aggregateCall += 1
        return {
          _sum: {
            amount:
              aggregateCall === 1
                ? options.registrationTotal
                : options.matchTotal,
          },
        }
      },
      create: async () => {
        calls.push('create-ledger-entry')
        return { id: 'points-1' }
      },
    },
    user: {
      findUnique: async () => {
        calls.push('read-user-points')
        return { points: options.points }
      },
      update: async () => {
        calls.push('update-user-points')
        return { id: 'user-1' }
      },
    },
  } as unknown as Prisma.TransactionClient

  return { tx, calls }
}

test('registration grant locks the user before reading point aggregates', async () => {
  const { tx, calls } = rewardTransaction({
    registrationTotal: 0,
    matchTotal: 0,
    points: 10,
  })

  const result = await grantRegistrationRewardPoints(tx, {
    userId: 'user-1',
    matchId: 'match-1',
  })

  assert.deepEqual(result, { granted: 1, totalAwarded: 1 })
  assert.equal(calls[0], 'lock-user')
  assert.ok(calls.indexOf('lock-user') < calls.indexOf('read-user-points'))
  assert.ok(calls.indexOf('lock-user') < calls.indexOf('aggregate-points'))
})

test('registration refund locks the user before calculating a safe deduction', async () => {
  const { tx, calls } = rewardTransaction({
    registrationTotal: 1,
    matchTotal: 1,
    points: 1,
  })

  const result = await refundRegistrationRewardPoints(tx, {
    userId: 'user-1',
    matchId: 'match-1',
  })

  assert.deepEqual(result, { deducted: 1, totalAwarded: 0 })
  assert.equal(calls[0], 'lock-user')
  assert.ok(calls.indexOf('lock-user') < calls.indexOf('read-user-points'))
  assert.ok(calls.indexOf('lock-user') < calls.indexOf('aggregate-points'))
})
