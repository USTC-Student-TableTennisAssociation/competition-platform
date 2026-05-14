import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/prisma'

type MatchBasicRow = {
  id: string
  type: string
  status: string
  registrationDeadline: Date
}

type TeamMemberRow = {
  teamId: string
  registeredAt: Date | null
  userId: string
  nickname: string
  avatarUrl: string | null
  slot: number
}

type InviteRow = {
  id: string
  matchId: string
  inviterId: string
  inviteeId: string
  status: string
  createdAt: Date
  inviterNickname: string
  inviteeNickname: string
  matchTitle: string
}

function isMissingInviteTableError(error: unknown) {
  const maybeError = error as {
    code?: string
    message?: string
    meta?: { code?: string; message?: string }
  }

  return (
    maybeError.code === 'P2010' &&
    maybeError.meta?.code === '42P01' &&
    (maybeError.meta?.message?.includes('match_doubles_invite') ??
      maybeError.message?.includes('match_doubles_invite') ??
      false)
  )
}

async function getMatchBasic(matchId: string) {
  const rows = await prisma.$queryRaw<MatchBasicRow[]>`
    SELECT id, type, status, "registrationDeadline"
    FROM "Match"
    WHERE id = ${matchId}
    LIMIT 1
  `
  return rows[0] ?? null
}

export async function assertDoublesMatchOpen(matchId: string) {
  const match = await getMatchBasic(matchId)
  if (!match) {
    return { ok: false as const, error: '比赛不存在。' }
  }
  if (match.type !== 'double') {
    return { ok: false as const, error: '该比赛不是双打比赛。' }
  }
  if (match.status !== 'registration') {
    return { ok: false as const, error: '当前比赛不在报名阶段。' }
  }
  if (new Date() >= new Date(match.registrationDeadline)) {
    return { ok: false as const, error: '报名已截止。' }
  }
  return { ok: true as const, match }
}

export async function getRegisteredDoublesTeamCount(matchId: string) {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count
    FROM match_doubles_team t
    WHERE t.match_id = ${matchId}
      AND t.registered_at IS NOT NULL
  `
  return Number(rows[0]?.count ?? 0)
}

export async function getPendingInviteCountForUser(userId: string) {
  try {
    const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM match_doubles_invite i
      JOIN "Match" m ON m.id = i.match_id
      WHERE i.invitee_id = ${userId}
        AND i.status = 'pending'
        AND m.status = 'registration'
        AND now() < m."registrationDeadline"
    `
    return Number(rows[0]?.count ?? 0)
  } catch (error) {
    if (isMissingInviteTableError(error)) {
      return 0
    }

    throw error
  }
}

export async function searchDoublesInviteCandidates(matchId: string, currentUserId: string, keyword: string) {
  const q = keyword.trim().toLowerCase()
  if (!q) return [] as Array<{ id: string; nickname: string; email: string }>

  return prisma.$queryRaw<Array<{ id: string; nickname: string; email: string }>>`
    SELECT u.id, u.nickname, u.email
    FROM "User" u
    WHERE u.id <> ${currentUserId}
      AND u."isBanned" = false
      AND (
        LOWER(u.nickname) LIKE ${`%${q}%`}
        OR LOWER(u.email) LIKE ${`%${q}%`}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "Registration" r
        WHERE r."matchId" = ${matchId}
          AND r."userId" = u.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM match_doubles_team_member tm
        WHERE tm.match_id = ${matchId}
          AND tm.user_id = u.id
      )
    ORDER BY u.nickname ASC
    LIMIT 20
  `
}

export async function getDoublesTeamForUser(matchId: string, userId: string) {
  const rows = await prisma.$queryRaw<TeamMemberRow[]>`
    SELECT
      t.id AS "teamId",
      t.registered_at AS "registeredAt",
      tm.user_id AS "userId",
      u.nickname,
      u."avatarUrl",
      tm.slot
    FROM match_doubles_team t
    JOIN match_doubles_team_member tm ON tm.team_id = t.id
    JOIN "User" u ON u.id = tm.user_id
    WHERE t.match_id = ${matchId}
      AND t.id IN (
        SELECT team_id
        FROM match_doubles_team_member
        WHERE match_id = ${matchId}
          AND user_id = ${userId}
        LIMIT 1
      )
    ORDER BY tm.slot ASC
  `

  if (rows.length !== 2) return null

  return {
    teamId: rows[0].teamId,
    registeredAt: rows[0].registeredAt,
    members: rows.map((row) => ({
      userId: row.userId,
      nickname: row.nickname,
      avatarUrl: row.avatarUrl,
      slot: row.slot,
    })),
  }
}

