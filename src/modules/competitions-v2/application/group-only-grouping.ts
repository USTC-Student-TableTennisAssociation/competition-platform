import { Prisma, type CompetitionFormat, type PrismaClient } from "@prisma/client";

import { assertEngineCanWrite } from "../domain";
import {
  V2CompetitionApplicationError,
  runV2Transaction,
  type V2Actor,
  type V2CompetitionTransaction,
} from "./entries";

export const V2_GROUP_ONLY_PUBLICATION_SCHEMA_VERSION = 1;
export const V2_GROUP_ONLY_STANDINGS_POLICY_VERSION = 1;
export const V2_GROUP_THEN_KNOCKOUT_BRACKET_POLICY_VERSION = 1;

const IDENTIFIER_PADDING = 4;
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const MAX_GROUPING_ENTRY_COUNT = 1_024;
const MAX_GROUP_COUNT = 256;
const MAX_GROUP_FIXTURE_COUNT = 10_000;

export type V2GroupOnlyGroupingMatchType = "single" | "double" | "team";

export type V2GroupOnlyGroupingExpectedEntry = Readonly<{
  entryId: string;
  version: number;
}>;

export type V2GroupOnlyGroupingDraft = Readonly<{
  format: CompetitionFormat;
  groups: readonly Readonly<{ entryIds: readonly string[] }>[];
  qualifiersPerGroup?: number;
  seedMethod?: "min_diff" | "snake";
}>;

export type PublishV2GroupOnlyGroupingCommand = Readonly<{
  actor: V2Actor;
  matchId: string;
  expectedEntries: readonly V2GroupOnlyGroupingExpectedEntry[];
  draft: V2GroupOnlyGroupingDraft;
}>;

export type PublishV2GroupOnlyGroupingResult = Readonly<{
  matchId: string;
  created: boolean;
  publishedAt: Date;
  groupCount: number;
  fixtureCount: number;
}>;

export type V2GroupOnlyGroupingApplicationService = Readonly<{
  publish(
    command: PublishV2GroupOnlyGroupingCommand,
  ): Promise<PublishV2GroupOnlyGroupingResult>;
}>;

export type V2GroupOnlyGroupingApplicationServiceDependencies = Readonly<{
  db: Pick<PrismaClient, "$transaction">;
  clock?: () => Date;
}>;

export type V2GroupOnlyGroupingProfile = Readonly<{
  matchType: V2GroupOnlyGroupingMatchType;
  entryKind: "INDIVIDUAL" | "DOUBLES" | "TEAM";
  format: "group_only" | "group_then_knockout";
  projectionCompetitorType: "user" | "team";
  publication: string;
  auditAction: string;
  formalMatchMessage: string;
  groupThenUnavailableMessage: string;
}>;

export const V2_SINGLE_GROUP_ONLY_GROUPING_PROFILE = Object.freeze({
  matchType: "single",
  entryKind: "INDIVIDUAL",
  format: "group_only",
  projectionCompetitorType: "user",
  publication: "V2_SINGLE_GROUPING",
  auditAction: "v2_single_grouping_publish",
  formalMatchMessage: "This command accepts formal singles matches only.",
  groupThenUnavailableMessage:
    "SINGLE V2 group-then-knockout publication is not enabled yet.",
} satisfies V2GroupOnlyGroupingProfile);

export const V2_DOUBLE_GROUP_ONLY_GROUPING_PROFILE = Object.freeze({
  matchType: "double",
  entryKind: "DOUBLES",
  format: "group_only",
  projectionCompetitorType: "team",
  publication: "V2_DOUBLE_GROUPING",
  auditAction: "v2_double_grouping_publish",
  formalMatchMessage: "This command accepts formal doubles matches only.",
  groupThenUnavailableMessage:
    "DOUBLE V2 group-then-knockout publication is not enabled yet.",
} satisfies V2GroupOnlyGroupingProfile);

export const V2_TEAM_GROUP_ONLY_GROUPING_PROFILE = Object.freeze({
  matchType: "team",
  entryKind: "TEAM",
  format: "group_only",
  projectionCompetitorType: "team",
  publication: "V2_TEAM_GROUPING",
  auditAction: "v2_team_grouping_publish",
  formalMatchMessage: "This command accepts formal team matches only.",
  groupThenUnavailableMessage:
    "TEAM V2 group-then-knockout publication is not enabled yet.",
} satisfies V2GroupOnlyGroupingProfile);

export const V2_SINGLE_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE = Object.freeze({
  ...V2_SINGLE_GROUP_ONLY_GROUPING_PROFILE,
  format: "group_then_knockout",
  publication: "V2_SINGLE_GROUP_THEN_KNOCKOUT_GROUPING",
  auditAction: "v2_single_group_then_knockout_grouping_publish",
} satisfies V2GroupOnlyGroupingProfile);

export const V2_DOUBLE_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE = Object.freeze({
  ...V2_DOUBLE_GROUP_ONLY_GROUPING_PROFILE,
  format: "group_then_knockout",
  publication: "V2_DOUBLE_GROUP_THEN_KNOCKOUT_GROUPING",
  auditAction: "v2_double_group_then_knockout_grouping_publish",
} satisfies V2GroupOnlyGroupingProfile);

export const V2_TEAM_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE = Object.freeze({
  ...V2_TEAM_GROUP_ONLY_GROUPING_PROFILE,
  format: "group_then_knockout",
  publication: "V2_TEAM_GROUP_THEN_KNOCKOUT_GROUPING",
  auditAction: "v2_team_group_then_knockout_grouping_publish",
} satisfies V2GroupOnlyGroupingProfile);

type NormalizedCommand = Readonly<{
  actor: V2Actor;
  matchId: string;
  expectedEntries: readonly V2GroupOnlyGroupingExpectedEntry[];
  draft: Readonly<{
    format: "group_only" | "group_then_knockout";
    groups: readonly Readonly<{ entryIds: readonly string[] }>[];
    seedMethod: "min_diff" | "snake";
    qualifiersPerGroup: number | null;
  }>;
}>;

type UserSnapshot = Readonly<{
  id: string;
  nickname: string;
  points: number;
  eloRating: number;
}>;

type AuthoritativeMember = Readonly<{
  id: string;
  userId: string;
  role: "player" | "captain" | "substitute";
  slot: number;
  rosterVersion: number;
  user: UserSnapshot;
}>;

type AuthoritativeEntry = Readonly<{
  id: string;
  version: number;
  rosterVersion: number;
  displayName: string;
  projectionCompetitorId: string;
  seedElo: number;
  seedPoints: number;
  members: readonly AuthoritativeMember[];
}>;

