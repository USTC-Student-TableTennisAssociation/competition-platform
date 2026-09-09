import { Prisma, type PrismaClient } from "@prisma/client";

import {
  validateV2KnockoutGraph,
  type V2KnockoutGraphSnapshot,
} from "../application/knockout-advancement";
import { V2ResultApplicationError } from "../application/results-errors";
import {
  parseV2SingleGroupTableLabelsFromMetadata,
  sameV2GroupTableLabels,
} from "../domain/group-fixture-metadata";
import {
  resolveV2GroupOnlyActiveResult,
  type V2GroupOnlyActiveResult,
} from "./group-only-results";

const GROUPING_SELECT = Prisma.validator<Prisma.MatchSelect>()({
  id: true,
  title: true,
  type: true,
  status: true,
  engineVersion: true,
  isQuickMatch: true,
  format: true,
  createdBy: true,
  registrationDeadline: true,
  teamRegistrationDeadline: true,
  teamMinMembers: true,
  teamMaxMembers: true,
  groupingGeneratedAt: true,
  entries: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      kind: true,
      status: true,
      sourceKey: true,
      sourceUserId: true,
      sourceDoublesTeamId: true,
      sourceMatchTeamId: true,
      displayNameSnapshot: true,
      version: true,
      sourceUser: {
        select: {
          id: true,
          nickname: true,
          isBanned: true,
          emailVerifiedAt: true,
        },
      },
      sourceDoublesTeam: {
        select: {
          id: true,
          matchId: true,
          members: {
            orderBy: [{ slot: "asc" }, { id: "asc" }],
            select: { userId: true, slot: true, matchId: true },
          },
        },
      },
      sourceMatchTeam: {
        select: {
          id: true,
          matchId: true,
          captainId: true,
          status: true,
          members: {
            orderBy: { userId: "asc" },
            select: { userId: true, matchId: true },
          },
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
          effectiveUntil: true,
          user: {
            select: {
              id: true,
              nickname: true,
              avatarUrl: true,
              isBanned: true,
              emailVerifiedAt: true,
            },
          },
        },
      },
    },
  },
  groupingResult: {
    select: {
      id: true,
      matchId: true,
      v2SchemaVersion: true,
      seedMethod: true,
      standingsPolicyVersion: true,
      qualifiersPerGroup: true,
      bracketPolicyVersion: true,
      createdAt: true,
      qualificationSnapshot: {
        select: {
          id: true,
          matchId: true,
          groupingId: true,
          schemaVersion: true,
          standingsPolicyVersion: true,
          sourceRevisionFingerprint: true,
          createdAt: true,
          standings: {
            orderBy: [
              { groupId: "asc" },
              { rank: "asc" },
              { id: "asc" },
            ],
            select: {
              id: true,
              matchId: true,
              snapshotId: true,
              groupId: true,
              entryId: true,
              rank: true,
              played: true,
              wins: true,
              losses: true,
              scoreFor: true,
              scoreAgainst: true,
              scoreDifferential: true,
              qualified: true,
              qualificationOrder: true,
              ineligibilityReason: true,
              groupEntry: { select: { rosterVersion: true } },
            },
          },
        },
      },
    },
  },
  matchGroups: {
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: {
      id: true,
      matchId: true,
      groupingId: true,
      groupKey: true,
      displayName: true,
      position: true,
      entries: {
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: {
          id: true,
          matchId: true,
          groupId: true,
          entryId: true,
          position: true,
          globalSeedRank: true,
          seedElo: true,
          seedPoints: true,
          entryVersion: true,
          rosterVersion: true,
        },
      },
    },
  },
  fixtures: {
    orderBy: [{ fixtureKey: "asc" }, { id: "asc" }],
    select: {
      id: true,
      matchId: true,
      fixtureKey: true,
      stage: true,
      bestOf: true,
      status: true,
      groupId: true,
      groupKey: true,
      roundNumber: true,
      position: true,
      sideAEntryId: true,
      sideBEntryId: true,
      sideARosterVersion: true,
      sideBRosterVersion: true,
      version: true,
      startedAt: true,
      completedAt: true,
      metadata: true,
      lineupMembers: {
        orderBy: [{ side: "asc" }, { position: "asc" }, { id: "asc" }],
        select: {
          id: true,
          matchId: true,
          fixtureId: true,
          entryId: true,
          entryMemberId: true,
          side: true,
          position: true,
        },
      },
      resultRevisions: {
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
      administrativeResolution: {
        select: {
          id: true,
          matchId: true,
          fixtureId: true,
          kind: true,
          advancingEntryId: true,
          advancingRosterVersion: true,
          resolvedById: true,
          reason: true,
          createdAt: true,
          resolvedBy: {
            select: { id: true, nickname: true },
          },
        },
      },
    },
  },
});

const KNOCKOUT_DEPENDENCY_SELECT =
  Prisma.validator<Prisma.MatchFixtureDependencySelect>()({
    id: true,
    matchId: true,
    sourceFixtureId: true,
    sourceOutcome: true,
    sourceQualificationStandingId: true,
    targetFixtureId: true,
    targetSide: true,
  });

type Source = Prisma.MatchGetPayload<{ select: typeof GROUPING_SELECT }>;
type SourceEntry = Source["entries"][number];
type SourceDependency = Prisma.MatchFixtureDependencyGetPayload<{
  select: typeof KNOCKOUT_DEPENDENCY_SELECT;
}>;
type TransactionClient = Parameters<
  Parameters<Pick<PrismaClient, "$transaction">["$transaction"]>[0]
>[0];

export type V2GroupOnlyGroupingReadProfile = Readonly<{
  matchType: "single" | "double" | "team";
  entryKind: "INDIVIDUAL" | "DOUBLES" | "TEAM";
  publication: "V2_SINGLE_GROUPING" | "V2_DOUBLE_GROUPING" | "V2_TEAM_GROUPING";
  groupThenKnockoutPublication:
    | "V2_SINGLE_GROUP_THEN_KNOCKOUT_GROUPING"
    | "V2_DOUBLE_GROUP_THEN_KNOCKOUT_GROUPING"
    | "V2_TEAM_GROUP_THEN_KNOCKOUT_GROUPING";
  competitorType: "user" | "team";
}>;

export const V2_SINGLE_GROUPING_READ_PROFILE = Object.freeze({
  matchType: "single",
  entryKind: "INDIVIDUAL",
  publication: "V2_SINGLE_GROUPING",
  groupThenKnockoutPublication: "V2_SINGLE_GROUP_THEN_KNOCKOUT_GROUPING",
  competitorType: "user",
} satisfies V2GroupOnlyGroupingReadProfile);

export const V2_DOUBLE_GROUPING_READ_PROFILE = Object.freeze({
  matchType: "double",
  entryKind: "DOUBLES",
  publication: "V2_DOUBLE_GROUPING",
  groupThenKnockoutPublication: "V2_DOUBLE_GROUP_THEN_KNOCKOUT_GROUPING",
  competitorType: "team",
} satisfies V2GroupOnlyGroupingReadProfile);

