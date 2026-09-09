import { Prisma, type PrismaClient } from "@prisma/client";

import {
  buildV2KnockoutBracket,
  V2KnockoutBracketError,
  type V2KnockoutSideSource,
} from "../domain/knockout-bracket";
import { parseV2SingleGroupTableLabelsFromMetadata } from "../domain/group-fixture-metadata";
import {
  V2_GROUP_ONLY_PUBLICATION_SCHEMA_VERSION,
  V2_GROUP_THEN_KNOCKOUT_BRACKET_POLICY_VERSION,
} from "./group-only-grouping";
import {
  V2_QUALIFICATION_SNAPSHOT_SCHEMA_VERSION,
  V2_QUALIFICATION_STANDINGS_POLICY_VERSION,
} from "./qualification-snapshot";
import {
  V2CompetitionApplicationError,
  runV2Transaction,
  type V2Actor,
  type V2CompetitionTransaction,
} from "./entries";

export const V2_KNOCKOUT_PUBLICATION_SCHEMA_VERSION = 1;

const MAX_IDENTIFIER_LENGTH = 191;
const MAX_GROUP_COUNT = 256;
const MAX_ENTRY_COUNT = 1_024;
const MAX_TEAM_ROSTER_SIZE = 50;
const MAX_MEMBER_HISTORY_COUNT = MAX_ENTRY_COUNT * MAX_TEAM_ROSTER_SIZE;

export type PublishV2KnockoutCommand = Readonly<{
  actor: V2Actor;
  matchId: string;
  expectedQualificationSnapshotId: string;
  expectedSourceRevisionFingerprint: string;
}>;

export type PublishV2KnockoutResult = Readonly<{
  matchId: string;
  qualificationSnapshotId: string;
  sourceRevisionFingerprint: string;
  created: boolean;
  publishedAt: Date;
  qualificationCount: number;
  roundCount: number;
  fixtureCount: number;
}>;

export type V2KnockoutPublicationApplicationService = Readonly<{
  publish(command: PublishV2KnockoutCommand): Promise<PublishV2KnockoutResult>;
}>;

export type V2KnockoutPublicationApplicationServiceDependencies = Readonly<{
  db: Pick<PrismaClient, "$transaction">;
  clock?: () => Date;
}>;

/**
 * Trusted application-layer fault seam. Production callers must not provide
 * hooks; it exists so transaction orchestration can prove rollback after the
 * first knockout write against a real database.
 */
export type V2KnockoutPublicationTransactionHooks = Readonly<{
  afterFixturesCreated?: () => void | Promise<void>;
}>;

type NormalizedCommand = PublishV2KnockoutCommand;

type MatchRow = Readonly<{
  id: string;
  title: string;
  createdBy: string;
  engineVersion: "LEGACY" | "V2";
  isQuickMatch: boolean;
  type: "single" | "double" | "team";
  status: "registration" | "ongoing" | "finished";
  format: "group_only" | "group_then_knockout";
  groupingGeneratedAt: Date | null;
  teamMinMembers: number | null;
  teamMaxMembers: number | null;
}>;

type GroupingRow = Readonly<{
  id: string;
  matchId: string;
  v2SchemaVersion: number | null;
  seedMethod: "MIN_DIFF" | "SNAKE" | null;
  standingsPolicyVersion: number | null;
  qualifiersPerGroup: number | null;
  bracketPolicyVersion: number | null;
  createdAt: Date;
}>;

type GroupRow = Readonly<{
  id: string;
  matchId: string;
  groupingId: string;
  groupKey: string;
  position: number;
}>;

type MembershipRow = Readonly<{
  id: string;
  matchId: string;
  groupId: string;
  entryId: string;
  position: number;
  globalSeedRank: number;
  entryVersion: number;
  rosterVersion: number;
}>;

type SnapshotRow = Readonly<{
  id: string;
  matchId: string;
  groupingId: string;
  schemaVersion: number;
  standingsPolicyVersion: number;
  sourceRevisionFingerprint: string;
  createdAt: Date;
}>;

type StandingRow = Readonly<{
  id: string;
  matchId: string;
  snapshotId: string;
  groupId: string;
  entryId: string;
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

type EntryRow = Readonly<{
  id: string;
  matchId: string;
  kind: "INDIVIDUAL" | "DOUBLES" | "TEAM";
  status: "DRAFT" | "ACTIVE" | "WITHDRAWN" | "DISQUALIFIED" | "ARCHIVED";
  version: number;
}>;

type MemberRow = Readonly<{
  id: string;
  matchId: string;
  entryId: string;
  userId: string;
  role: "player" | "captain" | "substitute";
  status: "ACTIVE" | "WITHDRAWN" | "REMOVED" | "DISQUALIFIED" | "SUPERSEDED";
  slot: number;
  rosterVersion: number;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
}>;

type QualifiedEntry = Readonly<{
  standingId: string;
  entryId: string;
  qualificationOrder: number;
  rosterVersion: number;
  members: readonly MemberRow[];
}>;

type FixtureRow = Readonly<{
  id: string;
  matchId: string;
  fixtureKey: string;
  stage: "GROUP" | "KNOCKOUT" | "FREE_PLAY";
  status: "SCHEDULED" | "READY" | "COMPLETED" | "VOIDED";
  groupId: string | null;
  groupKey: string | null;
  roundNumber: number | null;
  position: number | null;
  sideAEntryId: string | null;
  sideBEntryId: string | null;
  sideARosterVersion: number | null;
  sideBRosterVersion: number | null;
  scheduledAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  version: number;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
}>;

type DependencyRow = Readonly<{
  id: string;
  matchId: string;
  sourceFixtureId: string | null;
  sourceOutcome: "WINNER" | "LOSER" | null;
  sourceQualificationStandingId: string | null;
  targetFixtureId: string;
  targetSide: "SIDE_A" | "SIDE_B";
  createdAt: Date;
}>;

type LineupRow = Readonly<{
  id: string;
  matchId: string;
  fixtureId: string;
  entryId: string;
  entryMemberId: string;
  side: "SIDE_A" | "SIDE_B";
  position: number;
  createdAt: Date;
}>;

type AuditRow = Readonly<{
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  details: Prisma.JsonValue | null;
  createdAt: Date;
}>;

type UserRow = Readonly<{
  id: string;
  role: "user" | "admin";
  isBanned: boolean;
  emailVerifiedAt: Date | null;
}>;

type ExpectedFixture = Readonly<{
  fixtureKey: string;
  roundNumber: number;
  position: number;
  status: "SCHEDULED" | "READY";
  sideA: V2KnockoutSideSource;
  sideB: V2KnockoutSideSource;
}>;

function fail(
  code: V2CompetitionApplicationError["code"],
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new V2CompetitionApplicationError(code, message, details);
}

function compareIdentifiers(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPowerOfTwo(value: number) {
  return value >= 2 && (value & (value - 1)) === 0;
}

function assertStableIdentifier(value: unknown, name: string): asserts value is string {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value === value.trim() &&
    !value.includes("\u0000")
  ) {
    return;
  }
  fail("INVALID_INPUT", `${name} must be a non-empty stable identifier.`, { name });
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  name: string,
) {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length === 0) return;
  fail("INVALID_INPUT", `${name} contains unsupported fields.`, {
    name,
    unexpected,
  });
}

