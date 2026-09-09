import { MatchStatus, Prisma, type MatchEngineVersion } from '@prisma/client'
import { disqualifyV2EntriesInTransaction } from '../../../modules/competitions-v2/application/entry-disqualification'
import { finishV2SingleGroupOnlyMatchIfTerminal } from '../../../modules/competitions-v2/application/match-completion'
import { reverseRegistrationSettlement } from '../../../modules/competitions-v2/application/registration-settlements'
import {
  assertFixtureLineupMatchesFrozenRoster,
  assertRosterKindMatchesMatchType,
  resolveFrozenFixtureRoster,
  type FrozenFixtureRoster,
} from '../../../modules/competitions-v2/application/settlements'
import { lockMatchForEngine } from '../match/engine-guard'
import { removeUserFromMatch } from '../match/remove-participant'
import { enqueueAccountBanNotification } from '../notification/account-ban-notification'
import { lockUsersForUpdate } from './lock-users'

type AuditContext = {
  ip?: string | null
  userAgent?: string | null
}

type UserBanStateResult = {
  userId: string
  banned: boolean
  removedMatches: Array<{ id: string; title: string }>
  v2Disqualifications: V2SingleBanEffect[]
  v2CorrectionCleanups: V2CorrectionCleanupEffect[]
  notificationOutboxId: string | null
}

export type SetUsersBanStateInput = {
  userIds: readonly string[]
  banned: boolean
  actorId: string
  auditContext?: AuditContext
}

type V2SingleBanEffect = {
  matchId: string
  matchTitle: string
  entryId: string
  voidedFixtureIds: string[]
  voidedResultRevisionIds: string[]
  forfeitedFixtureIds?: string[]
}

type V2CorrectionCleanupEffect = {
  matchId: string
  matchTitle: string
  fixtureId: string
  participantEntryId: string
  voidedResultRevisionId: string
}

type LockedBanWriteScope = {
  matchIds: ReadonlySet<string>
  v2ExtendedActiveMatchIds: ReadonlySet<string>
  v2ExtendedHistoricalMatchIds: ReadonlySet<string>
  v2EntryIds: ReadonlySet<string>
  v2FixtureIds: ReadonlySet<string>
  v2ResultRevisionIds: ReadonlySet<string>
  v2HistoricalFixtureIds: ReadonlySet<string>
  v2HistoricalResultRevisionIds: ReadonlySet<string>
  v2RosterUserIds: ReadonlySet<string>
}

const V2_BAN_REASON = 'USER_BANNED'

type V2BanFixtureIdentity = {
  id: string
  matchId: string
  status: 'SCHEDULED' | 'READY' | 'COMPLETED' | 'VOIDED'
  sideAEntryId: string | null
  sideBEntryId: string | null
  sideARosterVersion: number | null
  sideBRosterVersion: number | null
}

async function resolveV2SingleFixtureRoster(
  tx: Prisma.TransactionClient,
  fixture: V2BanFixtureIdentity,
  options: { requireLineup: boolean },
): Promise<FrozenFixtureRoster> {
  const roster = await resolveFrozenFixtureRoster(tx, fixture)
  assertRosterKindMatchesMatchType('single', roster)
  if (roster.sideA.members.length !== 1 || roster.sideB.members.length !== 1) {
    throw new Error('V2 单打对局的冻结阵容人数异常，封禁操作未生效。')
  }
  if (options.requireLineup) {
    await assertFixtureLineupMatchesFrozenRoster(tx, fixture, roster)
  }
  return roster
}

function normalizeUserIds(userIds: readonly string[]) {
  return [...new Set(userIds.map((id) => id.trim()).filter(Boolean))].sort()
}

async function findAffectedV2Matches(
  tx: Prisma.TransactionClient,
  targetIds: readonly string[],
) {
  return tx.match.findMany({
    where: {
      engineVersion: 'V2',
      isQuickMatch: false,
      status: { not: MatchStatus.finished },
      entries: {
        some: {
          status: 'ACTIVE',
          members: {
            some: {
              userId: { in: [...targetIds] },
              status: 'ACTIVE',
              effectiveUntil: null,
            },
          },
        },
      },
    },
    select: { id: true, engineVersion: true, type: true, format: true },
  })
}

/**
 * Locks every supported match in which a target appears in a frozen lineup
 * for a completed, confirmed fixture. The query deliberately does not require
 * a current PENDING correction: holding the Match lock closes the race with a
 * correction command that would otherwise be created while the ban commits.
 */
async function findV2HistoricalCorrectionMatches(
  tx: Prisma.TransactionClient,
  targetIds: readonly string[],
) {
  return tx.match.findMany({
    where: {
      engineVersion: 'V2',
      isQuickMatch: false,
      fixtures: {
        some: {
          status: 'COMPLETED',
          lineupMembers: {
            some: {
              entryMember: { userId: { in: [...targetIds] } },
            },
          },
          resultRevisions: { some: { status: 'CONFIRMED' } },
        },
      },
    },
    select: { id: true, engineVersion: true, type: true, format: true },
  })
}

async function lockV2SingleBanRows(
  tx: Prisma.TransactionClient,
  input: {
    activeMatchIds: readonly string[]
    historicalMatchIds: readonly string[]
    targetIds: readonly string[]
  },
): Promise<
  Omit<
    LockedBanWriteScope,
    'matchIds' | 'v2ExtendedActiveMatchIds' | 'v2ExtendedHistoricalMatchIds'
  >
