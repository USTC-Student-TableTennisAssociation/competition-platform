import { Prisma, type PrismaClient } from "@prisma/client";

import {
  parseV2SingleGroupTableLabelsFromMetadata,
  sameV2GroupTableLabels,
} from "../domain/group-fixture-metadata";
import {
  resolveV2GroupOnlyActiveResult,
  type V2GroupOnlyActiveResult,
  type V2GroupOnlyRevisionReadModel,
} from "./group-only-results";
import {
  V2_SINGLE_GROUPING_READ_PROFILE,
  V2GroupOnlyGroupingReadIntegrityError,
  getV2GroupOnlyGroupingReadModelInTransaction,
  type V2CompetitionGroupingReadModel,
  type V2GroupOnlyGroupingReadModel,
} from "./group-only-grouping";

const ACTIVE_REVISION_STATUSES = ["PENDING", "CONFIRMED"] as const;

/**
 * This is deliberately one read-only Prisma aggregate selection. Prisma may
 * resolve nested relations with multiple SQL statements, so the caller wraps
 * it in one RepeatableRead snapshot. Keeping the selection here prevents a
 * future page adapter from falling back to legacy Registration, MatchGrouping,
 * or MatchResult identities for a V2 match.
 */
const SINGLE_V2_MATCH_SELECT = Prisma.validator<Prisma.MatchSelect>()({
  id: true,
  title: true,
  description: true,
  dateTime: true,
  location: true,
  isQuickMatch: true,
  type: true,
  status: true,
  engineVersion: true,
  format: true,
  maxParticipants: true,
  createdBy: true,
  registrationDeadline: true,
  groupingGeneratedAt: true,
  createdAt: true,
  updatedAt: true,
  creator: {
    select: {
      id: true,
      nickname: true,
      avatarUrl: true,
    },
  },
  entries: {
    select: {
      id: true,
      kind: true,
      status: true,
      sourceKey: true,
      sourceUserId: true,
      displayNameSnapshot: true,
      seed: true,
      version: true,
      withdrawnAt: true,
      disqualifiedAt: true,
      archivedAt: true,
      createdAt: true,
      updatedAt: true,
      sourceUser: {
        select: {
          id: true,
          nickname: true,
          avatarUrl: true,
          eloRating: true,
          points: true,
          isBanned: true,
        },
      },
      members: {
        orderBy: [
          { rosterVersion: "asc" },
          { slot: "asc" },
          { id: "asc" },
        ],
        select: {
          id: true,
          userId: true,
          displayNameSnapshot: true,
          role: true,
          status: true,
          slot: true,
          rosterVersion: true,
          effectiveFrom: true,
          effectiveUntil: true,
          endReason: true,
          user: {
            select: {
              id: true,
              nickname: true,
              avatarUrl: true,
              eloRating: true,
              points: true,
              isBanned: true,
            },
          },
        },
      },
    },
  },
  fixtures: {
    where: { stage: "GROUP" },
    select: {
      id: true,
      fixtureKey: true,
      stage: true,
      status: true,
      groupKey: true,
      roundNumber: true,
      position: true,
      sideAEntryId: true,
      sideBEntryId: true,
      sideARosterVersion: true,
      sideBRosterVersion: true,
      scheduledAt: true,
      startedAt: true,
      completedAt: true,
      version: true,
      metadata: true,
      createdAt: true,
      updatedAt: true,
      incomingDependencies: {
        orderBy: [{ targetSide: "asc" }, { id: "asc" }],
        select: {
          id: true,
          sourceFixtureId: true,
          sourceOutcome: true,
          targetSide: true,
        },
      },
      resultRevisions: {
        where: { status: { in: [...ACTIVE_REVISION_STATUSES] } },
        orderBy: [{ revisionNumber: "desc" }, { id: "asc" }],
        select: {
          id: true,
          revisionNumber: true,
          status: true,
          resolutionKind: true,
          winnerEntryId: true,
          loserEntryId: true,
          score: true,
          supersedesRevisionId: true,
          reason: true,
          resolvedAt: true,
          createdAt: true,
          updatedAt: true,
          reportedBy: {
            select: { id: true, nickname: true, avatarUrl: true },
          },
          verifiedBy: {
            select: { id: true, nickname: true, avatarUrl: true },
          },
        },
      },
    },
  },
});