export async function getRegisteredDoublesTeams(matchId: string) {
  const rows = await prisma.$queryRaw<TeamMemberRow[]>`
    SELECT
      t.id AS "teamId",
      t.registered_at AS "registeredAt",
      tm.user_id AS "userId",
      u.nickname,
      u."avatarUrl",
      tm.slot
    FROM match_doubles_team t
    JOIN match_doubles_team_member tm ON tm.team_id = t.id
    JOIN "User" u ON u.id = tm.user_id
    WHERE t.match_id = ${matchId}
      AND t.registered_at IS NOT NULL
    ORDER BY t.created_at ASC, tm.slot ASC
  `

  const grouped = new Map<
    string,
    {
      teamId: string
      registeredAt: Date | null
      members: Array<{ userId: string; nickname: string; avatarUrl: string | null; slot: number }>
    }
  >()
  for (const row of rows) {
    if (!grouped.has(row.teamId)) {
      grouped.set(row.teamId, {
        teamId: row.teamId,
        registeredAt: row.registeredAt,
        members: [],
      })
    }
    grouped.get(row.teamId)!.members.push({
      userId: row.userId,
      nickname: row.nickname,
      avatarUrl: row.avatarUrl,
      slot: row.slot,
    })
  }

  return Array.from(grouped.values())
    .map((team) => ({
      ...team,
      members: [...team.members].sort((a, b) => a.slot - b.slot),
    }))
    .filter((team) => team.members.length === 2)
}