type EntryRow = Readonly<{
  id: string;
  kind: "INDIVIDUAL" | "DOUBLES" | "TEAM";
  status: "DRAFT" | "ACTIVE" | "WITHDRAWN" | "DISQUALIFIED" | "ARCHIVED";
  version: number;
  sourceKey: string;
  sourceUserId: string | null;
  sourceDoublesTeamId: string | null;
  sourceMatchTeamId: string | null;
  displayNameSnapshot: string;
  sourceDoublesTeam: Readonly<{
    id: string;
    matchId: string;
    members: readonly Readonly<{ matchId: string; userId: string; slot: number }>[];
  }> | null;
  sourceMatchTeam: Readonly<{
    id: string;
    matchId: string;
    status: "draft" | "submitted" | "approved" | "rejected" | "waitlisted" | "cancelled";
    captainId: string;
    members: readonly Readonly<{ matchId: string; userId: string }>[];
  }> | null;
  members: readonly Readonly<{
    id: string;
    userId: string;
    role: "player" | "captain" | "substitute";
    slot: number;
    rosterVersion: number;
  }>[];
}>;

type GroupPlan = Readonly<{
  groupKey: string;
  displayName: string;
  position: number;
  entryIds: readonly string[];
}>;

type GroupFixtureDefinition = Readonly<{
  matchId: string;
  fixtureKey: string;
  stage: "GROUP";
  status: "READY";
  groupId: string;
  groupKey: string;
  roundNumber: null;
  position: null;
  sideAEntryId: string;
  sideBEntryId: string;
  sideARosterVersion: number;
  sideBRosterVersion: number;
  sideAMembers: readonly AuthoritativeMember[];
  sideBMembers: readonly AuthoritativeMember[];
  metadata: Prisma.InputJsonObject;
}>;

type ExistingGroupRow = Readonly<{
  id: string;
  matchId: string;
  groupingId: string;
  groupKey: string;
  displayName: string;
  position: number;
  entries: readonly Readonly<{
    matchId: string;
    groupId: string;
    entryId: string;
    position: number;
    globalSeedRank: number;
    seedElo: number;
    seedPoints: number;
    entryVersion: number;
    rosterVersion: number;
  }>[];
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

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function assertOnlyKeys(
  value: Record<string, unknown>,
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

function assertStableIdentifier(value: unknown, name: string): asserts value is string {
  if (
    typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    !value.includes("\u0000")
  ) {
    return;
  }
  fail("INVALID_INPUT", `${name} must be a non-empty stable identifier.`, { name });
}

function assertVersion(value: unknown, name: string): asserts value is number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return;
  }
  fail("INVALID_INPUT", `${name} must be a non-negative safe integer.`, {
    name,
    value,
  });
}

function normalizeCommand(
  command: PublishV2GroupOnlyGroupingCommand,
  profile: V2GroupOnlyGroupingProfile,
): NormalizedCommand {
  if (!isRecord(command)) {
    fail("INVALID_INPUT", "The grouping command must be an object.");
  }
  assertOnlyKeys(command, ["actor", "matchId", "expectedEntries", "draft"], "command");
  assertStableIdentifier(command.matchId, "matchId");

  if (!isRecord(command.actor)) fail("INVALID_INPUT", "actor must be an object.");
  assertOnlyKeys(command.actor, ["id", "role"], "actor");
  assertStableIdentifier(command.actor.id, "actor.id");
  if (command.actor.role !== "user" && command.actor.role !== "admin") {
    fail("INVALID_INPUT", "actor.role must be user or admin.");
  }

  if (!Array.isArray(command.expectedEntries)) {
    fail("INVALID_INPUT", "expectedEntries must be an array.");
  }
  if (command.expectedEntries.length > MAX_GROUPING_ENTRY_COUNT) {
    fail("INVALID_INPUT", "The grouping contains too many entries.");
  }
  const expectedEntries = command.expectedEntries.map((value, index) => {
    if (!isRecord(value)) {
      fail("INVALID_INPUT", "Each expected entry must be an object.", { index });
    }
    assertOnlyKeys(value, ["entryId", "version"], `expectedEntries[${index}]`);
    assertStableIdentifier(value.entryId, `expectedEntries[${index}].entryId`);
    assertVersion(value.version, `expectedEntries[${index}].version`);
    return { entryId: value.entryId, version: value.version };
  });
  if (new Set(expectedEntries.map((entry) => entry.entryId)).size !== expectedEntries.length) {
    fail("INVALID_INPUT", "expectedEntries must not contain duplicate entries.");
  }

  if (!isRecord(command.draft)) fail("INVALID_INPUT", "draft must be an object.");
  assertOnlyKeys(
    command.draft,
    ["format", "groups", "qualifiersPerGroup", "seedMethod"],
    "draft",
  );
  if (
    command.draft.format !== "group_only" &&
    command.draft.format !== "group_then_knockout"
  ) {
    fail("INVALID_INPUT", "draft.format is invalid.");
  }
  if (!Array.isArray(command.draft.groups) || command.draft.groups.length === 0) {
    fail("INVALID_INPUT", "draft.groups must contain at least one group.");
  }
  if (command.draft.groups.length > MAX_GROUP_COUNT) {
    fail("INVALID_INPUT", "The grouping contains too many groups.");
  }

  const allGroupedEntryIds: string[] = [];
  const groups = command.draft.groups.map((value, groupIndex) => {
    if (!isRecord(value)) {
      fail("INVALID_INPUT", "Each group must be an object.", { groupIndex });
    }
    assertOnlyKeys(value, ["entryIds"], `draft.groups[${groupIndex}]`);
    if (!Array.isArray(value.entryIds) || value.entryIds.length < 2) {
      fail("INVALID_INPUT", "Every V2 group must contain at least two entries.", {
        groupIndex,
      });
    }
    const entryIds = value.entryIds.map((entryId, entryIndex) => {
      assertStableIdentifier(
        entryId,
        `draft.groups[${groupIndex}].entryIds[${entryIndex}]`,
      );
      allGroupedEntryIds.push(entryId);
      return entryId;
    });
    return { entryIds };
  });

  if (allGroupedEntryIds.length < 2) {
    fail("INVALID_INPUT", "At least two entries are required for grouping.");
  }
  if (new Set(allGroupedEntryIds).size !== allGroupedEntryIds.length) {
    fail("INVALID_INPUT", "An entry may appear in only one group.");
  }
  const fixtureCount = groups.reduce(
    (total, group) =>
      total + (group.entryIds.length * (group.entryIds.length - 1)) / 2,
    0,
  );
  if (!Number.isSafeInteger(fixtureCount) || fixtureCount > MAX_GROUP_FIXTURE_COUNT) {
    fail("INVALID_INPUT", "The grouping would create too many fixtures.", {
      fixtureCount,
    });
  }
  const expectedIds = new Set(expectedEntries.map((entry) => entry.entryId));
  if (
    expectedIds.size !== allGroupedEntryIds.length ||
    allGroupedEntryIds.some((entryId) => !expectedIds.has(entryId))
  ) {
    fail("INVALID_INPUT", "The grouped entries must exactly match expectedEntries.");
  }

  const seedMethod = command.draft.seedMethod ?? "min_diff";
  if (seedMethod !== "min_diff" && seedMethod !== "snake") {
    fail("INVALID_INPUT", "draft.seedMethod is invalid.");
  }

  let qualifiersPerGroup: number | null = null;
  if (command.draft.format === "group_then_knockout") {
    const qualifierCount = command.draft.qualifiersPerGroup;
    if (
      typeof qualifierCount !== "number" ||
      !Number.isSafeInteger(qualifierCount) ||
      qualifierCount < 1
    ) {
      fail(
        "INVALID_INPUT",
        "qualifiersPerGroup must be a positive integer for a knockout format.",
      );
    }
    const totalQualified = qualifierCount * groups.length;
    if (
      !Number.isSafeInteger(totalQualified) ||
      totalQualified < 2 ||
      !Number.isInteger(Math.log2(totalQualified))
    ) {
      fail("INVALID_INPUT", "The number of qualifiers must be a power of two.", {
        groupCount: groups.length,
        qualifiersPerGroup: qualifierCount,
      });
    }
    if (groups.some((group) => group.entryIds.length < qualifierCount)) {
      fail(
        "INVALID_INPUT",
        "Every group must contain at least qualifiersPerGroup entries.",
      );
    }
    qualifiersPerGroup = qualifierCount;
  } else if (command.draft.qualifiersPerGroup !== undefined) {
    fail(
      "INVALID_INPUT",
      "qualifiersPerGroup is supported only by group_then_knockout.",
    );
  }

  if (command.draft.format !== profile.format) {
    if (
      command.draft.format === "group_then_knockout" &&
      profile.format === "group_only"
    ) {
      fail("FIXTURE_CREATION_NOT_ALLOWED", profile.groupThenUnavailableMessage);
    }
    fail("FIXTURE_CREATION_NOT_ALLOWED", "The grouping format is not enabled by this service.", {
      expectedFormat: profile.format,
      actualFormat: command.draft.format,
    });
  }

  return {
    actor: { id: command.actor.id, role: command.actor.role },
    matchId: command.matchId,
    expectedEntries,
    draft: {
      format: command.draft.format,
      groups,
      seedMethod,
      qualifiersPerGroup,
    },
  };
}