> {
  if (input.activeMatchIds.length === 0 && input.historicalMatchIds.length === 0) {
    return {
      v2EntryIds: new Set(),
      v2FixtureIds: new Set(),
      v2ResultRevisionIds: new Set(),
      v2HistoricalFixtureIds: new Set(),
      v2HistoricalResultRevisionIds: new Set(),
      v2RosterUserIds: new Set(),
    }
  }

  const activeEntries = input.activeMatchIds.length === 0
    ? []
    : await tx.matchEntry.findMany({
        where: {
          matchId: { in: [...input.activeMatchIds] },
          kind: 'INDIVIDUAL',
          status: 'ACTIVE',
          members: {
            some: {
              userId: { in: [...input.targetIds] },
              status: 'ACTIVE',
              effectiveUntil: null,
            },
          },
        },
        select: { id: true, matchId: true },
        orderBy: { id: 'asc' },
      })
  const entryMatchIds = new Set(activeEntries.map((entry) => entry.matchId))
  if (input.activeMatchIds.some((matchId) => !entryMatchIds.has(matchId))) {
    throw new Error('V2 用户参赛状态已发生变化，请重试。')
  }
  const activeEntryIds = activeEntries.map((entry) => entry.id)

  const activeFixtures = activeEntryIds.length === 0
    ? []
    : await tx.matchFixture.findMany({
        where: {
          matchId: { in: [...input.activeMatchIds] },
          OR: [
            { sideAEntryId: { in: activeEntryIds } },
            { sideBEntryId: { in: activeEntryIds } },
          ],
        },
        select: {
          id: true,
          matchId: true,
          status: true,
          sideAEntryId: true,
          sideBEntryId: true,
          sideARosterVersion: true,
          sideBRosterVersion: true,
        },
        orderBy: { id: 'asc' },
      })
  const activeFixtureIds = activeFixtures.map((fixture) => fixture.id)
  const activeFixtureIdSet = new Set(activeFixtureIds)

  const historicalCandidates = input.historicalMatchIds.length === 0
    ? []
    : await tx.matchFixture.findMany({
        where: {
          matchId: { in: [...input.historicalMatchIds] },
          status: 'COMPLETED',
          lineupMembers: {
            some: {
              entryMember: { userId: { in: [...input.targetIds] } },
            },
          },
          AND: [
            { resultRevisions: { some: { status: 'CONFIRMED' } } },
            {
              resultRevisions: {
                some: {
                  status: 'PENDING',
                  supersedesRevisionId: { not: null },
                },
              },
            },
          ],
        },
        select: {
          id: true,
          matchId: true,
          status: true,
          sideAEntryId: true,
          sideBEntryId: true,
          sideARosterVersion: true,
          sideBRosterVersion: true,
          match: { select: { status: true } },
        },
        orderBy: { id: 'asc' },
      })

  // Gather the whole Entry/member lock set before taking its first row lock.
  // This preserves one global Match -> Entry -> Fixture -> Revision -> User
  // order even when the correction belongs only to historical identities.
  const candidateFixturesById = new Map<
    string,
    V2BanFixtureIdentity
  >()
  for (const fixture of [...activeFixtures, ...historicalCandidates]) {
    candidateFixturesById.set(fixture.id, fixture)
  }
  const candidateFixtures = [...candidateFixturesById.values()].sort(
    (left, right) => left.id.localeCompare(right.id),
  )
  const lockedEntryIds = [
    ...new Set([
      ...activeEntryIds,
      ...candidateFixtures.flatMap((fixture) =>
        [fixture.sideAEntryId, fixture.sideBEntryId].filter(
          (entryId): entryId is string => entryId !== null,
        ),
      ),
    ]),
  ].sort()
  if (lockedEntryIds.length > 0) {
    const lockedEntries = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "match_entry"
      WHERE "id" IN (${Prisma.join(lockedEntryIds)})
      ORDER BY "id"
      FOR UPDATE
    `)
    if (lockedEntries.length !== lockedEntryIds.length) {
      throw new Error('V2 对局参赛身份已发生变化，请重试。')
    }
    await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "match_entry_member"
      WHERE "entry_id" IN (${Prisma.join(lockedEntryIds)})
      ORDER BY "id"
      FOR UPDATE
    `)
  }

  const candidateFixtureIds = candidateFixtures.map((fixture) => fixture.id)
  if (candidateFixtureIds.length > 0) {
    const lockedFixtures = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "match_fixture"
      WHERE "id" IN (${Prisma.join(candidateFixtureIds)})
      ORDER BY "id"
      FOR UPDATE
    `)
    if (lockedFixtures.length !== candidateFixtureIds.length) {
      throw new Error('V2 对局状态已发生变化，请重试。')
    }
  }

  const targetIdSet = new Set(input.targetIds)
  const fixtureRosters = new Map<string, FrozenFixtureRoster>()
  for (const fixture of candidateFixtures) {
    const roster = await resolveV2SingleFixtureRoster(tx, fixture, {
      requireLineup:
        fixture.status === 'READY' || fixture.status === 'COMPLETED',
    })
    fixtureRosters.set(fixture.id, roster)
  }
  const historicalFixtureIds: string[] = []
  for (const fixture of historicalCandidates) {
    if (activeFixtureIdSet.has(fixture.id)) continue
    const roster = fixtureRosters.get(fixture.id)
    if (!roster) {
      throw new Error('V2 历史固定阵容状态已发生变化，请重试。')
    }
    const targetSides = [roster.sideA, roster.sideB].filter((side) =>
      side.userIds.some((userId) => targetIdSet.has(userId)),
    )
    if (targetSides.length === 0) {
      throw new Error('V2 历史固定阵容身份异常，封禁操作未生效。')
    }
    if (
      fixture.match.status === MatchStatus.finished ||
      targetSides.some((side) => side.status !== 'ACTIVE')
    ) {
      historicalFixtureIds.push(fixture.id)
      continue
    }
    // A current ACTIVE individual identity should have been owned by the
    // normal branch. Refuse a malformed identity instead of leaving its
    // already-pending correction confirmable after the account is banned.
    throw new Error('V2 历史参赛身份状态异常，封禁操作未生效。')
  }
  const historicalFixtureIdSet = new Set(historicalFixtureIds)
  const affectedFixtureIds = [
    ...new Set([...activeFixtureIds, ...historicalFixtureIds]),
  ].sort()

  const resultRevisions = affectedFixtureIds.length === 0
    ? []
    : await tx.resultRevision.findMany({
        where: {
          fixtureId: { in: affectedFixtureIds },
          status: { in: ['PENDING', 'CONFIRMED'] },
        },
        select: { id: true, fixtureId: true },
        orderBy: { id: 'asc' },
      })
  const allResultRevisionIds = resultRevisions.map((revision) => revision.id)
  if (allResultRevisionIds.length > 0) {
    await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "result_revision"
      WHERE "id" IN (${Prisma.join(allResultRevisionIds)})
      ORDER BY "id"
      FOR UPDATE
    `)
  }

  return {
    v2EntryIds: new Set(activeEntryIds),
    v2FixtureIds: activeFixtureIdSet,
    v2ResultRevisionIds: new Set(
      resultRevisions
        .filter((revision) => activeFixtureIdSet.has(revision.fixtureId))
        .map((revision) => revision.id),
    ),
    v2HistoricalFixtureIds: historicalFixtureIdSet,
    v2HistoricalResultRevisionIds: new Set(
      resultRevisions
        .filter((revision) => historicalFixtureIdSet.has(revision.fixtureId))
        .map((revision) => revision.id),
    ),
    v2RosterUserIds: new Set(
      [...fixtureRosters.values()].flatMap((roster) => roster.allUserIds),
    ),
  }
}