export const V2_TEAM_GROUPING_READ_PROFILE = Object.freeze({
  matchType: "team",
  entryKind: "TEAM",
  publication: "V2_TEAM_GROUPING",
  groupThenKnockoutPublication: "V2_TEAM_GROUP_THEN_KNOCKOUT_GROUPING",
  competitorType: "team",
} satisfies V2GroupOnlyGroupingReadProfile);

export type V2GroupOnlyGroupingMember = Readonly<{
  entryMemberId: string;
  userId: string;
  frozenDisplayName: string;
  nickname: string;
  avatarUrl: string | null;
  slot: number;
  role: "player" | "captain" | "substitute";
  rosterVersion: number;
  isCurrentlyBanned: boolean;
}>;

export type V2GroupOnlyGroupingEntry = Readonly<{
  entryId: string;
  entryVersion: number;
  entryStatus: "DRAFT" | "ACTIVE" | "WITHDRAWN" | "DISQUALIFIED" | "ARCHIVED";
  sourceCompetitorId: string;
  frozenDisplayName: string;
  currentRosterVersion: number | null;
  currentMembers: readonly V2GroupOnlyGroupingMember[];
}>;

export type V2GroupOnlyGroupingFixture = Readonly<{
  fixtureId: string;
  fixtureKey: string;
  fixtureVersion: number;
  bestOf?: number;
  startedAt?: string | null;
  status: "SCHEDULED" | "READY" | "COMPLETED" | "VOIDED";
  sideA: Readonly<{
    entryId: string;
    entryStatus: V2GroupOnlyGroupingEntry["entryStatus"];
    frozenDisplayName: string;
    members: readonly V2GroupOnlyGroupingMember[];
  }>;
  sideB: Readonly<{
    entryId: string;
    entryStatus: V2GroupOnlyGroupingEntry["entryStatus"];
    frozenDisplayName: string;
    members: readonly V2GroupOnlyGroupingMember[];
  }>;
  activeResult: V2GroupOnlyActiveResult;
}>;

export type V2GroupOnlyGroupingGroup = Readonly<{
  groupId: string;
  groupKey: string;
  displayName: string;
  position: number;
  tableLabels: readonly string[];
  entries: readonly Readonly<{
    entryId: string;
    frozenDisplayName: string;
    sourceCompetitorId: string;
    entryVersionAtPublication: number;
    rosterVersion: number;
    seedElo: number;
    seedPoints: number;
    globalSeedRank: number;
    members: readonly V2GroupOnlyGroupingMember[];
  }>[];
  fixtures: readonly V2GroupOnlyGroupingFixture[];
}>;

/**
 * A qualification row is an immutable projection of the relational snapshot.
 * It deliberately carries its frozen roster rather than consulting a live
 * source team when the detail page renders a published bracket.
 */
export type V2QualificationStandingReadModel = Readonly<{
  standingId: string;
  snapshotId: string;
  groupId: string;
  entryId: string;
  frozenDisplayName: string;
  rosterVersion: number;
  members: readonly V2GroupOnlyGroupingMember[];
  rank: number;
  played: number;
  wins: number;
  losses: number;
  scoreFor: number;
  scoreAgainst: number;
  scoreDifferential: number;
  qualified: boolean;
  qualificationOrder: number | null;
  ineligibilityReason: string | null;
}>;

export type V2KnockoutFixtureFeederReadModel =
  | Readonly<{
      kind: "QUALIFIER";
      dependencyId: string;
      sourceQualificationStandingId: string;
      sourceEntryId: string;
      sourceGroupId: string;
      sourceRank: number;
      qualificationOrder: number;
      resolved: true;
    }>
  | Readonly<{
      kind: "WINNER";
      dependencyId: string;
      sourceFixtureId: string;
      sourceFixtureKey: string;
      sourceRoundNumber: number;
      sourcePosition: number;
      sourceOutcome: "WINNER";
      resolved: boolean;
      empty: boolean;
    }>;

export type V2KnockoutFixtureSideReadModel = Readonly<{
  feeder: V2KnockoutFixtureFeederReadModel;
  entry: Readonly<{
    entryId: string;
    entryStatus: V2GroupOnlyGroupingEntry["entryStatus"];
    frozenDisplayName: string;
    rosterVersion: number;
    members: readonly V2GroupOnlyGroupingMember[];
  }> | null;
}>;

export type V2KnockoutFixtureReadModel = Readonly<{
  fixtureId: string;
  fixtureKey: string;
  fixtureVersion: number;
  bestOf?: number;
  roundNumber: number;
  position: number;
  status: "SCHEDULED" | "READY" | "COMPLETED" | "VOIDED";
  startedAt: string | null;
  completedAt: string | null;
  tableLabels: readonly string[];
  sideA: V2KnockoutFixtureSideReadModel;
  sideB: V2KnockoutFixtureSideReadModel;
  activeResult: V2GroupOnlyActiveResult;
  administrativeResolution: Readonly<{
    resolutionId: string;
    kind: "NO_CONTEST" | "ADMIN_BYE";
    advancingEntryId: string | null;
    reason: string;
    resolvedById: string;
    resolvedByName: string;
    resolvedAt: string;
  }> | null;
}>;

export type V2QualificationSnapshotReadModel = Readonly<{
  snapshotId: string;
  frozenAt: string;
  sourceRevisionFingerprint: string;
  standings: readonly V2QualificationStandingReadModel[];
}>;

export type V2KnockoutBracketReadModel = Readonly<{
  fixtureCount: number;
  roundCount: number;
  finalFixtureId: string;
  rounds: readonly Readonly<{
    roundNumber: number;
    fixtures: readonly V2KnockoutFixtureReadModel[];
  }>[];
}>;

export type V2GroupThenKnockoutManagementState =
  | "UNPUBLISHED"
  | "GROUP_IN_PROGRESS"
  | "READY_TO_FINALIZE"
  | "KNOCKOUT_PUBLISHED";

type V2GroupingReadMatch<TFormat extends "group_only" | "group_then_knockout"> =
  Readonly<{
    id: string;
    title: string;
    type: "single" | "double" | "team";
    status: "registration" | "ongoing" | "finished";
    format: TFormat;
    createdBy: string;
    registrationDeadline: string;
    groupingGeneratedAt: string | null;
  }>;

export type V2GroupOnlyGroupingReadModel =
  | Readonly<{ kind: "MATCH_NOT_FOUND" }>
  | Readonly<{ kind: "UNSUPPORTED_V2_MATCH" }>
  | Readonly<{
      kind: "GROUP_ONLY_V2_MATCH";
      match: V2GroupingReadMatch<"group_only">;
      activeEntries: readonly V2GroupOnlyGroupingEntry[];
      groups: readonly V2GroupOnlyGroupingGroup[];
      published: boolean;
    }>
  | Readonly<{
      kind: "GROUP_THEN_KNOCKOUT_V2_MATCH";
      match: V2GroupingReadMatch<"group_then_knockout">;
      activeEntries: readonly V2GroupOnlyGroupingEntry[];
      groups: readonly V2GroupOnlyGroupingGroup[];
      published: boolean;
      qualifiersPerGroup: number | null;
      managementState: V2GroupThenKnockoutManagementState;
      qualification: V2QualificationSnapshotReadModel | null;
      knockout: V2KnockoutBracketReadModel | null;
    }>;