export async function sendDoublesInvite(params: { matchId: string; inviterId: string; inviteeId: string }) {
  const { matchId, inviterId, inviteeId } = params

  if (inviterId === inviteeId) {
    return { ok: false as const, error: '不能邀请自己组队。' }
  }

  const canInvite = await assertDoublesMatchOpen(matchId)
  if (!canInvite.ok) return canInvite

  const [invitee, inviterReg, inviteeReg, inviterTeam, inviteeTeam, existingPending] = await Promise.all([
    prisma.user.findUnique({ where: { id: inviteeId }, select: { id: true, isBanned: true } }),
    prisma.registration.findFirst({ where: { matchId, userId: inviterId }, select: { id: true } }),
    prisma.registration.findFirst({ where: { matchId, userId: inviteeId }, select: { id: true } }),
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT t.id
      FROM match_doubles_team t
      JOIN match_doubles_team_member tm ON tm.team_id = t.id
      WHERE t.match_id = ${matchId}
        AND tm.user_id = ${inviterId}
      LIMIT 1
    `,
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT t.id
      FROM match_doubles_team t
      JOIN match_doubles_team_member tm ON tm.team_id = t.id
      WHERE t.match_id = ${matchId}
        AND tm.user_id = ${inviteeId}
      LIMIT 1
    `,
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM match_doubles_invite
      WHERE match_id = ${matchId}
        AND status = 'pending'
        AND (
          (inviter_id = ${inviterId} AND invitee_id = ${inviteeId})
          OR (inviter_id = ${inviteeId} AND invitee_id = ${inviterId})
        )
      LIMIT 1
    `,
  ])

  if (!invitee || invitee.isBanned) return { ok: false as const, error: '邀请对象不可用。' }
  if (inviterReg || inviteeReg) return { ok: false as const, error: '有成员已报名该比赛，无法发起组队邀请。' }
  if (inviterTeam.length > 0 || inviteeTeam.length > 0) return { ok: false as const, error: '有成员已在小队中，无法重复组队。' }
  if (existingPending.length > 0) return { ok: false as const, error: '双方已有待处理邀请。' }

  await prisma.$executeRaw`
    INSERT INTO match_doubles_invite(id, match_id, inviter_id, invitee_id, status, created_at, updated_at)
    VALUES (${randomUUID()}, ${matchId}, ${inviterId}, ${inviteeId}, 'pending', now(), now())
  `

  return { ok: true as const }
}

export async function acceptDoublesInvite(params: { inviteId: string; currentUserId: string }) {
  const { inviteId, currentUserId } = params

  const inviteRows = await prisma.$queryRaw<Array<{ id: string; matchId: string; inviterId: string; inviteeId: string; status: string }>>`
    SELECT id, match_id AS "matchId", inviter_id AS "inviterId", invitee_id AS "inviteeId", status
    FROM match_doubles_invite
    WHERE id = ${inviteId}
    LIMIT 1
  `

  const invite = inviteRows[0]
  if (!invite) return { ok: false as const, error: '邀请不存在。' }
  if (invite.inviteeId !== currentUserId) return { ok: false as const, error: '仅被邀请者可接受。' }
  if (invite.status !== 'pending') return { ok: false as const, error: '该邀请已失效。' }

  const canAccept = await assertDoublesMatchOpen(invite.matchId)
  if (!canAccept.ok) return canAccept

  const memberA = invite.inviterId
  const memberB = invite.inviteeId

  const [regA, regB, teamA, teamB] = await Promise.all([
    prisma.registration.findFirst({ where: { matchId: invite.matchId, userId: memberA }, select: { id: true } }),
    prisma.registration.findFirst({ where: { matchId: invite.matchId, userId: memberB }, select: { id: true } }),
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT t.id
      FROM match_doubles_team t
      JOIN match_doubles_team_member tm ON tm.team_id = t.id
      WHERE t.match_id = ${invite.matchId}
        AND tm.user_id = ${memberA}
      LIMIT 1
    `,
    prisma.$queryRaw<Array<{ id: string }>>`
      SELECT t.id
      FROM match_doubles_team t
      JOIN match_doubles_team_member tm ON tm.team_id = t.id
      WHERE t.match_id = ${invite.matchId}
        AND tm.user_id = ${memberB}
      LIMIT 1
    `,
  ])

  if (regA || regB) return { ok: false as const, error: '有成员已报名，不能再接受组队邀请。' }
  if (teamA.length > 0 || teamB.length > 0) return { ok: false as const, error: '有成员已在其他小队中。' }

  await prisma.$transaction(async (tx) => {
    const teamId = randomUUID()
    await tx.$executeRaw`
      INSERT INTO match_doubles_team(id, match_id, created_by_id, created_at)
      VALUES (${teamId}, ${invite.matchId}, ${memberA}, now())
    `

    await tx.$executeRaw`
      INSERT INTO match_doubles_team_member(id, team_id, match_id, user_id, slot)
      VALUES
        (${randomUUID()}, ${teamId}, ${invite.matchId}, ${memberA}, 1),
        (${randomUUID()}, ${teamId}, ${invite.matchId}, ${memberB}, 2)
    `

    await tx.$executeRaw`
      UPDATE match_doubles_invite
      SET status = 'accepted', updated_at = now()
      WHERE id = ${invite.id}
    `

    await tx.$executeRaw`
      UPDATE match_doubles_invite
      SET status = 'voided', updated_at = now()
      WHERE match_id = ${invite.matchId}
        AND status = 'pending'
        AND id <> ${invite.id}
        AND (
          inviter_id IN (${memberA}, ${memberB})
          OR invitee_id IN (${memberA}, ${memberB})
        )
    `
  })

  return { ok: true as const }
}

export async function revokeDoublesInvite(params: { inviteId: string; currentUserId: string }) {
  const { inviteId, currentUserId } = params

  const updated = await prisma.$executeRaw`
    UPDATE match_doubles_invite
    SET status = 'revoked', updated_at = now()
    WHERE id = ${inviteId}
      AND inviter_id = ${currentUserId}
      AND status = 'pending'
  `

  if (updated === 0) return { ok: false as const, error: '邀请不存在或不可撤回。' }
  return { ok: true as const }
}