async function lockBanWriteScope(
  tx: Prisma.TransactionClient,
  input: { actorId: string; targetIds: string[]; banned: boolean },
): Promise<LockedBanWriteScope> {
  const lockedMatchIds = new Set<string>()
  const legacyParticipantMatchIds: string[] = []
  let v2Scope: Omit<LockedBanWriteScope, 'matchIds'> = {
    v2ExtendedActiveMatchIds: new Set(),
    v2ExtendedHistoricalMatchIds: new Set(),
    v2EntryIds: new Set(),
    v2FixtureIds: new Set(),
    v2ResultRevisionIds: new Set(),
    v2HistoricalFixtureIds: new Set(),
    v2HistoricalResultRevisionIds: new Set(),
    v2RosterUserIds: new Set(),
  }

  if (input.banned) {
    const [
      legacyParticipantMatches,
      v2ParticipantMatches,
      v2HistoricalMatches,
      inviteMatches,
    ] = await Promise.all([
      tx.match.findMany({
        where: {
          engineVersion: 'LEGACY',
          isQuickMatch: true,
          status: { not: MatchStatus.finished },
          OR: [
            { registrations: { some: { userId: { in: input.targetIds } } } },
            { doublesTeamMembers: { some: { userId: { in: input.targetIds } } } },
            { teamMembers: { some: { userId: { in: input.targetIds } } } },
            { teamRegistrations: { some: { captainId: { in: input.targetIds } } } },
          ],
        },
        select: { id: true, engineVersion: true },
      }),
      findAffectedV2Matches(tx, input.targetIds),
      findV2HistoricalCorrectionMatches(tx, input.targetIds),
      tx.match.findMany({
        where: {
          engineVersion: 'V2',
          status: { not: MatchStatus.finished },
          doublesInvites: {
            some: {
              status: 'pending',
              OR: [
                { inviterId: { in: input.targetIds } },
                { inviteeId: { in: input.targetIds } },
              ],
            },
          },
        },
        select: { id: true, engineVersion: true },
      }),
    ])

    const matchEngines = new Map<string, MatchEngineVersion>()
    const v2MatchIds = new Set(
      [...v2ParticipantMatches, ...v2HistoricalMatches].map(
        (match) => match.id,
      ),
    )
    const isOriginalSingleGroupOnlySlice = (match: {
      type: string
      format: string
    }) => match.type === 'single' && match.format === 'group_only'
    const originalParticipantMatches = v2ParticipantMatches.filter(
      isOriginalSingleGroupOnlySlice,
    )
    const originalHistoricalMatches = v2HistoricalMatches.filter(
      isOriginalSingleGroupOnlySlice,
    )
    for (const match of [
      ...legacyParticipantMatches,
      ...v2ParticipantMatches,
      ...v2HistoricalMatches,
      ...inviteMatches,
    ]) {
      matchEngines.set(match.id, match.engineVersion)
    }
    legacyParticipantMatchIds.push(
      ...legacyParticipantMatches.map((match) => match.id),
    )

    for (const matchId of [...matchEngines.keys()].sort()) {
      await lockMatchForEngine(tx, {
        matchId,
        expectedEngine: matchEngines.get(matchId)!,
        ...(v2MatchIds.has(matchId)
          ? { expectedQuickMatch: false }
          : {}),
      })
      lockedMatchIds.add(matchId)
    }

    const originalScope = await lockV2SingleBanRows(tx, {
      activeMatchIds: originalParticipantMatches.map((match) => match.id).sort(),
      historicalMatchIds: originalHistoricalMatches.map((match) => match.id).sort(),
      targetIds: input.targetIds,
    })
    v2Scope = {
      ...originalScope,
      v2ExtendedActiveMatchIds: new Set(
        v2ParticipantMatches
          .filter((match) => !isOriginalSingleGroupOnlySlice(match))
          .map((match) => match.id),
      ),
      v2ExtendedHistoricalMatchIds: new Set(
        v2HistoricalMatches
          .filter((match) => !isOriginalSingleGroupOnlySlice(match))
          .map((match) => match.id),
      ),
    }
  }

  const [doublesTeams, matchTeams] = legacyParticipantMatchIds.length > 0
    ? await Promise.all([
        tx.matchDoublesTeam.findMany({
          where: {
            matchId: { in: legacyParticipantMatchIds },
            members: { some: { userId: { in: input.targetIds } } },
          },
          select: {
            createdById: true,
            members: { select: { userId: true } },
          },
        }),
        tx.matchTeam.findMany({
          where: {
            matchId: { in: legacyParticipantMatchIds },
            OR: [
              { captainId: { in: input.targetIds } },
              { members: { some: { userId: { in: input.targetIds } } } },
            ],
          },
          select: {
            captainId: true,
            members: { select: { userId: true } },
          },
        }),
      ])
    : [[], []]
  const relatedUserIds = [
    ...doublesTeams.flatMap((team) =>
      [team.createdById, ...team.members.map((member) => member.userId)],
    ),
    ...matchTeams.flatMap((team) => [
      team.captainId,
      ...team.members.map((member) => member.userId),
    ]),
  ]

  await lockUsersForUpdate(tx, [
    input.actorId,
    ...input.targetIds,
    ...relatedUserIds,
    ...v2Scope.v2RosterUserIds,
  ])

  return {
    matchIds: lockedMatchIds,
    ...v2Scope,
  }
}

type V2BanFixturePlan = {
  fixtureId: string
  matchId: string
  matchTitle: string
  fixtureVersion: number
  fromStatus: 'SCHEDULED' | 'READY' | 'COMPLETED'
  action: 'VOID_UNPLAYED' | 'VOID_CORRECTION'
  pendingRevisionId: string | null
  targetUserIds: string[]
  historicalTargets: Array<{ userId: string; participantEntryId: string }>
}