export type V2CompetitionGroupingReadModel = Exclude<
  V2GroupOnlyGroupingReadModel,
  { kind: "MATCH_NOT_FOUND" | "UNSUPPORTED_V2_MATCH" }
>;

export class V2GroupOnlyGroupingReadIntegrityError extends Error {
  readonly matchId: string;
  readonly entityId: string;

  constructor(message: string, matchId: string, entityId = matchId) {
    super(message);
    this.name = "V2GroupOnlyGroupingReadIntegrityError";
    this.matchId = matchId;
    this.entityId = entityId;
  }
}

function integrity(source: Source, message: string, entityId = source.id): never {
  throw new V2GroupOnlyGroupingReadIntegrityError(message, source.id, entityId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function sourceCompetitorId(
  source: Source,
  entry: SourceEntry,
  profile: V2GroupOnlyGroupingReadProfile,
) {
  const prefix =
    profile.matchType === "single"
      ? "individual:"
      : profile.matchType === "double"
        ? "doubles:"
        : "team:";
  if (!entry.sourceKey.startsWith(prefix) || entry.sourceKey.length === prefix.length) {
    integrity(source, "An Entry has an invalid typed source identity.", entry.id);
  }
  return entry.sourceKey.slice(prefix.length);
}

function membersAtRoster(
  source: Source,
  entry: SourceEntry,
  rosterVersion: number,
  profile: V2GroupOnlyGroupingReadProfile,
) {
  const members = entry.members.filter(
    (member) => member.rosterVersion === rosterVersion,
  );
  const expectedCount =
    profile.matchType === "single" ? 1 : profile.matchType === "double" ? 2 : null;
  if (
    !Number.isSafeInteger(rosterVersion) ||
    rosterVersion < 1 ||
    members.length === 0 ||
    (expectedCount !== null && members.length !== expectedCount) ||
    new Set(members.map((member) => member.id)).size !== members.length ||
    new Set(members.map((member) => member.userId)).size !== members.length ||
    members.some(
      (member, index) =>
        member.slot !== index + 1 ||
        !member.user ||
        member.user.id !== member.userId,
    ) ||
    (profile.matchType !== "team" &&
      members.some((member) => member.role !== "player")) ||
    (profile.matchType === "team" &&
      members.filter((member) => member.role === "captain").length !== 1)
  ) {
    integrity(source, "An Entry roster snapshot is incomplete.", entry.id);
  }
  return members.map((member) => ({
    entryMemberId: member.id,
    userId: member.userId,
    frozenDisplayName: member.displayNameSnapshot,
    nickname: member.user.nickname,
    avatarUrl: member.user.avatarUrl,
    slot: member.slot,
    role: member.role,
    rosterVersion: member.rosterVersion,
    isCurrentlyBanned: member.user.isBanned,
  })) satisfies readonly V2GroupOnlyGroupingMember[];
}

function currentMembers(
  source: Source,
  entry: SourceEntry,
  profile: V2GroupOnlyGroupingReadProfile,
) {
  const current = entry.members.filter(
    (member) => member.status === "ACTIVE" && member.effectiveUntil === null,
  );
  if (entry.status !== "ACTIVE") {
    if (current.length !== 0) {
      integrity(source, "A non-active Entry retains current members.", entry.id);
    }
    return { rosterVersion: null, members: [] as const };
  }
  const rosterVersions = new Set(current.map((member) => member.rosterVersion));
  if (rosterVersions.size !== 1) {
    integrity(source, "An ACTIVE Entry spans multiple current roster versions.", entry.id);
  }
  const rosterVersion = current[0]?.rosterVersion;
  if (rosterVersion === undefined) {
    integrity(source, "An ACTIVE Entry has no current roster.", entry.id);
  }
  const latestRosterVersion = Math.max(
    ...entry.members.map((member) => member.rosterVersion),
  );
  if (rosterVersion !== latestRosterVersion) {
    integrity(source, "An ACTIVE Entry does not use its latest roster snapshot.", entry.id);
  }
  return {
    rosterVersion,
    members: membersAtRoster(source, entry, rosterVersion, profile),
  };
}

function validateSourceSnapshot(
  source: Source,
  entry: SourceEntry,
  members: readonly V2GroupOnlyGroupingMember[],
  profile: V2GroupOnlyGroupingReadProfile,
) {
  const competitorId = sourceCompetitorId(source, entry, profile);
  const memberUserIds = members.map((member) => member.userId).sort();
  const currentRoster = members[0]?.rosterVersion === Math.max(...entry.members.map(member => member.rosterVersion));
  if (profile.matchType === "single") {
    if (
      entry.kind !== "INDIVIDUAL" ||
      entry.sourceUserId !== competitorId ||
      entry.sourceDoublesTeamId !== null ||
      entry.sourceMatchTeamId !== null ||
      !entry.sourceUser ||
      entry.sourceUser.id !== competitorId ||
      memberUserIds.length !== 1 ||
      memberUserIds[0] !== competitorId
    ) {
      integrity(source, "A SINGLE Entry has an invalid source snapshot.", entry.id);
    }
  } else if (profile.matchType === "double") {
    const doubles = entry.sourceDoublesTeam;
    const sourceUserIds = doubles?.members.map((member) => member.userId).sort() ?? [];
    if (
      entry.kind !== "DOUBLES" ||
      entry.sourceUserId !== null ||
      entry.sourceDoublesTeamId !== competitorId ||
      entry.sourceMatchTeamId !== null ||
      !doubles ||
      doubles.id !== competitorId ||
      doubles.matchId !== source.id ||
      doubles.members.length !== 2 ||
      doubles.members.some(
        (member, index) =>
          member.matchId !== source.id || member.slot !== index + 1,
      ) ||
      (currentRoster && (sourceUserIds.length !== memberUserIds.length ||
      sourceUserIds.some((userId, index) => userId !== memberUserIds[index])))
    ) {
      integrity(source, "A DOUBLE Entry has an invalid source snapshot.", entry.id);
    }
  } else {
    const team = entry.sourceMatchTeam;
    const sourceUserIds = team?.members.map((member) => member.userId).sort() ?? [];
    if (
      entry.kind !== "TEAM" ||
      entry.sourceUserId !== null ||
      entry.sourceDoublesTeamId !== null ||
      entry.sourceMatchTeamId !== competitorId ||
      !team ||
      team.id !== competitorId ||
      team.matchId !== source.id ||
      team.status !== "approved" ||
      team.members.some((member) => member.matchId !== source.id) ||
      !Number.isSafeInteger(source.teamMinMembers) ||
      !Number.isSafeInteger(source.teamMaxMembers) ||
      source.teamMinMembers === null ||
      source.teamMaxMembers === null ||
      members.length < source.teamMinMembers ||
      members.length > source.teamMaxMembers ||
      (currentRoster && members.filter((member) => member.role === "captain")[0]?.userId !==
        team.captainId) ||
      (currentRoster && (sourceUserIds.length !== memberUserIds.length ||
      sourceUserIds.some((userId, index) => userId !== memberUserIds[index])))
    ) {
      integrity(source, "A TEAM Entry has an invalid source snapshot.", entry.id);
    }
  }
  return competitorId;
}

function validateActiveSource(
  source: Source,
  entry: SourceEntry,
  current: ReturnType<typeof currentMembers>,
  profile: V2GroupOnlyGroupingReadProfile,
) {
  const competitorId = validateSourceSnapshot(
    source,
    entry,
    current.members,
    profile,
  );
  const currentRows = entry.members.filter(
    (member) => member.rosterVersion === current.rosterVersion,
  );
  if (
    current.members.some((member) => member.isCurrentlyBanned) ||
    currentRows.some((member) => !member.user || !member.user.emailVerifiedAt)
  ) {
    integrity(
      source,
      "An ACTIVE Entry contains a banned or unverified member.",
      entry.id,
    );
  }
  return competitorId;
}

function parseFixtureMetadata(
  source: Source,
  fixture: Source["fixtures"][number],
  groupPosition: number,
  groupName: string,
  seedMethod: "MIN_DIFF" | "SNAKE",
  profile: V2GroupOnlyGroupingReadProfile,
) {
  const value = fixture.metadata;
  const expectedPublication =
    source.format === "group_then_knockout"
      ? profile.groupThenKnockoutPublication
      : profile.publication;
  const expectedQualifiers =
    source.format === "group_then_knockout"
      ? source.groupingResult?.qualifiersPerGroup
      : null;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "publication",
      "publicationVersion",
      "groupIndex",
      "groupName",
      "format",
      "qualifiersPerGroup",
      "seedMethod",
      "sideAPosition",
      "sideBPosition",
      "v2Display",
    ]) ||
    value.publication !== expectedPublication ||
    value.publicationVersion !== 1 ||
    value.groupIndex !== groupPosition ||
    value.groupName !== groupName ||
    value.format !== source.format ||
    value.qualifiersPerGroup !== expectedQualifiers ||
    value.seedMethod !== (seedMethod === "MIN_DIFF" ? "min_diff" : "snake") ||
    !Number.isSafeInteger(value.sideAPosition) ||
    !Number.isSafeInteger(value.sideBPosition) ||
    (value.sideAPosition as number) < 1 ||
    (value.sideBPosition as number) <= (value.sideAPosition as number)
  ) {
    integrity(source, "A GROUP Fixture has invalid publication metadata.", fixture.id);
  }
  const tableLabels = parseV2SingleGroupTableLabelsFromMetadata(value);
  if (tableLabels === null) {
    integrity(source, "A GROUP Fixture has invalid display metadata.", fixture.id);
  }
  return {
    sideAPosition: value.sideAPosition as number,
    sideBPosition: value.sideBPosition as number,
    tableLabels,
  };
}