function stableOrdinal(value: number) {
  return String(value).padStart(IDENTIFIER_PADDING, "0");
}

function groupKey(groupIndex: number) {
  return `group:${stableOrdinal(groupIndex + 1)}`;
}

function fixtureKey(groupIndex: number, sideAIndex: number, sideBIndex: number) {
  return `${groupKey(groupIndex)}:pair:${stableOrdinal(sideAIndex + 1)}-${stableOrdinal(sideBIndex + 1)}`;
}

function compareEntryIds(left: string, right: string) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function isInt32(value: unknown, allowNegative: boolean): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= (allowNegative ? INT32_MIN : 0) &&
    value <= INT32_MAX
  );
}

function roundedIntegerAverage(
  values: readonly number[],
  name: string,
  allowNegative: boolean,
) {
  if (
    values.length === 0 ||
    values.some(
      (value) =>
        !Number.isSafeInteger(value) || (!allowNegative && value < 0),
    )
  ) {
    fail("FIXTURE_ENTRY_INVALID", `${name} contains invalid seed inputs.`);
  }
  const zero = BigInt(0);
  const one = BigInt(1);
  const two = BigInt(2);
  const total = values.reduce((sum, value) => sum + BigInt(value), zero);
  const count = BigInt(values.length);
  const quotient = total / count;
  const remainder = total % count;
  const magnitude = remainder < zero ? -remainder : remainder;
  const rounded =
    total >= zero
      ? quotient + (magnitude * two >= count ? one : zero)
      : quotient - (magnitude * two > count ? one : zero);
  if (rounded < BigInt(allowNegative ? INT32_MIN : 0) || rounded > BigInt(INT32_MAX)) {
    fail("FIXTURE_ENTRY_INVALID", `${name} is outside the database integer range.`);
  }
  return Number(rounded);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function buildGroupPlans(command: NormalizedCommand): GroupPlan[] {
  return command.draft.groups.map((group, index) => ({
    groupKey: groupKey(index),
    displayName: `第 ${index + 1} 组`,
    position: index + 1,
    entryIds: group.entryIds,
  }));
}

function buildProjection(
  command: NormalizedCommand,
  profile: V2GroupOnlyGroupingProfile,
  entries: ReadonlyMap<string, AuthoritativeEntry>,
  publishedAt: Date,
): Prisma.InputJsonObject {
  const groups = buildGroupPlans(command).map((group) => {
    const groupEntries = group.entryIds.map((entryId) => entries.get(entryId)!);
    const players = groupEntries.map((entry) => {
      if (profile.matchType === "single") {
        const user = entry.members[0].user;
        return {
          id: user.id,
          nickname: user.nickname,
          points: user.points,
          eloRating: user.eloRating,
        };
      }
      return {
        id: entry.projectionCompetitorId,
        nickname: entry.displayName,
        points: entry.seedPoints,
        eloRating: entry.seedElo,
      };
    });
    return {
      name: group.displayName,
      players,
      averagePoints: roundedIntegerAverage(
        groupEntries.map((entry) => entry.seedElo),
        "group Elo average",
        true,
      ),
    };
  });
  return {
    generatedAt: publishedAt.toISOString(),
    competitorType: profile.projectionCompetitorType,
    format: command.draft.format,
    config: {
      groupCount: groups.length,
      seedMethod: command.draft.seedMethod,
      ...(command.draft.format === "group_then_knockout"
        ? { qualifiersPerGroup: command.draft.qualifiersPerGroup }
        : {}),
    },
    groups,
    v2Publication: {
      schemaVersion: V2_GROUP_ONLY_PUBLICATION_SCHEMA_VERSION,
      groups: buildGroupPlans(command).map((group) => ({
        groupKey: group.groupKey,
        entryIds: [...group.entryIds],
      })),
    },
  } as unknown as Prisma.InputJsonObject;
}

function projectionIdentity(
  value: unknown,
  profile: V2GroupOnlyGroupingProfile,
) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "generatedAt",
      "competitorType",
      "format",
      "config",
      "groups",
      "v2Publication",
      "tableAssignments",
    ]) ||
    typeof value.generatedAt !== "string" ||
    value.competitorType !== profile.projectionCompetitorType ||
    value.format !== profile.format ||
    !isRecord(value.config) ||
    !hasOnlyKeys(
      value.config,
      profile.format === "group_then_knockout"
        ? ["groupCount", "seedMethod", "qualifiersPerGroup"]
        : ["groupCount", "seedMethod"],
    ) ||
    (profile.format === "group_then_knockout" &&
      (!Number.isSafeInteger(value.config.qualifiersPerGroup) ||
        (value.config.qualifiersPerGroup as number) < 1)) ||
    !Array.isArray(value.groups) ||
    !isRecord(value.v2Publication)
  ) {
    return null;
  }
  const groups = value.groups.map((group) => {
    if (
      !isRecord(group) ||
      !hasOnlyKeys(group, ["name", "players", "averagePoints"]) ||
      typeof group.name !== "string" ||
      typeof group.averagePoints !== "number" ||
      !Array.isArray(group.players)
    ) {
      return null;
    }
    const playerIds = group.players.map((player) => {
      if (
        !isRecord(player) ||
        !hasOnlyKeys(player, ["id", "nickname", "points", "eloRating"]) ||
        typeof player.id !== "string" ||
        typeof player.nickname !== "string" ||
        typeof player.points !== "number" ||
        typeof player.eloRating !== "number"
      ) {
        return null;
      }
      return player.id;
    });
    return playerIds.some((id) => id === null)
      ? null
      : { name: group.name, playerIds };
  });
  if (groups.some((group) => group === null)) return null;
  return stableJson({
    competitorType: value.competitorType,
    format: value.format,
    config: value.config,
    groups,
    v2Publication: value.v2Publication,
  });
}