async function applyLockedV2SingleBanDisqualifications(
  tx: Prisma.TransactionClient,
  input: {
    actorId: string
    targetIds: readonly string[]
    scope: LockedBanWriteScope
  },
) {
  const entries = await tx.matchEntry.findMany({
    where: {
      kind: 'INDIVIDUAL',
      status: 'ACTIVE',
      members: {
        some: {
          userId: { in: [...input.targetIds] },
          status: 'ACTIVE',
          effectiveUntil: null,
        },
      },
      match: {
        engineVersion: 'V2',
        isQuickMatch: false,
        type: 'single',
        format: 'group_only',
        status: { not: MatchStatus.finished },
      },
    },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      matchId: true,
      sourceUserId: true,
      version: true,
      withdrawnAt: true,
      disqualifiedAt: true,
      archivedAt: true,
      match: {
        select: {
          id: true,
          title: true,
          engineVersion: true,
          isQuickMatch: true,
          type: true,
          format: true,
          status: true,
        },
      },
      members: {
        where: { status: 'ACTIVE', effectiveUntil: null },
        orderBy: [{ rosterVersion: 'desc' }, { slot: 'asc' }],
        select: {
          id: true,
          userId: true,
          rosterVersion: true,
          slot: true,
          endReason: true,
        },
      },
    },
  })

  const targetIdSet = new Set(input.targetIds)
  if (entries.length !== input.scope.v2EntryIds.size) {
    throw new Error('V2 用户参赛状态已发生变化，请重试。')
  }
  const effectsByUserId = new Map<string, V2SingleBanEffect[]>()
  const correctionCleanupsByUserId = new Map<
    string,
    V2CorrectionCleanupEffect[]
  >()
  const entriesById = new Map<string, (typeof entries)[number]>()
  const targetByEntryId = new Map<string, string>()
  for (const entry of entries) {
    if (
      !input.scope.matchIds.has(entry.matchId) ||
      !input.scope.v2EntryIds.has(entry.id)
    ) {
      throw new Error('V2 用户参赛状态已发生变化，请重试。')
    }
    const member = entry.members[0]
    if (
      entry.match.id !== entry.matchId ||
      entry.match.engineVersion !== 'V2' ||
      entry.match.isQuickMatch ||
      entry.match.type !== 'single' ||
      entry.match.format !== 'group_only' ||
      entry.withdrawnAt !== null ||
      entry.disqualifiedAt !== null ||
      entry.archivedAt !== null ||
      entry.members.length !== 1 ||
      !member ||
      member.slot !== 1 ||
      member.rosterVersion < 1 ||
      member.endReason !== null ||
      member.userId !== entry.sourceUserId ||
      !targetIdSet.has(member.userId)
    ) {
      throw new Error('V2 单打参赛身份异常，封禁操作未生效。')
    }
    entriesById.set(entry.id, entry)
    targetByEntryId.set(entry.id, member.userId)
    const effects = effectsByUserId.get(member.userId) ?? []
    effects.push({
      matchId: entry.matchId,
      matchTitle: entry.match.title,
      entryId: entry.id,
      voidedFixtureIds: [],
      voidedResultRevisionIds: [],
    })
    effectsByUserId.set(member.userId, effects)
  }

  const entryIds = [...entriesById.keys()]
  const fixtures = entryIds.length === 0
    ? []
    : await tx.matchFixture.findMany({
        where: {
          OR: [
            { sideAEntryId: { in: entryIds } },
            { sideBEntryId: { in: entryIds } },
          ],
        },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          matchId: true,
          status: true,
          version: true,
          sideAEntryId: true,
          sideBEntryId: true,
          sideARosterVersion: true,
          sideBRosterVersion: true,
          resultRevisions: {
            where: { status: { in: ['PENDING', 'CONFIRMED'] } },
            orderBy: { revisionNumber: 'asc' },
            select: {
              id: true,
              status: true,
              supersedesRevisionId: true,
              settlementEvents: { select: { id: true } },
            },
          },
        },
      })

  const plans: V2BanFixturePlan[] = []
  if (fixtures.length !== input.scope.v2FixtureIds.size) {
    throw new Error('V2 对局状态已发生变化，请重试。')
  }
  const activeRevisionCount = fixtures.reduce(
    (count, fixture) => count + fixture.resultRevisions.length,
    0,
  )
  if (activeRevisionCount !== input.scope.v2ResultRevisionIds.size) {
    throw new Error('V2 赛果状态已发生变化，请重试。')
  }
  for (const fixture of fixtures) {
    if (!input.scope.v2FixtureIds.has(fixture.id)) {
      throw new Error('V2 对局状态已发生变化，请重试。')
    }
    const affectedEntryIds = [fixture.sideAEntryId, fixture.sideBEntryId].filter(
      (entryId): entryId is string => entryId !== null && entriesById.has(entryId),
    )
    if (affectedEntryIds.length === 0) {
      throw new Error('V2 对局与封禁参赛身份不一致，封禁操作未生效。')
    }
    if (
      affectedEntryIds.some(
        (entryId) => entriesById.get(entryId)?.matchId !== fixture.matchId,
      )
    ) {
      throw new Error('V2 对局归属异常，封禁操作未生效。')
    }
    const roster = await resolveV2SingleFixtureRoster(tx, fixture, {
      requireLineup:
        fixture.status === 'READY' || fixture.status === 'COMPLETED',
    })
    const frozenUserByEntryId = new Map([
      [roster.sideA.entryId, roster.sideA.userIds[0]],
      [roster.sideB.entryId, roster.sideB.userIds[0]],
    ])
    if (
      affectedEntryIds.some(
        (entryId) =>
          frozenUserByEntryId.get(entryId) !== targetByEntryId.get(entryId),
      )
    ) {
      throw new Error('V2 对局固定阵容与封禁参赛身份不一致。')
    }

    const pending = fixture.resultRevisions.filter(
      (revision) => revision.status === 'PENDING',
    )
    const confirmed = fixture.resultRevisions.filter(
      (revision) => revision.status === 'CONFIRMED',
    )
    if (pending.length > 1 || confirmed.length > 1) {
      throw new Error('V2 对局存在重复的生效中赛果，封禁操作未生效。')
    }
    for (const revision of fixture.resultRevisions) {
      if (!input.scope.v2ResultRevisionIds.has(revision.id)) {
        throw new Error('V2 赛果状态已发生变化，请重试。')
      }
    }
    const pendingRevision = pending[0] ?? null
    if (pendingRevision && pendingRevision.settlementEvents.length > 0) {
      throw new Error('V2 待确认赛果存在异常结算，封禁操作未生效。')
    }

    const targetUserIds = [
      ...new Set(
        affectedEntryIds.map((entryId) => targetByEntryId.get(entryId)!),
      ),
    ].sort()
    const matchTitle = entriesById.get(affectedEntryIds[0])!.match.title
    if (fixture.status === 'SCHEDULED' || fixture.status === 'READY') {
      if (
        confirmed.length !== 0 ||
        (pendingRevision && pendingRevision.supersedesRevisionId !== null)
      ) {
        throw new Error('V2 未赛对局存在异常赛果状态，封禁操作未生效。')
      }
      plans.push({
        fixtureId: fixture.id,
        matchId: fixture.matchId,
        matchTitle,
        fixtureVersion: fixture.version,
        fromStatus: fixture.status,
        action: 'VOID_UNPLAYED',
        pendingRevisionId: pendingRevision?.id ?? null,
        targetUserIds,
        historicalTargets: [],
      })
      continue
    }

    if (fixture.status === 'COMPLETED') {
      if (confirmed.length !== 1) {
        throw new Error('V2 已完成对局缺少唯一确认赛果，封禁操作未生效。')
      }
      if (pendingRevision) {
        if (pendingRevision.supersedesRevisionId !== confirmed[0].id) {
          throw new Error('V2 已完成对局的待确认更正异常，封禁操作未生效。')
        }
        plans.push({
          fixtureId: fixture.id,
          matchId: fixture.matchId,
          matchTitle,
          fixtureVersion: fixture.version,
          fromStatus: fixture.status,
          action: 'VOID_CORRECTION',
          pendingRevisionId: pendingRevision.id,
          targetUserIds,
          historicalTargets: [roster.sideA, roster.sideB]
            .filter((side) => {
              const userId = side.userIds[0]
              return (
                targetIdSet.has(userId) &&
                side.status !== 'ACTIVE' &&
                !targetUserIds.includes(userId)
              )
            })
            .map((side) => ({
              userId: side.userIds[0],
              participantEntryId: side.entryId,
            })),
        })
      }
      continue
    }

    if (fixture.status === 'VOIDED' && fixture.resultRevisions.length > 0) {
      throw new Error('V2 已作废对局仍有生效中赛果，封禁操作未生效。')
    }
  }

  const now = new Date()
  for (const entry of entries) {
    const member = entry.members[0]
    const updatedEntry = await tx.matchEntry.updateMany({
      where: {
        id: entry.id,
        matchId: entry.matchId,
        status: 'ACTIVE',
        version: entry.version,
      },
      data: {
        status: 'DISQUALIFIED',
        disqualifiedAt: now,
        version: { increment: 1 },
      },
    })
    if (updatedEntry.count !== 1) {
      throw new Error('V2 用户参赛状态已发生变化，请重试。')
    }
    const updatedMember = await tx.matchEntryMember.updateMany({
      where: {
        id: member.id,
        entryId: entry.id,
        matchId: entry.matchId,
        status: 'ACTIVE',
        effectiveUntil: null,
      },
      data: {
        status: 'DISQUALIFIED',
        effectiveUntil: now,
        endReason: V2_BAN_REASON,
      },
    })
    if (updatedMember.count !== 1) {
      throw new Error('V2 单打成员状态已发生变化，请重试。')
    }
    await reverseRegistrationSettlement(tx, {
      matchId: entry.matchId,
      matchEntryId: entry.id,
      rosterVersion: member.rosterVersion,
      clock: () => now,
    })
  }

  for (const plan of plans) {
    if (plan.pendingRevisionId) {
      const voidedRevision = await tx.resultRevision.updateMany({
        where: { id: plan.pendingRevisionId, status: 'PENDING' },
        data: {
          status: 'VOIDED',
          verifiedById: input.actorId,
          reason: V2_BAN_REASON,
          resolvedAt: now,
        },
      })
      if (voidedRevision.count !== 1) {
        throw new Error('V2 待确认赛果状态已发生变化，请重试。')
      }
    }

    const updatedFixture = await tx.matchFixture.updateMany({
      where: {
        id: plan.fixtureId,
        matchId: plan.matchId,
        status: plan.fromStatus,
        version: plan.fixtureVersion,
      },
      data: {
        ...(plan.action === 'VOID_UNPLAYED' ? { status: 'VOIDED' as const } : {}),
        version: { increment: 1 },
      },
    })
    if (updatedFixture.count !== 1) {
      throw new Error('V2 对局状态已发生变化，请重试。')
    }

    for (const targetId of plan.targetUserIds) {
      const effect = effectsByUserId
        .get(targetId)
        ?.find((item) => item.matchId === plan.matchId)
      if (!effect) {
        throw new Error('V2 封禁影响记录与参赛身份不一致。')
      }
      if (plan.action === 'VOID_UNPLAYED') {
        effect.voidedFixtureIds.push(plan.fixtureId)
      }
      if (plan.pendingRevisionId) {
        effect.voidedResultRevisionIds.push(plan.pendingRevisionId)
      }
    }
    if (plan.pendingRevisionId) {
      for (const target of plan.historicalTargets) {
        const cleanups = correctionCleanupsByUserId.get(target.userId) ?? []
        cleanups.push({
          matchId: plan.matchId,
          matchTitle: plan.matchTitle,
          fixtureId: plan.fixtureId,
          participantEntryId: target.participantEntryId,
          voidedResultRevisionId: plan.pendingRevisionId,
        })
        correctionCleanupsByUserId.set(target.userId, cleanups)
      }
    }
  }

  const matches = new Map(entries.map((entry) => [entry.matchId, entry.match]))
  for (const match of [...matches.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    await finishV2SingleGroupOnlyMatchIfTerminal(tx, match)
  }

  return {
    disqualificationsByUserId: effectsByUserId,
    correctionCleanupsByUserId,
  }
}