type SingleV2MatchSource = Prisma.MatchGetPayload<{
  select: typeof SINGLE_V2_MATCH_SELECT;
}>;
type SingleV2EntrySource = SingleV2MatchSource["entries"][number];
type SingleV2FixtureSource = SingleV2MatchSource["fixtures"][number];

export type V2SingleReadDatabase = Pick<PrismaClient, "$transaction">;
type V2SingleReadTransaction = Parameters<
  Parameters<Pick<PrismaClient, "$transaction">["$transaction"]>[0]
>[0];

export class V2SingleReadModelIntegrityError extends Error {
  readonly matchId: string;
  readonly entityId: string;

  constructor(message: string, matchId: string, entityId = matchId) {
    super(message);
    this.name = "V2SingleReadModelIntegrityError";
    this.matchId = matchId;
    this.entityId = entityId;
  }
}

export type V2UserDisplay = Readonly<{
  userId: string;
  nickname: string;
  avatarUrl: string | null;
  currentEloRating: number;
  currentPoints: number;
  isCurrentlyBanned: boolean;
}>;

export type V2SingleMemberSnapshot = Readonly<{
  entryMemberId: string;
  userId: string;
  displayNameSnapshot: string;
  role: "player" | "captain" | "substitute";
  status:
    | "ACTIVE"
    | "WITHDRAWN"
    | "REMOVED"
    | "DISQUALIFIED"
    | "SUPERSEDED";
  slot: number;
  rosterVersion: number;
  effectiveFrom: string;
  effectiveUntil: string | null;
  endReason: string | null;
  profile: V2UserDisplay;
}>;

