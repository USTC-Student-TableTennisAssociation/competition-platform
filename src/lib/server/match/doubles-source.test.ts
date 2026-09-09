import assert from 'node:assert/strict'
import test from 'node:test'
import type { Prisma } from '@prisma/client'

import {
  acceptDoublesInviteInTransaction,
  isRetryableDoublesSourceConflict,
  revokeDoublesInviteInTransaction,
  runDoublesSourceTransaction,
  sendDoublesInviteInTransaction,
} from './doubles-source'

type FakeInvite = {
  id: string
  matchId: string
  inviterId: string
  inviteeId: string
  status: string
}

function sqlText(query: Prisma.Sql) {
  return query.strings.join('?')
}

function createTransaction(options: {
  match?: {
    id: string
    type: string
    status: string
    registrationDeadline: Date
    isQuickMatch: boolean
    engineVersion: 'LEGACY' | 'V2'
  } | null
  invite?: FakeInvite | null
  users?: Array<{ id: string; isBanned?: boolean }>
  registration?: boolean
  existingTeam?: boolean
  existingPending?: boolean
  acceptedCount?: number
  revokedCount?: number
} = {}) {
  const calls: string[] = []
  const createdInvites: unknown[] = []
  const createdTeams: unknown[] = []
  const updates: Array<{ status: string; args: unknown }> = []
  const match = options.match === undefined
    ? {
        id: 'match-1',
        type: 'double',
        status: 'registration',
        registrationDeadline: new Date('2099-01-01T00:00:00.000Z'),
        isQuickMatch: false,
        engineVersion: 'V2' as const,
      }
    : options.match
  const invite = options.invite === undefined
    ? {
        id: 'invite-1',
        matchId: 'match-1',
        inviterId: 'user-a',
        inviteeId: 'user-b',
        status: 'pending',
      }
    : options.invite

  const tx = {
    $queryRaw: async (query: Prisma.Sql) => {
      const text = sqlText(query)
      if (text.includes('FROM "Match"')) {
        calls.push('lock-match')
        return match ? [match] : []
      }
      if (
        text.includes('FROM match_doubles_invite') &&
        text.includes('WHERE id =')
      ) {
        calls.push('lock-invite')
        return invite ? [invite] : []
      }
      if (text.includes('FROM match_doubles_invite')) {
        calls.push('lock-related-invites')
        return []
      }
      if (text.includes('FROM match_doubles_team t')) {
        calls.push('lock-teams')
        return []
      }
      if (text.includes('FROM match_doubles_team_member tm')) {
        calls.push('lock-team-members')
        return []
      }
      if (text.includes('FROM "User"')) {
        calls.push('lock-users')
        return []
      }
      throw new Error(`Unexpected lock query: ${text}`)
    },
    user: {
      findMany: async () => {
        calls.push('read-users')
        return options.users ?? [
          { id: 'user-a', isBanned: false },
          { id: 'user-b', isBanned: false },
        ]
      },
    },
    registration: {
      findFirst: async () => {
        calls.push('read-registrations')
        return options.registration ? { id: 'registration-1' } : null
      },
    },
    matchDoublesTeamMember: {
      findFirst: async () => {
        calls.push('read-team-membership')
        return options.existingTeam ? { id: 'membership-1' } : null
      },
    },
    matchDoublesInvite: {
      findUnique: async () => {
        calls.push('locate-invite')
        return invite ? { matchId: invite.matchId } : null
      },
      findFirst: async () => {
        calls.push('read-pending-pair')
        return options.existingPending ? { id: 'pending-1' } : null
      },
      create: async (args: unknown) => {
        calls.push('create-invite')
        createdInvites.push(args)
        return { id: 'created-invite' }
      },
      updateMany: async (args: { data: { status: string } }) => {
        calls.push(`update-invite-${args.data.status}`)
        updates.push({ status: args.data.status, args })
        if (args.data.status === 'accepted') {
          return { count: options.acceptedCount ?? 1 }
        }
        if (args.data.status === 'revoked') {
          return { count: options.revokedCount ?? 1 }
        }
        return { count: 1 }
      },
    },
    matchDoublesTeam: {
      create: async (args: unknown) => {
        calls.push('create-team')
        createdTeams.push(args)
        return { id: 'created-team' }
      },
    },
  } as unknown as Prisma.TransactionClient

  return { tx, calls, createdInvites, createdTeams, updates }
}

function assertBefore(calls: string[], first: string, second: string) {
  const firstIndex = calls.indexOf(first)
  const secondIndex = calls.indexOf(second)
  assert.notEqual(firstIndex, -1, `missing call: ${first}`)
  assert.notEqual(secondIndex, -1, `missing call: ${second}`)
  assert.ok(firstIndex < secondIndex, `${first} must precede ${second}`)
}

test('send locks Match, source rows and sorted Users before the authoritative checks and insert', async () => {
  const harness = createTransaction()

  const result = await sendDoublesInviteInTransaction(harness.tx, {
    matchId: 'match-1',
    inviterId: 'user-b',
    inviteeId: 'user-a',
    now: new Date('2026-09-04T00:00:00.000Z'),
  })

  assert.deepEqual(result, { ok: true })
  assert.equal(harness.createdInvites.length, 1)
  assertBefore(harness.calls, 'lock-match', 'lock-related-invites')
  assertBefore(harness.calls, 'lock-related-invites', 'lock-teams')
  assertBefore(harness.calls, 'lock-teams', 'lock-team-members')
  assertBefore(harness.calls, 'lock-team-members', 'lock-users')
  assertBefore(harness.calls, 'lock-users', 'read-users')
  assertBefore(harness.calls, 'read-pending-pair', 'create-invite')
})