async function applyLockedV2ExtendedBanDisqualifications(
  tx: Prisma.TransactionClient,
  input: {
    actorId: string
    targetIds: readonly string[]
    scope: LockedBanWriteScope
  },
) {
  const matchIds = [...input.scope.v2ExtendedActiveMatchIds]
  const entries = matchIds.length === 0
    ? []
    : await tx.matchEntry.findMany({
        where: {
          matchId: { in: matchIds },
          status: 'ACTIVE',
          members: {
            some: {
              userId: { in: [...input.targetIds] },
              status: 'ACTIVE',
              effectiveUntil: null,
            },
          },
        },
        orderBy: [{ matchId: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          matchId: true,
          version: true,
          match: {
            select: {
              id: true,
              title: true,
              engineVersion: true,
              isQuickMatch: true,
              type: true,
              format: true,
              status: true,
            },
          },
          members: {
            where: { status: 'ACTIVE', effectiveUntil: null },
            orderBy: [{ rosterVersion: 'desc' }, { slot: 'asc' }, { id: 'asc' }],
            select: { userId: true },
          },
        },
      })
  const discoveredMatchIds = new Set(entries.map((entry) => entry.matchId))
  if (
    discoveredMatchIds.size !== input.scope.v2ExtendedActiveMatchIds.size ||
    [...input.scope.v2ExtendedActiveMatchIds].some(
      (matchId) => !discoveredMatchIds.has(matchId),
    )
  ) {
    throw new Error('V2 用户参赛状态已发生变化，请重试。')
  }

  const targetIdSet = new Set(input.targetIds)
  const entriesByMatchId = new Map<string, typeof entries>()
  for (const entry of entries) {
    if (
      !input.scope.matchIds.has(entry.matchId) ||
      entry.match.id !== entry.matchId ||
      entry.match.engineVersion !== 'V2' ||
      entry.match.isQuickMatch ||
      entry.match.status === MatchStatus.finished ||
      (entry.match.type === 'single' && entry.match.format === 'group_only')
    ) {
      throw new Error('V2 参赛身份归属异常，封禁操作未生效。')
    }
    const affectedUsers = entry.members
      .map((member) => member.userId)
      .filter((userId) => targetIdSet.has(userId))
    if (affectedUsers.length === 0) {
      throw new Error('V2 参赛成员状态已发生变化，请重试。')
    }
    const group = entriesByMatchId.get(entry.matchId) ?? []
    group.push(entry)
    entriesByMatchId.set(entry.matchId, group)
  }

  const effectsByUserId = new Map<string, V2SingleBanEffect[]>()
  for (const [matchId, matchEntries] of entriesByMatchId) {
    const result = await disqualifyV2EntriesInTransaction(tx, {
      actor: { id: input.actorId, role: 'admin' },
      matchId,
      targets: matchEntries.map((entry) => ({
        entryId: entry.id,
        expectedEntryVersion: entry.version,
      })),
      reason: V2_BAN_REASON,
    })
    const voidedFixtureIds = [
      ...new Set([
        ...result.noContestFixtureIds,
        ...result.adminByeFixtureIds,
      ]),
    ].sort()
    for (const entry of matchEntries) {
      const effect: V2SingleBanEffect = {
        matchId,
        matchTitle: entry.match.title,
        entryId: entry.id,
        voidedFixtureIds,
        voidedResultRevisionIds: [...result.voidedPendingRevisionIds],
        ...(result.forfeitedFixtureIds.length === 0
          ? {}
          : { forfeitedFixtureIds: [...result.forfeitedFixtureIds] }),
      }
      for (const userId of entry.members
        .map((member) => member.userId)
        .filter((userId) => targetIdSet.has(userId))) {
        effectsByUserId.set(userId, [
          ...(effectsByUserId.get(userId) ?? []),
          effect,
        ])
      }
    }
  }
  return effectsByUserId
}

async function applyLockedV2HistoricalCorrectionCleanups(
  tx: Prisma.TransactionClient,
  input: {
    actorId: string
    targetIds: readonly string[]
    scope: LockedBanWriteScope
  },
) {
  const fixtureIds = [...input.scope.v2HistoricalFixtureIds]
  const fixtures = fixtureIds.length === 0
    ? []
    : await tx.matchFixture.findMany({
        where: { id: { in: fixtureIds } },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          matchId: true,
          status: true,
          version: true,
          sideAEntryId: true,
          sideBEntryId: true,
          sideARosterVersion: true,
          sideBRosterVersion: true,
          match: {
            select: {
              id: true,
              title: true,
              engineVersion: true,
              isQuickMatch: true,
              type: true,
              format: true,
              status: true,
            },
          },
          resultRevisions: {
            where: { status: { in: ['PENDING', 'CONFIRMED'] } },
            orderBy: { revisionNumber: 'asc' },
            select: {
              id: true,
              status: true,
              supersedesRevisionId: true,
              settlementEvents: { select: { id: true } },
            },
          },
        },
      })

  if (fixtures.length !== input.scope.v2HistoricalFixtureIds.size) {
    throw new Error('V2 历史更正状态已发生变化，请重试。')
  }
  const activeRevisionCount = fixtures.reduce(
    (count, fixture) => count + fixture.resultRevisions.length,
    0,
  )
  if (activeRevisionCount !== input.scope.v2HistoricalResultRevisionIds.size) {
    throw new Error('V2 历史更正状态已发生变化，请重试。')
  }

  const plans: Array<{
    fixtureId: string
    fixtureVersion: number
    matchId: string
    matchTitle: string
    pendingRevisionId: string
    targets: Array<{ userId: string; participantEntryId: string }>
  }> = []
  const targetIdSet = new Set(input.targetIds)
  for (const fixture of fixtures) {
    if (
      !input.scope.matchIds.has(fixture.matchId) ||
      !input.scope.v2HistoricalFixtureIds.has(fixture.id) ||
      input.scope.v2FixtureIds.has(fixture.id) ||
      fixture.match.id !== fixture.matchId ||
      fixture.match.engineVersion !== 'V2' ||
      fixture.match.isQuickMatch ||
      fixture.match.type !== 'single' ||
      fixture.match.format !== 'group_only' ||
      fixture.status !== 'COMPLETED'
    ) {
      throw new Error('V2 历史更正归属异常，封禁操作未生效。')
    }

    const pending = fixture.resultRevisions.filter(
      (revision) => revision.status === 'PENDING',
    )
    const confirmed = fixture.resultRevisions.filter(
      (revision) => revision.status === 'CONFIRMED',
    )
    if (
      pending.length !== 1 ||
      confirmed.length !== 1 ||
      pending[0].supersedesRevisionId !== confirmed[0].id ||
      pending[0].settlementEvents.length > 0
    ) {
      throw new Error('V2 历史待确认更正异常，封禁操作未生效。')
    }
    if (
      fixture.resultRevisions.some(
        (revision) =>
          !input.scope.v2HistoricalResultRevisionIds.has(revision.id),
      )
    ) {
      throw new Error('V2 历史更正状态已发生变化，请重试。')
    }

    const roster = await resolveV2SingleFixtureRoster(tx, fixture, {
      requireLineup: true,
    })
    const eligibleSides = [roster.sideA, roster.sideB].filter((side) =>
      targetIdSet.has(side.userIds[0]) &&
      (fixture.match.status === MatchStatus.finished || side.status !== 'ACTIVE'),
    )
    const eligibleUserIds = eligibleSides.map((side) => side.userIds[0])
    if (eligibleSides.length === 0 || new Set(eligibleUserIds).size !== eligibleUserIds.length) {
      throw new Error('V2 历史固定阵容身份异常，封禁操作未生效。')
    }
    plans.push({
      fixtureId: fixture.id,
      fixtureVersion: fixture.version,
      matchId: fixture.matchId,
      matchTitle: fixture.match.title,
      pendingRevisionId: pending[0].id,
      targets: eligibleSides.map((side) => ({
        userId: side.userIds[0],
        participantEntryId: side.entryId,
      })),
    })
  }

  const effectsByUserId = new Map<string, V2CorrectionCleanupEffect[]>()
  const now = new Date()
  for (const plan of plans) {
    const voidedRevision = await tx.resultRevision.updateMany({
      where: {
        id: plan.pendingRevisionId,
        matchId: plan.matchId,
        fixtureId: plan.fixtureId,
        status: 'PENDING',
      },
      data: {
        status: 'VOIDED',
        verifiedById: input.actorId,
        reason: V2_BAN_REASON,
        resolvedAt: now,
      },
    })
    if (voidedRevision.count !== 1) {
      throw new Error('V2 历史待确认更正状态已发生变化，请重试。')
    }
    const updatedFixture = await tx.matchFixture.updateMany({
      where: {
        id: plan.fixtureId,
        matchId: plan.matchId,
        status: 'COMPLETED',
        version: plan.fixtureVersion,
      },
      data: { version: { increment: 1 } },
    })
    if (updatedFixture.count !== 1) {
      throw new Error('V2 历史对局状态已发生变化，请重试。')
    }

    for (const target of plan.targets) {
      const effects = effectsByUserId.get(target.userId) ?? []
      effects.push({
        matchId: plan.matchId,
        matchTitle: plan.matchTitle,
        fixtureId: plan.fixtureId,
        participantEntryId: target.participantEntryId,
        voidedResultRevisionId: plan.pendingRevisionId,
      })
      effectsByUserId.set(target.userId, effects)
    }
  }
  return effectsByUserId
}

