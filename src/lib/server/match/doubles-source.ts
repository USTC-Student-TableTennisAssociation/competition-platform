import { randomUUID } from 'node:crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import { lockUsersForUpdate } from '../user/lock-users'

type DoublesSourceTransaction = Prisma.TransactionClient

type LockedDoublesMatch = {
  id: string
  type: string
  status: string
  registrationDeadline: Date
  isQuickMatch: boolean
  engineVersion: 'LEGACY' | 'V2'
}

type LockedDoublesInvite = {
  id: string
  matchId: string
  inviterId: string
  inviteeId: string
  status: string
}

export type DoublesSourceCommandResult =
  | { ok: true }
  | { ok: false; error: string }

export function isRetryableDoublesSourceConflict(error: unknown) {
  const candidate = error as {
    code?: string
    meta?: { code?: string }
  }
  return (
    candidate.code === 'P2034' ||
    candidate.code === '40001' ||
    candidate.code === '40P01' ||
    candidate.meta?.code === '40001' ||
    candidate.meta?.code === '40P01'
  )
}

export async function runDoublesSourceTransaction(
  database: Pick<PrismaClient, '$transaction'>,
  operation: (
    tx: Prisma.TransactionClient,
  ) => Promise<DoublesSourceCommandResult>,
) {
  try {
    return await database.$transaction(operation, {
      isolationLevel: 'Serializable',
    })
  } catch (error) {
    if (isRetryableDoublesSourceConflict(error)) {
      return { ok: false as const, error: '数据已发生变化，请重试。' }
    }
    throw error
  }
}

async function lockDoublesMatch(
  tx: DoublesSourceTransaction,
  matchId: string,
): Promise<LockedDoublesMatch | null> {
  const rows = await tx.$queryRaw<LockedDoublesMatch[]>(Prisma.sql`
    SELECT
      id,
      type,
      status,
      "registrationDeadline",
      "isQuickMatch",
      engine_version AS "engineVersion"
    FROM "Match"
    WHERE id = ${matchId}
    FOR UPDATE
  `)

  return rows[0] ?? null
}

function validateFormalDoublesMatch(match: LockedDoublesMatch | null) {
  if (!match) return { ok: false as const, error: '比赛不存在。' }
  if (match.engineVersion !== 'V2') {
    return { ok: false as const, error: '历史比赛已归档，不能修改组队。' }
  }
  if (match.type !== 'double') {
    return { ok: false as const, error: '该比赛不是双打比赛。' }
  }
  if (match.isQuickMatch) {
    return { ok: false as const, error: '快速约球不支持双打组队。' }
  }
  return { ok: true as const, match }
}

function validateRegistrationWindow(
  match: LockedDoublesMatch,
  now: Date,
) {
  if (match.status !== 'registration') {
    return { ok: false as const, error: '当前比赛不在报名阶段。' }
  }
  if (now >= new Date(match.registrationDeadline)) {
    return { ok: false as const, error: '报名已截止。' }
  }
  return { ok: true as const }
}

async function findInviteMatchId(
  tx: DoublesSourceTransaction,
  inviteId: string,
) {
  const invite = await tx.matchDoublesInvite.findUnique({
    where: { id: inviteId },
    select: { matchId: true },
  })
  return invite?.matchId ?? null
}

async function lockDoublesInvite(
  tx: DoublesSourceTransaction,
  inviteId: string,
  matchId: string,
): Promise<LockedDoublesInvite | null> {
  const rows = await tx.$queryRaw<LockedDoublesInvite[]>(Prisma.sql`
    SELECT
      id,
      match_id AS "matchId",
      inviter_id AS "inviterId",
      invitee_id AS "inviteeId",
      status
    FROM match_doubles_invite
    WHERE id = ${inviteId}
      AND match_id = ${matchId}
    FOR UPDATE
  `)

  return rows[0] ?? null
}

/**
 * Locks existing source rows before user rows. The Match lock is the range
 * mutex for absent rows: every source-building writer for one match takes it
 * before checking for a missing invitation or membership and inserting one.
 */