function validateKnockoutProjection(
  source: Source,
  grouping: NonNullable<Source["groupingResult"]>,
  knockoutFixtures: readonly Source["fixtures"][number][],
  knockoutDependencies: readonly SourceDependency[],
  groups: readonly V2GroupOnlyGroupingGroup[],
  entriesById: ReadonlyMap<string, SourceEntry>,
  profile: V2GroupOnlyGroupingReadProfile,
) {
  const snapshot = grouping.qualificationSnapshot;
  if (!snapshot || knockoutFixtures.length === 0 || knockoutDependencies.length === 0) {
    integrity(
      source,
      "The qualification snapshot and knockout graph must be published atomically.",
      snapshot?.id ?? knockoutFixtures[0]?.id ?? knockoutDependencies[0]?.id,
    );
  }
  const qualifiedEntryIds = new Set(
    snapshot.standings
      .filter((standing) => standing.qualified)
      .map((standing) => standing.entryId),
  );
  const graph = {
    match: {
      id: source.id,
      engineVersion: source.engineVersion,
      isQuickMatch: source.isQuickMatch,
      status: source.status,
      format: source.format,
    },
    grouping: {
      id: grouping.id,
      matchId: grouping.matchId,
      v2SchemaVersion: grouping.v2SchemaVersion,
      standingsPolicyVersion: grouping.standingsPolicyVersion,
      qualifiersPerGroup: grouping.qualifiersPerGroup,
      bracketPolicyVersion: grouping.bracketPolicyVersion,
      groupCount: source.matchGroups.length,
    },
    snapshot: {
      id: snapshot.id,
      matchId: snapshot.matchId,
      groupingId: snapshot.groupingId,
      schemaVersion: snapshot.schemaVersion,
      standingsPolicyVersion: snapshot.standingsPolicyVersion,
      sourceRevisionFingerprint: snapshot.sourceRevisionFingerprint,
    },
    standings: snapshot.standings,
    fixtures: knockoutFixtures,
    dependencies: knockoutDependencies,
    rosterMembers: source.entries.flatMap((entry) =>
      qualifiedEntryIds.has(entry.id)
        ? entry.members.map((member) => ({
            id: member.id,
            entryId: entry.id,
            rosterVersion: member.rosterVersion,
            slot: member.slot,
          }))
        : [],
    ),
  } satisfies V2KnockoutGraphSnapshot;
  try {
    validateV2KnockoutGraph(graph);
  } catch (error) {
    if (error instanceof V2ResultApplicationError) {
      const entityId =
        typeof error.details.fixtureId === "string"
          ? error.details.fixtureId
          : typeof error.details.dependencyId === "string"
            ? error.details.dependencyId
            : snapshot.id;
      integrity(source, `The knockout graph is malformed: ${error.message}`, entityId);
    }
    throw error;
  }

  const membershipsByIdentity = new Map<
    string,
    Readonly<{
      group: V2GroupOnlyGroupingGroup;
      entry: V2GroupOnlyGroupingGroup["entries"][number];
    }>
  >(
    groups.flatMap((group) =>
      group.entries.map((entry) => [
        `${group.groupId}\u0000${entry.entryId}`,
        { group, entry },
      ] as const),
    ),
  );
  if (snapshot.standings.length !== membershipsByIdentity.size) {
    integrity(
      source,
      "The qualification snapshot does not cover every published membership exactly once.",
      snapshot.id,
    );
  }
  const seenStandingMemberships = new Set<string>();
  const seenStandingIds = new Set<string>();
  const seenQualificationOrders = new Set<number>();
  const qualificationStandings = snapshot.standings.map((standing) => {
    const identity = `${standing.groupId}\u0000${standing.entryId}`;
    const membership = membershipsByIdentity.get(identity);
    const entry = entriesById.get(standing.entryId);
    const integers = [
      standing.rank,
      standing.played,
      standing.wins,
      standing.losses,
      standing.scoreFor,
      standing.scoreAgainst,
      standing.scoreDifferential,
    ];
    if (
      seenStandingIds.has(standing.id) ||
      seenStandingMemberships.has(identity) ||
      standing.matchId !== source.id ||
      standing.snapshotId !== snapshot.id ||
      !membership ||
      !entry ||
      standing.groupEntry.rosterVersion !== membership.entry.rosterVersion ||
      integers.some((value) => !Number.isSafeInteger(value)) ||
      standing.rank < 1 ||
      standing.rank > membership.group.entries.length ||
      standing.played < 0 ||
      standing.wins < 0 ||
      standing.losses < 0 ||
      standing.scoreFor < 0 ||
      standing.scoreAgainst < 0 ||
      standing.played !== standing.wins + standing.losses ||
      standing.scoreDifferential !== standing.scoreFor - standing.scoreAgainst ||
      standing.qualified !== (standing.qualificationOrder !== null) ||
      (standing.qualificationOrder !== null &&
        (!Number.isSafeInteger(standing.qualificationOrder) ||
          standing.qualificationOrder < 1 ||
          seenQualificationOrders.has(standing.qualificationOrder))) ||
      (standing.qualified && standing.ineligibilityReason !== null) ||
      (standing.ineligibilityReason !== null &&
        (standing.ineligibilityReason.trim() === "" ||
          standing.ineligibilityReason !== standing.ineligibilityReason.trim()))
    ) {
      integrity(source, "A frozen qualification standing is malformed.", standing.id);
    }
    seenStandingIds.add(standing.id);
    seenStandingMemberships.add(identity);
    if (standing.qualificationOrder !== null) {
      seenQualificationOrders.add(standing.qualificationOrder);
    }
    const members = membersAtRoster(
      source,
      entry,
      membership.entry.rosterVersion,
      profile,
    );
    validateSourceSnapshot(source, entry, members, profile);
    return {
      standingId: standing.id,
      snapshotId: snapshot.id,
      groupId: standing.groupId,
      entryId: standing.entryId,
      frozenDisplayName: membership.entry.frozenDisplayName,
      rosterVersion: membership.entry.rosterVersion,
      members,
      rank: standing.rank,
      played: standing.played,
      wins: standing.wins,
      losses: standing.losses,
      scoreFor: standing.scoreFor,
      scoreAgainst: standing.scoreAgainst,
      scoreDifferential: standing.scoreDifferential,
      qualified: standing.qualified,
      qualificationOrder: standing.qualificationOrder,
      ineligibilityReason: standing.ineligibilityReason,
    } satisfies V2QualificationStandingReadModel;
  });
  if (
    seenStandingMemberships.size !== membershipsByIdentity.size ||
    [...seenQualificationOrders]
      .sort((left, right) => left - right)
      .some((order, index) => order !== index + 1)
  ) {
    integrity(source, "The qualification snapshot has incomplete ordering.", snapshot.id);
  }
  const groupPositionById = new Map(groups.map((group) => [group.groupId, group.position]));
  qualificationStandings.sort(
    (left, right) =>
      (groupPositionById.get(left.groupId) ?? 0) -
        (groupPositionById.get(right.groupId) ?? 0) ||
      left.rank - right.rank ||
      (left.standingId < right.standingId ? -1 : left.standingId > right.standingId ? 1 : 0),
  );

  const standingsById = new Map(
    qualificationStandings.map((standing) => [standing.standingId, standing]),
  );
  const fixturesById = new Map(knockoutFixtures.map((fixture) => [fixture.id, fixture]));
  const dependencyByTargetSide = new Map(
    knockoutDependencies.map((dependency) => [
      `${dependency.targetFixtureId}\u0000${dependency.targetSide}`,
      dependency,
    ]),
  );
  const mapSide = (
    fixture: Source["fixtures"][number],
    side: "SIDE_A" | "SIDE_B",
  ): V2KnockoutFixtureSideReadModel => {
    const dependency = dependencyByTargetSide.get(`${fixture.id}\u0000${side}`);
    if (!dependency) {
      integrity(source, "A knockout side has no authoritative feeder.", fixture.id);
    }
    const entryId = side === "SIDE_A" ? fixture.sideAEntryId : fixture.sideBEntryId;
    const rosterVersion =
      side === "SIDE_A" ? fixture.sideARosterVersion : fixture.sideBRosterVersion;
    const entry = entryId === null ? null : entriesById.get(entryId);
    if (
      (entryId === null) !== (rosterVersion === null) ||
      (entryId !== null && !entry)
    ) {
      integrity(source, "A knockout side has an invalid frozen participant.", fixture.id);
    }
    const participant =
      entryId === null || rosterVersion === null || !entry
        ? null
        : {
            entryId,
            entryStatus: entry.status,
            frozenDisplayName: entry.displayNameSnapshot,
            rosterVersion,
            members: membersAtRoster(
              source,
              entry,
              rosterVersion,
              profile,
            ),
          };
    if (participant && profile.entryKind === "DOUBLES") {
      participant.frozenDisplayName = participant.members.map(member => member.frozenDisplayName).join(" / ");
    }
    if (participant) {
      validateSourceSnapshot(
        source,
        entry!,
        participant.members,
        profile,
      );
    }
    if (dependency.sourceQualificationStandingId !== null) {
      const standing = standingsById.get(dependency.sourceQualificationStandingId);
      if (!standing?.qualified || standing.qualificationOrder === null || !participant) {
        integrity(source, "A qualifier feeder is unresolved or invalid.", dependency.id);
      }
      return {
        feeder: {
          kind: "QUALIFIER",
          dependencyId: dependency.id,
          sourceQualificationStandingId: standing.standingId,
          sourceEntryId: standing.entryId,
          sourceGroupId: standing.groupId,
          sourceRank: standing.rank,
          qualificationOrder: standing.qualificationOrder,
          resolved: true,
        },
        entry: participant,
      };
    }
    const sourceFixture = dependency.sourceFixtureId
      ? fixturesById.get(dependency.sourceFixtureId)
      : null;
    if (
      !sourceFixture ||
      dependency.sourceOutcome !== "WINNER" ||
      sourceFixture.roundNumber === null ||
      sourceFixture.position === null
    ) {
      integrity(source, "A winner feeder is invalid.", dependency.id);
    }
    return {
      feeder: {
        kind: "WINNER",
        dependencyId: dependency.id,
        sourceFixtureId: sourceFixture.id,
        sourceFixtureKey: sourceFixture.fixtureKey,
        sourceRoundNumber: sourceFixture.roundNumber,
        sourcePosition: sourceFixture.position,
        sourceOutcome: "WINNER",
        resolved: participant !== null,
        empty:
          participant === null &&
          sourceFixture.status === "VOIDED" &&
          sourceFixture.administrativeResolution?.kind === "NO_CONTEST",
      },
      entry: participant,
    };
  };

  const mappedFixtures = knockoutFixtures.map((fixture) => {
    if (
      fixture.roundNumber === null ||
      fixture.position === null
    ) {
      integrity(source, "A knockout Fixture has an invalid public shape.", fixture.id);
    }
    const tableLabels = parseV2SingleGroupTableLabelsFromMetadata(
      fixture.metadata,
    );
    if (tableLabels === null) {
      integrity(source, "A knockout Fixture has invalid display metadata.", fixture.id);
    }
    const sideA = mapSide(fixture, "SIDE_A");
    const sideB = mapSide(fixture, "SIDE_B");
    return {
      fixtureId: fixture.id,
      fixtureKey: fixture.fixtureKey,
      fixtureVersion: fixture.version,
      bestOf: fixture.bestOf,
      roundNumber: fixture.roundNumber,
      position: fixture.position,
      status: fixture.status,
      completedAt: fixture.completedAt?.toISOString() ?? null,
      startedAt: fixture.startedAt?.toISOString() ?? null,
      tableLabels,
      sideA,
      sideB,
      activeResult: resolveV2GroupOnlyActiveResult(
        fixture,
        new Map([sideA.entry, sideB.entry].filter(entry => entry !== null).map(entry => [entry.entryId, { displayNameSnapshot: entry.frozenDisplayName }])),
        (message, entityId) => integrity(source, message, entityId),
      ),
      administrativeResolution: fixture.administrativeResolution
        ? {
            resolutionId: fixture.administrativeResolution.id,
            kind: fixture.administrativeResolution.kind,
            advancingEntryId:
              fixture.administrativeResolution.advancingEntryId,
            reason: fixture.administrativeResolution.reason,
            resolvedById: fixture.administrativeResolution.resolvedById,
            resolvedByName: fixture.administrativeResolution.resolvedBy.nickname,
            resolvedAt:
              fixture.administrativeResolution.createdAt.toISOString(),
          }
        : null,
    } satisfies V2KnockoutFixtureReadModel;
  });
  mappedFixtures.sort(
    (left, right) =>
      left.roundNumber - right.roundNumber ||
      left.position - right.position ||
      (left.fixtureId < right.fixtureId ? -1 : left.fixtureId > right.fixtureId ? 1 : 0),
  );
  const roundCount = Math.max(...mappedFixtures.map((fixture) => fixture.roundNumber));
  const final = mappedFixtures.find(
    (fixture) => fixture.roundNumber === roundCount && fixture.position === 1,
  );
  if (!final) {
    integrity(source, "The knockout bracket has no terminal final Fixture.", snapshot.id);
  }
  const rounds = Array.from({ length: roundCount }, (_, index) => {
    const roundNumber = index + 1;
    return {
      roundNumber,
      fixtures: mappedFixtures.filter((fixture) => fixture.roundNumber === roundNumber),
    };
  });
  return {
    qualification: {
      snapshotId: snapshot.id,
      frozenAt: snapshot.createdAt.toISOString(),
      sourceRevisionFingerprint: snapshot.sourceRevisionFingerprint,
      standings: qualificationStandings,
    } satisfies V2QualificationSnapshotReadModel,
    knockout: {
      fixtureCount: mappedFixtures.length,
      roundCount,
      finalFixtureId: final.fixtureId,
      rounds,
    } satisfies V2KnockoutBracketReadModel,
  };
}