async function applyLockedV2ExtendedHistoricalCorrectionCleanups(
  tx: Prisma.TransactionClient,
  input: {
    actorId: string
    targetIds: readonly string[]
    scope: LockedBanWriteScope
  },
) {
  const matchIds = [...input.scope.v2ExtendedHistoricalMatchIds]
  const fixtures = matchIds.length === 0
    ? []
    : await tx.matchFixture.findMany({
        where: {
          matchId: { in: matchIds },
          status: 'COMPLETED',
          lineupMembers: {
            some: { entryMember: { userId: { in: [...input.targetIds] } } },
          },
          AND: [
            { resultRevisions: { some: { status: 'CONFIRMED' } } },
            {
              resultRevisions: {
                some: {
                  status: 'PENDING',
                  supersedesRevisionId: { not: null },
                },
              },
            },
          ],
        },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          matchId: true,
          status: true,
          version: true,
          sideAEntryId: true,
          sideBEntryId: true,
          sideARosterVersion: true,
          sideBRosterVersion: true,
          match: {
            select: {
              id: true,
              title: true,
              engineVersion: true,
              isQuickMatch: true,
              type: true,
              format: true,
              status: true,
            },
          },
          resultRevisions: {
            where: { status: { in: ['PENDING', 'CONFIRMED'] } },
            orderBy: { revisionNumber: 'asc' },
            select: {
              id: true,
              status: true,
              supersedesRevisionId: true,
              settlementEvents: { select: { id: true } },
            },
          },
        },
      })
  const targetIdSet = new Set(input.targetIds)
  const effectsByUserId = new Map<string, V2CorrectionCleanupEffect[]>()
  const now = new Date()
  for (const fixture of fixtures) {
    if (
      !input.scope.matchIds.has(fixture.matchId) ||
      fixture.match.id !== fixture.matchId ||
      fixture.match.engineVersion !== 'V2' ||
      fixture.match.isQuickMatch ||
      (fixture.match.type === 'single' && fixture.match.format === 'group_only')
    ) {
      throw new Error('V2 历史更正归属异常，封禁操作未生效。')
    }
    const pending = fixture.resultRevisions.filter(
      (revision) => revision.status === 'PENDING',
    )
    const confirmed = fixture.resultRevisions.filter(
      (revision) => revision.status === 'CONFIRMED',
    )
    if (
      pending.length !== 1 ||
      confirmed.length !== 1 ||
      pending[0].supersedesRevisionId !== confirmed[0].id ||
      pending[0].settlementEvents.length > 0
    ) {
      throw new Error('V2 历史待确认更正异常，封禁操作未生效。')
    }
    const roster = await resolveFrozenFixtureRoster(tx, fixture)
    assertRosterKindMatchesMatchType(fixture.match.type, roster)
    await assertFixtureLineupMatchesFrozenRoster(tx, fixture, roster)
    const eligibleSides = [roster.sideA, roster.sideB].filter(
      (side) =>
        side.userIds.some((userId) => targetIdSet.has(userId)) &&
        (fixture.match.status === MatchStatus.finished ||
          side.status !== 'ACTIVE'),
    )
    if (eligibleSides.length === 0) {
      throw new Error('V2 历史固定阵容身份异常，封禁操作未生效。')
    }
    const voidedRevision = await tx.resultRevision.updateMany({
      where: {
        id: pending[0].id,
        matchId: fixture.matchId,
        fixtureId: fixture.id,
        status: 'PENDING',
      },
      data: {
        status: 'VOIDED',
        verifiedById: input.actorId,
        reason: V2_BAN_REASON,
        resolvedAt: now,
      },
    })
    if (voidedRevision.count !== 1) {
      throw new Error('V2 历史待确认更正状态已发生变化，请重试。')
    }
    const updatedFixture = await tx.matchFixture.updateMany({
      where: {
        id: fixture.id,
        matchId: fixture.matchId,
        status: 'COMPLETED',
        version: fixture.version,
      },
      data: { version: { increment: 1 } },
    })
    if (updatedFixture.count !== 1) {
      throw new Error('V2 历史对局状态已发生变化，请重试。')
    }
    for (const side of eligibleSides) {
      for (const userId of side.userIds.filter((userId) => targetIdSet.has(userId))) {
        effectsByUserId.set(userId, [
          ...(effectsByUserId.get(userId) ?? []),
          {
            matchId: fixture.matchId,
            matchTitle: fixture.match.title,
            fixtureId: fixture.id,
            participantEntryId: side.entryId,
            voidedResultRevisionId: pending[0].id,
          },
        ])
      }
    }
  }
  return effectsByUserId
}

