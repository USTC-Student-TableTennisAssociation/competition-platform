import assert from 'node:assert/strict'
import test from 'node:test'
import type { MatchEngineVersion, Prisma } from '@prisma/client'

import { setUserBanState, setUsersBanState } from './ban-user'

type Target = {
  id: string
  nickname: string
  email: string
  role: 'admin' | 'user'
  isBanned: boolean
}

function target(
  id: string,
  overrides: Partial<Target> = {},
): Target {
  return {
    id,
    nickname: id,
    email: `${id}@example.test`,
    role: 'user',
    isBanned: false,
    ...overrides,
  }
}

function fakeTransaction(options: {
  actorRole?: 'admin' | 'user' | null
  actorBanned?: boolean
  actorVerified?: boolean
  targets: Target[]
  participantMatches?: Array<{ id: string; engineVersion: MatchEngineVersion }>
  v2ParticipantMatches?: Array<{ id: string; engineVersion: MatchEngineVersion }>
  v2HistoricalMatches?: Array<{ id: string; engineVersion: MatchEngineVersion }>
  v2EntryIds?: string[]
  v2RosterUserIds?: string[]
  v2FixtureRosterUserIds?: string[]
  v2FixtureIds?: string[]
  v2RevisionIds?: string[]
  inviteMatches?: Array<{ id: string; engineVersion: MatchEngineVersion }>
  doublesMemberIds?: string[]
  doublesCreatorId?: string
  teamCaptainId?: string
  teamMemberIds?: string[]
}) {
  const calls: string[] = []
  const lockQueries: Prisma.Sql[] = []
  let userWrites = 0
  let audits = 0
  let inviteWrites = 0
  const matchEngines = new Map(
    [
      ...(options.participantMatches ?? []),
      ...(options.v2ParticipantMatches ?? []),
      ...(options.v2HistoricalMatches ?? []),
      ...(options.inviteMatches ?? []),
    ]
      .map((match) => [match.id, match.engineVersion]),
  )

  const tx = {
    $queryRaw: async (query: Prisma.Sql) => {
      lockQueries.push(query)
      const sql = query.strings.join('?')
      if (sql.includes('FROM "Match"')) {
        const matchId = String(query.values[0])
        calls.push(`lock-match:${matchId}`)
        return [{
          id: matchId,
          engineVersion: matchEngines.get(matchId) ?? 'LEGACY',
          isQuickMatch: false,
        }]
      }
      if (sql.includes('FROM "match_entry"')) {
        calls.push('lock-v2-entries')
        return query.values.map((id) => ({ id }))
      }
      if (sql.includes('FROM "match_entry_member"')) {
        calls.push('lock-v2-members')
        return query.values.map((id) => ({ id }))
      }
      if (sql.includes('FROM "match_fixture"')) {
        calls.push('lock-v2-fixtures')
        return query.values.map((id) => ({ id }))
      }
      if (sql.includes('FROM "result_revision"')) {
        calls.push('lock-v2-revisions')
        return query.values.map((id) => ({ id }))
      }
      calls.push('lock-users')
      return query.values.map((id) => ({ id }))
    },
    match: {
      findMany: async (args: {
        where: { engineVersion?: string; fixtures?: unknown; doublesInvites?: unknown }
        select: { engineVersion?: boolean; title?: boolean }
      }) => {
        if (args.select.title) {
          calls.push('read-target-matches')
          return []
        }
        if (args.where.doublesInvites) {
          calls.push('discover-invite-matches')
          return options.inviteMatches ?? []
        }
        if (args.where.engineVersion === 'LEGACY') {
          calls.push('discover-participant-matches')
          return options.participantMatches ?? []
        }
        if (args.where.engineVersion === 'V2') {
          if (args.where.fixtures) {
            calls.push('discover-v2-historical-matches')
            return (options.v2HistoricalMatches ?? []).map((match) => ({
              ...match,
              type: 'single',
              format: 'group_only',
            }))
          }
          calls.push('discover-v2-participant-matches')
          return (options.v2ParticipantMatches ?? []).map((match) => ({
            ...match,
            type: 'single',
            format: 'group_only',
          }))
        }
        calls.push('discover-invite-matches')
        return options.inviteMatches ?? []
      },
    },
    matchEntry: {
      findMany: async (args: { select?: { matchId?: boolean; kind?: boolean }; where?: { id?: { in?: string[] } } }) => {
        calls.push('read-v2-entries')
        if (args.select?.kind) {
          return (args.where?.id?.in ?? []).map((id) => ({
            id,
            kind: 'INDIVIDUAL',
            status: 'ACTIVE',
          }))
        }
        return (options.v2EntryIds ?? []).map((id) => ({
          id,
          matchId: options.v2ParticipantMatches?.[0]?.id ?? 'v2-match',
        }))
      },
    },
    matchEntryMember: {
      findMany: async (args: { select?: { role?: boolean }; where?: { OR?: Array<{ entryId?: string }> } }) => {
        calls.push('read-v2-roster-users')
        if (args.select?.role) {
          const targetId = options.targets[0]?.id ?? 'target-user'
          const opponentId = (options.v2FixtureRosterUserIds ?? options.v2RosterUserIds ?? [])
            .find((userId) => userId !== targetId) ?? 'fixture-opponent'
          const entryIds = (args.where?.OR ?? [])
            .map((clause) => clause.entryId)
            .filter((entryId): entryId is string => Boolean(entryId))
          return entryIds.map((entryId, index) => ({
            entryId,
            rosterVersion: 1,
            userId: index === 0 ? targetId : opponentId,
            role: 'player',
          }))
        }
        return (options.v2RosterUserIds ?? []).map((userId) => ({ userId }))
      },
    },
    matchFixture: {
      findMany: async (args: { where?: { AND?: unknown } }) => {
        calls.push('read-v2-fixtures')
        if (args.where?.AND) return []
        return (options.v2FixtureIds ?? []).map((id) => ({
          id,
          matchId: options.v2ParticipantMatches?.[0]?.id ?? 'v2-match',
          status: 'SCHEDULED',
          sideAEntryId: options.v2EntryIds?.[0] ?? 'v2-entry',
          sideBEntryId: `${id}-opponent-entry`,
          sideARosterVersion: 1,
          sideBRosterVersion: 1,
        }))
      },
    },
    matchFixtureLineupMember: {
      findMany: async () => {
        calls.push('read-v2-fixture-roster-users')
        return (options.v2FixtureRosterUserIds ?? []).map((userId) => ({
          entryMember: { userId },
        }))
      },
    },
    resultRevision: {
      findMany: async () => {
        calls.push('read-v2-revisions')
        return (options.v2RevisionIds ?? []).map((id) => ({
          id,
          fixtureId: options.v2FixtureIds?.[0] ?? 'v2-fixture',
        }))
      },
    },
    matchDoublesTeam: {
      findMany: async () => {
        calls.push('discover-related-doubles-users')
        return options.doublesMemberIds?.length
          ? [{
              createdById:
                options.doublesCreatorId ?? options.doublesMemberIds[0] ?? 'user-z',
              members: options.doublesMemberIds.map((userId) => ({ userId })),
            }]
          : []
      },
    },
    matchTeam: {
      findMany: async () => {
        calls.push('discover-related-team-users')
        return options.teamCaptainId
          ? [{
              captainId: options.teamCaptainId,
              members: (options.teamMemberIds ?? []).map((userId) => ({ userId })),
            }]
          : []
      },
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
        return options.targets
      },
      update: async () => {
        calls.push('write-user')
        userWrites += 1
        return { id: 'updated-user' }
      },
    },
    matchDoublesInvite: {
      updateMany: async () => {
        calls.push('write-invites')
        inviteWrites += 1
        return { count: 0 }
      },
    },
    auditLog: {
      create: async () => {
        calls.push('write-audit')
        audits += 1
        return { id: 'audit-1' }
      },
    },
  } as unknown as Prisma.TransactionClient

  return {
    tx,
    calls,
    lockQueries,
    getWrites: () => ({ userWrites, audits, inviteWrites }),
  }
}