export type V2SingleEntryReadModel = Readonly<{
  entryId: string;
  entryVersion: number;
  kind: "INDIVIDUAL";
  status: "DRAFT" | "ACTIVE" | "WITHDRAWN" | "DISQUALIFIED" | "ARCHIVED";
  sourceKey: string;
  sourceUserId: string | null;
  displayNameSnapshot: string;
  seed: number | null;
  currentRosterVersion: number | null;
  player: Readonly<{
    userId: string;
    displayNameSnapshot: string;
    profile: V2UserDisplay;
  }> | null;
  members: readonly V2SingleMemberSnapshot[];
  withdrawnAt: string | null;
  disqualifiedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

/** Kept as public SINGLE aliases while the revision-chain resolver is shared. */
export type V2SingleRevisionReadModel = V2GroupOnlyRevisionReadModel;
export type V2SingleActiveResult = V2GroupOnlyActiveResult;

export type V2SingleFixtureSideReadModel = Readonly<{
  entryId: string;
  entryVersion: number;
  entryStatus: V2SingleEntryReadModel["status"];
  entryDisplayNameSnapshot: string;
  rosterVersion: number;
  player: Readonly<{
    entryMemberId: string;
    userId: string;
    displayNameSnapshot: string;
    profile: V2UserDisplay;
  }>;
}>;

type V2SingleFixtureBase = Readonly<{
  fixtureId: string;
  fixtureKey: string;
  fixtureVersion: number;
  status: "SCHEDULED" | "READY" | "COMPLETED" | "VOIDED";
  sideA: V2SingleFixtureSideReadModel | null;
  sideB: V2SingleFixtureSideReadModel | null;
  feeders: Readonly<{
    sideA: V2SingleFixtureFeeder | null;
    sideB: V2SingleFixtureFeeder | null;
  }>;
  activeResult: V2SingleActiveResult;
  /** Convenience aliases for the active result command target. */
  currentRevisionId: string | null;
  revisionVersion: number | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type V2SingleFixtureFeeder = Readonly<{
  dependencyId: string;
  sourceFixtureId: string;
  sourceOutcome: "WINNER" | "LOSER";
}>;

export type V2SingleFixtureReadModel =
  | (V2SingleFixtureBase &
      Readonly<{
        stage: "GROUP";
        groupKey: string;
        tableLabels: readonly string[];
        roundNumber: null;
        position: null;
      }>)
  | (V2SingleFixtureBase &
      Readonly<{
        stage: "KNOCKOUT";
        groupKey: null;
        roundNumber: number;
        position: number;
      }>)
  | (V2SingleFixtureBase &
      Readonly<{
        stage: "FREE_PLAY";
        groupKey: null;
        roundNumber: null;
        position: null;
      }>);

export type V2SingleGroupReadModel = Readonly<{
  groupKey: string;
  tableLabels: readonly string[];
  fixtureIds: readonly string[];
  participants: readonly Readonly<{
    entryId: string;
    entryVersion: number;
    entryStatus: V2SingleEntryReadModel["status"];
    userId: string | null;
    displayNameSnapshot: string;
    currentProfile: V2UserDisplay | null;
  }>[];
}>;

export type CompetitionMatchHeader = Readonly<{
  id: string;
  title: string;
  description: string | null;
  dateTime: string;
  location: string | null;
  isQuickMatch: boolean;
  type: "single" | "double" | "team";
  status: "registration" | "ongoing" | "finished";
  engineVersion: "LEGACY" | "V2";
  format: "group_only" | "group_then_knockout";
  maxParticipants: number;
  createdBy: string;
  creator: Readonly<{
    userId: string;
    nickname: string;
    avatarUrl: string | null;
  }>;
  registrationDeadline: string;
  groupingGeneratedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type SingleCompetitionReadModel =
  | Readonly<{
      kind: "MATCH_NOT_FOUND";
      matchId: string;
    }>
  | Readonly<{
      kind: "LEGACY_MATCH";
      engineVersion: "LEGACY";
      match: CompetitionMatchHeader & Readonly<{ engineVersion: "LEGACY" }>;
    }>
  | Readonly<{
      kind: "UNSUPPORTED_V2_MATCH";
      engineVersion: "V2";
      reason: "QUICK_MATCH" | "NON_SINGLE_MATCH";
      match: CompetitionMatchHeader & Readonly<{ engineVersion: "V2" }>;
    }>
  | Readonly<{
      kind: "SINGLE_V2_MATCH";
      engineVersion: "V2";
      match: CompetitionMatchHeader &
        Readonly<{
          engineVersion: "V2";
          type: "single";
          isQuickMatch: false;
        }>;
      entries: readonly V2SingleEntryReadModel[];
      fixtures: readonly V2SingleFixtureReadModel[];
      groups: readonly V2SingleGroupReadModel[];
      stageFixtureIds: Readonly<{
        group: readonly string[];
        knockout: readonly string[];
        freePlay: readonly string[];
      }>;
      grouping: V2CompetitionGroupingReadModel;
    }>;

function iso(value: Date | null) {
  return value?.toISOString() ?? null;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mapUserDisplay(user: {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  eloRating: number;
  points: number;
  isBanned: boolean;
}): V2UserDisplay {
  return {
    userId: user.id,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
    currentEloRating: user.eloRating,
    currentPoints: user.points,
    isCurrentlyBanned: user.isBanned,
  };
}

function mapHeader(source: SingleV2MatchSource): CompetitionMatchHeader {
  return {
    id: source.id,
    title: source.title,
    description: source.description,
    dateTime: source.dateTime.toISOString(),
    location: source.location,
    isQuickMatch: source.isQuickMatch,
    type: source.type,
    status: source.status,
    engineVersion: source.engineVersion,
    format: source.format,
    maxParticipants: source.maxParticipants,
    createdBy: source.createdBy,
    creator: {
      userId: source.creator.id,
      nickname: source.creator.nickname,
      avatarUrl: source.creator.avatarUrl,
    },
    registrationDeadline: source.registrationDeadline.toISOString(),
    groupingGeneratedAt: iso(source.groupingGeneratedAt),
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  };
}

function mapEntry(
  source: SingleV2EntrySource,
  matchId: string,
): V2SingleEntryReadModel {
  if (source.kind !== "INDIVIDUAL") {
    throw new V2SingleReadModelIntegrityError(
      "A SINGLE V2 match contains a non-individual Entry.",
      matchId,
      source.id,
    );
  }

  const members = source.members.map((member) => ({
    entryMemberId: member.id,
    userId: member.userId,
    displayNameSnapshot: member.displayNameSnapshot,
    role: member.role,
    status: member.status,
    slot: member.slot,
    rosterVersion: member.rosterVersion,
    effectiveFrom: member.effectiveFrom.toISOString(),
    effectiveUntil: iso(member.effectiveUntil),
    endReason: member.endReason,
    profile: mapUserDisplay(member.user),
  }));
  const activeMembers = members.filter(
    (member) => member.status === "ACTIVE" && member.effectiveUntil === null,
  );
  const currentVersions = new Set(
    activeMembers.map((member) => member.rosterVersion),
  );
  if (
    (source.status === "ACTIVE" && activeMembers.length !== 1) ||
    (source.status !== "ACTIVE" && activeMembers.length > 1) ||
    currentVersions.size > 1
  ) {
    throw new V2SingleReadModelIntegrityError(
      source.status === "ACTIVE"
        ? "An active individual Entry must have exactly one current member snapshot."
        : "An individual Entry has more than one current member snapshot.",
      matchId,
      source.id,
    );
  }

  const latestMember = [...members].sort(
    (left, right) =>
      right.rosterVersion - left.rosterVersion || right.slot - left.slot,
  )[0];
  const playerProfile = source.sourceUser
    ? mapUserDisplay(source.sourceUser)
    : (latestMember?.profile ?? null);
  const playerUserId = source.sourceUserId ?? latestMember?.userId ?? null;

  return {
    entryId: source.id,
    entryVersion: source.version,
    kind: source.kind,
    status: source.status,
    sourceKey: source.sourceKey,
    sourceUserId: source.sourceUserId,
    displayNameSnapshot: source.displayNameSnapshot,
    seed: source.seed,
    currentRosterVersion: activeMembers[0]?.rosterVersion ?? null,
    player:
      playerProfile && playerUserId
        ? {
            userId: playerUserId,
            displayNameSnapshot: source.displayNameSnapshot,
            profile: playerProfile,
          }
        : null,
    members,
    withdrawnAt: iso(source.withdrawnAt),
    disqualifiedAt: iso(source.disqualifiedAt),
    archivedAt: iso(source.archivedAt),
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  };
}

function mapFixtureSide(
  matchId: string,
  fixtureId: string,
  entryId: string | null,
  rosterVersion: number | null,
  entriesById: ReadonlyMap<string, V2SingleEntryReadModel>,
): V2SingleFixtureSideReadModel | null {
  if (entryId === null && rosterVersion === null) return null;
  if (entryId === null || rosterVersion === null) {
    throw new V2SingleReadModelIntegrityError(
      "A Fixture side must pair its Entry and roster version.",
      matchId,
      fixtureId,
    );
  }
  const entry = entriesById.get(entryId);
  if (!entry) {
    throw new V2SingleReadModelIntegrityError(
      "A Fixture side references a missing Entry.",
      matchId,
      fixtureId,
    );
  }
  const roster = entry.members.filter(
    (member) => member.rosterVersion === rosterVersion,
  );
  if (roster.length !== 1) {
    throw new V2SingleReadModelIntegrityError(
      "A SINGLE Fixture side must resolve to one frozen player snapshot.",
      matchId,
      fixtureId,
    );
  }
  const player = roster[0];
  return {
    entryId: entry.entryId,
    entryVersion: entry.entryVersion,
    entryStatus: entry.status,
    entryDisplayNameSnapshot: entry.displayNameSnapshot,
    rosterVersion,
    player: {
      entryMemberId: player.entryMemberId,
      userId: player.userId,
      displayNameSnapshot: player.displayNameSnapshot,
      profile: player.profile,
    },
  };
}

function mapFeeders(
  source: SingleV2FixtureSource,
  matchId: string,
): V2SingleFixtureBase["feeders"] {
  let sideA: V2SingleFixtureFeeder | null = null;
  let sideB: V2SingleFixtureFeeder | null = null;
  for (const dependency of source.incomingDependencies) {
    if (
      dependency.sourceFixtureId === null ||
      dependency.sourceOutcome === null
    ) {
      throw new V2SingleReadModelIntegrityError(
        "This read model does not support qualification-sourced knockout sides.",
        matchId,
        source.id,
      );
    }
    const feeder = {
      dependencyId: dependency.id,
      sourceFixtureId: dependency.sourceFixtureId,
      sourceOutcome: dependency.sourceOutcome,
    };
    if (dependency.targetSide === "SIDE_A") {
      if (sideA) {
        throw new V2SingleReadModelIntegrityError(
          "A Fixture has multiple feeders for SIDE_A.",
          matchId,
          source.id,
        );
      }
      sideA = feeder;
    } else {
      if (sideB) {
        throw new V2SingleReadModelIntegrityError(
          "A Fixture has multiple feeders for SIDE_B.",
          matchId,
          source.id,
        );
      }
      sideB = feeder;
    }
  }
  return { sideA, sideB };
}

function mapFixture(
  source: SingleV2FixtureSource,
  entriesById: ReadonlyMap<string, V2SingleEntryReadModel>,
  matchId: string,
): V2SingleFixtureReadModel {
  const activeResult = resolveV2GroupOnlyActiveResult(
    source,
    entriesById,
    (message, entityId) => {
      throw new V2SingleReadModelIntegrityError(message, matchId, entityId);
    },
  );
  const base: V2SingleFixtureBase = {
    fixtureId: source.id,
    fixtureKey: source.fixtureKey,
    fixtureVersion: source.version,
    status: source.status,
    sideA: mapFixtureSide(
      matchId,
      source.id,
      source.sideAEntryId,
      source.sideARosterVersion,
      entriesById,
    ),
    sideB: mapFixtureSide(
      matchId,
      source.id,
      source.sideBEntryId,
      source.sideBRosterVersion,
      entriesById,
    ),
    feeders: mapFeeders(source, matchId),
    activeResult,
    currentRevisionId: activeResult.currentRevisionId,
    revisionVersion: activeResult.revisionVersion,
    scheduledAt: iso(source.scheduledAt),
    startedAt: iso(source.startedAt),
    completedAt: iso(source.completedAt),
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  };

  if (source.stage === "GROUP") {
    if (!source.groupKey) {
      throw new V2SingleReadModelIntegrityError(
        "A GROUP Fixture is missing groupKey.",
        matchId,
        source.id,
      );
    }
    const tableLabels = parseV2SingleGroupTableLabelsFromMetadata(
      source.metadata,
    );
    if (tableLabels === null) {
      throw new V2SingleReadModelIntegrityError(
        "A GROUP Fixture has invalid V2 display metadata.",
        matchId,
        source.id,
      );
    }
    return {
      ...base,
      stage: source.stage,
      groupKey: source.groupKey,
      tableLabels,
      roundNumber: null,
      position: null,
    };
  }
  if (source.stage === "KNOCKOUT") {
    if (source.roundNumber === null || source.position === null) {
      throw new V2SingleReadModelIntegrityError(
        "A KNOCKOUT Fixture is missing its round or position.",
        matchId,
        source.id,
      );
    }
    return {
      ...base,
      stage: source.stage,
      groupKey: null,
      roundNumber: source.roundNumber,
      position: source.position,
    };
  }
  return {
    ...base,
    stage: source.stage,
    groupKey: null,
    roundNumber: null,
    position: null,
  };
}

function compareEntries(
  left: V2SingleEntryReadModel,
  right: V2SingleEntryReadModel,
) {
  if (left.seed !== null || right.seed !== null) {
    if (left.seed === null) return 1;
    if (right.seed === null) return -1;
    if (left.seed !== right.seed) return left.seed - right.seed;
  }
  const created = compareText(left.createdAt, right.createdAt);
  return created || compareText(left.entryId, right.entryId);
}

const STAGE_ORDER: Readonly<Record<V2SingleFixtureReadModel["stage"], number>> = {
  GROUP: 0,
  KNOCKOUT: 1,
  FREE_PLAY: 2,
};

function compareFixtures(
  left: V2SingleFixtureReadModel,
  right: V2SingleFixtureReadModel,
) {
  const stage = STAGE_ORDER[left.stage] - STAGE_ORDER[right.stage];
  if (stage) return stage;
  const group = compareText(left.groupKey ?? "", right.groupKey ?? "");
  if (group) return group;
  const round = (left.roundNumber ?? 0) - (right.roundNumber ?? 0);
  if (round) return round;
  const position = (left.position ?? 0) - (right.position ?? 0);
  if (position) return position;
  return (
    compareText(left.fixtureKey, right.fixtureKey) ||
    compareText(left.fixtureId, right.fixtureId)
  );
}

function buildGroups(
  fixtures: readonly V2SingleFixtureReadModel[],
  entriesById: ReadonlyMap<string, V2SingleEntryReadModel>,
  matchId: string,
): readonly V2SingleGroupReadModel[] {
  const groups = new Map<
    string,
    {
      fixtureIds: string[];
      entryIds: Set<string>;
      tableLabels: readonly string[] | null;
    }
  >();
  for (const fixture of fixtures) {
    if (fixture.stage !== "GROUP") continue;
    const group = groups.get(fixture.groupKey) ?? {
      fixtureIds: [],
      entryIds: new Set<string>(),
      tableLabels: null,
    };
    if (
      group.tableLabels !== null &&
      !sameV2GroupTableLabels(group.tableLabels, fixture.tableLabels)
    ) {
      throw new V2SingleReadModelIntegrityError(
        "GROUP Fixtures disagree on their V2 table labels.",
        matchId,
        fixture.fixtureId,
      );
    }
    group.tableLabels = fixture.tableLabels;
    group.fixtureIds.push(fixture.fixtureId);
    if (fixture.sideA) group.entryIds.add(fixture.sideA.entryId);
    if (fixture.sideB) group.entryIds.add(fixture.sideB.entryId);
    groups.set(fixture.groupKey, group);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([groupKey, group]) => ({
      groupKey,
      tableLabels: group.tableLabels ?? [],
      fixtureIds: group.fixtureIds,
      participants: [...group.entryIds]
        .map((entryId) => entriesById.get(entryId))
        .filter((entry): entry is V2SingleEntryReadModel => entry !== undefined)
        .sort(compareEntries)
        .map((entry) => ({
          entryId: entry.entryId,
          entryVersion: entry.entryVersion,
          entryStatus: entry.status,
          userId: entry.player?.userId ?? null,
          displayNameSnapshot: entry.displayNameSnapshot,
          currentProfile: entry.player?.profile ?? null,
        })),
    }));
}

/**
 * Loads the engine discriminator and the complete SINGLE V2 page projection.
 * It never performs auto-finish, reconciliation writes, legacy fallback reads,
 * or any other mutation.
 */
export async function getSingleCompetitionReadModelInTransaction(
  tx: V2SingleReadTransaction,
  matchId: string,
): Promise<SingleCompetitionReadModel> {
  if (matchId.trim() === "" || matchId !== matchId.trim()) {
    throw new TypeError("matchId must be a non-empty stable identifier.");
  }
  const source = await tx.match.findUnique({
    where: { id: matchId },
    select: SINGLE_V2_MATCH_SELECT,
  });
  if (!source) return { kind: "MATCH_NOT_FOUND", matchId };

  const header = mapHeader(source);
  if (source.engineVersion === "LEGACY") {
    return {
      kind: "LEGACY_MATCH",
      engineVersion: source.engineVersion,
      match: { ...header, engineVersion: source.engineVersion },
    };
  }
  if (source.isQuickMatch) {
    return {
      kind: "UNSUPPORTED_V2_MATCH",
      engineVersion: source.engineVersion,
      reason: "QUICK_MATCH",
      match: { ...header, engineVersion: source.engineVersion },
    };
  }
  if (source.type !== "single") {
    return {
      kind: "UNSUPPORTED_V2_MATCH",
      engineVersion: source.engineVersion,
      reason: "NON_SINGLE_MATCH",
      match: { ...header, engineVersion: source.engineVersion },
    };
  }
  let groupingProjection: V2GroupOnlyGroupingReadModel;
  try {
    groupingProjection = await getV2GroupOnlyGroupingReadModelInTransaction(
      tx,
      matchId,
      V2_SINGLE_GROUPING_READ_PROFILE,
    );
  } catch (error) {
    if (error instanceof V2GroupOnlyGroupingReadIntegrityError) {
      throw new V2SingleReadModelIntegrityError(
        error.message,
        error.matchId,
        error.entityId,
      );
    }
    throw error;
  }
  if (
    (groupingProjection.kind !== "GROUP_ONLY_V2_MATCH" &&
      groupingProjection.kind !== "GROUP_THEN_KNOCKOUT_V2_MATCH") ||
    groupingProjection.match.id !== source.id ||
    groupingProjection.match.type !== "single" ||
    groupingProjection.match.format !== source.format
  ) {
    throw new V2SingleReadModelIntegrityError(
      "The SINGLE competition phase projection is unavailable or inconsistent.",
      source.id,
    );
  }

  const entries = source.entries.map((entry) => mapEntry(entry, source.id));
  entries.sort(compareEntries);
  const entriesById = new Map(entries.map((entry) => [entry.entryId, entry]));
  const fixtures = source.fixtures.map((fixture) =>
    mapFixture(fixture, entriesById, source.id),
  );
  fixtures.sort(compareFixtures);

  return {
    kind: "SINGLE_V2_MATCH",
    engineVersion: source.engineVersion,
    match: {
      ...header,
      engineVersion: source.engineVersion,
      type: source.type,
      isQuickMatch: false,
    },
    entries,
    fixtures,
    groups: buildGroups(fixtures, entriesById, source.id),
    stageFixtureIds: {
      group: fixtures
        .filter((fixture) => fixture.stage === "GROUP")
        .map((fixture) => fixture.fixtureId),
      knockout: fixtures
        .filter((fixture) => fixture.stage === "KNOCKOUT")
        .map((fixture) => fixture.fixtureId),
      freePlay: fixtures
        .filter((fixture) => fixture.stage === "FREE_PLAY")
        .map((fixture) => fixture.fixtureId),
    },
    grouping: groupingProjection,
  };
}

/** Standalone caller preserving one RepeatableRead competition snapshot. */
export async function getSingleCompetitionReadModel(
  db: V2SingleReadDatabase,
  matchId: string,
): Promise<SingleCompetitionReadModel> {
  if (matchId.trim() === "" || matchId !== matchId.trim()) {
    throw new TypeError("matchId must be a non-empty stable identifier.");
  }
  return db.$transaction(
    (tx) => getSingleCompetitionReadModelInTransaction(tx, matchId),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