function normalizeCommand(command: PublishV2KnockoutCommand): NormalizedCommand {
  if (!command || typeof command !== "object") {
    fail("INVALID_INPUT", "A knockout publication command is required.");
  }
  assertOnlyKeys(
    command as Readonly<Record<string, unknown>>,
    [
      "actor",
      "matchId",
      "expectedQualificationSnapshotId",
      "expectedSourceRevisionFingerprint",
    ],
    "command",
  );
  if (
    !command.actor ||
    typeof command.actor !== "object" ||
    Array.isArray(command.actor)
  ) {
    fail("INVALID_INPUT", "actor must be an object.");
  }
  assertOnlyKeys(
    command.actor as Readonly<Record<string, unknown>>,
    ["id", "role"],
    "actor",
  );
  assertStableIdentifier(command.actor?.id, "actor.id");
  if (command.actor.role !== "user" && command.actor.role !== "admin") {
    fail("INVALID_INPUT", "actor.role is invalid.");
  }
  assertStableIdentifier(command.matchId, "matchId");
  assertStableIdentifier(
    command.expectedQualificationSnapshotId,
    "expectedQualificationSnapshotId",
  );
  if (!/^[a-f0-9]{64}$/.test(command.expectedSourceRevisionFingerprint)) {
    fail(
      "INVALID_INPUT",
      "expectedSourceRevisionFingerprint must be a lowercase SHA-256 fingerprint.",
    );
  }
  return Object.freeze({
    actor: Object.freeze({ ...command.actor }),
    matchId: command.matchId,
    expectedQualificationSnapshotId:
      command.expectedQualificationSnapshotId,
    expectedSourceRevisionFingerprint:
      command.expectedSourceRevisionFingerprint,
  });
}

function expectedEntryKind(matchType: MatchRow["type"]) {
  if (matchType === "single") return "INDIVIDUAL" as const;
  if (matchType === "double") return "DOUBLES" as const;
  return "TEAM" as const;
}

function auditAction(matchType: MatchRow["type"]) {
  if (matchType === "single") return "v2_single_knockout_publish";
  if (matchType === "double") return "v2_double_knockout_publish";
  return "v2_team_knockout_publish";
}

const KNOCKOUT_AUDIT_ACTIONS = [
  "v2_single_knockout_publish",
  "v2_double_knockout_publish",
  "v2_team_knockout_publish",
] as const;

function publicationMetadata(
  snapshot: SnapshotRow,
  publishedAt: Date,
  fixture: Pick<ExpectedFixture, "roundNumber" | "position">,
): Prisma.InputJsonObject {
  return {
    publication: "V2_KNOCKOUT_BRACKET",
    schemaVersion: V2_KNOCKOUT_PUBLICATION_SCHEMA_VERSION,
    bracketPolicyVersion: V2_GROUP_THEN_KNOCKOUT_BRACKET_POLICY_VERSION,
    qualificationSnapshotId: snapshot.id,
    sourceRevisionFingerprint: snapshot.sourceRevisionFingerprint,
    roundNumber: fixture.roundNumber,
    position: fixture.position,
    publishedAt: publishedAt.toISOString(),
  };
}

function metadataMatches(
  value: Prisma.JsonValue | null,
  snapshot: SnapshotRow,
  fixture: Pick<ExpectedFixture, "roundNumber" | "position">,
  publishedAt: Date,
) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const expected = publicationMetadata(snapshot, publishedAt, fixture);
  const keys = Object.keys(value)
    .filter((key) => key !== "v2Display")
    .sort();
  const expectedKeys = Object.keys(expected).sort();
  const tableLabels = parseV2SingleGroupTableLabelsFromMetadata(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index]) &&
    expectedKeys.every((key) => value[key] === expected[key]) &&
    tableLabels !== null
  );
}

function publicationAuditMatches(
  audit: AuditRow,
  match: MatchRow,
  snapshot: SnapshotRow,
  publishedAt: Date,
  qualificationCount: number,
  roundCount: number,
  fixtureCount: number,
) {
  if (
    audit.action !== auditAction(match.type) ||
    audit.entityType !== "Match" ||
    audit.entityId !== match.id ||
    !Number.isFinite(audit.createdAt.getTime()) ||
    audit.createdAt.getTime() !== publishedAt.getTime() ||
    audit.details === null ||
    typeof audit.details !== "object" ||
    Array.isArray(audit.details)
  ) {
    return false;
  }
  const details = audit.details;
  const expectedKeys = [
    "targetLabel",
    "qualificationSnapshotId",
    "sourceRevisionFingerprint",
    "publicationSchemaVersion",
    "bracketPolicyVersion",
    "qualificationCount",
    "roundCount",
    "fixtureCount",
    "publishedAt",
  ].sort();
  const actualKeys = Object.keys(details).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    details.targetLabel === match.title &&
    details.qualificationSnapshotId === snapshot.id &&
    details.sourceRevisionFingerprint === snapshot.sourceRevisionFingerprint &&
    details.publicationSchemaVersion === V2_KNOCKOUT_PUBLICATION_SCHEMA_VERSION &&
    details.bracketPolicyVersion ===
      V2_GROUP_THEN_KNOCKOUT_BRACKET_POLICY_VERSION &&
    details.qualificationCount === qualificationCount &&
    details.roundCount === roundCount &&
    details.fixtureCount === fixtureCount &&
    details.publishedAt === publishedAt.toISOString()
  );
}

async function lockPublicationAggregate(
  tx: V2CompetitionTransaction,
  matchId: string,
) {
  const matches = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Match" WHERE "id" = ${matchId} FOR UPDATE
  `);
  if (matches.length === 0) {
    fail("MATCH_NOT_FOUND", "The match does not exist.", { matchId });
  }
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "MatchGrouping"
    WHERE "matchId" = ${matchId} ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "match_group"
    WHERE "match_id" = ${matchId} ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "match_group_entry"
    WHERE "match_id" = ${matchId} ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "match_qualification_snapshot"
    WHERE "match_id" = ${matchId} ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "match_qualification_standing"
    WHERE "match_id" = ${matchId} ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "match_entry"
    WHERE "match_id" = ${matchId} ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "match_entry_member"
    WHERE "match_id" = ${matchId} ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "match_fixture"
    WHERE "match_id" = ${matchId} ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "match_fixture_dependency"
    WHERE "match_id" = ${matchId} ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "match_fixture_lineup_member"
    WHERE "match_id" = ${matchId} ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT revision."id"
    FROM "result_revision" AS revision
    INNER JOIN "match_fixture" AS fixture ON fixture."id" = revision."fixture_id"
    WHERE fixture."match_id" = ${matchId} AND fixture."stage" = 'KNOCKOUT'
    ORDER BY revision."id" FOR UPDATE OF revision
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "AuditLog"
    WHERE "entityType" = 'Match' AND "entityId" = ${matchId}
    ORDER BY "id" FOR UPDATE
  `);
}