test('ban scope locks every Match before the sorted actor, targets and related users', async () => {
  const fake = fakeTransaction({
    targets: [
      target('user-z', { isBanned: true }),
      target('user-a', { isBanned: true }),
    ],
    participantMatches: [
      { id: 'match-z', engineVersion: 'LEGACY' },
      { id: 'match-a', engineVersion: 'LEGACY' },
    ],
    inviteMatches: [{ id: 'match-m', engineVersion: 'V2' }],
    doublesMemberIds: ['partner-y'],
    doublesCreatorId: 'doubles-creator-c',
    teamCaptainId: 'captain-b',
    teamMemberIds: ['member-x'],
  })

  await setUsersBanState(fake.tx, {
    actorId: 'admin-1',
    userIds: ['user-z', 'user-a'],
    banned: true,
  })

  assert.deepEqual(fake.calls.slice(4, 9), [
    'lock-match:match-a',
    'lock-match:match-m',
    'lock-match:match-z',
    'discover-related-doubles-users',
    'discover-related-team-users',
  ])
  const userLock = fake.lockQueries.find((query) =>
    query.strings.join('?').includes('FROM "User"'),
  )
  assert.deepEqual(userLock?.values, [
    'admin-1',
    'captain-b',
    'doubles-creator-c',
    'member-x',
    'partner-y',
    'user-a',
    'user-z',
  ])
  assert.ok(fake.calls.lastIndexOf('lock-match:match-z') < fake.calls.indexOf('lock-users'))
  assert.ok(fake.calls.indexOf('lock-users') < fake.calls.indexOf('read-actor'))
  assert.ok(fake.calls.indexOf('read-targets') < fake.calls.indexOf('write-user'))
})