function build(
  source: Source | null,
  profile: V2GroupOnlyGroupingReadProfile,
  knockoutDependencies: readonly SourceDependency[],
): V2GroupOnlyGroupingReadModel {
  if (!source) return { kind: "MATCH_NOT_FOUND" };
  if (
    source.engineVersion !== "V2" ||
    source.isQuickMatch ||
    source.type !== profile.matchType ||
    (source.format !== "group_only" &&
      source.format !== "group_then_knockout")
  ) {
    return { kind: "UNSUPPORTED_V2_MATCH" };
  }

  const entriesById = new Map(source.entries.map((entry) => [entry.id, entry]));
  const activeUserIds = new Set<string>();
  const activeEntries = source.entries
    .filter((entry) => entry.status === "ACTIVE")
    .map((entry) => {
      const current = currentMembers(source, entry, profile);
      const competitorId = validateActiveSource(source, entry, current, profile);
      for (const member of current.members) {
        if (activeUserIds.has(member.userId)) {
          integrity(source, "One user appears in multiple ACTIVE Entries.", member.userId);
        }
        activeUserIds.add(member.userId);
      }
      return {
        entryId: entry.id,
        entryVersion: entry.version,
        entryStatus: entry.status,
        sourceCompetitorId: competitorId,
        frozenDisplayName: entry.displayNameSnapshot,
        currentRosterVersion: current.rosterVersion,
        currentMembers: current.members,
      } satisfies V2GroupOnlyGroupingEntry;
    });

  const grouping = source.groupingResult;
  if (!grouping) {
    if (
      source.groupingGeneratedAt !== null ||
      source.matchGroups.length > 0 ||
      source.fixtures.length > 0 ||
      knockoutDependencies.length > 0
    ) {
      integrity(source, "Relational grouping state is partially materialized.");
    }
    const match = {
      id: source.id,
      title: source.title,
      type: source.type,
      status: source.status,
      format: source.format,
      createdBy: source.createdBy,
      registrationDeadline: source.registrationDeadline.toISOString(),
      groupingGeneratedAt: null,
    };
    return source.format === "group_only"
      ? {
          kind: "GROUP_ONLY_V2_MATCH",
          match: { ...match, format: "group_only" },
          activeEntries,
          groups: [],
          published: false,
        }
      : {
          kind: "GROUP_THEN_KNOCKOUT_V2_MATCH",
          match: { ...match, format: "group_then_knockout" },
          activeEntries,
          groups: [],
          published: false,
          qualifiersPerGroup: null,
          managementState: "UNPUBLISHED",
          qualification: null,
          knockout: null,
        };
  }

  const publicationSeedMethod = grouping.seedMethod;
  const qualifiersPerGroup = grouping.qualifiersPerGroup;
  const formatPolicyIsValid =
    source.format === "group_only"
      ? qualifiersPerGroup === null && grouping.bracketPolicyVersion === null
      : Number.isSafeInteger(qualifiersPerGroup) &&
        (qualifiersPerGroup ?? 0) >= 1 &&
        grouping.bracketPolicyVersion === 1;
  if (
    grouping.matchId !== source.id ||
    source.groupingGeneratedAt === null ||
    grouping.createdAt.getTime() !== source.groupingGeneratedAt.getTime() ||
    grouping.v2SchemaVersion !== 1 ||
    (publicationSeedMethod !== "MIN_DIFF" &&
      publicationSeedMethod !== "SNAKE") ||
    grouping.standingsPolicyVersion !== 1 ||
    !formatPolicyIsValid ||
    source.matchGroups.length === 0 ||
    (source.status !== "ongoing" && source.status !== "finished")
  ) {
    integrity(source, "The group-phase publication header is inconsistent.", grouping.id);
  }
  if (
    publicationSeedMethod !== "MIN_DIFF" &&
    publicationSeedMethod !== "SNAKE"
  ) {
    integrity(source, "The group-phase seed method is unsupported.", grouping.id);
  }

  const seenGroupedEntries = new Set<string>();
  const seenFixtureIds = new Set<string>();
  const publishedMemberships: Array<{
    entryId: string;
    globalSeedRank: number;
    seedElo: number;
    seedPoints: number;
  }> = [];
  const groups = source.matchGroups.map((group, groupIndex) => {
    const position = groupIndex + 1;
    const expectedKey = `group:${String(position).padStart(4, "0")}`;
    if (
      group.matchId !== source.id ||
      group.groupingId !== grouping.id ||
      group.position !== position ||
      group.groupKey !== expectedKey ||
      group.displayName !== `第 ${position} 组` ||
      group.entries.length < 2
    ) {
      integrity(source, "A relational group is malformed.", group.id);
    }

    const entries = group.entries.map((membership, memberIndex) => {
      const entry = entriesById.get(membership.entryId);
      if (
        !entry ||
        membership.matchId !== source.id ||
        membership.groupId !== group.id ||
        membership.position !== memberIndex + 1 ||
        entry.kind !== profile.entryKind ||
        membership.entryVersion > entry.version ||
        !Number.isSafeInteger(membership.globalSeedRank) ||
        membership.globalSeedRank < 1 ||
        !Number.isSafeInteger(membership.seedElo) ||
        !Number.isSafeInteger(membership.seedPoints) ||
        membership.seedPoints < 0 ||
        seenGroupedEntries.has(entry.id)
      ) {
        integrity(source, "A relational group membership is malformed.", membership.id);
      }
      seenGroupedEntries.add(entry.id);
      const competitorId = sourceCompetitorId(source, entry, profile);
      const members = membersAtRoster(
        source,
        entry,
        membership.rosterVersion,
        profile,
      );
      validateSourceSnapshot(source, entry, members, profile);
      publishedMemberships.push({
        entryId: entry.id,
        globalSeedRank: membership.globalSeedRank,
        seedElo: membership.seedElo,
        seedPoints: membership.seedPoints,
      });
      return {
        entryId: entry.id,
        frozenDisplayName: entry.displayNameSnapshot,
        sourceCompetitorId: competitorId,
        entryVersionAtPublication: membership.entryVersion,
        rosterVersion: membership.rosterVersion,
        seedElo: membership.seedElo,
        seedPoints: membership.seedPoints,
        globalSeedRank: membership.globalSeedRank,
        members,
      };
    });
    const membershipsById = new Map(entries.map((entry) => [entry.entryId, entry]));
    const fixtures = source.fixtures.filter((fixture) => fixture.groupId === group.id);
    const expectedFixtureCount = (entries.length * (entries.length - 1)) / 2;
    const seenPairs = new Set<string>();
    let tableLabels: readonly string[] | null = null;
    const mappedFixtures = fixtures.map((fixture) => {
      if (
        seenFixtureIds.has(fixture.id) ||
        fixture.matchId !== source.id ||
        fixture.stage !== "GROUP" ||
        fixture.groupKey !== group.groupKey ||
        fixture.roundNumber !== null ||
        fixture.position !== null ||
        !fixture.sideAEntryId ||
        !fixture.sideBEntryId ||
        fixture.sideAEntryId === fixture.sideBEntryId ||
        fixture.sideARosterVersion === null ||
        fixture.sideBRosterVersion === null
      ) {
        integrity(source, "A group Fixture is structurally incomplete.", fixture.id);
      }
      seenFixtureIds.add(fixture.id);
      const sideA = membershipsById.get(fixture.sideAEntryId);
      const sideB = membershipsById.get(fixture.sideBEntryId);
      if (
        !sideA ||
        !sideB ||
        sideA.rosterVersion > fixture.sideARosterVersion ||
        sideB.rosterVersion > fixture.sideBRosterVersion
      ) {
        integrity(source, "A group Fixture references a stale membership.", fixture.id);
      }
      const fixtureSideA = { ...sideA, rosterVersion: fixture.sideARosterVersion, members: membersAtRoster(source, entriesById.get(sideA.entryId)!, fixture.sideARosterVersion, profile) };
      const fixtureSideB = { ...sideB, rosterVersion: fixture.sideBRosterVersion, members: membersAtRoster(source, entriesById.get(sideB.entryId)!, fixture.sideBRosterVersion, profile) };
      if (profile.matchType === "double") {
        fixtureSideA.frozenDisplayName = fixtureSideA.members.map(member => member.frozenDisplayName).join(" / ");
        fixtureSideB.frozenDisplayName = fixtureSideB.members.map(member => member.frozenDisplayName).join(" / ");
      }
      const metadata = parseFixtureMetadata(
        source,
        fixture,
        position,
        group.displayName,
        publicationSeedMethod,
        profile,
      );
      if (
        metadata.sideAPosition !== group.entries.find((row) => row.entryId === sideA.entryId)?.position ||
        metadata.sideBPosition !== group.entries.find((row) => row.entryId === sideB.entryId)?.position
      ) {
        integrity(source, "Fixture metadata positions disagree with the group.", fixture.id);
      }
      const expectedFixtureKey = `${group.groupKey}:pair:${String(
        metadata.sideAPosition,
      ).padStart(4, "0")}-${String(metadata.sideBPosition).padStart(4, "0")}`;
      if (fixture.fixtureKey !== expectedFixtureKey) {
        integrity(source, "A group Fixture has a non-canonical key.", fixture.id);
      }
      if (
        tableLabels !== null &&
        !sameV2GroupTableLabels(tableLabels, metadata.tableLabels)
      ) {
        integrity(source, "GROUP Fixtures disagree on table labels.", fixture.id);
      }
      tableLabels = metadata.tableLabels;
      const pairKey = [sideA.entryId, sideB.entryId].sort().join(":");
      if (seenPairs.has(pairKey)) {
        integrity(source, "A round-robin pair is duplicated.", fixture.id);
      }
      seenPairs.add(pairKey);

      for (const [side, entry] of [
        ["SIDE_A", fixtureSideA],
        ["SIDE_B", fixtureSideB],
      ] as const) {
        const actual = fixture.lineupMembers.filter((lineup) => lineup.side === side);
        if (
          actual.length !== entry.members.length ||
          actual.some(
            (lineup, index) =>
              lineup.matchId !== source.id ||
              lineup.fixtureId !== fixture.id ||
              lineup.entryId !== entry.entryId ||
              lineup.entryMemberId !== entry.members[index]?.entryMemberId ||
              lineup.position !== entry.members[index]?.slot,
          )
        ) {
          integrity(source, "A Fixture does not contain its complete frozen lineup.", fixture.id);
        }
      }
      if (fixture.lineupMembers.length !== fixtureSideA.members.length + fixtureSideB.members.length) {
        integrity(source, "A Fixture lineup contains extra members.", fixture.id);
      }
      const activeResult = resolveV2GroupOnlyActiveResult(
        fixture,
        new Map([fixtureSideA, fixtureSideB].map(entry => [entry.entryId, { displayNameSnapshot: entry.frozenDisplayName }])),
        (message, entityId) => integrity(source, message, entityId),
      );
      return {
        fixtureId: fixture.id,
        fixtureKey: fixture.fixtureKey,
        fixtureVersion: fixture.version,
      bestOf: fixture.bestOf,
      startedAt: fixture.startedAt?.toISOString() ?? null,
        status: fixture.status,
        sideA: {
          entryId: sideA.entryId,
          entryStatus: entriesById.get(sideA.entryId)?.status ??
            integrity(source, "A Fixture side references a missing Entry.", fixture.id),
          frozenDisplayName: fixtureSideA.frozenDisplayName,
          members: fixtureSideA.members,
        },
        sideB: {
          entryId: sideB.entryId,
          entryStatus: entriesById.get(sideB.entryId)?.status ??
            integrity(source, "A Fixture side references a missing Entry.", fixture.id),
          frozenDisplayName: fixtureSideB.frozenDisplayName,
          members: fixtureSideB.members,
        },
        activeResult,
      } satisfies V2GroupOnlyGroupingFixture;
    });
    if (fixtures.length !== expectedFixtureCount || seenPairs.size !== expectedFixtureCount) {
      integrity(source, "A group does not contain a complete round robin.", group.id);
    }
    return {
      groupId: group.id,
      groupKey: group.groupKey,
      displayName: group.displayName,
      position: group.position,
      tableLabels: tableLabels ?? [],
      entries,
      fixtures: mappedFixtures,
    } satisfies V2GroupOnlyGroupingGroup;
  });

  const groupFixtureRows = source.fixtures.filter(
    (fixture) => fixture.stage === "GROUP",
  );
  const knockoutFixtureRows = source.fixtures.filter(
    (fixture) => fixture.stage === "KNOCKOUT",
  );
  if (
    seenFixtureIds.size !== groupFixtureRows.length ||
    source.fixtures.length !== groupFixtureRows.length + knockoutFixtureRows.length
  ) {
    integrity(source, "A group-phase publication contains an unowned Fixture.");
  }
  if (activeEntries.some((entry) => !seenGroupedEntries.has(entry.entryId))) {
    integrity(source, "An ACTIVE Entry is missing from the published grouping.");
  }
  const rankedMemberships = [...publishedMemberships].sort(
    (left, right) =>
      right.seedElo - left.seedElo ||
      right.seedPoints - left.seedPoints ||
      (left.entryId === right.entryId ? 0 : left.entryId < right.entryId ? -1 : 1),
  );
  if (
    rankedMemberships.some(
      (membership, index) => membership.globalSeedRank !== index + 1,
    )
  ) {
    integrity(source, "Published global seed ranks are inconsistent.");
  }

  if (source.format === "group_then_knockout") {
    const totalQualified = (qualifiersPerGroup ?? 0) * groups.length;
    if (
      groups.some((group) => group.entries.length < (qualifiersPerGroup ?? 0)) ||
      totalQualified < 2 ||
      !Number.isSafeInteger(totalQualified) ||
      !Number.isInteger(Math.log2(totalQualified))
    ) {
      integrity(source, "The stored qualifier policy is inconsistent with the groups.");
    }
  }

  const snapshot = grouping.qualificationSnapshot ?? null;
  if (source.format === "group_only") {
    if (
      snapshot !== null ||
      knockoutFixtureRows.length > 0 ||
      knockoutDependencies.length > 0
    ) {
      integrity(source, "A group-only match contains knockout publication state.");
    }
  } else if (
    (snapshot !== null ||
      knockoutFixtureRows.length > 0 ||
      knockoutDependencies.length > 0) &&
    !(
      snapshot !== null &&
      knockoutFixtureRows.length > 0 &&
      knockoutDependencies.length > 0
    )
  ) {
    integrity(
      source,
      "The qualification snapshot and knockout graph are only partially materialized.",
    );
  }

  const knockoutPublication =
    source.format === "group_then_knockout" && snapshot !== null
      ? validateKnockoutProjection(
          source,
          grouping,
          knockoutFixtureRows,
          knockoutDependencies,
          groups,
          entriesById,
          profile,
        )
      : null;
  const allGroupFixturesConfirmed = groups.every((group) =>
    group.fixtures.every(
      (fixture) =>
        fixture.status === "COMPLETED" &&
        fixture.activeResult.state === "CONFIRMED",
    ),
  );

  const match = {
    id: source.id,
    title: source.title,
    type: source.type,
    status: source.status,
    format: source.format,
    createdBy: source.createdBy,
    registrationDeadline: source.registrationDeadline.toISOString(),
    groupingGeneratedAt: source.groupingGeneratedAt.toISOString(),
  };
  return source.format === "group_only"
    ? {
        kind: "GROUP_ONLY_V2_MATCH",
        match: { ...match, format: "group_only" },
        activeEntries,
        groups,
        published: true,
      }
    : {
        kind: "GROUP_THEN_KNOCKOUT_V2_MATCH",
        match: { ...match, format: "group_then_knockout" },
        activeEntries,
        groups,
        published: true,
        qualifiersPerGroup: qualifiersPerGroup!,
        managementState:
          knockoutPublication !== null
            ? "KNOCKOUT_PUBLISHED"
            : allGroupFixturesConfirmed
              ? "READY_TO_FINALIZE"
              : "GROUP_IN_PROGRESS",
        qualification: knockoutPublication?.qualification ?? null,
        knockout: knockoutPublication?.knockout ?? null,
      };
}

export async function getV2GroupOnlyGroupingReadModelInTransaction(
  tx: TransactionClient,
  matchId: string,
  profile: V2GroupOnlyGroupingReadProfile,
): Promise<V2GroupOnlyGroupingReadModel> {
  const source = await tx.match.findUnique({
    where: { id: matchId },
    select: GROUPING_SELECT,
  });
  const knockoutDependencies =
    source !== null
      ? await tx.matchFixtureDependency.findMany({
          where: { matchId },
          orderBy: { id: "asc" },
          select: KNOCKOUT_DEPENDENCY_SELECT,
        })
      : [];
  return build(source, profile, knockoutDependencies);
}

/** Reads the complete relational group phase and any atomic knockout publication. */
export async function getV2GroupOnlyGroupingReadModel(
  db: Pick<PrismaClient, "$transaction">,
  matchId: string,
  profile: V2GroupOnlyGroupingReadProfile,
): Promise<V2GroupOnlyGroupingReadModel> {
  return db.$transaction(
    (tx) => getV2GroupOnlyGroupingReadModelInTransaction(tx, matchId, profile),
    { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 10_000 },
  );
}
