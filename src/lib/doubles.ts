import { prisma } from '@/lib/prisma'
import {
  acceptDoublesInviteInTransaction,
  revokeDoublesInviteInTransaction,
  runDoublesSourceTransaction,
  sendDoublesInviteInTransaction,
} from '@/lib/server/match/doubles-source'

type MatchBasicRow = {
  id: string
  type: string
  status: string
  registrationDeadline: Date
  isQuickMatch: boolean
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
    SELECT id, type, status, "registrationDeadline", "isQuickMatch"
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
  if (match.isQuickMatch) {
    return { ok: false as const, error: '快速约球不支持双打组队。' }
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
      AND NOT EXISTS (
        SELECT 1
        FROM match_doubles_team_member tm
        JOIN "User" u ON u.id = tm.user_id
        WHERE tm.team_id = t.id
          AND u."isBanned" = true
      )
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
      AND NOT EXISTS (
        SELECT 1
        FROM match_doubles_team_member active_tm
        JOIN "User" active_user ON active_user.id = active_tm.user_id
        WHERE active_tm.team_id = t.id
          AND active_user."isBanned" = true
      )
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
      AND NOT EXISTS (
        SELECT 1
        FROM match_doubles_team_member active_tm
        JOIN "User" active_user ON active_user.id = active_tm.user_id
        WHERE active_tm.team_id = t.id
          AND active_user."isBanned" = true
      )
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
  return runDoublesSourceTransaction(prisma, (tx) =>
    sendDoublesInviteInTransaction(tx, params),
  )
}

export async function acceptDoublesInvite(params: { inviteId: string; currentUserId: string }) {
  return runDoublesSourceTransaction(prisma, (tx) =>
    acceptDoublesInviteInTransaction(tx, params),
  )
}

export async function revokeDoublesInvite(params: { inviteId: string; currentUserId: string }) {
  return runDoublesSourceTransaction(prisma, (tx) =>
    revokeDoublesInviteInTransaction(tx, params),
  )
}

export async function registerDoublesTeamByUser(matchId: string, currentUserId: string) {
  const canRegister = await assertDoublesMatchOpen(matchId)
  if (!canRegister.ok) return canRegister

  const team = await getDoublesTeamForUser(matchId, currentUserId)
  if (!team) return { ok: false as const, error: '请先与队友完成组队。' }
  if (team.registeredAt) return { ok: false as const, error: '你们的小队已报名该比赛。' }

  const memberIds = team.members.map((member) => member.userId)

  const activeMemberCount = await prisma.user.count({
    where: { id: { in: memberIds }, isBanned: false },
  })
  if (activeMemberCount !== memberIds.length) {
    return { ok: false as const, error: '队伍中存在已封禁用户，无法报名。' }
  }

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
