import { createHash } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import {
  V2GroupStandingsError,
  evaluateV2GroupQualification,
  type V2QualificationStanding,
  type V2StandingsFixture,
  type V2StandingsGroup,
} from "../domain/group-standings";
import {
  V2CompetitionApplicationError,
  runV2Transaction,
  type V2Actor,
  type V2CompetitionTransaction,
} from "./entries";

export const V2_QUALIFICATION_SNAPSHOT_SCHEMA_VERSION = 1;
export const V2_QUALIFICATION_STANDINGS_POLICY_VERSION = 1;
export const V2_QUALIFICATION_BRACKET_POLICY_VERSION = 1;

const MAX_IDENTIFIER_LENGTH = 191;
const MAX_GROUP_COUNT = 256;
const MAX_STANDING_COUNT = 1_024;
const MAX_FIXTURE_COUNT = 10_000;
const MAX_TEAM_ROSTER_SIZE = 50;
const MAX_MEMBER_HISTORY_COUNT = MAX_STANDING_COUNT * MAX_TEAM_ROSTER_SIZE;
const MAX_LINEUP_COUNT = MAX_FIXTURE_COUNT * MAX_TEAM_ROSTER_SIZE * 2;
const MAX_REVISION_COUNT = 100_000;
const MAX_SETTLEMENT_COUNT = MAX_REVISION_COUNT * 2;
const MAX_EFFECTS_PER_SETTLEMENT = MAX_TEAM_ROSTER_SIZE * 2;
const MAX_SETTLEMENT_EFFECT_COUNT =
  MAX_SETTLEMENT_COUNT * MAX_EFFECTS_PER_SETTLEMENT;

export type FreezeV2QualificationSnapshotCommand = Readonly<{
  actor: V2Actor;
  matchId: string;
}>;

export type FreezeV2QualificationSnapshotResult = Readonly<{
  matchId: string;
  groupingId: string;
  snapshotId: string;
  created: boolean;
  frozenAt: Date;
  sourceRevisionFingerprint: string;
  qualificationCount: number;
  standings: readonly V2QualificationStanding[];
}>;

export type V2QualificationSnapshotApplicationService = Readonly<{
  freeze(
    command: FreezeV2QualificationSnapshotCommand,
  ): Promise<FreezeV2QualificationSnapshotResult>;
}>;

export type V2QualificationSnapshotApplicationServiceDependencies = Readonly<{
  db: Pick<PrismaClient, "$transaction">;
  clock?: () => Date;
}>;

type NormalizedCommand = Readonly<{
  actor: V2Actor;
  matchId: string;
}>;

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
  displayName: string;
  position: number;
  createdAt: Date;
}>;

type GroupEntryRow = Readonly<{
  id: string;
  matchId: string;
  groupId: string;
  entryId: string;
  position: number;
  globalSeedRank: number;
  seedElo: number;
  seedPoints: number;
  entryVersion: number;
  rosterVersion: number;
  createdAt: Date;
}>;

type EntryRow = Readonly<{
  id: string;
  matchId: string;
  kind: "INDIVIDUAL" | "DOUBLES" | "TEAM";
  status: "DRAFT" | "ACTIVE" | "WITHDRAWN" | "DISQUALIFIED" | "ARCHIVED";
  version: number;
}>;

type EntryMemberRow = Readonly<{
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
  endReason: string | null;
}>;

