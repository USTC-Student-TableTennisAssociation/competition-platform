import assert from 'node:assert/strict'
import test from 'node:test'
import type { Prisma } from '@prisma/client'

import {
  HardDeleteUsersBlockedError,
  hardDeleteUsersWithoutBusinessHistory,
} from './hard-delete-users'

const HISTORY_KEYS = [
  'createdMatches',
  'registrations',
  'wonResults',
  'lostResults',
  'reportedResults',
  'verifiedResults',
  'eloHistory',
  'pointsLedger',
  'redemptions',
  'awardedBadges',
  'reviewsGiven',
  'reviewsReceived',
  'auditLogs',
  'certificates',
  'doublesTeamsCreated',
  'doublesTeamMembers',
  'doublesInvitesSent',
  'doublesInvitesReceived',
  'createdMatchPosts',
  'matchedMatchPosts',
  'matchApplications',
  'captainedMatchTeams',
  'reviewedMatchTeams',
  'matchTeamMembers',
  'notificationOutbox',
  'matchEntryMembers',
  'sourcedMatchEntries',
  'resultRevisionsReported',
  'resultRevisionsVerified',
  'settlementEffects',
] as const

function emptyHistoryCounts() {
  return Object.fromEntries(HISTORY_KEYS.map((key) => [key, 0]))
}

function userRow(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    email: `${id}@example.test`,
    nickname: id,
    role: 'user',
    points: 0,
    eloRating: 1200,
    wins: 0,
    losses: 0,
    matchesPlayed: 0,
    identity: null,
    _count: emptyHistoryCounts(),
    ...overrides,
  }
}

function fakeTransaction(options: {
  actorRole?: 'admin' | 'user' | null
  actorBanned?: boolean
  actorVerified?: boolean
  targets?: ReturnType<typeof userRow>[]
  participantResults?: Array<{ winnerTeamIds: string[]; loserTeamIds: string[] }>
  leaderboardUserIds?: string[]
  auditTargetIds?: string[]
}) {
  const calls: string[] = []
  const lockQueries: Prisma.Sql[] = []
  const audits: unknown[] = []
  let deleteCount = 0
  const targets = options.targets ?? []

  const tx = {
    $queryRaw: async (query: Prisma.Sql) => {
      calls.push('lock-users')
      lockQueries.push(query)
      return []
    },
    user: {
      findUnique: async () => {
        calls.push('read-actor')
        return options.actorRole === null
          ? null
          : {
              role: options.actorRole ?? 'admin',
              isBanned: options.actorBanned ?? false,
              emailVerifiedAt: options.actorVerified === false ? null : new Date(),
            }
      },
      findMany: async () => {
        calls.push('read-targets')
        return targets
      },
      deleteMany: async () => {
        calls.push('delete-users')
        deleteCount += targets.length
        return { count: targets.length }
      },
    },
    matchResult: {
      findMany: async () => {
        calls.push('read-result-members')
        return options.participantResults ?? []
      },
    },
    leaderboardCache: {
      groupBy: async () => {
        calls.push('read-leaderboard-cache')
        return (options.leaderboardUserIds ?? []).map((userId) => ({
          userId,
          _count: { _all: 1 },
        }))
      },
    },
    auditLog: {
      findMany: async () => {
        calls.push('read-target-audits')
        return (options.auditTargetIds ?? []).map((entityId) => ({ entityId }))
      },
      create: async (args: unknown) => {
        calls.push('create-delete-audit')
        audits.push(args)
        return { id: 'audit-1' }
      },
    },
  } as unknown as Prisma.TransactionClient

  return {
    tx,
    calls,
    lockQueries,
    audits,
    getDeleteCount: () => deleteCount,
  }
}

test('clean account is locked, checked, deleted and audited in that order', async () => {
  const fake = fakeTransaction({ targets: [userRow('user-1')] })

  const result = await hardDeleteUsersWithoutBusinessHistory(fake.tx, {
    actorId: 'admin-1',
    userIds: ['user-1'],
    mode: 'single',
    auditContext: { ip: '127.0.0.1', userAgent: 'test' },
  })

  assert.deepEqual(result, { deletedCount: 1, deletedUserIds: ['user-1'] })
  assert.deepEqual(fake.lockQueries[0].values, ['admin-1', 'user-1'])
  assert.equal(fake.calls[0], 'lock-users')
  assert.ok(fake.calls.indexOf('lock-users') < fake.calls.indexOf('read-targets'))
  assert.ok(fake.calls.indexOf('read-targets') < fake.calls.indexOf('delete-users'))
  assert.ok(fake.calls.indexOf('read-result-members') < fake.calls.indexOf('delete-users'))
  assert.ok(fake.calls.indexOf('read-leaderboard-cache') < fake.calls.indexOf('delete-users'))
  assert.ok(fake.calls.indexOf('read-target-audits') < fake.calls.indexOf('delete-users'))
  assert.ok(fake.calls.indexOf('delete-users') < fake.calls.indexOf('create-delete-audit'))
  assert.equal(fake.audits.length, 1)
})