function projectionMatchesFrozenSeeds(
  value: unknown,
  command: NormalizedCommand,
  groups: readonly ExistingGroupRow[],
  entries: ReadonlyMap<string, AuthoritativeEntry>,
) {
  if (!isRecord(value) || !Array.isArray(value.groups)) return false;
  const projectedGroups = value.groups;
  const plans = buildGroupPlans(command);
  if (projectedGroups.length !== plans.length) return false;
  return plans.every((plan, groupIndex) => {
    const projectedGroup = projectedGroups[groupIndex];
    const relationalGroup = groups.find(
      (candidate) => candidate.groupKey === plan.groupKey,
    );
    if (
      !isRecord(projectedGroup) ||
      !Array.isArray(projectedGroup.players) ||
      projectedGroup.players.length !== plan.entryIds.length ||
      !relationalGroup
    ) {
      return false;
    }
    const memberships = [...relationalGroup.entries].sort(
      (left, right) => left.position - right.position,
    );
    if (memberships.length !== plan.entryIds.length) return false;
    for (let index = 0; index < plan.entryIds.length; index += 1) {
      const entryId = plan.entryIds[index];
      const membership = memberships[index];
      const projectedPlayer = projectedGroup.players[index];
      if (
        !isRecord(projectedPlayer) ||
        membership.entryId !== entryId ||
        projectedPlayer.id !== entries.get(entryId)?.projectionCompetitorId ||
        projectedPlayer.eloRating !== membership.seedElo ||
        projectedPlayer.points !== membership.seedPoints
      ) {
        return false;
      }
    }
    return (
      projectedGroup.averagePoints ===
      roundedIntegerAverage(
        memberships.map((membership) => membership.seedElo),
        "frozen group Elo average",
        true,
      )
    );
  });
}

function fixtureMetadataIdentity(value: unknown) {
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
    ])
  ) {
    return null;
  }
  const immutable = { ...value };
  delete immutable.v2Display;
  return stableJson(immutable);
}

function buildFixtures(
  command: NormalizedCommand,
  profile: V2GroupOnlyGroupingProfile,
  entries: ReadonlyMap<string, AuthoritativeEntry>,
  groupIds: ReadonlyMap<string, string>,
): GroupFixtureDefinition[] {
  return command.draft.groups.flatMap((group, groupIndex) => {
    const fixtures: GroupFixtureDefinition[] = [];
    const key = groupKey(groupIndex);
    const groupId = groupIds.get(key);
    if (!groupId) {
      fail("PERSISTENCE_CONFLICT", "A grouping row is missing its materialized group.", {
        groupKey: key,
      });
    }
    for (let sideAIndex = 0; sideAIndex < group.entryIds.length; sideAIndex += 1) {
      for (
        let sideBIndex = sideAIndex + 1;
        sideBIndex < group.entryIds.length;
        sideBIndex += 1
      ) {
        const sideA = entries.get(group.entryIds[sideAIndex])!;
        const sideB = entries.get(group.entryIds[sideBIndex])!;
        fixtures.push({
          matchId: command.matchId,
          fixtureKey: fixtureKey(groupIndex, sideAIndex, sideBIndex),
          stage: "GROUP",
          status: "READY",
          groupId,
          groupKey: key,
          roundNumber: null,
          position: null,
          sideAEntryId: sideA.id,
          sideBEntryId: sideB.id,
          sideARosterVersion: sideA.rosterVersion,
          sideBRosterVersion: sideB.rosterVersion,
          sideAMembers: sideA.members,
          sideBMembers: sideB.members,
          metadata: {
            publication: profile.publication,
            publicationVersion: V2_GROUP_ONLY_PUBLICATION_SCHEMA_VERSION,
            groupIndex: groupIndex + 1,
            groupName: `第 ${groupIndex + 1} 组`,
            format: command.draft.format,
            qualifiersPerGroup: command.draft.qualifiersPerGroup,
            seedMethod: command.draft.seedMethod,
            sideAPosition: sideAIndex + 1,
            sideBPosition: sideBIndex + 1,
          },
        });
      }
    }
    return fixtures;
  });
}

function fixtureCreateData(
  fixture: GroupFixtureDefinition,
): Prisma.MatchFixtureCreateManyInput {
  return {
    matchId: fixture.matchId,
    fixtureKey: fixture.fixtureKey,
    stage: fixture.stage,
    status: fixture.status,
    groupId: fixture.groupId,
    groupKey: fixture.groupKey,
    roundNumber: fixture.roundNumber,
    position: fixture.position,
    sideAEntryId: fixture.sideAEntryId,
    sideBEntryId: fixture.sideBEntryId,
    sideARosterVersion: fixture.sideARosterVersion,
    sideBRosterVersion: fixture.sideBRosterVersion,
    metadata: fixture.metadata,
  };
}

function expectedFixtureCount(command: NormalizedCommand) {
  return command.draft.groups.reduce(
    (total, group) => total + (group.entryIds.length * (group.entryIds.length - 1)) / 2,
    0,
  );
}

function currentRosterVersion(entry: EntryRow) {
  if (entry.members.length === 0) {
    fail("FIXTURE_ENTRY_INVALID", "Every active Entry must have a current roster.", {
      entryId: entry.id,
    });
  }
  const rosterVersion = entry.members[0].rosterVersion;
  const memberIds = new Set<string>();
  const userIds = new Set<string>();
  if (
    !Number.isSafeInteger(rosterVersion) ||
    rosterVersion < 1
  ) {
    fail("FIXTURE_ENTRY_INVALID", "The active Entry roster is structurally incomplete.", {
      entryId: entry.id,
    });
  }
  for (let index = 0; index < entry.members.length; index += 1) {
    const member = entry.members[index];
    if (
      member.rosterVersion !== rosterVersion ||
      member.slot !== index + 1 ||
      memberIds.has(member.id) ||
      userIds.has(member.userId)
    ) {
      fail(
        "FIXTURE_ENTRY_INVALID",
        "The active Entry roster is structurally incomplete.",
        { entryId: entry.id },
      );
    }
    memberIds.add(member.id);
    userIds.add(member.userId);
  }
  return rosterVersion;
}