test('send rechecks a bilateral pending invitation after locks and does not duplicate it', async () => {
  const harness = createTransaction({ existingPending: true })

  const result = await sendDoublesInviteInTransaction(harness.tx, {
    matchId: 'match-1',
    inviterId: 'user-a',
    inviteeId: 'user-b',
  })

  assert.deepEqual(result, { ok: false, error: '双方已有待处理邀请。' })
  assert.equal(harness.createdInvites.length, 0)
  assertBefore(harness.calls, 'lock-users', 'read-pending-pair')
})

test('accept uses the locked invitation state and never creates a team from a stale pending read', async () => {
  const harness = createTransaction({
    invite: {
      id: 'invite-1',
      matchId: 'match-1',
      inviterId: 'user-a',
      inviteeId: 'user-b',
      status: 'voided',
    },
  })

  const result = await acceptDoublesInviteInTransaction(harness.tx, {
    inviteId: 'invite-1',
    currentUserId: 'user-b',
  })

  assert.deepEqual(result, { ok: false, error: '该邀请已失效。' })
  assert.equal(harness.createdTeams.length, 0)
  assertBefore(harness.calls, 'locate-invite', 'lock-match')
  assertBefore(harness.calls, 'lock-match', 'lock-invite')
})

test('accept permits a V2 doubles source and checks membership after the canonical locks', async () => {
  const harness = createTransaction()

  const result = await acceptDoublesInviteInTransaction(harness.tx, {
    inviteId: 'invite-1',
    currentUserId: 'user-b',
    now: new Date('2026-09-04T00:00:00.000Z'),
  })

  assert.deepEqual(result, { ok: true })
  assert.equal(harness.createdTeams.length, 1)
  assertBefore(harness.calls, 'lock-match', 'lock-invite')
  assertBefore(harness.calls, 'lock-invite', 'lock-related-invites')
  assertBefore(harness.calls, 'lock-related-invites', 'lock-teams')
  assertBefore(harness.calls, 'lock-team-members', 'lock-users')
  assertBefore(harness.calls, 'lock-users', 'read-team-membership')
  assertBefore(harness.calls, 'read-team-membership', 'update-invite-accepted')
  assertBefore(harness.calls, 'update-invite-accepted', 'create-team')
  assertBefore(harness.calls, 'create-team', 'update-invite-voided')
})

test('accept refuses a member already placed in another team after locks', async () => {
  const harness = createTransaction({ existingTeam: true })

  const result = await acceptDoublesInviteInTransaction(harness.tx, {
    inviteId: 'invite-1',
    currentUserId: 'user-b',
  })

  assert.deepEqual(result, { ok: false, error: '有成员已在其他小队中。' })
  assert.equal(harness.createdTeams.length, 0)
  assert.equal(
    harness.updates.some((update) => update.status === 'accepted'),
    false,
  )
})

test('revoke remains available after registration closes or the match type changes', async () => {
  const harness = createTransaction({
    match: {
      id: 'match-1',
      type: 'single',
      status: 'finished',
      registrationDeadline: new Date('2020-01-01T00:00:00.000Z'),
      isQuickMatch: true,
      engineVersion: 'LEGACY',
    },
  })

  const result = await revokeDoublesInviteInTransaction(harness.tx, {
    inviteId: 'invite-1',
    currentUserId: 'user-a',
  })

  assert.deepEqual(result, { ok: true })
  assertBefore(harness.calls, 'lock-match', 'lock-invite')
  assertBefore(harness.calls, 'lock-invite', 'lock-users')
  assertBefore(harness.calls, 'lock-users', 'update-invite-revoked')
})

test('only serialization failures are classified as retryable source conflicts', () => {
  assert.equal(isRetryableDoublesSourceConflict({ code: 'P2034' }), true)
  assert.equal(isRetryableDoublesSourceConflict({ code: '40001' }), true)
  assert.equal(isRetryableDoublesSourceConflict({ code: '40P01' }), true)
  assert.equal(
    isRetryableDoublesSourceConflict({ code: 'P2010', meta: { code: '40001' } }),
    true,
  )
  assert.equal(
    isRetryableDoublesSourceConflict({ code: 'P2010', meta: { code: '40P01' } }),
    true,
  )
  assert.equal(isRetryableDoublesSourceConflict({ code: 'P2002' }), false)
  assert.equal(isRetryableDoublesSourceConflict(new Error('database unavailable')), false)
})

test('the source wrapper uses Serializable and maps only its retryable conflict', async () => {
  let isolationLevel: unknown
  const retryableDatabase = {
    $transaction: async (
      _operation: unknown,
      options: { isolationLevel?: unknown },
    ) => {
      isolationLevel = options.isolationLevel
      throw { code: 'P2034' }
    },
  }

  const retryable = await runDoublesSourceTransaction(
    retryableDatabase as never,
    async () => ({ ok: true }),
  )
  assert.equal(isolationLevel, 'Serializable')
  assert.deepEqual(retryable, {
    ok: false,
    error: '数据已发生变化，请重试。',
  })

  const fatal = new Error('database unavailable')
  const fatalDatabase = {
    $transaction: async () => {
      throw fatal
    },
  }
  await assert.rejects(
    () =>
      runDoublesSourceTransaction(
        fatalDatabase as never,
        async () => ({ ok: true }),
      ),
    (error) => error === fatal,
  )
})