function mergeCorrectionCleanupEffects(
  target: Map<string, V2CorrectionCleanupEffect[]>,
  source: ReadonlyMap<string, readonly V2CorrectionCleanupEffect[]>,
) {
  for (const [userId, effects] of source) {
    target.set(userId, [...(target.get(userId) ?? []), ...effects])
  }
}

function mergeDisqualificationEffects(
  target: Map<string, V2SingleBanEffect[]>,
  source: ReadonlyMap<string, readonly V2SingleBanEffect[]>,
) {
  for (const [userId, effects] of source) {
    target.set(userId, [...(target.get(userId) ?? []), ...effects])
  }
}

async function applyLockedUserBanState(
  tx: Prisma.TransactionClient,
  params: {
    target: {
      id: string
      nickname: string
      email: string
      isBanned: boolean
    }
    banned: boolean
    actorId: string
    auditContext?: AuditContext
    lockedMatchIds: ReadonlySet<string>
    v2Disqualifications: readonly V2SingleBanEffect[]
    v2CorrectionCleanups: readonly V2CorrectionCleanupEffect[]
  },
): Promise<UserBanStateResult> {
  const {
    target,
    banned,
    actorId,
    auditContext,
    lockedMatchIds,
    v2Disqualifications,
    v2CorrectionCleanups,
  } = params
  const removedMatches = [
    ...new Map(
      v2Disqualifications.map((effect) => [
        effect.matchId,
        { id: effect.matchId, title: effect.matchTitle },
      ]),
    ).values(),
  ]

  if (banned) {
    const matches = await tx.match.findMany({
      where: {
        engineVersion: 'LEGACY',
          isQuickMatch: true,
        status: { not: MatchStatus.finished },
        OR: [
          { registrations: { some: { userId: target.id } } },
          { doublesTeamMembers: { some: { userId: target.id } } },
          { teamMembers: { some: { userId: target.id } } },
          { teamRegistrations: { some: { captainId: target.id } } },
        ],
      },
      select: { id: true, title: true },
      orderBy: { createdAt: 'asc' },
    })
    if (matches.some((match) => !lockedMatchIds.has(match.id))) {
      throw new Error('用户参赛状态已发生变化，请重试。')
    }

    const inviteMatches = await tx.match.findMany({
      where: {
        engineVersion: 'V2',
        status: { not: MatchStatus.finished },
        doublesInvites: {
          some: {
            status: 'pending',
            OR: [{ inviterId: target.id }, { inviteeId: target.id }],
          },
        },
      },
      select: { id: true },
    })
    if (inviteMatches.some((match) => !lockedMatchIds.has(match.id))) {
      throw new Error('用户邀请状态已发生变化，请重试。')
    }

    for (const match of matches) {
      const result = await removeUserFromMatch(tx, {
        matchId: match.id,
        userId: target.id,
        actorId,
        reason: 'user_banned',
        auditContext,
      })
      if (result.removed) removedMatches.push({ id: match.id, title: match.title })
    }

    await tx.matchDoublesInvite.updateMany({
      where: {
        matchId: { in: [...lockedMatchIds] },
        status: 'pending',
        match: { status: { not: MatchStatus.finished } },
        OR: [{ inviterId: target.id }, { inviteeId: target.id }],
      },
      data: { status: 'voided', updatedAt: new Date() },
    })
  }

  await tx.user.update({
    where: { id: target.id },
    data: {
      isBanned: banned,
      sessionVersion: { increment: 1 },
    },
  })

  const notification =
    banned && !target.isBanned
      ? await enqueueAccountBanNotification(tx, {
          userId: target.id,
          recipientEmail: target.email,
        })
      : null

  await tx.auditLog.create({
    data: {
      actorId,
      action: banned ? 'user.ban' : 'user.unban',
      entityType: 'User',
      entityId: target.id,
      ip: auditContext?.ip ?? null,
      userAgent: auditContext?.userAgent ?? null,
      details: {
        banned,
        previousBanned: target.isBanned,
        targetLabel: `${target.nickname} (${target.email})`,
        removedMatches,
        removedMatchIds: removedMatches.map((match) => match.id),
        v2Disqualifications,
        v2CorrectionCleanups,
      },
    },
  })

  return {
    userId: target.id,
    banned,
    removedMatches,
    v2Disqualifications: [...v2Disqualifications],
    v2CorrectionCleanups: [...v2CorrectionCleanups],
    notificationOutboxId: notification?.id ?? null,
  }
}