function validateEntrySource(
  entry: EntryRow,
  profile: V2GroupOnlyGroupingProfile,
  match: Readonly<{
    id: string;
    teamMinMembers: number | null;
    teamMaxMembers: number | null;
  }>,
) {
  if (entry.kind !== profile.entryKind) {
    fail("FIXTURE_ENTRY_INVALID", "An active Entry kind does not match the match type.", {
      entryId: entry.id,
      expectedKind: profile.entryKind,
      actualKind: entry.kind,
    });
  }
  if (profile.matchType === "single") {
    if (
      !entry.sourceUserId ||
      entry.sourceKey !== `individual:${entry.sourceUserId}` ||
      entry.sourceDoublesTeamId !== null ||
      entry.sourceMatchTeamId !== null ||
      entry.members.length !== 1 ||
      entry.members[0].userId !== entry.sourceUserId ||
      entry.members[0].role !== "player"
    ) {
      fail(
        "FIXTURE_ENTRY_INVALID",
        "Every active singles Entry must have one complete current roster.",
        { entryId: entry.id },
      );
    }
    return entry.sourceUserId;
  }
  if (profile.matchType === "double") {
    const source = entry.sourceDoublesTeam;
    if (
      !entry.sourceDoublesTeamId ||
      !source ||
      source.id !== entry.sourceDoublesTeamId ||
      source.matchId !== match.id ||
      entry.sourceKey !== `doubles:${entry.sourceDoublesTeamId}` ||
      entry.sourceUserId !== null ||
      entry.sourceMatchTeamId !== null ||
      entry.members.length !== 2 ||
      entry.members.some((member) => member.role !== "player") ||
      source.members.length !== 2 ||
      source.members.some(
        (member, index) =>
          member.matchId !== match.id ||
          member.slot !== index + 1 ||
          member.userId !== entry.members[index].userId,
      )
    ) {
      fail(
        "FIXTURE_ENTRY_INVALID",
        "Every active doubles Entry must match one complete two-player source roster.",
        { entryId: entry.id },
      );
    }
    return entry.sourceDoublesTeamId;
  }

  const source = entry.sourceMatchTeam;
  const min = match.teamMinMembers;
  const max = match.teamMaxMembers;
  const captains = entry.members.filter((member) => member.role === "captain");
  const sourceUserIds = source?.members.map((member) => member.userId).sort() ?? [];
  const entryUserIds = entry.members.map((member) => member.userId).sort();
  if (
    !entry.sourceMatchTeamId ||
    !source ||
    source.id !== entry.sourceMatchTeamId ||
    source.matchId !== match.id ||
    source.status !== "approved" ||
    source.members.some((member) => member.matchId !== match.id) ||
    entry.sourceKey !== `team:${entry.sourceMatchTeamId}` ||
    entry.sourceUserId !== null ||
    entry.sourceDoublesTeamId !== null ||
    !Number.isSafeInteger(min) ||
    !Number.isSafeInteger(max) ||
    min === null ||
    max === null ||
    min < 1 ||
    max < min ||
    entry.members.length < min ||
    entry.members.length > max ||
    captains.length !== 1 ||
    captains[0].userId !== source.captainId ||
    sourceUserIds.length !== entryUserIds.length ||
    sourceUserIds.some((userId, index) => userId !== entryUserIds[index])
  ) {
    fail(
      "FIXTURE_ENTRY_INVALID",
      "Every active team Entry must match an approved, complete source roster with one captain.",
      { entryId: entry.id },
    );
  }
  return entry.sourceMatchTeamId;
}

function validateExistingGroups(
  groups: readonly ExistingGroupRow[],
  groupingId: string,
  command: NormalizedCommand,
  entries: ReadonlyMap<string, AuthoritativeEntry>,
) {
  const expectedGroups = buildGroupPlans(command);
  if (groups.length !== expectedGroups.length) return null;
  const groupIds = new Map<string, string>();
  const memberships: ExistingGroupRow["entries"][number][] = [];
  for (const expected of expectedGroups) {
    const group = groups.find((candidate) => candidate.groupKey === expected.groupKey);
    if (
      !group ||
      group.matchId !== command.matchId ||
      group.groupingId !== groupingId ||
      group.displayName !== expected.displayName ||
      group.position !== expected.position ||
      group.entries.length !== expected.entryIds.length
    ) {
      return null;
    }
    groupIds.set(group.groupKey, group.id);
    for (let index = 0; index < expected.entryIds.length; index += 1) {
      const entryId = expected.entryIds[index];
      const current = entries.get(entryId)!;
      const membership = group.entries.find((row) => row.entryId === entryId);
      if (
        !membership ||
        membership.matchId !== command.matchId ||
        membership.groupId !== group.id ||
        membership.position !== index + 1 ||
        membership.entryVersion !== current.version ||
        membership.rosterVersion !== current.rosterVersion ||
        !isInt32(membership.seedElo, true) ||
        !isInt32(membership.seedPoints, false) ||
        !Number.isSafeInteger(membership.globalSeedRank) ||
        membership.globalSeedRank < 1
      ) {
        return null;
      }
      memberships.push(membership);
    }
  }
  if (new Set(memberships.map((row) => row.entryId)).size !== entries.size) return null;
  const ranked = [...memberships].sort(
    (left, right) =>
      right.seedElo - left.seedElo ||
      right.seedPoints - left.seedPoints ||
      compareEntryIds(left.entryId, right.entryId),
  );
  if (ranked.some((membership, index) => membership.globalSeedRank !== index + 1)) {
    return null;
  }
  return groupIds;
}