test('every direct business/history relation blocks hard deletion', async () => {
  for (const key of HISTORY_KEYS) {
    const fake = fakeTransaction({
      targets: [
        userRow('user-1', {
          _count: { ...emptyHistoryCounts(), [key]: 1 },
        }),
      ],
    })

    await assert.rejects(
      () =>
        hardDeleteUsersWithoutBusinessHistory(fake.tx, {
          actorId: 'admin-1',
          userIds: ['user-1'],
          mode: 'single',
        }),
      HardDeleteUsersBlockedError,
      key,
    )
    assert.equal(fake.getDeleteCount(), 0, key)
  }
})

test('non-default user aggregates block deletion defensively', async () => {
  const variants = [
    { points: 1 },
    { points: -1 },
    { eloRating: 1199 },
    { wins: 1 },
    { losses: 1 },
    { matchesPlayed: 1 },
  ]

  for (const aggregate of variants) {
    const fake = fakeTransaction({ targets: [userRow('user-1', aggregate)] })
    await assert.rejects(
      () =>
        hardDeleteUsersWithoutBusinessHistory(fake.tx, {
          actorId: 'admin-1',
          userIds: ['user-1'],
          mode: 'single',
        }),
      HardDeleteUsersBlockedError,
    )
    assert.equal(fake.getDeleteCount(), 0)
  }
})

test('a certificate identity blocks hard deletion even without another relation', async () => {
  const fake = fakeTransaction({
    targets: [userRow('user-1', { identity: { id: 'identity-1' } })],
  })

  await assert.rejects(
    () =>
      hardDeleteUsersWithoutBusinessHistory(fake.tx, {
        actorId: 'admin-1',
        userIds: ['user-1'],
        mode: 'single',
      }),
    HardDeleteUsersBlockedError,
  )
  assert.equal(fake.getDeleteCount(), 0)
})

test('legacy result arrays, leaderboard cache and target audit records block deletion', async () => {
  const cases = [
    { participantResults: [{ winnerTeamIds: ['user-1'], loserTeamIds: [] }] },
    { leaderboardUserIds: ['user-1'] },
    { auditTargetIds: ['user-1'] },
  ]

  for (const extraHistory of cases) {
    const fake = fakeTransaction({ targets: [userRow('user-1')], ...extraHistory })
    await assert.rejects(
      () =>
        hardDeleteUsersWithoutBusinessHistory(fake.tx, {
          actorId: 'admin-1',
          userIds: ['user-1'],
          mode: 'single',
        }),
      HardDeleteUsersBlockedError,
    )
    assert.equal(fake.getDeleteCount(), 0)
  }
})

test('bulk deletion rejects the complete batch when one target is blocked', async () => {
  const fake = fakeTransaction({
    targets: [
      userRow('clean-user'),
      userRow('history-user', {
        _count: { ...emptyHistoryCounts(), registrations: 1 },
      }),
    ],
  })

  await assert.rejects(
    () =>
      hardDeleteUsersWithoutBusinessHistory(fake.tx, {
        actorId: 'admin-1',
        userIds: ['history-user', 'clean-user'],
        mode: 'bulk',
      }),
    (error: unknown) => {
      assert.ok(error instanceof HardDeleteUsersBlockedError)
      assert.equal(error.blockedCount, 1)
      assert.equal(error.requestedCount, 2)
      assert.match(error.message, /2 个账号中有 1 个/)
      return true
    },
  )
  assert.equal(fake.getDeleteCount(), 0)
  assert.equal(fake.audits.length, 0)
})

test('missing, admin and current-admin targets are all protected', async () => {
  const cases = [
    { targets: [] },
    { targets: [userRow('user-1', { role: 'admin' })] },
    { actorId: 'user-1', targets: [userRow('user-1')] },
  ]

  for (const item of cases) {
    const fake = fakeTransaction({ targets: item.targets })
    await assert.rejects(
      () =>
        hardDeleteUsersWithoutBusinessHistory(fake.tx, {
          actorId: item.actorId ?? 'admin-1',
          userIds: ['user-1'],
          mode: 'single',
        }),
      HardDeleteUsersBlockedError,
    )
    assert.equal(fake.getDeleteCount(), 0)
  }
})

test('actor authorization state is rechecked under the same row-lock transaction', async () => {
  for (const actorState of [
    { actorRole: 'user' as const },
    { actorBanned: true },
    { actorVerified: false },
  ]) {
    const fake = fakeTransaction({
      ...actorState,
      targets: [userRow('user-1')],
    })

    await assert.rejects(
      () =>
        hardDeleteUsersWithoutBusinessHistory(fake.tx, {
          actorId: 'admin-1',
          userIds: ['user-1'],
          mode: 'single',
        }),
      (error: unknown) => {
        assert.ok(error instanceof HardDeleteUsersBlockedError)
        assert.match(error.message, /管理员权限已发生变化/)
        return true
      },
    )
    assert.equal(fake.calls[0], 'lock-users')
    assert.equal(fake.getDeleteCount(), 0)
  }
})