test('actor role, ban state and verification are rechecked after row locks', async () => {
  for (const actorState of [
    { actorRole: 'user' as const },
    { actorBanned: true },
    { actorVerified: false },
  ]) {
    const fake = fakeTransaction({
      ...actorState,
      targets: [target('user-1')],
    })

    await assert.rejects(
      () =>
        setUserBanState(fake.tx, {
          actorId: 'admin-1',
          userId: 'user-1',
          banned: true,
        }),
      /管理员权限已发生变化/,
    )
    assert.deepEqual(fake.getWrites(), {
      userWrites: 0,
      audits: 0,
      inviteWrites: 0,
    })
    assert.ok(fake.calls.indexOf('lock-users') < fake.calls.indexOf('read-actor'))
  }
})

test('V2 ban scope locks Entry, member, Fixture and active Revision before every roster User', async () => {
  const fake = fakeTransaction({
    actorRole: 'user',
    targets: [target('target-user')],
    v2ParticipantMatches: [{ id: 'v2-match', engineVersion: 'V2' }],
    v2EntryIds: ['v2-entry'],
    v2RosterUserIds: ['historical-roster-user', 'target-user'],
    v2FixtureIds: ['v2-fixture'],
    v2RevisionIds: ['v2-revision'],
  })

  await assert.rejects(
    () =>
      setUserBanState(fake.tx, {
        actorId: 'admin-1',
        userId: 'target-user',
        banned: true,
      }),
    /管理员权限已发生变化/,
  )

  const orderedLocks = fake.calls.filter((call) =>
    call.startsWith('lock-'),
  )
  assert.deepEqual(orderedLocks, [
    'lock-match:v2-match',
    'lock-v2-entries',
    'lock-v2-members',
    'lock-v2-fixtures',
    'lock-v2-revisions',
    'lock-users',
  ])
  const userLock = fake.lockQueries.find((query) =>
    query.strings.join('?').includes('FROM "User"'),
  )
  assert.deepEqual(userLock?.values, [
    'admin-1',
    'historical-roster-user',
    'target-user',
  ])
  assert.deepEqual(fake.getWrites(), {
    userWrites: 0,
    audits: 0,
    inviteWrites: 0,
  })
})

test('bulk ban rejects the whole batch when a locked target was promoted', async () => {
  const fake = fakeTransaction({
    targets: [target('ordinary-user'), target('promoted-user', { role: 'admin' })],
  })

  await assert.rejects(
    () =>
      setUsersBanState(fake.tx, {
        actorId: 'admin-1',
        userIds: ['ordinary-user', 'promoted-user'],
        banned: true,
      }),
    /不允许封禁管理员账号/,
  )
  assert.deepEqual(fake.getWrites(), {
    userWrites: 0,
    audits: 0,
    inviteWrites: 0,
  })
})

test('self-ban is rejected but a previously banned admin may be unbanned', async () => {
  const self = fakeTransaction({
    targets: [target('admin-1', { role: 'admin' })],
  })
  await assert.rejects(
    () =>
      setUserBanState(self.tx, {
        actorId: 'admin-1',
        userId: 'admin-1',
        banned: true,
      }),
    /不能封禁当前管理员自己/,
  )
  assert.equal(self.getWrites().userWrites, 0)

  const unban = fakeTransaction({
    targets: [target('admin-2', { role: 'admin', isBanned: true })],
  })
  const result = await setUserBanState(unban.tx, {
    actorId: 'admin-1',
    userId: 'admin-2',
    banned: false,
  })
  assert.deepEqual(result, {
    userId: 'admin-2',
    banned: false,
    removedMatches: [],
    v2Disqualifications: [],
    v2CorrectionCleanups: [],
    notificationOutboxId: null,
  })
  assert.deepEqual(unban.getWrites(), {
    userWrites: 1,
    audits: 1,
    inviteWrites: 0,
  })
})