async function publishInTransaction(
  tx: V2CompetitionTransaction,
  command: NormalizedCommand,
  profile: V2GroupOnlyGroupingProfile,
  clock: () => Date,
): Promise<PublishV2GroupOnlyGroupingResult> {
  const lockedMatch = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Match" WHERE "id" = ${command.matchId} FOR UPDATE
  `);
  if (lockedMatch.length === 0) {
    fail("MATCH_NOT_FOUND", "The match does not exist.", { matchId: command.matchId });
  }
  const publishedAt = clock();
  if (!(publishedAt instanceof Date) || !Number.isFinite(publishedAt.getTime())) {
    fail("INVALID_INPUT", "The grouping publication clock is invalid.");
  }

  const lockedActor = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "User" WHERE "id" = ${command.actor.id} FOR UPDATE
  `);
  if (lockedActor.length === 0) {
    fail("ACTOR_NOT_ACTIVE", "The actor is missing, banned, or unverified.", {
      actorId: command.actor.id,
    });
  }
  const actor = await tx.user.findUnique({
    where: { id: command.actor.id },
    select: {
      id: true,
      role: true,
      nickname: true,
      points: true,
      eloRating: true,
      isBanned: true,
      emailVerifiedAt: true,
    },
  });
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

  const match = await tx.match.findUnique({
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
      registrationDeadline: true,
      teamRegistrationDeadline: true,
      teamMinMembers: true,
      teamMaxMembers: true,
      groupingGeneratedAt: true,
    },
  });
  if (!match) {
    fail("MATCH_NOT_FOUND", "The match does not exist.", { matchId: command.matchId });
  }
  assertEngineCanWrite(match.engineVersion, "V2");
  if (match.isQuickMatch || match.type !== profile.matchType) {
    fail("FIXTURE_CREATION_NOT_ALLOWED", profile.formalMatchMessage, {
      isQuickMatch: match.isQuickMatch,
      matchType: match.type,
    });
  }
  if (match.status === "finished") {
    fail(
      "FIXTURE_CREATION_NOT_ALLOWED",
      "A finished match cannot publish grouping fixtures.",
    );
  }
  const registrationDeadline =
    profile.matchType === "team"
      ? (match.teamRegistrationDeadline ?? match.registrationDeadline)
      : match.registrationDeadline;
  if (publishedAt < registrationDeadline) {
    fail(
      "FIXTURE_CREATION_NOT_ALLOWED",
      "Grouping fixtures can be published only after registration closes.",
      { registrationDeadline },
    );
  }
  if (match.format !== profile.format) {
    fail("FIXTURE_CREATION_NOT_ALLOWED", "The match format is not enabled by this service.", {
      expectedFormat: profile.format,
      matchFormat: match.format,
    });
  }
  if (command.draft.format !== match.format) {
    fail("INVALID_INPUT", "The grouping preview uses a stale match format.", {
      expectedFormat: command.draft.format,
      actualFormat: match.format,
    });
  }
  if (actor.role !== "admin" && match.createdBy !== actor.id) {
    fail("FORBIDDEN", "Only the match creator or an administrator can publish grouping.", {
      actorId: actor.id,
      matchId: match.id,
    });
  }

  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "match_entry"
    WHERE "match_id" = ${command.matchId}
    ORDER BY "id"
    FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "match_entry_member"
    WHERE "match_id" = ${command.matchId}
    ORDER BY "id"
    FOR UPDATE
  `);
  const entryRows: EntryRow[] = await tx.matchEntry.findMany({
    where: { matchId: command.matchId },
    orderBy: { id: "asc" },
    select: {
      id: true,
      kind: true,
      status: true,
      version: true,
      sourceKey: true,
      sourceUserId: true,
      sourceDoublesTeamId: true,
      sourceMatchTeamId: true,
      displayNameSnapshot: true,
      sourceDoublesTeam: {
        select: {
          id: true,
          matchId: true,
          members: {
            orderBy: { slot: "asc" },
            select: { matchId: true, userId: true, slot: true },
          },
        },
      },
      sourceMatchTeam: {
        select: {
          id: true,
          matchId: true,
          status: true,
          captainId: true,
          members: {
            orderBy: { userId: "asc" },
            select: { matchId: true, userId: true },
          },
        },
      },
      members: {
        where: { status: "ACTIVE", effectiveUntil: null },
        orderBy: { slot: "asc" },
        select: {
          id: true,
          userId: true,
          role: true,
          slot: true,
          rosterVersion: true,
        },
      },
    },
  });
  const activeEntries = entryRows.filter((entry) => entry.status === "ACTIVE");
  const expectedById = new Map(
    command.expectedEntries.map((entry) => [entry.entryId, entry.version]),
  );
  if (
    activeEntries.length !== expectedById.size ||
    activeEntries.some((entry) => !expectedById.has(entry.id))
  ) {
    fail(
      "FIXTURE_ENTRY_INVALID",
      "The active Entry set changed after the grouping preview was generated.",
      {
        expectedEntryIds: [...expectedById.keys()].sort(),
        actualEntryIds: activeEntries.map((entry) => entry.id).sort(),
      },
    );
  }
  const rosterVersions = new Map<string, number>();
  const projectionIds = new Map<string, string>();
  for (const entry of activeEntries) {
    const expectedVersion = expectedById.get(entry.id)!;
    if (entry.version !== expectedVersion) {
      fail(
        "ENTRY_VERSION_CONFLICT",
        "An Entry changed after the grouping preview was generated.",
        { entryId: entry.id, expectedVersion, actualVersion: entry.version },
      );
    }
    rosterVersions.set(entry.id, currentRosterVersion(entry));
    projectionIds.set(entry.id, validateEntrySource(entry, profile, match));
  }

  const participantUserIds = activeEntries.flatMap((entry) =>
    entry.members.map((member) => member.userId),
  );
  if (new Set(participantUserIds).size !== participantUserIds.length) {
    fail(
      "FIXTURE_ENTRY_INVALID",
      "One user cannot participate in more than one active grouped Entry.",
    );
  }
  const lockedUserIds = [...new Set(participantUserIds)]
    .filter((userId) => userId !== actor.id)
    .sort();
  if (lockedUserIds.length > 0) {
    await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "User"
      WHERE "id" IN (${Prisma.join(lockedUserIds)})
      ORDER BY "id"
      FOR UPDATE
    `);
  }
  const users = await tx.user.findMany({
    where: { id: { in: lockedUserIds } },
    select: {
      id: true,
      nickname: true,
      points: true,
      eloRating: true,
      isBanned: true,
      emailVerifiedAt: true,
    },
  });
  const usersById = new Map([
    [actor.id, actor] as const,
    ...users.map((user) => [user.id, user] as const),
  ]);

  const authoritativeEntries = new Map<string, AuthoritativeEntry>();
  for (const entry of activeEntries) {
    const members: AuthoritativeMember[] = entry.members.map((member) => {
      const user = usersById.get(member.userId);
      if (!user || user.isBanned || !user.emailVerifiedAt) {
        fail(
          "FIXTURE_ENTRY_INVALID",
          "Every grouped participant must be active and verified.",
          { entryId: entry.id, userId: member.userId },
        );
      }
      if (
        !Number.isSafeInteger(user.eloRating) ||
        !Number.isSafeInteger(user.points) ||
        user.points < 0
      ) {
        fail("FIXTURE_ENTRY_INVALID", "A participant has invalid seed inputs.", {
          entryId: entry.id,
          userId: member.userId,
        });
      }
      return {
        id: member.id,
        userId: member.userId,
        role: member.role,
        slot: member.slot,
        rosterVersion: member.rosterVersion,
        user: {
          id: user.id,
          nickname: user.nickname,
          points: user.points,
          eloRating: user.eloRating,
        },
      };
    });
    authoritativeEntries.set(entry.id, {
      id: entry.id,
      version: entry.version,
      rosterVersion: rosterVersions.get(entry.id)!,
      displayName: entry.displayNameSnapshot,
      projectionCompetitorId: projectionIds.get(entry.id)!,
      seedElo: roundedIntegerAverage(
        members.map((member) => member.user.eloRating),
        "entry Elo average",
        true,
      ),
      seedPoints: roundedIntegerAverage(
        members.map((member) => member.user.points),
        "entry points average",
        false,
      ),
      members,
    });
  }

  const projection = buildProjection(command, profile, authoritativeEntries, publishedAt);
  const existingGrouping = await tx.matchGrouping.findUnique({
    where: { matchId: command.matchId },
    select: {
      id: true,
      matchId: true,
      payload: true,
      v2SchemaVersion: true,
      seedMethod: true,
      standingsPolicyVersion: true,
      qualifiersPerGroup: true,
      bracketPolicyVersion: true,
      createdAt: true,
    },
  });
  const existingGroups: ExistingGroupRow[] = await tx.matchGroup.findMany({
    where: { matchId: command.matchId },
    orderBy: { position: "asc" },
    select: {
      id: true,
      matchId: true,
      groupingId: true,
      groupKey: true,
      displayName: true,
      position: true,
      entries: {
        orderBy: { position: "asc" },
        select: {
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
  });
  const existingFixtures = await tx.matchFixture.findMany({
    where: { matchId: command.matchId },
    select: {
      id: true,
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
      metadata: true,
    },
  });
  const existingFixtureIds = existingFixtures.map((fixture) => fixture.id);
  const existingLineups =
    existingFixtureIds.length === 0
      ? []
      : await tx.matchFixtureLineupMember.findMany({
          where: {
            matchId: command.matchId,
            fixtureId: { in: existingFixtureIds },
          },
          select: {
            matchId: true,
            fixtureId: true,
            entryId: true,
            entryMemberId: true,
            side: true,
            position: true,
          },
        });

  if (existingGrouping) {
    const groupIds = validateExistingGroups(
      existingGroups,
      existingGrouping.id,
      command,
      authoritativeEntries,
    );
    const fixtures = groupIds
      ? buildFixtures(command, profile, authoritativeEntries, groupIds)
      : [];
    const expectedFixturesByKey = new Map(
      fixtures.map((fixture) => [fixture.fixtureKey, fixture]),
    );
    const existingGroupFixtures = existingFixtures.filter(
      (fixture) => fixture.stage === "GROUP",
    );
    const downstreamFixtures = existingFixtures.filter(
      (fixture) => fixture.stage !== "GROUP",
    );
    // This command owns only the group publication. Once a downstream bracket
    // exists, callers must use the bracket read model instead of replaying a
    // stale grouping command that cannot validate the later aggregate.
    const downstreamFixtureStateAllowed = downstreamFixtures.length === 0;
    const exactFixtures =
      downstreamFixtureStateAllowed &&
      existingGroupFixtures.length === expectedFixturesByKey.size &&
      existingGroupFixtures.every((fixture) => {
        const expected = expectedFixturesByKey.get(fixture.fixtureKey);
        return (
          expected !== undefined &&
          fixture.stage === "GROUP" &&
          fixture.status !== "SCHEDULED" &&
          fixture.groupId === expected.groupId &&
          fixture.groupKey === expected.groupKey &&
          fixture.roundNumber === null &&
          fixture.position === null &&
          fixture.sideAEntryId === expected.sideAEntryId &&
          fixture.sideBEntryId === expected.sideBEntryId &&
          fixture.sideARosterVersion === expected.sideARosterVersion &&
          fixture.sideBRosterVersion === expected.sideBRosterVersion &&
          fixtureMetadataIdentity(fixture.metadata) ===
            fixtureMetadataIdentity(expected.metadata)
        );
      });
    const expectedLineupKeys = new Set(
      existingGroupFixtures.flatMap((fixture) => {
        const expected = expectedFixturesByKey.get(fixture.fixtureKey);
        if (!expected) return [];
        return [
          ...expected.sideAMembers.map(
            (member) =>
              `${fixture.id}:SIDE_A:${member.slot}:${expected.sideAEntryId}:${member.id}`,
          ),
          ...expected.sideBMembers.map(
            (member) =>
              `${fixture.id}:SIDE_B:${member.slot}:${expected.sideBEntryId}:${member.id}`,
          ),
        ];
      }),
    );
    const groupFixtureIds = new Set(
      existingGroupFixtures.map((fixture) => fixture.id),
    );
    const existingGroupLineups = existingLineups.filter((lineup) =>
      groupFixtureIds.has(lineup.fixtureId),
    );
    const actualLineupKeys = new Set(
      existingGroupLineups.map(
        (lineup) =>
          `${lineup.fixtureId}:${lineup.side}:${lineup.position}:${lineup.entryId}:${lineup.entryMemberId}`,
      ),
    );
    const exactLineups =
      existingGroupLineups.every((lineup) => lineup.matchId === command.matchId) &&
      actualLineupKeys.size === existingGroupLineups.length &&
      actualLineupKeys.size === expectedLineupKeys.size &&
      [...actualLineupKeys].every((key) => expectedLineupKeys.has(key));
    const payloadGeneratedAt =
      isRecord(existingGrouping.payload) &&
      typeof existingGrouping.payload.generatedAt === "string"
        ? new Date(existingGrouping.payload.generatedAt)
        : null;
    const expectedSeedMethod =
      command.draft.seedMethod === "min_diff" ? "MIN_DIFF" : "SNAKE";
    const expectedBracketPolicyVersion =
      command.draft.format === "group_then_knockout"
        ? V2_GROUP_THEN_KNOCKOUT_BRACKET_POLICY_VERSION
        : null;
    if (
      match.status !== "ongoing" ||
      match.groupingGeneratedAt === null ||
      existingGrouping.matchId !== command.matchId ||
      existingGrouping.createdAt.getTime() !== match.groupingGeneratedAt.getTime() ||
      payloadGeneratedAt === null ||
      !Number.isFinite(payloadGeneratedAt.getTime()) ||
      payloadGeneratedAt.getTime() !== match.groupingGeneratedAt.getTime() ||
      existingGrouping.v2SchemaVersion !== V2_GROUP_ONLY_PUBLICATION_SCHEMA_VERSION ||
      existingGrouping.seedMethod !== expectedSeedMethod ||
      existingGrouping.standingsPolicyVersion !==
        V2_GROUP_ONLY_STANDINGS_POLICY_VERSION ||
      existingGrouping.qualifiersPerGroup !== command.draft.qualifiersPerGroup ||
      existingGrouping.bracketPolicyVersion !== expectedBracketPolicyVersion ||
      groupIds === null ||
      projectionIdentity(projection, profile) === null ||
      projectionIdentity(existingGrouping.payload, profile) !==
        projectionIdentity(projection, profile) ||
      !projectionMatchesFrozenSeeds(
        existingGrouping.payload,
        command,
        existingGroups,
        authoritativeEntries,
      ) ||
      !exactFixtures ||
      !exactLineups
    ) {
      fail(
        "FIXTURE_KEY_CONFLICT",
        "A different or incomplete grouping publication already exists.",
        { matchId: command.matchId },
      );
    }
    return {
      matchId: command.matchId,
      created: false,
      publishedAt: match.groupingGeneratedAt,
      groupCount: command.draft.groups.length,
      fixtureCount: fixtures.length,
    };
  }

  if (
    match.groupingGeneratedAt !== null ||
    existingGroups.length > 0 ||
    existingFixtures.length > 0 ||
    existingLineups.length > 0
  ) {
    fail(
      "FIXTURE_KEY_CONFLICT",
      "Fixtures or grouping state already exist outside this atomic publication.",
      { matchId: command.matchId, fixtureCount: existingFixtures.length },
    );
  }

  const grouping = await tx.matchGrouping.create({
    data: {
      matchId: command.matchId,
      payload: projection,
      v2SchemaVersion: V2_GROUP_ONLY_PUBLICATION_SCHEMA_VERSION,
      seedMethod: command.draft.seedMethod === "min_diff" ? "MIN_DIFF" : "SNAKE",
      standingsPolicyVersion: V2_GROUP_ONLY_STANDINGS_POLICY_VERSION,
      qualifiersPerGroup: command.draft.qualifiersPerGroup,
      bracketPolicyVersion:
        command.draft.format === "group_then_knockout"
          ? V2_GROUP_THEN_KNOCKOUT_BRACKET_POLICY_VERSION
          : null,
      createdAt: publishedAt,
    },
    select: { id: true },
  });
  const groupIds = new Map<string, string>();
  for (const plan of buildGroupPlans(command)) {
    const group = await tx.matchGroup.create({
      data: {
        matchId: command.matchId,
        groupingId: grouping.id,
        groupKey: plan.groupKey,
        displayName: plan.displayName,
        position: plan.position,
      },
      select: { id: true },
    });
    groupIds.set(plan.groupKey, group.id);
  }

  const rankedEntries = [...authoritativeEntries.values()].sort(
    (left, right) =>
      right.seedElo - left.seedElo ||
      right.seedPoints - left.seedPoints ||
      compareEntryIds(left.id, right.id),
  );
  const globalSeedRanks = new Map(
    rankedEntries.map((entry, index) => [entry.id, index + 1]),
  );
  await tx.matchGroupEntry.createMany({
    data: buildGroupPlans(command).flatMap((group) =>
      group.entryIds.map((entryId, index) => {
        const entry = authoritativeEntries.get(entryId)!;
        return {
          matchId: command.matchId,
          groupId: groupIds.get(group.groupKey)!,
          entryId,
          position: index + 1,
          globalSeedRank: globalSeedRanks.get(entryId)!,
          seedElo: entry.seedElo,
          seedPoints: entry.seedPoints,
          entryVersion: entry.version,
          rosterVersion: entry.rosterVersion,
        };
      }),
    ),
  });

  const fixtures = buildFixtures(command, profile, authoritativeEntries, groupIds);
  if (fixtures.length !== expectedFixtureCount(command)) {
    fail("PERSISTENCE_CONFLICT", "The complete round-robin fixture set was not built.");
  }
  if (fixtures.length > 0) {
    const rules = await tx.match.findUniqueOrThrow({ where: { id: command.matchId }, select: { groupBestOf: true } });
    await tx.matchFixture.createMany({ data: fixtures.map(fixture => ({ ...fixtureCreateData(fixture), bestOf: rules.groupBestOf })) });
    const materializedFixtures = await tx.matchFixture.findMany({
      where: {
        matchId: command.matchId,
        fixtureKey: { in: fixtures.map((fixture) => fixture.fixtureKey) },
      },
      select: { id: true, fixtureKey: true, groupId: true },
    });
    const materializedByKey = new Map(
      materializedFixtures.map((fixture) => [fixture.fixtureKey, fixture]),
    );
    if (
      materializedByKey.size !== fixtures.length ||
      fixtures.some(
        (fixture) => materializedByKey.get(fixture.fixtureKey)?.groupId !== fixture.groupId,
      )
    ) {
      fail(
        "PERSISTENCE_CONFLICT",
        "The complete grouping fixture set was not materialized.",
        {
          expectedFixtureCount: fixtures.length,
          actualFixtureCount: materializedByKey.size,
        },
      );
    }
    await tx.matchFixtureLineupMember.createMany({
      data: fixtures.flatMap((fixture) => {
        const fixtureId = materializedByKey.get(fixture.fixtureKey)!.id;
        return [
          ...fixture.sideAMembers.map((member) => ({
            matchId: command.matchId,
            fixtureId,
            entryId: fixture.sideAEntryId,
            entryMemberId: member.id,
            side: "SIDE_A" as const,
            position: member.slot,
          })),
          ...fixture.sideBMembers.map((member) => ({
            matchId: command.matchId,
            fixtureId,
            entryId: fixture.sideBEntryId,
            entryMemberId: member.id,
            side: "SIDE_B" as const,
            position: member.slot,
          })),
        ];
      }),
    });
  }
  await tx.match.update({
    where: { id: command.matchId },
    data: { status: "ongoing", groupingGeneratedAt: publishedAt },
  });
  await tx.auditLog.create({
    data: {
      actorId: actor.id,
      action: profile.auditAction,
      entityType: "Match",
      entityId: command.matchId,
      details: {
        targetLabel: match.title,
        format: match.format,
        groupCount: command.draft.groups.length,
        fixtureCount: fixtures.length,
        publicationSchemaVersion: V2_GROUP_ONLY_PUBLICATION_SCHEMA_VERSION,
      },
    },
  });
  return {
    matchId: command.matchId,
    created: true,
    publishedAt,
    groupCount: command.draft.groups.length,
    fixtureCount: fixtures.length,
  };
}

/**
 * Generic relational group-phase publication kernel. Existing production
 * facades pass only the group_only profiles; group_then_knockout profiles remain
 * internal until qualification and bracket materialization are fully connected.
 */
export function createV2GroupOnlyGroupingApplicationService(
  dependencies: V2GroupOnlyGroupingApplicationServiceDependencies,
  profile: V2GroupOnlyGroupingProfile,
): V2GroupOnlyGroupingApplicationService {
  const clock = dependencies.clock ?? (() => new Date());
  return Object.freeze({
    publish: async (rawCommand) => {
      const command = normalizeCommand(rawCommand, profile);
      return runV2Transaction(dependencies.db, (tx) =>
        publishInTransaction(tx, command, profile, clock),
      );
    },
  });
}