type UserRow = Readonly<{
  id: string;
  role: "user" | "admin";
  isBanned: boolean;
  emailVerifiedAt: Date | null;
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
  completedAt: Date | null;
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

type RevisionRow = Readonly<{
  id: string;
  matchId: string;
  fixtureId: string;
  revisionNumber: number;
  status: "PENDING" | "CONFIRMED" | "REJECTED" | "VOIDED" | "SUPERSEDED";
  resolutionKind: "PLAYED" | "FORFEIT";
  winnerEntryId: string | null;
  loserEntryId: string | null;
  score: Prisma.JsonValue;
  reportedById: string;
  verifiedById: string | null;
  supersedesRevisionId: string | null;
  reason: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

type SettlementEffectRow = Readonly<{
  id: string;
  eventId: string;
  userId: string;
  eloBefore: number | null;
  eloAfter: number | null;
  eloDelta: number | null;
  pointsBefore: number | null;
  pointsAfter: number | null;
  pointsDelta: number | null;
  winsDelta: number;
  lossesDelta: number;
  matchesPlayedDelta: number;
  createdAt: Date;
}>;

type SettlementRow = Readonly<{
  id: string;
  idempotencyKey: string;
  kind: "RESULT_APPLY" | "RESULT_REVERSAL" | "REGISTRATION_APPLY" | "REGISTRATION_REVERSAL";
  status: "PENDING" | "APPLIED" | "REVERSED" | "FAILED";
  resultRevisionId: string | null;
  matchEntryId: string | null;
  reversesEventId: string | null;
  metadata: Prisma.JsonValue | null;
  failureReason: string | null;
  appliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  effects: readonly SettlementEffectRow[];
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

type PersistedStandingRow = V2QualificationStanding &
  Readonly<{
    id: string;
    matchId: string;
    snapshotId: string;
    createdAt: Date;
  }>;

type FrozenRoster = Readonly<{
  entryId: string;
  rosterVersion: number;
  members: readonly EntryMemberRow[];
}>;

type LockedUsers = Readonly<{
  actor: UserRow;
  byId: ReadonlyMap<string, UserRow>;
}>;

function fail(
  code: V2CompetitionApplicationError["code"],
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new V2CompetitionApplicationError(code, message, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
) {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length === 0) return;
  fail("INVALID_INPUT", `${name} contains unsupported fields.`, { name, unexpected });
}

function assertStableIdentifier(value: unknown, name: string): asserts value is string {
  if (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  ) {
    return;
  }
  fail("INVALID_INPUT", `${name} must be a stable identifier.`, { name });
}

function assertPersistedIdentifier(
  value: unknown,
  name: string,
): asserts value is string {
  if (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  ) {
    return;
  }
  fail("PERSISTENCE_CONFLICT", `${name} is not a valid persisted identifier.`, {
    name,
  });
}

function normalizeCommand(
  command: FreezeV2QualificationSnapshotCommand,
): NormalizedCommand {
  if (!isRecord(command)) {
    fail("INVALID_INPUT", "The qualification snapshot command must be an object.");
  }
  assertOnlyKeys(command, ["actor", "matchId"], "command");
  assertStableIdentifier(command.matchId, "matchId");
  if (!isRecord(command.actor)) fail("INVALID_INPUT", "actor must be an object.");
  assertOnlyKeys(command.actor, ["id", "role"], "actor");
  assertStableIdentifier(command.actor.id, "actor.id");
  if (command.actor.role !== "user" && command.actor.role !== "admin") {
    fail("INVALID_INPUT", "actor.role must be user or admin.");
  }
  return {
    actor: { id: command.actor.id, role: command.actor.role },
    matchId: command.matchId,
  };
}

function compareIdentifiers(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertDatabaseDate(value: unknown, name: string): asserts value is Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) return;
  fail("PERSISTENCE_CONFLICT", `${name} is not a valid database timestamp.`, { name });
}

function iso(value: Date | null, name: string) {
  if (value === null) return null;
  assertDatabaseDate(value, name);
  return value.toISOString();
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded !== undefined) return encoded;
  fail("PERSISTENCE_CONFLICT", "A fingerprint source contains a non-JSON value.");
}

function sha256(value: unknown) {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPowerOfTwo(value: number) {
  if (!Number.isSafeInteger(value) || value < 1) return false;
  const integer = BigInt(value);
  return (integer & (integer - BigInt(1))) === BigInt(0);
}

function expectedEntryKind(matchType: MatchRow["type"]): EntryRow["kind"] {
  if (matchType === "single") return "INDIVIDUAL";
  if (matchType === "double") return "DOUBLES";
  return "TEAM";
}

function assertKnownEntryStatus(status: unknown): asserts status is EntryRow["status"] {
  if (
    status === "DRAFT" ||
    status === "ACTIVE" ||
    status === "WITHDRAWN" ||
    status === "DISQUALIFIED" ||
    status === "ARCHIVED"
  ) {
    return;
  }
  fail("PERSISTENCE_CONFLICT", "A grouped Entry has an unknown status.", { status });
}

function assertKnownFixtureStatus(
  status: unknown,
): asserts status is FixtureRow["status"] {
  if (
    status === "SCHEDULED" ||
    status === "READY" ||
    status === "COMPLETED" ||
    status === "VOIDED"
  ) {
    return;
  }
  fail("PERSISTENCE_CONFLICT", "A group fixture has an unknown status.", { status });
}

function assertKnownRevisionStatus(
  status: unknown,
): asserts status is RevisionRow["status"] {
  if (
    status === "PENDING" ||
    status === "CONFIRMED" ||
    status === "REJECTED" ||
    status === "VOIDED" ||
    status === "SUPERSEDED"
  ) {
    return;
  }
  fail("PERSISTENCE_CONFLICT", "A result revision has an unknown status.", {
    status,
  });
}

async function lockQualificationAggregate(
  tx: V2CompetitionTransaction,
  command: NormalizedCommand,
) {
  const match = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Match" WHERE "id" = ${command.matchId} FOR UPDATE
  `);
  if (match.length === 0) {
    fail("MATCH_NOT_FOUND", "The match does not exist.", { matchId: command.matchId });
  }

  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "MatchGrouping"
    WHERE "matchId" = ${command.matchId}
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "match_group"
    WHERE "match_id" = ${command.matchId}
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "match_group_entry"
    WHERE "match_id" = ${command.matchId}
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "match_entry"
    WHERE "match_id" = ${command.matchId}
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "match_entry_member"
    WHERE "match_id" = ${command.matchId}
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "match_fixture"
    WHERE "match_id" = ${command.matchId} AND "stage" = 'GROUP'
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT lineup."id"
    FROM "match_fixture_lineup_member" AS lineup
    INNER JOIN "match_fixture" AS fixture ON fixture."id" = lineup."fixture_id"
    WHERE fixture."match_id" = ${command.matchId} AND fixture."stage" = 'GROUP'
    ORDER BY lineup."id" FOR UPDATE OF lineup
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT revision."id"
    FROM "result_revision" AS revision
    INNER JOIN "match_fixture" AS fixture ON fixture."id" = revision."fixture_id"
    WHERE fixture."match_id" = ${command.matchId} AND fixture."stage" = 'GROUP'
    ORDER BY revision."id" FOR UPDATE OF revision
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT settlement."id"
    FROM "settlement_event" AS settlement
    LEFT JOIN "result_revision" AS direct_revision
      ON direct_revision."id" = settlement."result_revision_id"
    LEFT JOIN "match_fixture" AS direct_fixture
      ON direct_fixture."id" = direct_revision."fixture_id"
    LEFT JOIN "settlement_event" AS reversed_event
      ON reversed_event."id" = settlement."reverses_event_id"
    LEFT JOIN "result_revision" AS reversed_revision
      ON reversed_revision."id" = reversed_event."result_revision_id"
    LEFT JOIN "match_fixture" AS reversed_fixture
      ON reversed_fixture."id" = reversed_revision."fixture_id"
    WHERE (
      direct_fixture."match_id" = ${command.matchId}
      AND direct_fixture."stage" = 'GROUP'
    ) OR (
      reversed_fixture."match_id" = ${command.matchId}
      AND reversed_fixture."stage" = 'GROUP'
    )
    ORDER BY settlement."id" FOR UPDATE OF settlement
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT effect."id"
    FROM "settlement_effect" AS effect
    INNER JOIN "settlement_event" AS settlement ON settlement."id" = effect."event_id"
    LEFT JOIN "result_revision" AS direct_revision
      ON direct_revision."id" = settlement."result_revision_id"
    LEFT JOIN "match_fixture" AS direct_fixture
      ON direct_fixture."id" = direct_revision."fixture_id"
    LEFT JOIN "settlement_event" AS reversed_event
      ON reversed_event."id" = settlement."reverses_event_id"
    LEFT JOIN "result_revision" AS reversed_revision
      ON reversed_revision."id" = reversed_event."result_revision_id"
    LEFT JOIN "match_fixture" AS reversed_fixture
      ON reversed_fixture."id" = reversed_revision."fixture_id"
    WHERE (
      direct_fixture."match_id" = ${command.matchId}
      AND direct_fixture."stage" = 'GROUP'
    ) OR (
      reversed_fixture."match_id" = ${command.matchId}
      AND reversed_fixture."stage" = 'GROUP'
    )
    ORDER BY effect."id" FOR UPDATE OF effect
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "match_qualification_snapshot"
    WHERE "match_id" = ${command.matchId}
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "match_qualification_standing"
    WHERE "match_id" = ${command.matchId}
    ORDER BY "id" FOR UPDATE
  `);

}

async function lockAndLoadUsers(
  tx: V2CompetitionTransaction,
  command: NormalizedCommand,
  rosterUserIds: readonly string[],
): Promise<LockedUsers> {
  const userIds = [...new Set([command.actor.id, ...rosterUserIds])].sort(
    compareIdentifiers,
  );
  const lockedRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "User"
    WHERE "id" IN (${Prisma.join(userIds)})
    ORDER BY "id" FOR UPDATE
  `);
  const lockedIds = lockedRows.map((row) => row.id).sort(compareIdentifiers);
  if (
    lockedIds.length !== userIds.length ||
    lockedIds.some((userId, index) => userId !== userIds[index])
  ) {
    fail("ACTOR_NOT_ACTIVE", "The actor or a frozen roster user is missing.", {
      actorId: command.actor.id,
    });
  }

  const users = (await tx.user.findMany({
    where: { id: { in: userIds } },
    orderBy: { id: "asc" },
    select: { id: true, role: true, isBanned: true, emailVerifiedAt: true },
  })) as readonly UserRow[];
  const byId = new Map(users.map((user) => [user.id, user]));
  if (byId.size !== userIds.length) {
    fail("PERSISTENCE_CONFLICT", "The locked frozen roster user set changed.");
  }
  const actor = byId.get(command.actor.id);
  if (!actor || actor.isBanned || !actor.emailVerifiedAt) {
    fail("ACTOR_NOT_ACTIVE", "The actor is missing, banned, or unverified.", {
      actorId: command.actor.id,
    });
  }
  if (actor.role !== command.actor.role) {
    fail("ACTOR_ROLE_STALE", "The supplied actor role is stale.", {
      actorId: command.actor.id,
    });
  }
  return { actor, byId };
}

function validateFormalMatch(match: MatchRow, matchId: string) {
  if (match.id !== matchId) {
    fail("PERSISTENCE_CONFLICT", "The locked Match identity changed.", { matchId });
  }
  if (match.engineVersion !== "V2" || match.isQuickMatch) {
    fail(
      "FIXTURE_CREATION_NOT_ALLOWED",
      "Qualification snapshots accept formal V2 matches only.",
      { engineVersion: match.engineVersion, isQuickMatch: match.isQuickMatch },
    );
  }
  if (match.status !== "ongoing") {
    fail(
      "FIXTURE_CREATION_NOT_ALLOWED",
      "Qualification can freeze only while the match is ongoing.",
      { matchStatus: match.status },
    );
  }
  if (match.format !== "group_then_knockout") {
    fail(
      "FIXTURE_CREATION_NOT_ALLOWED",
      "Qualification snapshots require group_then_knockout format.",
      { matchFormat: match.format },
    );
  }
  if (
    match.type !== "single" &&
    match.type !== "double" &&
    match.type !== "team"
  ) {
    fail("FIXTURE_CREATION_NOT_ALLOWED", "The match type is not supported.");
  }
  if (match.groupingGeneratedAt === null) {
    fail("PERSISTENCE_CONFLICT", "The Match is missing its grouping timestamp.");
  }
  assertDatabaseDate(match.groupingGeneratedAt, "match.groupingGeneratedAt");
}

function validateGrouping(match: MatchRow, grouping: GroupingRow, groupCount: number) {
  if (
    grouping.matchId !== match.id ||
    grouping.v2SchemaVersion !== V2_QUALIFICATION_SNAPSHOT_SCHEMA_VERSION ||
    (grouping.seedMethod !== "MIN_DIFF" && grouping.seedMethod !== "SNAKE") ||
    grouping.standingsPolicyVersion !==
      V2_QUALIFICATION_STANDINGS_POLICY_VERSION ||
    grouping.bracketPolicyVersion !== V2_QUALIFICATION_BRACKET_POLICY_VERSION ||
    !isPositiveInteger(grouping.qualifiersPerGroup)
  ) {
    fail(
      "PERSISTENCE_CONFLICT",
      "The relational grouping does not contain a supported complete V2 field set.",
      { groupingId: grouping.id },
    );
  }
  assertDatabaseDate(grouping.createdAt, "grouping.createdAt");
  if (grouping.createdAt.getTime() !== match.groupingGeneratedAt!.getTime()) {
    fail(
      "PERSISTENCE_CONFLICT",
      "The grouping timestamp does not match its Match publication timestamp.",
      { groupingId: grouping.id },
    );
  }
  const totalQualified = grouping.qualifiersPerGroup * groupCount;
  if (
    !Number.isSafeInteger(totalQualified) ||
    totalQualified < 2 ||
    !isPowerOfTwo(totalQualified)
  ) {
    fail(
      "PERSISTENCE_CONFLICT",
      "The total qualifier count must be at least two and a power of two.",
      {
        groupCount,
        qualifiersPerGroup: grouping.qualifiersPerGroup,
        totalQualified,
      },
    );
  }
}

function validateFrozenRoster(
  match: MatchRow,
  grouping: GroupingRow,
  membership: GroupEntryRow,
  entry: EntryRow,
  members: readonly EntryMemberRow[],
  snapshotAt: Date = grouping.createdAt,
): FrozenRoster {
  const sorted = [...members].sort(
    (left, right) => left.slot - right.slot || compareIdentifiers(left.id, right.id),
  );
  if (sorted.length === 0) {
    fail("PERSISTENCE_CONFLICT", "A grouped Entry has no frozen roster members.", {
      entryId: membership.entryId,
      rosterVersion: membership.rosterVersion,
    });
  }
  const memberIds = new Set<string>();
  const userIds = new Set<string>();
  for (let index = 0; index < sorted.length; index += 1) {
    const member = sorted[index];
    assertPersistedIdentifier(member.id, "entryMember.id");
    assertPersistedIdentifier(member.userId, "entryMember.userId");
    if (
      member.matchId !== match.id ||
      member.entryId !== membership.entryId ||
      member.rosterVersion !== membership.rosterVersion ||
      member.slot !== index + 1 ||
      memberIds.has(member.id) ||
      userIds.has(member.userId)
    ) {
      fail("PERSISTENCE_CONFLICT", "A grouped Entry has a corrupt frozen roster.", {
        entryId: membership.entryId,
        rosterVersion: membership.rosterVersion,
      });
    }
    if (
      (member.role !== "player" &&
        member.role !== "captain" &&
        member.role !== "substitute") ||
      (member.status !== "ACTIVE" &&
        member.status !== "WITHDRAWN" &&
        member.status !== "REMOVED" &&
        member.status !== "DISQUALIFIED" &&
        member.status !== "SUPERSEDED")
    ) {
      fail("PERSISTENCE_CONFLICT", "A frozen roster member has invalid state.", {
        entryMemberId: member.id,
      });
    }
    assertDatabaseDate(member.effectiveFrom, "entryMember.effectiveFrom");
    if (member.effectiveUntil !== null) {
      assertDatabaseDate(member.effectiveUntil, "entryMember.effectiveUntil");
    }
    if (
      (member.status === "ACTIVE") !== (member.effectiveUntil === null) ||
      member.effectiveFrom.getTime() > snapshotAt.getTime() ||
      (member.effectiveUntil !== null &&
        member.effectiveUntil.getTime() < snapshotAt.getTime())
    ) {
      fail(
        "PERSISTENCE_CONFLICT",
        "A frozen roster member was not active at grouping publication.",
        { entryMemberId: member.id, groupingId: grouping.id },
      );
    }
    memberIds.add(member.id);
    userIds.add(member.userId);
  }
  if (
    match.type === "single" &&
    (sorted.length !== 1 || sorted[0]?.role !== "player")
  ) {
    fail("PERSISTENCE_CONFLICT", "A singles Entry must freeze exactly one player.", {
      entryId: membership.entryId,
    });
  }
  if (
    match.type === "double" &&
    (sorted.length !== 2 || sorted.some((member) => member.role !== "player"))
  ) {
    fail("PERSISTENCE_CONFLICT", "A doubles Entry must freeze exactly two players.", {
      entryId: membership.entryId,
    });
  }
  if (match.type === "team") {
    if (
      !isPositiveInteger(match.teamMinMembers) ||
      !isPositiveInteger(match.teamMaxMembers) ||
      match.teamMaxMembers < match.teamMinMembers ||
      match.teamMaxMembers > MAX_TEAM_ROSTER_SIZE ||
      sorted.length < match.teamMinMembers ||
      sorted.length > match.teamMaxMembers ||
      sorted.filter((member) => member.role === "captain").length !== 1
    ) {
      fail("PERSISTENCE_CONFLICT", "A team Entry has an invalid complete frozen roster.", {
        entryId: membership.entryId,
      });
    }
  }
  if (
    entry.status === "ACTIVE" &&
    sorted.some(
      (member) => member.status !== "ACTIVE" && member.status !== "SUPERSEDED" && !(member.status === "REMOVED" && member.endReason === "ROSTER_REPLACED"),
    )
  ) {
    fail(
      "PERSISTENCE_CONFLICT",
      "An active grouped Entry must retain an active pinned roster.",
      { entryId: membership.entryId, rosterVersion: membership.rosterVersion },
    );
  }
  return {
    entryId: membership.entryId,
    rosterVersion: membership.rosterVersion,
    members: sorted,
  };
}

function assertLineupSide(
  fixture: FixtureRow,
  side: "SIDE_A" | "SIDE_B",
  entryId: string,
  roster: FrozenRoster,
  rows: readonly LineupRow[],
) {
  const actual = rows
    .filter((row) => row.side === side)
    .sort(
      (left, right) =>
        left.position - right.position || compareIdentifiers(left.id, right.id),
    );
  if (actual.length !== roster.members.length) {
    fail("FIXTURE_LINEUP_INVALID", "A group fixture lineup is not the complete frozen roster.", {
      fixtureId: fixture.id,
      side,
      entryId,
    });
  }
  for (let index = 0; index < roster.members.length; index += 1) {
    const expected = roster.members[index];
    const member = actual[index];
    if (
      member.matchId !== fixture.matchId ||
      member.fixtureId !== fixture.id ||
      member.entryId !== entryId ||
      member.entryMemberId !== expected.id ||
      member.position !== expected.slot
    ) {
      fail("FIXTURE_LINEUP_INVALID", "A group fixture lineup differs from its frozen roster.", {
        fixtureId: fixture.id,
        side,
        entryId,
      });
    }
  }
}

function validateEventEffects(
  event: SettlementRow,
  winnerUserIds: readonly string[],
  loserUserIds: readonly string[],
) {
  const expectedUserIds = [...winnerUserIds, ...loserUserIds];
  const expected = [...expectedUserIds].sort(compareIdentifiers);
  const actual = event.effects.map((effect) => effect.userId).sort(compareIdentifiers);
  if (
    new Set(event.effects.map((effect) => effect.id)).size !== event.effects.length ||
    new Set(actual).size !== actual.length ||
    actual.length !== expected.length ||
    actual.some((userId, index) => userId !== expected[index]) ||
    event.effects.some((effect) => effect.eventId !== event.id)
  ) {
    fail("PERSISTENCE_CONFLICT", "A result settlement has an incomplete effect set.", {
      eventId: event.id,
    });
  }

  const winners = new Set(winnerUserIds);
  const losers = new Set(loserUserIds);
  for (const effect of event.effects) {
    const isWinner = winners.has(effect.userId);
    if (!isWinner && !losers.has(effect.userId)) {
      fail("PERSISTENCE_CONFLICT", "A result settlement effect has no fixture side.", {
        eventId: event.id,
        userId: effect.userId,
      });
    }
    const expectedWins =
      event.kind === "RESULT_APPLY" ? (isWinner ? 1 : 0) : isWinner ? -1 : 0;
    const expectedLosses =
      event.kind === "RESULT_APPLY" ? (isWinner ? 0 : 1) : isWinner ? 0 : -1;
    const expectedPlayed = event.kind === "RESULT_APPLY" ? 1 : -1;
    if (
      effect.winsDelta !== expectedWins ||
      effect.lossesDelta !== expectedLosses ||
      effect.matchesPlayedDelta !== expectedPlayed
    ) {
      fail(
        "PERSISTENCE_CONFLICT",
        "A result settlement effect contradicts the recorded winner and loser.",
        { eventId: event.id, userId: effect.userId },
      );
    }
    const triplets = [
      [effect.eloBefore, effect.eloAfter, effect.eloDelta, "elo"],
      [effect.pointsBefore, effect.pointsAfter, effect.pointsDelta, "points"],
    ] as const;
    for (const [before, after, delta, dimension] of triplets) {
      if (
        before === null ||
        after === null ||
        delta === null ||
        !Number.isSafeInteger(before) ||
        !Number.isSafeInteger(after) ||
        !Number.isSafeInteger(delta) ||
        BigInt(after) - BigInt(before) !== BigInt(delta)
      ) {
        fail(
          "PERSISTENCE_CONFLICT",
          `A result settlement has an invalid ${dimension} effect.`,
          { eventId: event.id, userId: effect.userId },
        );
      }
    }
    if (
      (event.kind === "RESULT_APPLY" &&
        (effect.pointsDelta! < 0 || (!isWinner && effect.pointsDelta !== 0))) ||
      (event.kind === "RESULT_REVERSAL" && effect.pointsDelta! > 0)
    ) {
      fail("PERSISTENCE_CONFLICT", "A result settlement has an invalid points direction.", {
        eventId: event.id,
        userId: effect.userId,
      });
    }
  }
}

function validateReversalEffects(
  application: SettlementRow,
  reversal: SettlementRow,
) {
  const applicationByUser = new Map(
    application.effects.map((effect) => [effect.userId, effect]),
  );
  for (const effect of reversal.effects) {
    const original = applicationByUser.get(effect.userId);
    if (
      original === undefined ||
      effect.eloDelta !== -original.eloDelta! ||
      effect.winsDelta !== -original.winsDelta ||
      effect.lossesDelta !== -original.lossesDelta ||
      effect.matchesPlayedDelta !== -original.matchesPlayedDelta ||
      effect.pointsDelta! < -original.pointsDelta!
    ) {
      fail("PERSISTENCE_CONFLICT", "A result reversal does not reverse its application.", {
        applicationEventId: application.id,
        reversalEventId: reversal.id,
        userId: effect.userId,
      });
    }
  }
}

function validateSettlementHistory(
  revision: RevisionRow,
  events: readonly SettlementRow[],
  winnerUserIds: readonly string[],
  loserUserIds: readonly string[],
) {
  if (
    events.some(
      (event) =>
        event.resultRevisionId !== revision.id ||
        event.matchEntryId !== null ||
        (event.kind !== "RESULT_APPLY" && event.kind !== "RESULT_REVERSAL") ||
        (event.kind === "RESULT_APPLY" && event.reversesEventId !== null) ||
        (event.kind === "RESULT_REVERSAL" && event.reversesEventId === null),
    )
  ) {
    fail("PERSISTENCE_CONFLICT", "A result revision has an invalid settlement subject.", {
      resultRevisionId: revision.id,
    });
  }
  const applications = events.filter((event) => event.kind === "RESULT_APPLY");
  const reversals = events.filter((event) => event.kind === "RESULT_REVERSAL");
  if (applications.length > 1 || reversals.length > 1) {
    fail("PERSISTENCE_CONFLICT", "A result revision has duplicate settlement events.", {
      resultRevisionId: revision.id,
    });
  }
  if (revision.resolutionKind === "FORFEIT") {
    if (events.length !== 0) {
      fail(
        "PERSISTENCE_CONFLICT",
        "A FORFEIT revision must not produce global settlement events.",
        { resultRevisionId: revision.id },
      );
    }
    return;
  }

  const application = applications[0];
  const reversal = reversals[0];
  for (const event of events) {
    validateEventEffects(event, winnerUserIds, loserUserIds);
  }
  if (revision.status === "CONFIRMED") {
    if (
      application === undefined ||
      application.status !== "APPLIED" ||
      application.reversesEventId !== null ||
      application.failureReason !== null ||
      application.appliedAt === null ||
      reversal !== undefined ||
      events.some((event) => event.reversesEventId === application.id)
    ) {
      fail(
        "PERSISTENCE_CONFLICT",
        "A confirmed PLAYED revision requires one applied, unreversed settlement.",
        { resultRevisionId: revision.id },
      );
    }
    return;
  }
  if (revision.status === "PENDING" || revision.status === "REJECTED") {
    if (events.length !== 0) {
      fail("PERSISTENCE_CONFLICT", "An unresolved result has settlement history.", {
        resultRevisionId: revision.id,
        status: revision.status,
      });
    }
    return;
  }
  if (application === undefined) {
    if (reversal !== undefined || revision.status === "SUPERSEDED") {
      fail("PERSISTENCE_CONFLICT", "A historical result has incomplete settlement history.", {
        resultRevisionId: revision.id,
      });
    }
    return;
  }
  if (
    application.status !== "REVERSED" ||
    application.failureReason !== null ||
    application.appliedAt === null ||
    reversal === undefined ||
    reversal.status !== "APPLIED" ||
    reversal.reversesEventId !== application.id ||
    reversal.failureReason !== null ||
    reversal.appliedAt === null ||
    reversal.createdAt.getTime() < application.createdAt.getTime() ||
    reversal.appliedAt.getTime() < application.appliedAt.getTime()
  ) {
    fail("PERSISTENCE_CONFLICT", "A historical result was not fully reversed.", {
      resultRevisionId: revision.id,
    });
  }
  validateReversalEffects(application, reversal);
}

function validateRevisionChain(
  fixtureId: string,
  history: readonly RevisionRow[],
  settlementsByRevision: ReadonlyMap<string, readonly SettlementRow[]>,
) {
  const revisionsById = new Map(history.map((revision) => [revision.id, revision]));
  const superseded = history.filter((revision) => revision.status === "SUPERSEDED");
  const effectiveHeads = history.filter((revision) => {
    if (revision.status === "CONFIRMED") return true;
    if (revision.status !== "VOIDED") return false;
    return (settlementsByRevision.get(revision.id) ?? []).some(
      (event) => event.kind === "RESULT_APPLY",
    );
  });
  if (
    effectiveHeads.length > 1 ||
    (superseded.length > 0 && effectiveHeads.length !== 1)
  ) {
    fail("PERSISTENCE_CONFLICT", "A fixture has an ambiguous confirmed revision chain.", {
      fixtureId,
      headRevisionIds: effectiveHeads.map((revision) => revision.id),
    });
  }
  const head = effectiveHeads[0];
  if (head === undefined) return;

  const visited = new Set<string>();
  let successor = head;
  let predecessorId = head.supersedesRevisionId;
  while (predecessorId !== null) {
    if (visited.has(predecessorId)) {
      fail("PERSISTENCE_CONFLICT", "A fixture result revision chain contains a cycle.", {
        fixtureId,
        resultRevisionId: successor.id,
      });
    }
    const predecessor = revisionsById.get(predecessorId);
    if (
      predecessor === undefined ||
      predecessor.status !== "SUPERSEDED" ||
      predecessor.revisionNumber >= successor.revisionNumber
    ) {
      fail(
        "PERSISTENCE_CONFLICT",
        "A confirmed correction does not link to its superseded predecessor.",
        { fixtureId, resultRevisionId: successor.id, predecessorId },
      );
    }
    visited.add(predecessor.id);
    successor = predecessor;
    predecessorId = predecessor.supersedesRevisionId;
  }
  const orphaned = superseded
    .filter((revision) => !visited.has(revision.id))
    .map((revision) => revision.id);
  if (orphaned.length > 0) {
    fail("PERSISTENCE_CONFLICT", "A fixture has orphaned superseded revisions.", {
      fixtureId,
      resultRevisionIds: orphaned,
    });
  }
}

function mapStandingsError(error: V2GroupStandingsError): never {
  if (error.code === "QUALIFICATION_NOT_READY") {
    fail("FIXTURE_RESULT_REQUIRED", error.message, {
      standingsCode: error.code,
      ...error.details,
    });
  }
  fail("PERSISTENCE_CONFLICT", error.message, {
    standingsCode: error.code,
    ...error.details,
  });
}

function assertExactPersistedSnapshot(
  snapshot: SnapshotRow,
  rows: readonly PersistedStandingRow[],
  matchId: string,
  groupingId: string,
  fingerprint: string,
  standings: readonly V2QualificationStanding[],
) {
  if (
    snapshot.matchId !== matchId ||
    snapshot.groupingId !== groupingId ||
    snapshot.schemaVersion !== V2_QUALIFICATION_SNAPSHOT_SCHEMA_VERSION ||
    snapshot.standingsPolicyVersion !==
      V2_QUALIFICATION_STANDINGS_POLICY_VERSION ||
    snapshot.sourceRevisionFingerprint !== fingerprint
  ) {
    fail(
      "PERSISTENCE_CONFLICT",
      "A different or stale qualification snapshot already exists.",
      { snapshotId: snapshot.id, groupingId },
    );
  }
  assertDatabaseDate(snapshot.createdAt, "qualificationSnapshot.createdAt");
  if (rows.length !== standings.length) {
    fail("PERSISTENCE_CONFLICT", "The qualification snapshot has incomplete standings.", {
      snapshotId: snapshot.id,
    });
  }
  const expectedByEntryId = new Map(standings.map((row) => [row.entryId, row]));
  const seenIds = new Set<string>();
  const seenEntries = new Set<string>();
  for (const row of rows) {
    const expected = expectedByEntryId.get(row.entryId);
    assertDatabaseDate(row.createdAt, "qualificationStanding.createdAt");
    if (
      expected === undefined ||
      seenIds.has(row.id) ||
      seenEntries.has(row.entryId) ||
      row.matchId !== matchId ||
      row.snapshotId !== snapshot.id ||
      row.createdAt.getTime() !== snapshot.createdAt.getTime() ||
      row.groupId !== expected.groupId ||
      row.rank !== expected.rank ||
      row.played !== expected.played ||
      row.wins !== expected.wins ||
      row.losses !== expected.losses ||
      row.scoreFor !== expected.scoreFor ||
      row.scoreAgainst !== expected.scoreAgainst ||
      row.scoreDifferential !== expected.scoreDifferential ||
      row.qualified !== expected.qualified ||
      row.qualificationOrder !== expected.qualificationOrder ||
      row.ineligibilityReason !== expected.ineligibilityReason
    ) {
      fail("PERSISTENCE_CONFLICT", "The persisted qualification standings are polluted.", {
        snapshotId: snapshot.id,
        entryId: row.entryId,
      });
    }
    seenIds.add(row.id);
    seenEntries.add(row.entryId);
  }
}

async function freezeInTransaction(
  tx: V2CompetitionTransaction,
  command: NormalizedCommand,
  clock: () => Date,
): Promise<FreezeV2QualificationSnapshotResult> {
  await lockQualificationAggregate(tx, command);

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
  if (match === null) {
    fail("MATCH_NOT_FOUND", "The locked Match disappeared.", { matchId: command.matchId });
  }
  validateFormalMatch(match, command.matchId);

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
  if (grouping === null) {
    fail("PERSISTENCE_CONFLICT", "The match has no relational V2 grouping.", {
      matchId: command.matchId,
    });
  }

  const groups = (await tx.matchGroup.findMany({
    where: { matchId: command.matchId },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: {
      id: true,
      matchId: true,
      groupingId: true,
      groupKey: true,
      displayName: true,
      position: true,
      createdAt: true,
    },
  })) as readonly GroupRow[];
  if (groups.length < 1 || groups.length > MAX_GROUP_COUNT) {
    fail("PERSISTENCE_CONFLICT", "The relational grouping has an invalid group count.", {
      groupCount: groups.length,
    });
  }
  validateGrouping(match, grouping, groups.length);

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
      seedElo: true,
      seedPoints: true,
      entryVersion: true,
      rosterVersion: true,
      createdAt: true,
    },
  })) as readonly GroupEntryRow[];
  if (memberships.length < 2 || memberships.length > MAX_STANDING_COUNT) {
    fail("PERSISTENCE_CONFLICT", "The grouping has an invalid Entry membership count.");
  }

  const entryIds = memberships.map((membership) => membership.entryId);
  if (new Set(entryIds).size !== entryIds.length) {
    fail("PERSISTENCE_CONFLICT", "An Entry appears in more than one relational group.");
  }
  const membershipsByEntryId = new Map(
    memberships.map((membership) => [membership.entryId, membership]),
  );
  const entries = (await tx.matchEntry.findMany({
    where: { id: { in: entryIds } },
    select: { id: true, matchId: true, kind: true, status: true, version: true },
  })) as readonly EntryRow[];
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  if (entriesById.size !== entryIds.length) {
    fail("PERSISTENCE_CONFLICT", "A grouping membership references a missing Entry.");
  }

  const memberRows = (await tx.matchEntryMember.findMany({
    where: { entryId: { in: entryIds } },
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
      endReason: true,
    },
  })) as readonly EntryMemberRow[];
  if (memberRows.length > MAX_MEMBER_HISTORY_COUNT) {
    fail("PERSISTENCE_CONFLICT", "The grouped Entry member history is too large.", {
      memberCount: memberRows.length,
      maximum: MAX_MEMBER_HISTORY_COUNT,
    });
  }
  const memberRowsByEntryRoster = new Map<
    string,
    Map<number, EntryMemberRow[]>
  >();
  for (const member of memberRows) {
    const byRoster = memberRowsByEntryRoster.get(member.entryId) ?? new Map();
    const roster = byRoster.get(member.rosterVersion) ?? [];
    roster.push(member);
    byRoster.set(member.rosterVersion, roster);
    memberRowsByEntryRoster.set(member.entryId, byRoster);
  }

  const groupById = new Map<string, GroupRow>();
  const groupKeys = new Set<string>();
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    if (
      group.matchId !== match.id ||
      group.groupingId !== grouping.id ||
      group.position !== index + 1 ||
      group.groupKey.trim() === "" ||
      group.displayName.trim() === "" ||
      groupById.has(group.id) ||
      groupKeys.has(group.groupKey)
    ) {
      fail("PERSISTENCE_CONFLICT", "The relational group identities are incomplete.", {
        groupId: group.id,
      });
    }
    assertDatabaseDate(group.createdAt, "matchGroup.createdAt");
    groupById.set(group.id, group);
    groupKeys.add(group.groupKey);
  }

  const membershipsByGroup = new Map<string, GroupEntryRow[]>();
  const frozenRosters = new Map<string, FrozenRoster>();
  const frozenUserIds = new Set<string>();
  for (const membership of memberships) {
    const entry = entriesById.get(membership.entryId);
    if (
      !groupById.has(membership.groupId) ||
      membership.matchId !== match.id ||
      entry === undefined ||
      entry.matchId !== match.id ||
      entry.kind !== expectedEntryKind(match.type) ||
      !isNonNegativeInteger(entry.version) ||
      !isNonNegativeInteger(membership.entryVersion) ||
      entry.version < membership.entryVersion ||
      !isPositiveInteger(membership.rosterVersion) ||
      !isPositiveInteger(membership.globalSeedRank) ||
      !isNonNegativeInteger(membership.seedPoints)
    ) {
      fail("PERSISTENCE_CONFLICT", "A relational group membership is invalid.", {
        entryId: membership.entryId,
        groupId: membership.groupId,
      });
    }
    assertKnownEntryStatus(entry.status);
    assertDatabaseDate(membership.createdAt, "matchGroupEntry.createdAt");
    const groupMemberships = membershipsByGroup.get(membership.groupId) ?? [];
    groupMemberships.push(membership);
    membershipsByGroup.set(membership.groupId, groupMemberships);
    const roster = validateFrozenRoster(
      match,
      grouping,
      membership,
      entry,
      memberRowsByEntryRoster
        .get(membership.entryId)
        ?.get(membership.rosterVersion) ?? [],
    );
    for (const member of roster.members) {
      if (frozenUserIds.has(member.userId)) {
        fail(
          "PERSISTENCE_CONFLICT",
          "A user appears in more than one published frozen roster.",
          { userId: member.userId },
        );
      }
      frozenUserIds.add(member.userId);
    }
    frozenRosters.set(membership.entryId, roster);
  }
  for (const group of groups) {
    const rows = (membershipsByGroup.get(group.id) ?? []).sort(
      (left, right) =>
        left.position - right.position || compareIdentifiers(left.entryId, right.entryId),
    );
    if (
      rows.length < 2 ||
      rows.some((membership, index) => membership.position !== index + 1)
    ) {
      fail("PERSISTENCE_CONFLICT", "A relational group has non-contiguous membership.", {
        groupId: group.id,
      });
    }
    membershipsByGroup.set(group.id, rows);
  }

  const lockedUsers = await lockAndLoadUsers(
    tx,
    command,
    [...new Set(memberRows.map(member => member.userId))],
  );
  const frozenAt = clock();
  if (!(frozenAt instanceof Date) || !Number.isFinite(frozenAt.getTime())) {
    fail("INVALID_INPUT", "The qualification snapshot clock is invalid.");
  }
  if (
    lockedUsers.actor.role !== "admin" &&
    match.createdBy !== lockedUsers.actor.id
  ) {
    fail("FORBIDDEN", "Only the match creator or an administrator can freeze qualification.", {
      actorId: lockedUsers.actor.id,
      matchId: match.id,
    });
  }
  for (const membership of memberships) {
    const entry = entriesById.get(membership.entryId)!;
    if (entry.status !== "ACTIVE") continue;
    const currentMembers = memberRows.filter(member => member.entryId === entry.id && member.status === "ACTIVE" && member.effectiveUntil === null);
    if (currentMembers.length === 0) fail("PERSISTENCE_CONFLICT", "An active Entry must have a current roster.", { entryId: entry.id });
    const currentVersion = currentMembers[0].rosterVersion;
    if (currentVersion < membership.rosterVersion || currentMembers.some(member => member.rosterVersion !== currentVersion)) fail("PERSISTENCE_CONFLICT", "The current roster has inconsistent versions.", { entryId: entry.id });
    const roster = validateFrozenRoster(match, grouping, { ...membership, rosterVersion: currentVersion }, entry, currentMembers, new Date(Math.max(grouping.createdAt.getTime(), ...currentMembers.map(member => member.effectiveFrom.getTime()))));
    const unavailableUserIds = roster.members
      .filter((member) => {
        const user = lockedUsers.byId.get(member.userId);
        return !user || user.isBanned || user.emailVerifiedAt === null;
      })
      .map((member) => member.userId);
    if (unavailableUserIds.length > 0) {
      fail(
        "PERSISTENCE_CONFLICT",
        "An eligible grouped Entry contains banned or unverified roster users.",
        { entryId: entry.id, unavailableUserIds },
      );
    }
  }

  const fixtures = (await tx.matchFixture.findMany({
    where: { matchId: command.matchId, stage: "GROUP" },
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
      completedAt: true,
    },
  })) as readonly FixtureRow[];
  if (fixtures.length < 1 || fixtures.length > MAX_FIXTURE_COUNT) {
    fail("PERSISTENCE_CONFLICT", "The grouping has an invalid GROUP fixture count.");
  }
  const fixtureIds = fixtures.map((fixture) => fixture.id);
  if (new Set(fixtureIds).size !== fixtureIds.length) {
    fail("PERSISTENCE_CONFLICT", "The grouping has duplicate fixture identities.");
  }
  const lineups = (await tx.matchFixtureLineupMember.findMany({
    where: { fixtureId: { in: fixtureIds } },
    orderBy: [{ fixtureId: "asc" }, { side: "asc" }, { position: "asc" }],
    take: MAX_LINEUP_COUNT + 1,
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
  })) as readonly LineupRow[];
  if (lineups.length > MAX_LINEUP_COUNT) {
    fail("PERSISTENCE_CONFLICT", "The GROUP fixture lineup set is too large.", {
      lineupCount: lineups.length,
      maximum: MAX_LINEUP_COUNT,
    });
  }
  const lineupsByFixture = new Map<string, LineupRow[]>();
  for (const lineup of lineups) {
    const fixtureLineups = lineupsByFixture.get(lineup.fixtureId) ?? [];
    fixtureLineups.push(lineup);
    lineupsByFixture.set(lineup.fixtureId, fixtureLineups);
  }

  const fixtureById = new Map<string, FixtureRow>();
  const fixtureKeys = new Set<string>();
  const domainFixturesByGroup = new Map<string, V2StandingsFixture[]>();
  const fixtureRosters = new Map<string, FrozenRoster>();
  let expectedLineupCount = 0;
  for (const fixture of fixtures) {
    assertKnownFixtureStatus(fixture.status);
    const group = fixture.groupId === null ? undefined : groupById.get(fixture.groupId);
    const sideA =
      fixture.sideAEntryId === null
        ? undefined
        : membershipsByEntryId.get(fixture.sideAEntryId);
    const sideB =
      fixture.sideBEntryId === null
        ? undefined
        : membershipsByEntryId.get(fixture.sideBEntryId);
    if (
      fixture.matchId !== match.id ||
      fixture.stage !== "GROUP" ||
      group === undefined ||
      fixture.groupKey !== group.groupKey ||
      fixture.roundNumber !== null ||
      fixture.position !== null ||
      fixture.fixtureKey.trim() === "" ||
      fixtureKeys.has(fixture.fixtureKey) ||
      sideA === undefined ||
      sideB === undefined ||
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
    fixtureById.set(fixture.id, fixture);
    fixtureKeys.add(fixture.fixtureKey);
    const fixtureRoster = (membership: GroupEntryRow, version: number) => {
      const members = memberRowsByEntryRoster.get(membership.entryId)?.get(version) ?? [];
      const snapshotAt = version === membership.rosterVersion ? grouping.createdAt : new Date(Math.max(...members.map(member => member.effectiveFrom.getTime())));
      return validateFrozenRoster(match, grouping, { ...membership, rosterVersion: version }, entriesById.get(membership.entryId)!, members, snapshotAt);
    };
    const sideARoster = fixtureRoster(sideA, fixture.sideARosterVersion!);
    const sideBRoster = fixtureRoster(sideB, fixture.sideBRosterVersion!);
    fixtureRosters.set(`${fixture.id}:${sideA.entryId}`, sideARoster);
    fixtureRosters.set(`${fixture.id}:${sideB.entryId}`, sideBRoster);
    const fixtureLineups = lineupsByFixture.get(fixture.id) ?? [];
    assertLineupSide(
      fixture,
      "SIDE_A",
      sideA.entryId,
      sideARoster,
      fixtureLineups,
    );
    assertLineupSide(
      fixture,
      "SIDE_B",
      sideB.entryId,
      sideBRoster,
      fixtureLineups,
    );
    expectedLineupCount += sideARoster.members.length + sideBRoster.members.length;
  }
  if (
    lineups.length !== expectedLineupCount ||
    lineups.some((lineup) => !fixtureById.has(lineup.fixtureId))
  ) {
    fail("FIXTURE_LINEUP_INVALID", "The GROUP fixture lineup relation is polluted.");
  }

  const revisions = (await tx.resultRevision.findMany({
    where: { fixtureId: { in: fixtureIds } },
    orderBy: [{ fixtureId: "asc" }, { revisionNumber: "asc" }, { id: "asc" }],
    take: MAX_REVISION_COUNT + 1,
    select: {
      id: true,
      matchId: true,
      fixtureId: true,
      revisionNumber: true,
      status: true,
      resolutionKind: true,
      winnerEntryId: true,
      loserEntryId: true,
      score: true,
      reportedById: true,
      verifiedById: true,
      supersedesRevisionId: true,
      reason: true,
      resolvedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  })) as readonly RevisionRow[];
  if (revisions.length > MAX_REVISION_COUNT) {
    fail("PERSISTENCE_CONFLICT", "The GROUP result revision history is too large.", {
      revisionCount: revisions.length,
      maximum: MAX_REVISION_COUNT,
    });
  }
  const revisionsById = new Map<string, RevisionRow>();
  const revisionsByFixture = new Map<string, RevisionRow[]>();
  for (const revision of revisions) {
    assertKnownRevisionStatus(revision.status);
    if (
      revisionsById.has(revision.id) ||
      revision.matchId !== match.id ||
      !fixtureById.has(revision.fixtureId) ||
      !isPositiveInteger(revision.revisionNumber) ||
      (revision.resolutionKind !== "PLAYED" && revision.resolutionKind !== "FORFEIT")
    ) {
      fail("PERSISTENCE_CONFLICT", "A GROUP result revision is invalid.", {
        resultRevisionId: revision.id,
      });
    }
    assertDatabaseDate(revision.createdAt, "resultRevision.createdAt");
    assertDatabaseDate(revision.updatedAt, "resultRevision.updatedAt");
    if (revision.resolvedAt !== null) {
      assertDatabaseDate(revision.resolvedAt, "resultRevision.resolvedAt");
    }
    revisionsById.set(revision.id, revision);
    const current = revisionsByFixture.get(revision.fixtureId) ?? [];
    current.push(revision);
    revisionsByFixture.set(revision.fixtureId, current);
  }

  for (const fixture of fixtures) {
    const history = revisionsByFixture.get(fixture.id) ?? [];
    const sideIds = new Set([fixture.sideAEntryId!, fixture.sideBEntryId!]);
    for (let index = 0; index < history.length; index += 1) {
      const revision = history[index];
      if (
        revision.revisionNumber !== index + 1 ||
        revision.winnerEntryId === null ||
        revision.loserEntryId === null ||
        revision.winnerEntryId === revision.loserEntryId ||
        !sideIds.has(revision.winnerEntryId) ||
        !sideIds.has(revision.loserEntryId)
      ) {
        fail("PERSISTENCE_CONFLICT", "A fixture has corrupt result revision history.", {
          fixtureId: fixture.id,
          resultRevisionId: revision.id,
        });
      }
      if (revision.supersedesRevisionId !== null) {
        const predecessor = revisionsById.get(revision.supersedesRevisionId);
        if (
          predecessor === undefined ||
          predecessor.fixtureId !== fixture.id ||
          predecessor.revisionNumber >= revision.revisionNumber ||
          (predecessor.status !== "CONFIRMED" &&
            predecessor.status !== "SUPERSEDED")
        ) {
          fail("PERSISTENCE_CONFLICT", "A correction has an invalid predecessor.", {
            resultRevisionId: revision.id,
          });
        }
      }
    }
    const pending = history.filter((revision) => revision.status === "PENDING");
    const confirmed = history.filter((revision) => revision.status === "CONFIRMED");
    if (pending.length > 1 || confirmed.length > 1) {
      fail("PERSISTENCE_CONFLICT", "A fixture has ambiguous current result revisions.", {
        fixtureId: fixture.id,
      });
    }
    const current = confirmed[0];
    const groupDomainFixtures = domainFixturesByGroup.get(fixture.groupId!) ?? [];
    groupDomainFixtures.push({
      fixtureId: fixture.id,
      status: fixture.status,
      sideAEntryId: fixture.sideAEntryId!,
      sideBEntryId: fixture.sideBEntryId!,
      pendingRevisionIds: pending.map((revision) => revision.id),
      confirmedRevision: current
        ? {
            revisionId: current.id,
            resolutionKind: current.resolutionKind,
            winnerEntryId: current.winnerEntryId!,
            loserEntryId: current.loserEntryId!,
            score: current.score,
          }
        : null,
    });
    domainFixturesByGroup.set(fixture.groupId!, groupDomainFixtures);
  }

  const revisionIds = new Set(revisionsById.keys());

  const settlements = (await tx.settlementEvent.findMany({
    where: {
      OR: [
        { resultRevisionId: { in: [...revisionIds] } },
        { reverses: { is: { resultRevisionId: { in: [...revisionIds] } } } },
      ],
    },
    orderBy: [{ resultRevisionId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: MAX_SETTLEMENT_COUNT + 1,
    select: {
      id: true,
      idempotencyKey: true,
      kind: true,
      status: true,
      resultRevisionId: true,
      matchEntryId: true,
      reversesEventId: true,
      metadata: true,
      failureReason: true,
      appliedAt: true,
      createdAt: true,
      updatedAt: true,
      effects: {
        orderBy: { userId: "asc" },
        take: MAX_EFFECTS_PER_SETTLEMENT + 1,
        select: {
          id: true,
          eventId: true,
          userId: true,
          eloBefore: true,
          eloAfter: true,
          eloDelta: true,
          pointsBefore: true,
          pointsAfter: true,
          pointsDelta: true,
          winsDelta: true,
          lossesDelta: true,
          matchesPlayedDelta: true,
          createdAt: true,
        },
      },
    },
  })) as readonly SettlementRow[];
  if (settlements.length > MAX_SETTLEMENT_COUNT) {
    fail("PERSISTENCE_CONFLICT", "The GROUP result settlement history is too large.", {
      settlementCount: settlements.length,
      maximum: MAX_SETTLEMENT_COUNT,
    });
  }
  const settlementEffectCount = settlements.reduce(
    (total, event) => total + event.effects.length,
    0,
  );
  if (settlementEffectCount > MAX_SETTLEMENT_EFFECT_COUNT) {
    fail("PERSISTENCE_CONFLICT", "The GROUP settlement effect history is too large.", {
      effectCount: settlementEffectCount,
      maximum: MAX_SETTLEMENT_EFFECT_COUNT,
    });
  }
  if (new Set(settlements.map((event) => event.id)).size !== settlements.length) {
    fail("PERSISTENCE_CONFLICT", "Result settlement identities are duplicated.");
  }
  const settlementsByRevision = new Map<string, SettlementRow[]>();
  for (const event of settlements) {
    if (event.resultRevisionId === null || !revisionIds.has(event.resultRevisionId)) {
      fail("PERSISTENCE_CONFLICT", "A result settlement references an unknown revision.", {
        eventId: event.id,
      });
    }
    assertDatabaseDate(event.createdAt, "settlementEvent.createdAt");
    assertDatabaseDate(event.updatedAt, "settlementEvent.updatedAt");
    if (event.appliedAt !== null) {
      assertDatabaseDate(event.appliedAt, "settlementEvent.appliedAt");
    }
    if (event.effects.length > MAX_EFFECTS_PER_SETTLEMENT) {
      fail("PERSISTENCE_CONFLICT", "A result settlement effect set is too large.", {
        eventId: event.id,
        effectCount: event.effects.length,
        maximum: MAX_EFFECTS_PER_SETTLEMENT,
      });
    }
    for (const effect of event.effects) {
      assertDatabaseDate(effect.createdAt, "settlementEffect.createdAt");
    }
    const current = settlementsByRevision.get(event.resultRevisionId) ?? [];
    current.push(event);
    settlementsByRevision.set(event.resultRevisionId, current);
  }
  for (const revision of revisions) {
    const winnerRoster = fixtureRosters.get(`${revision.fixtureId}:${revision.winnerEntryId}`);
    const loserRoster = fixtureRosters.get(`${revision.fixtureId}:${revision.loserEntryId}`);
    if (winnerRoster === undefined || loserRoster === undefined) {
      fail("PERSISTENCE_CONFLICT", "A result revision has no frozen fixture roster.", {
        resultRevisionId: revision.id,
      });
    }
    validateSettlementHistory(
      revision,
      settlementsByRevision.get(revision.id) ?? [],
      winnerRoster.members.map((member) => member.userId),
      loserRoster.members.map((member) => member.userId),
    );
  }
  for (const fixture of fixtures) {
    validateRevisionChain(
      fixture.id,
      revisionsByFixture.get(fixture.id) ?? [],
      settlementsByRevision,
    );
  }

  const domainGroups: V2StandingsGroup[] = groups.map((group) => ({
    groupId: group.id,
    position: group.position,
    entries: membershipsByGroup.get(group.id)!.map((membership) => {
      const entry = entriesById.get(membership.entryId)!;
      return {
        entryId: membership.entryId,
        position: membership.position,
        globalSeedRank: membership.globalSeedRank,
        seedElo: membership.seedElo,
        eligible: entry.status === "ACTIVE",
        ...(entry.status === "ACTIVE"
          ? {}
          : { ineligibilityReason: entry.status }),
      };
    }),
    fixtures: domainFixturesByGroup.get(group.id) ?? [],
  }));
  let evaluation;
  try {
    evaluation = evaluateV2GroupQualification({
      matchType: match.type,
      qualifiersPerGroup: grouping.qualifiersPerGroup!,
      groups: domainGroups,
    });
  } catch (error) {
    if (error instanceof V2GroupStandingsError) mapStandingsError(error);
    throw error;
  }
  if (
    evaluation.qualificationCount !== grouping.qualifiersPerGroup! * groups.length
  ) {
    fail("PERSISTENCE_CONFLICT", "The evaluator returned an incomplete qualifier set.");
  }

  const sourceRevisionFingerprint = sha256({
    evaluator: evaluation.sourceFingerprintPayload,
    grouping: {
      id: grouping.id,
      matchId: grouping.matchId,
      schemaVersion: grouping.v2SchemaVersion,
      seedMethod: grouping.seedMethod,
      standingsPolicyVersion: grouping.standingsPolicyVersion,
      qualifiersPerGroup: grouping.qualifiersPerGroup,
      bracketPolicyVersion: grouping.bracketPolicyVersion,
      createdAt: grouping.createdAt.toISOString(),
    },
    groups: groups.map((group) => ({
      id: group.id,
      groupKey: group.groupKey,
      displayName: group.displayName,
      position: group.position,
      createdAt: group.createdAt.toISOString(),
    })),
    memberships: memberships.map((membership) => ({
      id: membership.id,
      groupId: membership.groupId,
      entryId: membership.entryId,
      position: membership.position,
      globalSeedRank: membership.globalSeedRank,
      seedElo: membership.seedElo,
      seedPoints: membership.seedPoints,
      entryVersion: membership.entryVersion,
      rosterVersion: membership.rosterVersion,
      currentEntryStatus: entriesById.get(membership.entryId)!.status,
      currentEntryVersion: entriesById.get(membership.entryId)!.version,
      members: frozenRosters.get(membership.entryId)!.members.map((member) => ({
        id: member.id,
        userId: member.userId,
        role: member.role,
        status: member.status,
        slot: member.slot,
        rosterVersion: member.rosterVersion,
        effectiveFrom: member.effectiveFrom.toISOString(),
        effectiveUntil: iso(member.effectiveUntil, "entryMember.effectiveUntil"),
        endReason: member.endReason,
      })),
    })),
    fixtures: fixtures.map((fixture) => ({
      id: fixture.id,
      fixtureKey: fixture.fixtureKey,
      status: fixture.status,
      groupId: fixture.groupId,
      groupKey: fixture.groupKey,
      sideAEntryId: fixture.sideAEntryId,
      sideBEntryId: fixture.sideBEntryId,
      sideARosterVersion: fixture.sideARosterVersion,
      sideBRosterVersion: fixture.sideBRosterVersion,
      completedAt: iso(fixture.completedAt, "fixture.completedAt"),
      lineup: (lineupsByFixture.get(fixture.id) ?? []).map((lineup) => ({
        id: lineup.id,
        entryId: lineup.entryId,
        entryMemberId: lineup.entryMemberId,
        side: lineup.side,
        position: lineup.position,
        createdAt: iso(lineup.createdAt, "lineup.createdAt"),
      })),
    })),
    // Every revision, not merely the current CONFIRMED row, is part of the
    // source identity. This makes later correction/history tampering visible.
    revisions: revisions.map((revision) => ({
      id: revision.id,
      fixtureId: revision.fixtureId,
      revisionNumber: revision.revisionNumber,
      status: revision.status,
      resolutionKind: revision.resolutionKind,
      winnerEntryId: revision.winnerEntryId,
      loserEntryId: revision.loserEntryId,
      score: revision.score,
      reportedById: revision.reportedById,
      verifiedById: revision.verifiedById,
      supersedesRevisionId: revision.supersedesRevisionId,
      reason: revision.reason,
      resolvedAt: iso(revision.resolvedAt, "resultRevision.resolvedAt"),
      createdAt: iso(revision.createdAt, "resultRevision.createdAt"),
      updatedAt: iso(revision.updatedAt, "resultRevision.updatedAt"),
    })),
    settlements: settlements.map((event) => ({
      id: event.id,
      idempotencyKey: event.idempotencyKey,
      kind: event.kind,
      status: event.status,
      resultRevisionId: event.resultRevisionId,
      reversesEventId: event.reversesEventId,
      metadata: event.metadata,
      failureReason: event.failureReason,
      appliedAt: iso(event.appliedAt, "settlementEvent.appliedAt"),
      createdAt: iso(event.createdAt, "settlementEvent.createdAt"),
      updatedAt: iso(event.updatedAt, "settlementEvent.updatedAt"),
      effects: event.effects.map((effect) => ({
        id: effect.id,
        userId: effect.userId,
        eloBefore: effect.eloBefore,
        eloAfter: effect.eloAfter,
        eloDelta: effect.eloDelta,
        pointsBefore: effect.pointsBefore,
        pointsAfter: effect.pointsAfter,
        pointsDelta: effect.pointsDelta,
        winsDelta: effect.winsDelta,
        lossesDelta: effect.lossesDelta,
        matchesPlayedDelta: effect.matchesPlayedDelta,
        createdAt: iso(effect.createdAt, "settlementEffect.createdAt"),
      })),
    })),
  });

  const existingSnapshot = (await tx.matchQualificationSnapshot.findUnique({
    where: { groupingId: grouping.id },
    select: {
      id: true,
      matchId: true,
      groupingId: true,
      schemaVersion: true,
      standingsPolicyVersion: true,
      sourceRevisionFingerprint: true,
      createdAt: true,
    },
  })) as SnapshotRow | null;
  const persistedStandings = (await tx.matchQualificationStanding.findMany({
    where: { matchId: match.id },
    orderBy: [{ groupId: "asc" }, { rank: "asc" }, { entryId: "asc" }],
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
      createdAt: true,
    },
  })) as readonly PersistedStandingRow[];

  if (existingSnapshot !== null) {
    assertExactPersistedSnapshot(
      existingSnapshot,
      persistedStandings,
      match.id,
      grouping.id,
      sourceRevisionFingerprint,
      evaluation.standings,
    );
    return {
      matchId: match.id,
      groupingId: grouping.id,
      snapshotId: existingSnapshot.id,
      created: false,
      frozenAt: existingSnapshot.createdAt,
      sourceRevisionFingerprint,
      qualificationCount: evaluation.qualificationCount,
      standings: evaluation.standings,
    };
  }
  if (persistedStandings.length !== 0) {
    fail("PERSISTENCE_CONFLICT", "Qualification standings exist without their snapshot.");
  }

  const snapshot = await tx.matchQualificationSnapshot.create({
    data: {
      matchId: match.id,
      groupingId: grouping.id,
      schemaVersion: V2_QUALIFICATION_SNAPSHOT_SCHEMA_VERSION,
      standingsPolicyVersion: V2_QUALIFICATION_STANDINGS_POLICY_VERSION,
      sourceRevisionFingerprint,
      createdAt: frozenAt,
    },
    select: { id: true, createdAt: true },
  });
  const persisted = await tx.matchQualificationStanding.createMany({
    data: evaluation.standings.map((standing) => ({
      matchId: match.id,
      snapshotId: snapshot.id,
      groupId: standing.groupId,
      entryId: standing.entryId,
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
      createdAt: frozenAt,
    })),
  });
  if (persisted.count !== evaluation.standings.length) {
    fail("PERSISTENCE_CONFLICT", "The complete qualification standing set was not persisted.", {
      expected: evaluation.standings.length,
      actual: persisted.count,
    });
  }
  await tx.auditLog.create({
    data: {
      actorId: lockedUsers.actor.id,
      action: "v2_qualification_snapshot_freeze",
      entityType: "Match",
      entityId: match.id,
      createdAt: frozenAt,
      details: {
        targetLabel: match.title,
        groupingId: grouping.id,
        snapshotId: snapshot.id,
        sourceRevisionFingerprint,
        schemaVersion: V2_QUALIFICATION_SNAPSHOT_SCHEMA_VERSION,
        standingsPolicyVersion: V2_QUALIFICATION_STANDINGS_POLICY_VERSION,
        groupCount: groups.length,
        standingCount: evaluation.standings.length,
        qualificationCount: evaluation.qualificationCount,
      },
    },
  });
  return {
    matchId: match.id,
    groupingId: grouping.id,
    snapshotId: snapshot.id,
    created: true,
    frozenAt: snapshot.createdAt,
    sourceRevisionFingerprint,
    qualificationCount: evaluation.qualificationCount,
    standings: evaluation.standings,
  };
}

/**
 * @internal Use only from an application service that already owns the outer
 * transaction. The command is normalized again so orchestration cannot bypass
 * the public anti-over-posting boundary.
 */
export function freezeV2QualificationSnapshotInTransaction(
  tx: V2CompetitionTransaction,
  rawCommand: FreezeV2QualificationSnapshotCommand,
  clock: () => Date,
) {
  return freezeInTransaction(tx, normalizeCommand(rawCommand), clock);
}

export function createV2QualificationSnapshotApplicationService(
  dependencies: V2QualificationSnapshotApplicationServiceDependencies,
): V2QualificationSnapshotApplicationService {
  const clock = dependencies.clock ?? (() => new Date());
  return Object.freeze({
    freeze: async (rawCommand) => {
      const command = normalizeCommand(rawCommand);
      return runV2Transaction(dependencies.db, (tx) =>
        freezeInTransaction(tx, command, clock),
      );
    },
  });
}
