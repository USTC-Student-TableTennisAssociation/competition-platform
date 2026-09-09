import assert from 'node:assert/strict'
import test from 'node:test'
import { MatchEngineVersion, MatchStatus, MatchType, type Prisma } from '@prisma/client'

import {
  hasMaterializedV2TeamEntry,
  isRetryableTeamSourceConflict,
  lockTeamSourceMatch,
  lockTeamSourceRows,
  type LockedTeamSourceMatch,
} from './team-source'

function match(overrides: Partial<LockedTeamSourceMatch> = {}): LockedTeamSourceMatch {
  return {
    id: 'match-1',
    title: '团体赛',
    type: MatchType.team,
    status: MatchStatus.registration,
    engineVersion: MatchEngineVersion.V2,
    isQuickMatch: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    registrationDeadline: new Date('2026-02-01T00:00:00.000Z'),
    teamRegistrationStart: null,
    teamRegistrationDeadline: null,
    teamMinMembers: 3,
    teamMaxMembers: 6,
    ...overrides,
  }
}

test('team source Match lock accepts only V2 formal team matches', async () => {
  for (const engineVersion of [MatchEngineVersion.V2]) {
    const queries: Prisma.Sql[] = []
    const tx = {
      $queryRaw: async (query: Prisma.Sql) => {
        queries.push(query)
        return [match({ engineVersion })]
      },
    } as unknown as Pick<Prisma.TransactionClient, '$queryRaw'>

    const result = await lockTeamSourceMatch(tx, 'match-1')

    assert.equal(result.ok, true)
    assert.equal(queries.length, 1)
    assert.deepEqual(queries[0].values, ['match-1'])
    assert.match(queries[0].strings.join('?'), /FROM "Match"[\s\S]*FOR UPDATE/)
  }
})

test('team source Match lock rejects missing, non-team and quick matches', async () => {
  const outcomes = [
    { rows: [match({ engineVersion: MatchEngineVersion.LEGACY })], error: '历史比赛已归档，不能修改报名。' },
    { rows: [], error: '比赛不存在。' },
    { rows: [match({ type: MatchType.single })], error: '该比赛不是团体赛。' },
    { rows: [match({ isQuickMatch: true })], error: '快速约球不支持团体报名。' },
  ]

  for (const outcome of outcomes) {
    const tx = {
      $queryRaw: async () => outcome.rows,
    } as unknown as Pick<Prisma.TransactionClient, '$queryRaw'>
    assert.deepEqual(await lockTeamSourceMatch(tx, 'match-1'), {
      ok: false,
      error: outcome.error,
    })
  }
})

test('team source rows lock sorted teams before their complete member rows', async () => {
  const queries: Prisma.Sql[] = []
  const tx = {
    $queryRaw: async (query: Prisma.Sql) => {
      queries.push(query)
      return queries.length === 1
        ? [{ id: 'team-a' }, { id: 'team-b' }]
        : [
            { id: 'member-1', teamId: 'team-a', userId: 'user-a' },
            { id: 'member-2', teamId: 'team-b', userId: 'user-b' },
          ]
    },
  } as unknown as Pick<Prisma.TransactionClient, '$queryRaw'>

  const result = await lockTeamSourceRows(tx, {
    matchId: 'match-1',
    teamIds: ['team-b', 'team-a', 'team-a'],
    userIds: ['user-b', 'user-a'],
  })

  assert.deepEqual(result.teamIds, ['team-a', 'team-b'])
  assert.equal(result.members.length, 2)
  assert.equal(queries.length, 2)
  assert.match(queries[0].strings.join('?'), /FROM match_team t[\s\S]*ORDER BY t\.id[\s\S]*FOR UPDATE/)
  assert.deepEqual(queries[0].values, [
    'match-1',
    'team-a',
    'team-b',
    'match-1',
    'user-a',
    'user-b',
  ])
  assert.match(queries[1].strings.join('?'), /FROM match_team_member tm[\s\S]*ORDER BY tm\.id[\s\S]*FOR UPDATE/)
  assert.deepEqual(queries[1].values, ['match-1', 'team-a', 'team-b'])
})

test('only V2 materialized team Entries activate the source mutation gate', async () => {
  let calls = 0
  const tx = {
    $queryRaw: async () => {
      calls += 1
      return [{ id: 'entry-1' }]
    },
  } as unknown as Pick<Prisma.TransactionClient, '$queryRaw'>

  assert.equal(
    await hasMaterializedV2TeamEntry(tx, {
      match: match({ engineVersion: MatchEngineVersion.LEGACY }),
      teamIds: ['team-1'],
    }),
    false,
  )
  assert.equal(calls, 0)
  assert.equal(
    await hasMaterializedV2TeamEntry(tx, {
      match: match({ engineVersion: MatchEngineVersion.V2 }),
      teamIds: ['team-2', 'team-1'],
    }),
    true,
  )
  assert.equal(calls, 1)
})

test('team source conflict mapping covers Prisma and PostgreSQL retry codes', () => {
  assert.equal(isRetryableTeamSourceConflict({ code: 'P2034' }), true)
  assert.equal(isRetryableTeamSourceConflict({ code: '40001' }), true)
  assert.equal(isRetryableTeamSourceConflict({ code: '40P01' }), true)
  assert.equal(
    isRetryableTeamSourceConflict({ code: 'P2010', meta: { code: '40001' } }),
    true,
  )
  assert.equal(
    isRetryableTeamSourceConflict({ code: 'P2010', meta: { code: '40P01' } }),
    true,
  )
  assert.equal(isRetryableTeamSourceConflict({ code: 'P2002' }), false)
})