async function lockAndLoadUsers(
  tx: V2CompetitionTransaction,
  command: NormalizedCommand,
  participantUserIds: readonly string[],
) {
  const userIds = [...new Set([command.actor.id, ...participantUserIds])].sort(
    compareIdentifiers,
  );
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "User"
    WHERE "id" IN (${Prisma.join(userIds)})
    ORDER BY "id" FOR UPDATE
  `);
  if (
    locked.length !== userIds.length ||
    locked
      .map((row) => row.id)
      .sort(compareIdentifiers)
      .some((id, index) => id !== userIds[index])
  ) {
    fail("ACTOR_NOT_ACTIVE", "The actor or a qualified roster user is missing.");
  }
  const users = (await tx.user.findMany({
    where: { id: { in: userIds } },
    orderBy: { id: "asc" },
    select: { id: true, role: true, isBanned: true, emailVerifiedAt: true },
  })) as readonly UserRow[];
  if (users.length !== userIds.length) {
    fail("PERSISTENCE_CONFLICT", "The locked user set changed.");
  }
  const byId = new Map(users.map((user) => [user.id, user]));
  const actor = byId.get(command.actor.id);
  if (!actor || actor.isBanned || actor.emailVerifiedAt === null) {
    fail("ACTOR_NOT_ACTIVE", "The actor is missing, banned, or unverified.", {
      actorId: command.actor.id,
    });
  }
  if (actor.role !== command.actor.role) {
    fail("ACTOR_ROLE_STALE", "The supplied actor role is stale.", {
      actorId: actor.id,
    });
  }
  const unavailable = participantUserIds.filter((userId) => {
    const user = byId.get(userId);
    return !user || user.isBanned || user.emailVerifiedAt === null;
  });
  if (unavailable.length > 0) {
    fail(
      "FIXTURE_ENTRY_INVALID",
      "A qualified Entry contains a banned, unverified, or missing roster user.",
      { unavailableUserIds: [...new Set(unavailable)].sort(compareIdentifiers) },
    );
  }
  return actor;
}

function fixturePairKey(left: string, right: string) {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function validateFrozenGroupTopology(
  match: MatchRow,
  groups: readonly GroupRow[],
  memberships: readonly MembershipRow[],
  fixtures: readonly FixtureRow[],
) {
  if (fixtures.some((fixture) => fixture.stage === "FREE_PLAY")) {
    fail("PERSISTENCE_CONFLICT", "A grouped knockout match contains FREE_PLAY fixtures.");
  }
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const membershipsByGroup = new Map<string, MembershipRow[]>();
  const membershipByEntry = new Map(memberships.map((row) => [row.entryId, row]));
  for (const membership of memberships) {
    const rows = membershipsByGroup.get(membership.groupId) ?? [];
    rows.push(membership);
    membershipsByGroup.set(membership.groupId, rows);
  }
  const expectedPairsByGroup = new Map<string, Set<string>>();
  let expectedCount = 0;
  for (const group of groups) {
    const entries = (membershipsByGroup.get(group.id) ?? []).map((row) => row.entryId);
    const pairs = new Set<string>();
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        pairs.add(fixturePairKey(entries[left], entries[right]));
      }
    }
    expectedPairsByGroup.set(group.id, pairs);
    expectedCount += pairs.size;
  }
  const groupFixtures = fixtures.filter((fixture) => fixture.stage === "GROUP");
  if (groupFixtures.length !== expectedCount) {
    fail("PERSISTENCE_CONFLICT", "The relational GROUP fixture set is incomplete.", {
      expectedFixtureCount: expectedCount,
      actualFixtureCount: groupFixtures.length,
    });
  }
  const actualPairsByGroup = new Map<string, Set<string>>();
  for (const fixture of groupFixtures) {
    const group = fixture.groupId === null ? undefined : groupById.get(fixture.groupId);
    const sideA = fixture.sideAEntryId === null
      ? undefined
      : membershipByEntry.get(fixture.sideAEntryId);
    const sideB = fixture.sideBEntryId === null
      ? undefined
      : membershipByEntry.get(fixture.sideBEntryId);
    if (
      fixture.matchId !== match.id ||
      !group ||
      fixture.groupKey !== group.groupKey ||
      fixture.roundNumber !== null ||
      fixture.position !== null ||
      (fixture.status !== "COMPLETED" && fixture.status !== "VOIDED") ||
      !sideA ||
      !sideB ||
      sideA.groupId !== group.id ||
      sideB.groupId !== group.id ||
      sideA.entryId === sideB.entryId ||
      (fixture.sideARosterVersion ?? 0) < sideA.rosterVersion ||
      (fixture.sideBRosterVersion ?? 0) < sideB.rosterVersion
    ) {
      fail("PERSISTENCE_CONFLICT", "A relational GROUP fixture is invalid.", {
        fixtureId: fixture.id,
      });
    }
    const pair = fixturePairKey(sideA.entryId, sideB.entryId);
    const expectedPairs = expectedPairsByGroup.get(group.id)!;
    const actualPairs = actualPairsByGroup.get(group.id) ?? new Set<string>();
    if (!expectedPairs.has(pair) || actualPairs.has(pair)) {
      fail("PERSISTENCE_CONFLICT", "A GROUP fixture pairing is missing or duplicated.", {
        fixtureId: fixture.id,
      });
    }
    actualPairs.add(pair);
    actualPairsByGroup.set(group.id, actualPairs);
  }
  for (const [groupId, expectedPairs] of expectedPairsByGroup) {
    if ((actualPairsByGroup.get(groupId)?.size ?? 0) !== expectedPairs.size) {
      fail("PERSISTENCE_CONFLICT", "A group does not contain every expected pairing.", {
        groupId,
      });
    }
  }
}

function validateMatchAndGrouping(
  match: MatchRow,
  grouping: GroupingRow,
  groups: readonly GroupRow[],
) {
  if (
    match.engineVersion !== "V2" ||
    match.isQuickMatch ||
    match.status !== "ongoing" ||
    match.format !== "group_then_knockout" ||
    match.groupingGeneratedAt === null
  ) {
    fail(
      "FIXTURE_CREATION_NOT_ALLOWED",
      "Knockout publication requires an ongoing formal V2 group-then-knockout match.",
      {
        engineVersion: match.engineVersion,
        isQuickMatch: match.isQuickMatch,
        matchStatus: match.status,
        format: match.format,
      },
    );
  }
  if (
    grouping.matchId !== match.id ||
    grouping.v2SchemaVersion !== V2_GROUP_ONLY_PUBLICATION_SCHEMA_VERSION ||
    (grouping.seedMethod !== "MIN_DIFF" && grouping.seedMethod !== "SNAKE") ||
    grouping.standingsPolicyVersion !==
      V2_QUALIFICATION_STANDINGS_POLICY_VERSION ||
    grouping.bracketPolicyVersion !==
      V2_GROUP_THEN_KNOCKOUT_BRACKET_POLICY_VERSION ||
    !isPositiveInteger(grouping.qualifiersPerGroup) ||
    grouping.createdAt.getTime() !== match.groupingGeneratedAt.getTime() ||
    groups.length < 1 ||
    groups.length > MAX_GROUP_COUNT
  ) {
    fail(
      "PERSISTENCE_CONFLICT",
      "The match has no supported complete relational group-then-knockout publication.",
      { matchId: match.id, groupingId: grouping.id },
    );
  }
  const seen = new Set<string>();
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (
      group.matchId !== match.id ||
      group.groupingId !== grouping.id ||
      group.position !== index + 1 ||
      seen.has(group.id)
    ) {
      fail("PERSISTENCE_CONFLICT", "The relational group set is incomplete.", {
        groupId: group.id,
      });
    }
    seen.add(group.id);
  }
}

function validateSnapshot(
  command: NormalizedCommand,
  match: MatchRow,
  grouping: GroupingRow,
  snapshots: readonly SnapshotRow[],
) {
  if (snapshots.length !== 1) {
    fail("PERSISTENCE_CONFLICT", "The match must have exactly one qualification snapshot.", {
      snapshotCount: snapshots.length,
    });
  }
  const snapshot = snapshots[0];
  if (
    snapshot.id !== command.expectedQualificationSnapshotId ||
    snapshot.sourceRevisionFingerprint !==
      command.expectedSourceRevisionFingerprint
  ) {
    fail(
      "FIXTURE_VERSION_CONFLICT",
      "The qualification snapshot changed after it was read.",
      {
        expectedQualificationSnapshotId:
          command.expectedQualificationSnapshotId,
        actualQualificationSnapshotId: snapshot.id,
      },
    );
  }
  if (
    snapshot.matchId !== match.id ||
    snapshot.groupingId !== grouping.id ||
    snapshot.schemaVersion !== V2_QUALIFICATION_SNAPSHOT_SCHEMA_VERSION ||
    snapshot.standingsPolicyVersion !==
      V2_QUALIFICATION_STANDINGS_POLICY_VERSION ||
    !/^[a-f0-9]{64}$/.test(snapshot.sourceRevisionFingerprint) ||
    snapshot.createdAt.getTime() < grouping.createdAt.getTime()
  ) {
    fail("PERSISTENCE_CONFLICT", "The qualification snapshot is incomplete or unsupported.", {
      snapshotId: snapshot.id,
    });
  }
  return snapshot;
}

function validateMembershipsAndStandings(
  match: MatchRow,
  grouping: GroupingRow,
  groups: readonly GroupRow[],
  memberships: readonly MembershipRow[],
  snapshot: SnapshotRow,
  standings: readonly StandingRow[],
) {
  if (
    memberships.length < 2 ||
    memberships.length > MAX_ENTRY_COUNT ||
    standings.length !== memberships.length
  ) {
    fail("PERSISTENCE_CONFLICT", "Qualification does not cover the complete grouping.");
  }
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const membershipByEntry = new Map<string, MembershipRow>();
  const membershipByGroup = new Map<string, MembershipRow[]>();
  const seedRanks = new Set<number>();
  for (const membership of memberships) {
    const rows = membershipByGroup.get(membership.groupId) ?? [];
    if (
      membership.matchId !== match.id ||
      !groupById.has(membership.groupId) ||
      membershipByEntry.has(membership.entryId) ||
      seedRanks.has(membership.globalSeedRank) ||
      !isNonNegativeInteger(membership.entryVersion) ||
      !isPositiveInteger(membership.rosterVersion)
    ) {
      fail("PERSISTENCE_CONFLICT", "A relational group membership is invalid.", {
        membershipId: membership.id,
      });
    }
    membershipByEntry.set(membership.entryId, membership);
    seedRanks.add(membership.globalSeedRank);
    rows.push(membership);
    membershipByGroup.set(membership.groupId, rows);
  }
  const orderedSeeds = [...seedRanks].sort((left, right) => left - right);
  if (orderedSeeds.some((rank, index) => rank !== index + 1)) {
    fail("PERSISTENCE_CONFLICT", "Global grouping seed ranks are not contiguous.");
  }
  for (const group of groups) {
    const rows = (membershipByGroup.get(group.id) ?? []).sort(
      (left, right) => left.position - right.position,
    );
    if (
      rows.length < 2 ||
      rows.some((membership, index) => membership.position !== index + 1)
    ) {
      fail("PERSISTENCE_CONFLICT", "A relational group membership is incomplete.", {
        groupId: group.id,
      });
    }
  }

  const standingByEntry = new Map<string, StandingRow>();
  const standingsByGroup = new Map<string, StandingRow[]>();
  for (const standing of standings) {
    const membership = membershipByEntry.get(standing.entryId);
    if (
      standing.matchId !== match.id ||
      standing.snapshotId !== snapshot.id ||
      membership === undefined ||
      membership.groupId !== standing.groupId ||
      standingByEntry.has(standing.entryId) ||
      !isPositiveInteger(standing.rank) ||
      !isNonNegativeInteger(standing.played) ||
      !isNonNegativeInteger(standing.wins) ||
      !isNonNegativeInteger(standing.losses) ||
      standing.played !== standing.wins + standing.losses ||
      !isNonNegativeInteger(standing.scoreFor) ||
      !isNonNegativeInteger(standing.scoreAgainst) ||
      standing.scoreDifferential !==
        standing.scoreFor - standing.scoreAgainst ||
      (standing.qualified !== (standing.qualificationOrder !== null)) ||
      (standing.qualified && standing.ineligibilityReason !== null) ||
      (!standing.qualified &&
        standing.ineligibilityReason !== null &&
        standing.ineligibilityReason.trim() === "")
    ) {
      fail("PERSISTENCE_CONFLICT", "A qualification standing is invalid.", {
        standingId: standing.id,
      });
    }
    standingByEntry.set(standing.entryId, standing);
    const rows = standingsByGroup.get(standing.groupId) ?? [];
    rows.push(standing);
    standingsByGroup.set(standing.groupId, rows);
  }
  if (standingByEntry.size !== memberships.length) {
    fail("PERSISTENCE_CONFLICT", "Qualification standings are incomplete.");
  }

  const qualified: StandingRow[] = [];
  for (const group of groups) {
    const rows = (standingsByGroup.get(group.id) ?? []).sort(
      (left, right) => left.rank - right.rank || compareIdentifiers(left.entryId, right.entryId),
    );
    if (
      rows.length !== (membershipByGroup.get(group.id) ?? []).length ||
      rows.some((standing, index) => standing.rank !== index + 1)
    ) {
      fail("PERSISTENCE_CONFLICT", "A group's qualification ranks are incomplete.", {
        groupId: group.id,
      });
    }
    const firstIneligibleIndex = rows.findIndex(
      (standing) => standing.ineligibilityReason !== null,
    );
    if (
      (firstIneligibleIndex >= 0 &&
        rows
          .slice(firstIneligibleIndex)
          .some((standing) => standing.ineligibilityReason === null)) ||
      rows
        .filter((standing) => standing.ineligibilityReason !== null)
        .some(
          (standing) =>
            standing.played !== 0 ||
            standing.wins !== 0 ||
            standing.losses !== 0 ||
            standing.scoreFor !== 0 ||
            standing.scoreAgainst !== 0 ||
            standing.scoreDifferential !== 0,
        )
    ) {
      fail(
        "PERSISTENCE_CONFLICT",
        "Ineligible standings must follow eligible rankings with zero results.",
        { groupId: group.id },
      );
    }
    const eligible = rows.filter((standing) => standing.ineligibilityReason === null);
    const expectedQualified = eligible.slice(0, grouping.qualifiersPerGroup!);
    if (
      expectedQualified.length !== grouping.qualifiersPerGroup ||
      rows.filter((standing) => standing.qualified).length !==
        grouping.qualifiersPerGroup ||
      expectedQualified.some((standing) => !standing.qualified) ||
      eligible.slice(grouping.qualifiersPerGroup!).some((standing) => standing.qualified)
    ) {
      fail("PERSISTENCE_CONFLICT", "A group has an invalid qualifier decision.", {
        groupId: group.id,
      });
    }
    qualified.push(...expectedQualified);
  }
  if (!isPowerOfTwo(qualified.length) || qualified.length > MAX_ENTRY_COUNT) {
    fail("PERSISTENCE_CONFLICT", "The qualifier count is not a supported power of two.", {
      qualificationCount: qualified.length,
    });
  }
  const expectedOrder = [...qualified].sort((left, right) => {
    const leftGroup = groupById.get(left.groupId)!;
    const rightGroup = groupById.get(right.groupId)!;
    return (
      left.rank - right.rank ||
      leftGroup.position - rightGroup.position ||
      compareIdentifiers(left.entryId, right.entryId)
    );
  });
  if (
    expectedOrder.some(
      (standing, index) => standing.qualificationOrder !== index + 1,
    )
  ) {
    fail("PERSISTENCE_CONFLICT", "Qualification order is not deterministic or contiguous.");
  }
  return { membershipByEntry, qualified: expectedOrder };
}

function validateQualifiedRosters(
  match: MatchRow,
  grouping: GroupingRow,
  memberships: ReadonlyMap<string, MembershipRow>,
  qualifiedStandings: readonly StandingRow[],
  entries: readonly EntryRow[],
  memberHistory: readonly MemberRow[],
) {
  const expectedKind = expectedEntryKind(match.type);
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  if (entriesById.size !== qualifiedStandings.length) {
    fail("PERSISTENCE_CONFLICT", "A qualified Entry is missing or duplicated.");
  }
  const membersByEntry = new Map<string, MemberRow[]>();
  for (const member of memberHistory) {
    if (member.matchId !== match.id || !entriesById.has(member.entryId)) {
      fail("PERSISTENCE_CONFLICT", "Qualified Entry member history is polluted.", {
        entryMemberId: member.id,
      });
    }
    const rows = membersByEntry.get(member.entryId) ?? [];
    rows.push(member);
    membersByEntry.set(member.entryId, rows);
  }
  const seenUsers = new Set<string>();
  const qualifiedEntries: QualifiedEntry[] = [];
  for (const standing of qualifiedStandings) {
    const entry = entriesById.get(standing.entryId);
    const membership = memberships.get(standing.entryId)!;
    if (
      !entry ||
      entry.matchId !== match.id ||
      entry.kind !== expectedKind ||
      entry.status !== "ACTIVE" ||
      !isNonNegativeInteger(entry.version) ||
      entry.version < membership.entryVersion
    ) {
      fail("FIXTURE_ENTRY_INVALID", "A qualified Entry is no longer active or compatible.", {
        entryId: standing.entryId,
      });
    }
    const history = membersByEntry.get(entry.id) ?? [];
    const current = history.filter(
      (member) => member.status === "ACTIVE" && member.effectiveUntil === null,
    );
    const currentVersion = current[0]?.rosterVersion ?? 0;
    const roster = [...current].sort((left, right) => left.slot - right.slot || compareIdentifiers(left.id, right.id));
    const memberIds = new Set<string>();
    const rosterUsers = new Set<string>();
    if (
      roster.length === 0 ||
      current.length !== roster.length ||
      currentVersion < membership.rosterVersion ||
      current.some((member) => member.rosterVersion !== currentVersion)
    ) {
      fail("FIXTURE_ENTRY_INVALID", "A qualified Entry no longer has its pinned active roster.", {
        entryId: entry.id,
        rosterVersion: membership.rosterVersion,
      });
    }
    for (let index = 0; index < roster.length; index += 1) {
      const member = roster[index];
      if (
        member.status !== "ACTIVE" ||
        member.effectiveUntil !== null ||
        !Number.isFinite(member.effectiveFrom.getTime()) ||
        member.slot !== index + 1 ||
        memberIds.has(member.id) ||
        rosterUsers.has(member.userId) ||
        seenUsers.has(member.userId)
      ) {
        fail("FIXTURE_ENTRY_INVALID", "A qualified pinned roster is structurally invalid.", {
          entryId: entry.id,
          entryMemberId: member.id,
        });
      }
      memberIds.add(member.id);
      rosterUsers.add(member.userId);
      seenUsers.add(member.userId);
    }
    const validShape =
      (match.type === "single" &&
        roster.length === 1 &&
        roster[0]?.role === "player") ||
      (match.type === "double" &&
        roster.length === 2 &&
        roster.every((member) => member.role === "player")) ||
      (match.type === "team" &&
        isPositiveInteger(match.teamMinMembers) &&
        isPositiveInteger(match.teamMaxMembers) &&
        match.teamMaxMembers >= match.teamMinMembers &&
        match.teamMaxMembers <= MAX_TEAM_ROSTER_SIZE &&
        roster.length >= match.teamMinMembers &&
        roster.length <= match.teamMaxMembers &&
        roster.filter((member) => member.role === "captain").length === 1);
    if (!validShape) {
      fail("FIXTURE_ENTRY_INVALID", "A qualified Entry has an invalid roster shape.", {
        entryId: entry.id,
      });
    }
    qualifiedEntries.push({
      standingId: standing.id,
      entryId: standing.entryId,
      qualificationOrder: standing.qualificationOrder!,
      rosterVersion: currentVersion,
      members: roster,
    });
  }
  return qualifiedEntries;
}

function expectedFixtureSide(
  source: V2KnockoutSideSource,
  qualifiedByStanding: ReadonlyMap<string, QualifiedEntry>,
) {
  if (source.kind === "WINNER") {
    return { entryId: null, rosterVersion: null } as const;
  }
  const qualified = qualifiedByStanding.get(source.standingId);
  if (
    !qualified ||
    qualified.entryId !== source.entryId ||
    qualified.rosterVersion !== source.rosterVersion ||
    qualified.qualificationOrder !== source.qualificationOrder
  ) {
    fail("PERSISTENCE_CONFLICT", "The knockout graph lost a qualification source.", {
      standingId: source.standingId,
    });
  }
  return {
    entryId: qualified.entryId,
    rosterVersion: qualified.rosterVersion,
  } as const;
}

function dependencyIdentity(
  targetFixtureKey: string,
  targetSide: "SIDE_A" | "SIDE_B",
  source: V2KnockoutSideSource,
) {
  return source.kind === "QUALIFIER"
    ? `${targetFixtureKey}:${targetSide}:QUALIFIER:${source.standingId}`
    : `${targetFixtureKey}:${targetSide}:WINNER:${source.fixtureKey}`;
}

function expectedLineupIdentity(
  fixtureKey: string,
  side: "SIDE_A" | "SIDE_B",
  qualified: QualifiedEntry,
  member: MemberRow,
) {
  return `${fixtureKey}:${side}:${member.slot}:${qualified.entryId}:${member.id}`;
}

function validateExactInitialPublication(input: Readonly<{
  match: MatchRow;
  snapshot: SnapshotRow;
  expectedFixtures: readonly ExpectedFixture[];
  qualifiedEntries: readonly QualifiedEntry[];
  fixtures: readonly FixtureRow[];
  dependencies: readonly DependencyRow[];
  lineups: readonly LineupRow[];
  audits: readonly AuditRow[];
  knockoutResultCount: number;
}>) {
  if (
    input.fixtures.length !== input.expectedFixtures.length ||
    input.knockoutResultCount !== 0
  ) {
    return null;
  }
  const expectedByKey = new Map(
    input.expectedFixtures.map((fixture) => [fixture.fixtureKey, fixture]),
  );
  const actualByKey = new Map(input.fixtures.map((fixture) => [fixture.fixtureKey, fixture]));
  if (actualByKey.size !== expectedByKey.size) return null;
  const publishedAt = input.fixtures[0]?.createdAt;
  if (!publishedAt || !Number.isFinite(publishedAt.getTime())) return null;
  const qualifiedByStanding = new Map(
    input.qualifiedEntries.map((entry) => [entry.standingId, entry]),
  );
  for (const [key, expected] of expectedByKey) {
    const actual = actualByKey.get(key);
    if (!actual) return null;
    const sideA = expectedFixtureSide(expected.sideA, qualifiedByStanding);
    const sideB = expectedFixtureSide(expected.sideB, qualifiedByStanding);
    const hasDisplayMetadata = Boolean(
      actual.metadata &&
        typeof actual.metadata === "object" &&
        !Array.isArray(actual.metadata) &&
        Object.hasOwn(actual.metadata, "v2Display"),
    );
    const hasValidPublicationOnlyVersion = hasDisplayMetadata
      ? actual.version >= 1 &&
        actual.updatedAt.getTime() >= actual.createdAt.getTime()
      : actual.version === 0 &&
        actual.updatedAt.getTime() === actual.createdAt.getTime();
    if (
      actual.matchId !== input.snapshot.matchId ||
      actual.stage !== "KNOCKOUT" ||
      actual.status !== expected.status ||
      actual.groupId !== null ||
      actual.groupKey !== null ||
      actual.roundNumber !== expected.roundNumber ||
      actual.position !== expected.position ||
      actual.sideAEntryId !== sideA.entryId ||
      actual.sideBEntryId !== sideB.entryId ||
      actual.sideARosterVersion !== sideA.rosterVersion ||
      actual.sideBRosterVersion !== sideB.rosterVersion ||
      actual.scheduledAt !== null ||
      actual.startedAt !== null ||
      actual.completedAt !== null ||
      actual.createdAt.getTime() !== publishedAt.getTime() ||
      !hasValidPublicationOnlyVersion ||
      !metadataMatches(actual.metadata, input.snapshot, expected, publishedAt)
    ) {
      return null;
    }
  }

  const fixtureKeyById = new Map(input.fixtures.map((fixture) => [fixture.id, fixture.fixtureKey]));
  const expectedDependencies = new Set<string>();
  for (const fixture of input.expectedFixtures) {
    expectedDependencies.add(dependencyIdentity(fixture.fixtureKey, "SIDE_A", fixture.sideA));
    expectedDependencies.add(dependencyIdentity(fixture.fixtureKey, "SIDE_B", fixture.sideB));
  }
  const actualDependencies = new Set<string>();
  for (const dependency of input.dependencies) {
    const targetKey = fixtureKeyById.get(dependency.targetFixtureId);
    let identity: string | null = null;
    if (
      dependency.matchId === input.snapshot.matchId &&
      targetKey &&
      dependency.createdAt.getTime() === publishedAt.getTime()
    ) {
      if (
        dependency.sourceQualificationStandingId !== null &&
        dependency.sourceFixtureId === null &&
        dependency.sourceOutcome === null
      ) {
        identity = `${targetKey}:${dependency.targetSide}:QUALIFIER:${dependency.sourceQualificationStandingId}`;
      } else if (
        dependency.sourceQualificationStandingId === null &&
        dependency.sourceFixtureId !== null &&
        dependency.sourceOutcome === "WINNER"
      ) {
        const sourceKey = fixtureKeyById.get(dependency.sourceFixtureId);
        if (sourceKey) {
          identity = `${targetKey}:${dependency.targetSide}:WINNER:${sourceKey}`;
        }
      }
    }
    if (!identity || actualDependencies.has(identity)) return null;
    actualDependencies.add(identity);
  }
  if (
    actualDependencies.size !== expectedDependencies.size ||
    [...actualDependencies].some((identity) => !expectedDependencies.has(identity))
  ) {
    return null;
  }

  const expectedLineups = new Set<string>();
  for (const fixture of input.expectedFixtures) {
    for (const [side, source] of [
      ["SIDE_A", fixture.sideA],
      ["SIDE_B", fixture.sideB],
    ] as const) {
      if (source.kind !== "QUALIFIER") continue;
      const qualified = qualifiedByStanding.get(source.standingId)!;
      for (const member of qualified.members) {
        expectedLineups.add(
          expectedLineupIdentity(fixture.fixtureKey, side, qualified, member),
        );
      }
    }
  }
  const actualLineups = new Set<string>();
  for (const lineup of input.lineups) {
    const key = fixtureKeyById.get(lineup.fixtureId);
    if (
      !key ||
      lineup.matchId !== input.snapshot.matchId ||
      lineup.createdAt.getTime() !== publishedAt.getTime()
    ) {
      return null;
    }
    const identity = `${key}:${lineup.side}:${lineup.position}:${lineup.entryId}:${lineup.entryMemberId}`;
    if (actualLineups.has(identity)) return null;
    actualLineups.add(identity);
  }
  if (
    actualLineups.size !== expectedLineups.size ||
    [...actualLineups].some((identity) => !expectedLineups.has(identity))
  ) {
    return null;
  }
  const roundCount = Math.max(
    ...input.expectedFixtures.map((fixture) => fixture.roundNumber),
  );
  if (
    input.audits.length !== 1 ||
    !publicationAuditMatches(
      input.audits[0]!,
      input.match,
      input.snapshot,
      publishedAt,
      input.qualifiedEntries.length,
      roundCount,
      input.expectedFixtures.length,
    )
  ) {
    return null;
  }
  return publishedAt;
}

async function publishInTransaction(
  tx: V2CompetitionTransaction,
  command: NormalizedCommand,
  clock: () => Date,
  hooks: V2KnockoutPublicationTransactionHooks = {},
): Promise<PublishV2KnockoutResult> {
  await lockPublicationAggregate(tx, command.matchId);
  const match = (await tx.match.findUnique({
    where: { id: command.matchId },
    select: {
      id: true,
      title: true,
      createdBy: true,
      engineVersion: true,
      isQuickMatch: true,
      type: true,
      status: true,
      format: true,
      groupingGeneratedAt: true,
      teamMinMembers: true,
      teamMaxMembers: true,
    },
  })) as MatchRow | null;
  if (!match) fail("MATCH_NOT_FOUND", "The locked match disappeared.");
  const grouping = (await tx.matchGrouping.findUnique({
    where: { matchId: command.matchId },
    select: {
      id: true,
      matchId: true,
      v2SchemaVersion: true,
      seedMethod: true,
      standingsPolicyVersion: true,
      qualifiersPerGroup: true,
      bracketPolicyVersion: true,
      createdAt: true,
    },
  })) as GroupingRow | null;
  if (!grouping) {
    fail("PERSISTENCE_CONFLICT", "The match has no relational grouping.");
  }
  const groups = (await tx.matchGroup.findMany({
    where: { matchId: command.matchId },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: {
      id: true,
      matchId: true,
      groupingId: true,
      groupKey: true,
      position: true,
    },
  })) as readonly GroupRow[];
  validateMatchAndGrouping(match, grouping, groups);
  const memberships = (await tx.matchGroupEntry.findMany({
    where: { matchId: command.matchId },
    orderBy: [{ groupId: "asc" }, { position: "asc" }, { id: "asc" }],
    select: {
      id: true,
      matchId: true,
      groupId: true,
      entryId: true,
      position: true,
      globalSeedRank: true,
      entryVersion: true,
      rosterVersion: true,
    },
  })) as readonly MembershipRow[];
  const snapshots = (await tx.matchQualificationSnapshot.findMany({
    where: { matchId: command.matchId },
    orderBy: { id: "asc" },
    select: {
      id: true,
      matchId: true,
      groupingId: true,
      schemaVersion: true,
      standingsPolicyVersion: true,
      sourceRevisionFingerprint: true,
      createdAt: true,
    },
  })) as readonly SnapshotRow[];
  const snapshot = validateSnapshot(command, match, grouping, snapshots);
  const standings = (await tx.matchQualificationStanding.findMany({
    where: { matchId: command.matchId },
    orderBy: [{ groupId: "asc" }, { rank: "asc" }, { id: "asc" }],
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
    },
  })) as readonly StandingRow[];
  const validated = validateMembershipsAndStandings(
    match,
    grouping,
    groups,
    memberships,
    snapshot,
    standings,
  );
  const qualifiedEntryIds = validated.qualified.map((standing) => standing.entryId);
  const entries = (await tx.matchEntry.findMany({
    where: { matchId: command.matchId, id: { in: qualifiedEntryIds } },
    orderBy: { id: "asc" },
    select: { id: true, matchId: true, kind: true, status: true, version: true },
  })) as readonly EntryRow[];
  const memberHistory = (await tx.matchEntryMember.findMany({
    where: { matchId: command.matchId, entryId: { in: qualifiedEntryIds } },
    orderBy: [{ entryId: "asc" }, { rosterVersion: "asc" }, { slot: "asc" }],
    take: MAX_MEMBER_HISTORY_COUNT + 1,
    select: {
      id: true,
      matchId: true,
      entryId: true,
      userId: true,
      role: true,
      status: true,
      slot: true,
      rosterVersion: true,
      effectiveFrom: true,
      effectiveUntil: true,
    },
  })) as readonly MemberRow[];
  if (memberHistory.length > MAX_MEMBER_HISTORY_COUNT) {
    fail("PERSISTENCE_CONFLICT", "Qualified Entry member history is too large.");
  }
  const qualifiedEntries = validateQualifiedRosters(
    match,
    grouping,
    validated.membershipByEntry,
    validated.qualified,
    entries,
    memberHistory,
  );
  const actor = await lockAndLoadUsers(
    tx,
    command,
    qualifiedEntries.flatMap((entry) => entry.members.map((member) => member.userId)),
  );
  if (actor.role !== "admin" && actor.id !== match.createdBy) {
    fail("FORBIDDEN", "Only the match creator or an administrator can publish knockout.", {
      actorId: actor.id,
      matchId: match.id,
    });
  }
  const now = clock();
  if (
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime()) ||
    now.getTime() < snapshot.createdAt.getTime()
  ) {
    fail("INVALID_INPUT", "The knockout publication clock is invalid.");
  }

  let bracket: ReturnType<typeof buildV2KnockoutBracket>;
  try {
    bracket = buildV2KnockoutBracket(qualifiedEntries);
  } catch (error) {
    if (error instanceof V2KnockoutBracketError) {
      fail(
        "PERSISTENCE_CONFLICT",
        "The frozen qualifier set cannot produce the supported knockout graph.",
        { bracketCode: error.code },
      );
    }
    throw error;
  }
  const expectedFixtures: ExpectedFixture[] = bracket.fixtures.map((fixture) => ({
    fixtureKey: fixture.fixtureKey,
    roundNumber: fixture.roundNumber,
    position: fixture.position,
    status: fixture.roundNumber === 1 ? "READY" : "SCHEDULED",
    sideA: fixture.sideA,
    sideB: fixture.sideB,
  }));
  const allFixtures = (await tx.matchFixture.findMany({
    where: { matchId: command.matchId },
    orderBy: { id: "asc" },
    select: {
      id: true,
      matchId: true,
      fixtureKey: true,
      stage: true,
      status: true,
      groupId: true,
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
    },
  })) as readonly FixtureRow[];
  const knockoutFixtures = allFixtures.filter((fixture) => fixture.stage === "KNOCKOUT");
  validateFrozenGroupTopology(match, groups, memberships, allFixtures);
  const dependencies = (await tx.matchFixtureDependency.findMany({
    where: { matchId: command.matchId },
    orderBy: { id: "asc" },
    select: {
      id: true,
      matchId: true,
      sourceFixtureId: true,
      sourceOutcome: true,
      sourceQualificationStandingId: true,
      targetFixtureId: true,
      targetSide: true,
      createdAt: true,
    },
  })) as readonly DependencyRow[];
  const knockoutIds = knockoutFixtures.map((fixture) => fixture.id);
  const lineups = knockoutIds.length === 0
    ? []
    : ((await tx.matchFixtureLineupMember.findMany({
        where: { matchId: command.matchId, fixtureId: { in: knockoutIds } },
        orderBy: { id: "asc" },
        select: {
          id: true,
          matchId: true,
          fixtureId: true,
          entryId: true,
          entryMemberId: true,
          side: true,
          position: true,
          createdAt: true,
        },
      })) as readonly LineupRow[]);
  const knockoutResultCount = knockoutIds.length === 0
    ? 0
    : await tx.resultRevision.count({ where: { fixtureId: { in: knockoutIds } } });
  const publicationAudits = (await tx.auditLog.findMany({
    where: {
      entityType: "Match",
      entityId: match.id,
      action: { in: [...KNOCKOUT_AUDIT_ACTIONS] },
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      actorId: true,
      action: true,
      entityType: true,
      entityId: true,
      details: true,
      createdAt: true,
    },
  })) as readonly AuditRow[];

  if (knockoutFixtures.length > 0) {
    const publishedAt = validateExactInitialPublication({
      match,
      snapshot,
      expectedFixtures,
      qualifiedEntries,
      fixtures: knockoutFixtures,
      dependencies,
      lineups,
      audits: publicationAudits,
      knockoutResultCount,
    });
    if (publishedAt === null) {
      fail(
        "FIXTURE_KEY_CONFLICT",
        "A progressed, different, or incomplete knockout publication already exists.",
        { matchId: match.id },
      );
    }
    return {
      matchId: match.id,
      qualificationSnapshotId: snapshot.id,
      sourceRevisionFingerprint: snapshot.sourceRevisionFingerprint,
      created: false,
      publishedAt,
      qualificationCount: bracket.entryCount,
      roundCount: bracket.roundCount,
      fixtureCount: bracket.fixtureCount,
    };
  }
  if (publicationAudits.length > 0) {
    fail(
      "FIXTURE_KEY_CONFLICT",
      "A knockout publication audit exists without its complete initial graph.",
      { matchId: match.id },
    );
  }
  if (dependencies.length > 0 || lineups.length > 0 || knockoutResultCount > 0) {
    fail(
      "FIXTURE_KEY_CONFLICT",
      "Knockout dependency, lineup, or result state exists without a complete bracket.",
      { matchId: match.id },
    );
  }
  const groupFixtureKeys = new Set(
    allFixtures.filter((fixture) => fixture.stage === "GROUP").map((fixture) => fixture.fixtureKey),
  );
  const keyCollision = expectedFixtures.find((fixture) =>
    groupFixtureKeys.has(fixture.fixtureKey),
  );
  if (keyCollision) {
    fail("FIXTURE_KEY_CONFLICT", "A group fixture uses a reserved knockout key.", {
      fixtureKey: keyCollision.fixtureKey,
    });
  }

  const qualifiedByStanding = new Map(
    qualifiedEntries.map((entry) => [entry.standingId, entry]),
  );
  const rules = await tx.match.findUniqueOrThrow({ where: { id: match.id }, select: { knockoutBestOf: true } });
  const createdFixtures = await tx.matchFixture.createMany({
    data: expectedFixtures.map((fixture) => {
      const sideA = expectedFixtureSide(fixture.sideA, qualifiedByStanding);
      const sideB = expectedFixtureSide(fixture.sideB, qualifiedByStanding);
      return {
        matchId: match.id,
        fixtureKey: fixture.fixtureKey,
        stage: "KNOCKOUT" as const,
        bestOf: rules.knockoutBestOf,
        status: fixture.status,
        groupId: null,
        groupKey: null,
        roundNumber: fixture.roundNumber,
        position: fixture.position,
        sideAEntryId: sideA.entryId,
        sideBEntryId: sideB.entryId,
        sideARosterVersion: sideA.rosterVersion,
        sideBRosterVersion: sideB.rosterVersion,
        scheduledAt: null,
        startedAt: null,
        completedAt: null,
        version: 0,
        metadata: publicationMetadata(snapshot, now, fixture),
        createdAt: now,
        updatedAt: now,
      };
    }),
  });
  if (createdFixtures.count !== expectedFixtures.length) {
    fail("PERSISTENCE_CONFLICT", "The complete knockout fixture set was not inserted.", {
      expected: expectedFixtures.length,
      actual: createdFixtures.count,
    });
  }
  await hooks.afterFixturesCreated?.();
  const materialized = await tx.matchFixture.findMany({
    where: {
      matchId: match.id,
      fixtureKey: { in: expectedFixtures.map((fixture) => fixture.fixtureKey) },
    },
    select: { id: true, fixtureKey: true },
  });
  const fixtureIdByKey = new Map(
    materialized.map((fixture) => [fixture.fixtureKey, fixture.id]),
  );
  if (fixtureIdByKey.size !== expectedFixtures.length) {
    fail("PERSISTENCE_CONFLICT", "The complete knockout fixture set was not materialized.");
  }
  const expectedDependencyCount = expectedFixtures.length * 2;
  const createdDependencies = await tx.matchFixtureDependency.createMany({
    data: expectedFixtures.flatMap((fixture) => {
      const targetFixtureId = fixtureIdByKey.get(fixture.fixtureKey)!;
      return ([
        ["SIDE_A", fixture.sideA],
        ["SIDE_B", fixture.sideB],
      ] as const).map(([targetSide, source]) =>
        source.kind === "QUALIFIER"
          ? {
              matchId: match.id,
              sourceFixtureId: null,
              sourceOutcome: null,
              sourceQualificationStandingId: source.standingId,
              targetFixtureId,
              targetSide,
              createdAt: now,
            }
          : {
              matchId: match.id,
              sourceFixtureId: fixtureIdByKey.get(source.fixtureKey)!,
              sourceOutcome: "WINNER" as const,
              sourceQualificationStandingId: null,
              targetFixtureId,
              targetSide,
              createdAt: now,
            },
      );
    }),
  });
  if (createdDependencies.count !== expectedDependencyCount) {
    fail("PERSISTENCE_CONFLICT", "The complete knockout dependency set was not inserted.", {
      expected: expectedDependencyCount,
      actual: createdDependencies.count,
    });
  }
  const lineupData = expectedFixtures.flatMap((fixture) => {
    const fixtureId = fixtureIdByKey.get(fixture.fixtureKey)!;
    return ([
      ["SIDE_A", fixture.sideA],
      ["SIDE_B", fixture.sideB],
    ] as const).flatMap(([side, source]) => {
      if (source.kind !== "QUALIFIER") return [];
      const qualified = qualifiedByStanding.get(source.standingId)!;
      return qualified.members.map((member) => ({
        matchId: match.id,
        fixtureId,
        entryId: qualified.entryId,
        entryMemberId: member.id,
        side,
        position: member.slot,
        createdAt: now,
      }));
    });
  });
  if (lineupData.length > 0) {
    const createdLineups = await tx.matchFixtureLineupMember.createMany({
      data: lineupData,
    });
    if (createdLineups.count !== lineupData.length) {
      fail("PERSISTENCE_CONFLICT", "The complete first-round lineup set was not inserted.", {
        expected: lineupData.length,
        actual: createdLineups.count,
      });
    }
  }
  await tx.auditLog.create({
    data: {
      actorId: actor.id,
      action: auditAction(match.type),
      entityType: "Match",
      entityId: match.id,
      createdAt: now,
      details: {
        targetLabel: match.title,
        qualificationSnapshotId: snapshot.id,
        sourceRevisionFingerprint: snapshot.sourceRevisionFingerprint,
        publicationSchemaVersion: V2_KNOCKOUT_PUBLICATION_SCHEMA_VERSION,
        bracketPolicyVersion: V2_GROUP_THEN_KNOCKOUT_BRACKET_POLICY_VERSION,
        qualificationCount: bracket.entryCount,
        roundCount: bracket.roundCount,
        fixtureCount: bracket.fixtureCount,
        publishedAt: now.toISOString(),
      },
    },
  });
  return {
    matchId: match.id,
    qualificationSnapshotId: snapshot.id,
    sourceRevisionFingerprint: snapshot.sourceRevisionFingerprint,
    created: true,
    publishedAt: now,
    qualificationCount: bracket.entryCount,
    roundCount: bracket.roundCount,
    fixtureCount: bracket.fixtureCount,
  };
}

/**
 * @internal Use only from an application service that already owns the outer
 * transaction. The command is normalized again so orchestration cannot bypass
 * the public anti-over-posting boundary.
 */
export function publishV2KnockoutInTransaction(
  tx: V2CompetitionTransaction,
  rawCommand: PublishV2KnockoutCommand,
  clock: () => Date,
  hooks: V2KnockoutPublicationTransactionHooks = {},
) {
  return publishInTransaction(tx, normalizeCommand(rawCommand), clock, hooks);
}

export function createV2KnockoutPublicationApplicationService(
  dependencies: V2KnockoutPublicationApplicationServiceDependencies,
): V2KnockoutPublicationApplicationService {
  const clock = dependencies.clock ?? (() => new Date());
  return Object.freeze({
    publish: async (rawCommand) => {
      const command = normalizeCommand(rawCommand);
      return runV2Transaction(dependencies.db, (tx) =>
        publishInTransaction(tx, command, clock),
      );
    },
  });
}