/**
 * The caller must use one Serializable interactive transaction. All related
 * Match rows are locked before actor, target, and affected-member User rows;
 * every authorization check is then repeated before the first write.
 */
export async function setUsersBanState(
  tx: Prisma.TransactionClient,
  input: SetUsersBanStateInput,
): Promise<UserBanStateResult[]> {
  const targetIds = normalizeUserIds(input.userIds)
  if (targetIds.length === 0) throw new Error('用户不存在。')

  const lockedScope = await lockBanWriteScope(tx, {
    actorId: input.actorId,
    targetIds,
    banned: input.banned,
  })

  const [actor, targets] = await Promise.all([
    tx.user.findUnique({
      where: { id: input.actorId },
      select: { role: true, isBanned: true, emailVerifiedAt: true },
    }),
    tx.user.findMany({
      where: { id: { in: targetIds } },
      select: {
        id: true,
        nickname: true,
        email: true,
        role: true,
        isBanned: true,
      },
    }),
  ])

  if (
    !actor ||
    actor.role !== 'admin' ||
    actor.isBanned ||
    !actor.emailVerifiedAt
  ) {
    throw new Error('管理员权限已发生变化，请重新登录后重试。')
  }
  if (targets.length !== targetIds.length) throw new Error('用户不存在。')

  const targetsById = new Map(targets.map((target) => [target.id, target]))
  if (input.banned) {
    if (targetIds.includes(input.actorId)) {
      throw new Error('不能封禁当前管理员自己。')
    }
    if (targets.some((target) => target.role === 'admin')) {
      throw new Error('不允许封禁管理员账号。')
    }
  }

  const v2BanEffects = input.banned
    ? await applyLockedV2SingleBanDisqualifications(tx, {
        actorId: input.actorId,
        targetIds,
        scope: lockedScope,
      })
    : {
        disqualificationsByUserId: new Map<string, V2SingleBanEffect[]>(),
        correctionCleanupsByUserId: new Map<
          string,
          V2CorrectionCleanupEffect[]
        >(),
      }
  if (input.banned) {
    mergeDisqualificationEffects(
      v2BanEffects.disqualificationsByUserId,
      await applyLockedV2ExtendedBanDisqualifications(tx, {
        actorId: input.actorId,
        targetIds,
        scope: lockedScope,
      }),
    )
    mergeCorrectionCleanupEffects(
      v2BanEffects.correctionCleanupsByUserId,
      await applyLockedV2HistoricalCorrectionCleanups(tx, {
        actorId: input.actorId,
        targetIds,
        scope: lockedScope,
      }),
    )
    mergeCorrectionCleanupEffects(
      v2BanEffects.correctionCleanupsByUserId,
      await applyLockedV2ExtendedHistoricalCorrectionCleanups(tx, {
        actorId: input.actorId,
        targetIds,
        scope: lockedScope,
      }),
    )
  }

  const results: UserBanStateResult[] = []
  for (const targetId of targetIds) {
    const target = targetsById.get(targetId)
    if (!target) throw new Error('用户不存在。')
    results.push(
      await applyLockedUserBanState(tx, {
        target,
        banned: input.banned,
        actorId: input.actorId,
        auditContext: input.auditContext,
        lockedMatchIds: lockedScope.matchIds,
        v2Disqualifications:
          v2BanEffects.disqualificationsByUserId.get(targetId) ?? [],
        v2CorrectionCleanups:
          v2BanEffects.correctionCleanupsByUserId.get(targetId) ?? [],
      }),
    )
  }

  return results
}

export async function setUserBanState(
  tx: Prisma.TransactionClient,
  params: {
    userId: string
    banned: boolean
    actorId: string
    auditContext?: AuditContext
  },
) {
  const [result] = await setUsersBanState(tx, {
    userIds: [params.userId],
    banned: params.banned,
    actorId: params.actorId,
    auditContext: params.auditContext,
  })
  return result
}