async function lockRelatedDoublesSourceRows(
  tx: DoublesSourceTransaction,
  matchId: string,
  userIds: readonly string[],
) {
  const sortedUserIds = [...new Set(userIds)].sort()
  if (sortedUserIds.length === 0) return

  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM match_doubles_invite
    WHERE match_id = ${matchId}
      AND status = 'pending'
      AND (
        inviter_id IN (${Prisma.join(sortedUserIds)})
        OR invitee_id IN (${Prisma.join(sortedUserIds)})
      )
    ORDER BY id
    FOR UPDATE
  `)

  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT t.id
    FROM match_doubles_team t
    WHERE t.match_id = ${matchId}
      AND EXISTS (
        SELECT 1
        FROM match_doubles_team_member tm
        WHERE tm.team_id = t.id
          AND tm.user_id IN (${Prisma.join(sortedUserIds)})
      )
    ORDER BY t.id
    FOR UPDATE
  `)

  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT tm.id
    FROM match_doubles_team_member tm
    WHERE tm.match_id = ${matchId}
      AND tm.user_id IN (${Prisma.join(sortedUserIds)})
    ORDER BY tm.id
    FOR UPDATE
  `)
}

export async function sendDoublesInviteInTransaction(
  tx: DoublesSourceTransaction,
  params: {
    matchId: string
    inviterId: string
    inviteeId: string
    now?: Date
  },
): Promise<DoublesSourceCommandResult> {
  const { matchId, inviterId, inviteeId } = params
  if (inviterId === inviteeId) {
    return { ok: false, error: '不能邀请自己组队。' }
  }

  const match = await lockDoublesMatch(tx, matchId)
  const formalDoubles = validateFormalDoublesMatch(match)
  if (!formalDoubles.ok) return formalDoubles

  const openWindow = validateRegistrationWindow(
    formalDoubles.match,
    params.now ?? new Date(),
  )
  if (!openWindow.ok) return openWindow

  const memberIds = [inviterId, inviteeId]
  await lockRelatedDoublesSourceRows(tx, matchId, memberIds)
  await lockUsersForUpdate(tx, memberIds)

  const members = await tx.user.findMany({
    where: { id: { in: memberIds } },
    select: { id: true, isBanned: true },
  })
  const memberById = new Map(members.map((member) => [member.id, member]))
  const inviter = memberById.get(inviterId)
  const invitee = memberById.get(inviteeId)

  if (!inviter || inviter.isBanned) {
    return { ok: false, error: '当前账号不可发起邀请。' }
  }
  if (!invitee || invitee.isBanned) {
    return { ok: false, error: '邀请对象不可用。' }
  }

  const registration = await tx.registration.findFirst({
    where: { matchId, userId: { in: memberIds } },
    select: { id: true },
  })
  if (registration) {
    return { ok: false, error: '有成员已报名该比赛，无法发起组队邀请。' }
  }

  const existingTeam = await tx.matchDoublesTeamMember.findFirst({
    where: { matchId, userId: { in: memberIds } },
    select: { id: true },
  })
  if (existingTeam) {
    return { ok: false, error: '有成员已在小队中，无法重复组队。' }
  }

  const existingPending = await tx.matchDoublesInvite.findFirst({
    where: {
      matchId,
      status: 'pending',
      OR: [
        { inviterId, inviteeId },
        { inviterId: inviteeId, inviteeId: inviterId },
      ],
    },
    select: { id: true },
  })
  if (existingPending) {
    return { ok: false, error: '双方已有待处理邀请。' }
  }

  await tx.matchDoublesInvite.create({
    data: {
      id: randomUUID(),
      matchId,
      inviterId,
      inviteeId,
      status: 'pending',
    },
  })

  return { ok: true }
}

export async function acceptDoublesInviteInTransaction(
  tx: DoublesSourceTransaction,
  params: {
    inviteId: string
    currentUserId: string
    now?: Date
  },
): Promise<DoublesSourceCommandResult> {
  const { inviteId, currentUserId } = params

  // This first read only discovers the Match lock key. All authorization and
  // state decisions use the locked invitation below.
  const matchId = await findInviteMatchId(tx, inviteId)
  if (!matchId) return { ok: false, error: '邀请不存在。' }

  const match = await lockDoublesMatch(tx, matchId)
  if (!match) return { ok: false, error: '比赛不存在。' }

  const invite = await lockDoublesInvite(tx, inviteId, matchId)
  if (!invite) return { ok: false, error: '邀请不存在。' }
  if (invite.inviteeId !== currentUserId) {
    return { ok: false, error: '仅被邀请者可接受。' }
  }
  if (invite.status !== 'pending') {
    return { ok: false, error: '该邀请已失效。' }
  }

  const formalDoubles = validateFormalDoublesMatch(match)
  if (!formalDoubles.ok) return formalDoubles

  const openWindow = validateRegistrationWindow(
    formalDoubles.match,
    params.now ?? new Date(),
  )
  if (!openWindow.ok) return openWindow

  const memberIds = [invite.inviterId, invite.inviteeId]
  await lockRelatedDoublesSourceRows(tx, matchId, memberIds)
  await lockUsersForUpdate(tx, memberIds)

  const members = await tx.user.findMany({
    where: { id: { in: memberIds }, isBanned: false },
    select: { id: true },
  })
  if (members.length !== 2) {
    return { ok: false, error: '邀请双方中存在已封禁用户。' }
  }

  const registration = await tx.registration.findFirst({
    where: { matchId, userId: { in: memberIds } },
    select: { id: true },
  })
  if (registration) {
    return { ok: false, error: '有成员已报名，不能再接受组队邀请。' }
  }

  const existingTeam = await tx.matchDoublesTeamMember.findFirst({
    where: { matchId, userId: { in: memberIds } },
    select: { id: true },
  })
  if (existingTeam) {
    return { ok: false, error: '有成员已在其他小队中。' }
  }

  const accepted = await tx.matchDoublesInvite.updateMany({
    where: { id: invite.id, matchId, status: 'pending' },
    data: { status: 'accepted', updatedAt: new Date() },
  })
  if (accepted.count !== 1) {
    return { ok: false, error: '该邀请已失效。' }
  }

  const teamId = randomUUID()
  await tx.matchDoublesTeam.create({
    data: {
      id: teamId,
      matchId,
      createdById: invite.inviterId,
      members: {
        create: [
          {
            id: randomUUID(),
            userId: invite.inviterId,
            slot: 1,
          },
          {
            id: randomUUID(),
            userId: invite.inviteeId,
            slot: 2,
          },
        ],
      },
    },
  })

  await tx.matchDoublesInvite.updateMany({
    where: {
      matchId,
      status: 'pending',
      id: { not: invite.id },
      OR: [
        { inviterId: { in: memberIds } },
        { inviteeId: { in: memberIds } },
      ],
    },
    data: { status: 'voided', updatedAt: new Date() },
  })

  return { ok: true }
}

export async function revokeDoublesInviteInTransaction(
  tx: DoublesSourceTransaction,
  params: { inviteId: string; currentUserId: string },
): Promise<DoublesSourceCommandResult> {
  const { inviteId, currentUserId } = params

  const matchId = await findInviteMatchId(tx, inviteId)
  if (!matchId) {
    return { ok: false, error: '邀请不存在或不可撤回。' }
  }

  const match = await lockDoublesMatch(tx, matchId)
  if (!match) {
    return { ok: false, error: '邀请不存在或不可撤回。' }
  }

  // Revocation intentionally does not validate the current Match type, quick
  // flag, status, or deadline. Historically a sender could clean up any of
  // their still-pending invitations, including after an organizer changed the
  // match type or registration closed.
  const invite = await lockDoublesInvite(tx, inviteId, matchId)
  if (
    !invite ||
    invite.inviterId !== currentUserId ||
    invite.status !== 'pending'
  ) {
    return { ok: false, error: '邀请不存在或不可撤回。' }
  }

  await lockUsersForUpdate(tx, [invite.inviterId, invite.inviteeId])
  const updated = await tx.matchDoublesInvite.updateMany({
    where: {
      id: inviteId,
      matchId,
      inviterId: currentUserId,
      status: 'pending',
    },
    data: { status: 'revoked', updatedAt: new Date() },
  })

  if (updated.count !== 1) {
    return { ok: false, error: '邀请不存在或不可撤回。' }
  }
  return { ok: true }
}
