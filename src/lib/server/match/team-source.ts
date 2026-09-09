import {
  MatchEngineVersion,
  MatchStatus,
  MatchType,
  Prisma,
  type PrismaClient,
} from '@prisma/client'

export type TeamSourceDatabase = Pick<PrismaClient, '$transaction'>

export type LockedTeamSourceMatch = {
  id: string
  title: string
  type: MatchType
  status: MatchStatus
  engineVersion: MatchEngineVersion
  isQuickMatch: boolean
  createdAt: Date
  registrationDeadline: Date
  teamRegistrationStart: Date | null
  teamRegistrationDeadline: Date | null
  teamMinMembers: number | null
  teamMaxMembers: number | null
}

export type LockedTeamSourceMember = {
  id: string
  teamId: string
  userId: string
}

export type TeamSourceMatchResult =
  | { ok: true; match: LockedTeamSourceMatch }
  | { ok: false; error: string }

export const TEAM_SOURCE_CHANGED_MESSAGE = '团体报名状态已发生变化，请刷新后重试。'
export const TEAM_SOURCE_ENTRY_EXISTS_MESSAGE =
  '该队伍已生成新版比赛报名身份，当前入口不能再修改，请刷新后重试。'

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values.filter(Boolean))].sort()
}

export function isRetryableTeamSourceConflict(error: unknown) {
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

/**
 * Match is the range mutex for all team-source writers, including creation
 * where no MatchTeam or MatchTeamMember row exists yet.
 */
export async function lockTeamSourceMatch(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  matchId: string,
): Promise<TeamSourceMatchResult> {
  const rows = await tx.$queryRaw<LockedTeamSourceMatch[]>(Prisma.sql`
    SELECT
      id,
      title,
      type,
      status,
      engine_version AS "engineVersion",
      "isQuickMatch",
      "createdAt",
      "registrationDeadline",
      "teamRegistrationStart",
      "teamRegistrationDeadline",
      "teamMinMembers",
      "teamMaxMembers"
    FROM "Match"
    WHERE id = ${matchId}
    FOR UPDATE
  `)

  const match = rows[0]
  if (!match) return { ok: false, error: '比赛不存在。' }
  if (match.engineVersion !== MatchEngineVersion.V2) {
    return { ok: false, error: '历史比赛已归档，不能修改报名。' }
  }
  if (match.type !== MatchType.team) {
    return { ok: false, error: '该比赛不是团体赛。' }
  }
  if (match.isQuickMatch) {
    return { ok: false, error: '快速约球不支持团体报名。' }
  }
  return { ok: true, match }
}

/**
 * Locks every explicitly addressed team plus any team containing one of the
 * addressed users. Member rows are locked only after all Team rows, and both
 * sets are ordered so every source writer follows the same protocol.
 */
export async function lockTeamSourceRows(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  input: {
    matchId: string
    teamIds?: readonly string[]
    userIds?: readonly string[]
  },
) {
  const teamIds = uniqueSorted(input.teamIds ?? [])
  const userIds = uniqueSorted(input.userIds ?? [])
  if (teamIds.length === 0 && userIds.length === 0) {
    return { teamIds: [] as string[], members: [] as LockedTeamSourceMember[] }
  }

  const predicate =
    teamIds.length > 0 && userIds.length > 0
      ? Prisma.sql`
          t.id IN (${Prisma.join(teamIds)})
          OR EXISTS (
            SELECT 1
            FROM match_team_member own_member
            WHERE own_member.team_id = t.id
              AND own_member.match_id = ${input.matchId}
              AND own_member.user_id IN (${Prisma.join(userIds)})
          )
        `
      : teamIds.length > 0
        ? Prisma.sql`t.id IN (${Prisma.join(teamIds)})`
        : Prisma.sql`
            EXISTS (
              SELECT 1
              FROM match_team_member own_member
              WHERE own_member.team_id = t.id
                AND own_member.match_id = ${input.matchId}
                AND own_member.user_id IN (${Prisma.join(userIds)})
            )
          `

  const lockedTeams = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT t.id
    FROM match_team t
    WHERE t.match_id = ${input.matchId}
      AND (${predicate})
    ORDER BY t.id
    FOR UPDATE
  `)
  const lockedTeamIds = lockedTeams.map((team) => team.id)
  if (lockedTeamIds.length === 0) {
    return { teamIds: [], members: [] as LockedTeamSourceMember[] }
  }

  const members = await tx.$queryRaw<LockedTeamSourceMember[]>(Prisma.sql`
    SELECT
      tm.id,
      tm.team_id AS "teamId",
      tm.user_id AS "userId"
    FROM match_team_member tm
    WHERE tm.match_id = ${input.matchId}
      AND tm.team_id IN (${Prisma.join(uniqueSorted(lockedTeamIds))})
    ORDER BY tm.id
    FOR UPDATE
  `)

  return { teamIds: lockedTeamIds, members }
}

/**
 * V2 Entry is already a frozen/versioned identity. Legacy source actions must
 * not mutate its MatchTeam implicitly; the V2 application service owns that
 * transition. Existing Entry rows are locked before returning the gate result.
 */
export async function hasMaterializedV2TeamEntry(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  input: {
    match: LockedTeamSourceMatch
    teamIds: readonly string[]
  },
) {
  if (input.match.engineVersion !== MatchEngineVersion.V2) return false
  const teamIds = uniqueSorted(input.teamIds)
  if (teamIds.length === 0) return false

  const entries = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM match_entry
    WHERE match_id = ${input.match.id}
      AND source_match_team_id IN (${Prisma.join(teamIds)})
    ORDER BY id
    FOR UPDATE
  `)
  return entries.length > 0
}