export async function registerDoublesTeamByUser(matchId: string, currentUserId: string) {
  const canRegister = await assertDoublesMatchOpen(matchId)
  if (!canRegister.ok) return canRegister

  const team = await getDoublesTeamForUser(matchId, currentUserId)
  if (!team) return { ok: false as const, error: '请先与队友完成组队。' }
  if (team.registeredAt) return { ok: false as const, error: '你们的小队已报名该比赛。' }

  const memberIds = team.members.map((member) => member.userId)

  const existingRegs = await prisma.registration.findMany({
    where: {
      matchId,
      userId: { in: memberIds },
    },
    select: { userId: true },
  })
  if (existingRegs.length > 0) {
    return { ok: false as const, error: '队伍中有成员已处于报名状态。' }
  }

  await prisma.$transaction(async (tx) => {
    await tx.registration.createMany({
      data: team.members.map((member) => ({
        matchId,
        userId: member.userId,
        role: member.slot === 1 ? 'captain' : 'substitute',
        status: 'registered',
      })),
      skipDuplicates: false,
    })

    await tx.$executeRaw`
      UPDATE match_doubles_team
      SET registered_at = now()
      WHERE id = ${team.teamId}
    `
  })

  return { ok: true as const, memberIds }
}

export async function unregisterDoublesTeamByUser(matchId: string, currentUserId: string) {
  const team = await getDoublesTeamForUser(matchId, currentUserId)
  if (!team || !team.registeredAt) {
    return { ok: false as const, error: '你当前没有已报名的小队。' }
  }

  const memberIds = team.members.map((member) => member.userId)

  await prisma.$transaction(async (tx) => {
    await tx.registration.deleteMany({
      where: {
        matchId,
        userId: { in: memberIds },
      },
    })

    await tx.$executeRaw`
      UPDATE match_doubles_team
      SET registered_at = NULL
      WHERE id = ${team.teamId}
    `
  })

  return { ok: true as const, memberIds }
}

export async function removeRegisteredDoublesTeamByMember(matchId: string, userId: string) {
  const team = await getDoublesTeamForUser(matchId, userId)
  if (!team || !team.registeredAt) {
    return { ok: false as const, error: '该选手所在双打小队未报名。' }
  }

  const memberIds = team.members.map((member) => member.userId)

  await prisma.$transaction(async (tx) => {
    await tx.registration.deleteMany({ where: { matchId, userId: { in: memberIds } } })
    await tx.$executeRaw`
      UPDATE match_doubles_team
      SET registered_at = NULL
      WHERE id = ${team.teamId}
    `
  })

  return { ok: true as const, memberIds }
}

export async function getInvitesForUser(currentUserId: string) {
  try {
    return await prisma.$queryRaw<InviteRow[]>`
      SELECT
        i.id,
        i.match_id AS "matchId",
        i.inviter_id AS "inviterId",
        i.invitee_id AS "inviteeId",
        i.status,
        i.created_at AS "createdAt",
        inviter.nickname AS "inviterNickname",
        invitee.nickname AS "inviteeNickname",
        m.title AS "matchTitle"
      FROM match_doubles_invite i
      JOIN "User" inviter ON inviter.id = i.inviter_id
      JOIN "User" invitee ON invitee.id = i.invitee_id
      JOIN "Match" m ON m.id = i.match_id
      WHERE i.inviter_id = ${currentUserId}
         OR i.invitee_id = ${currentUserId}
      ORDER BY i.created_at DESC
    `
  } catch (error) {
    if (isMissingInviteTableError(error)) {
      return []
    }
    throw error
  }
}

export async function getPendingMatchInvitesForUser(matchId: string, currentUserId: string) {
  try {
    return await prisma.$queryRaw<InviteRow[]>`
      SELECT
        i.id,
        i.match_id AS "matchId",
        i.inviter_id AS "inviterId",
        i.invitee_id AS "inviteeId",
        i.status,
        i.created_at AS "createdAt",
        inviter.nickname AS "inviterNickname",
        invitee.nickname AS "inviteeNickname",
        m.title AS "matchTitle"
      FROM match_doubles_invite i
      JOIN "User" inviter ON inviter.id = i.inviter_id
      JOIN "User" invitee ON invitee.id = i.invitee_id
      JOIN "Match" m ON m.id = i.match_id
      WHERE i.match_id = ${matchId}
        AND i.status = 'pending'
        AND (i.inviter_id = ${currentUserId} OR i.invitee_id = ${currentUserId})
      ORDER BY i.created_at DESC
    `
  } catch (error) {
    if (isMissingInviteTableError(error)) {
      return []
    }
    throw error
  }
}
