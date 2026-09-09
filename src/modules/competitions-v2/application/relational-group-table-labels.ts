import { Prisma, type PrismaClient } from "@prisma/client";

import {
  isValidV2GroupTableLabels,
  parseV2SingleGroupTableLabelsFromMetadata,
  sameV2GroupTableLabels,
} from "../domain/group-fixture-metadata";
import {
  V2CompetitionApplicationError,
  runV2Transaction,
  type V2Actor,
  type V2CompetitionTransaction,
} from "./entries";
import type {
  UpdateV2SingleGroupTableLabelsCommand,
  UpdateV2SingleGroupTableLabelsResult,
  V2SingleGroupTableLabelsApplicationService,
} from "./group-table-labels";

export type V2RelationalGroupTableLabelsProfile = Readonly<{
  matchType: "single" | "double" | "team";
}>;

type NormalizedCommand = Readonly<{
  actor: V2Actor;
  matchId: string;
  groupKey: string;
  expectedFixtures: readonly Readonly<{ fixtureId: string; version: number }>[];
  labels: readonly string[];
}>;

const MAX_FIXTURE_COUNT = 10_000;
const METADATA_KEYS = [
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
] as const;

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

function stableIdentifier(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 191 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail("INVALID_INPUT", `${name} must be a stable identifier.`, { name });
  }
  return value;
}

function normalize(
  command: UpdateV2SingleGroupTableLabelsCommand,
): NormalizedCommand {
  if (!isRecord(command)) fail("INVALID_INPUT", "The label command must be an object.");
  const allowed = new Set([
    "actor",
    "matchId",
    "groupKey",
    "expectedFixtures",
    "labels",
  ]);
  if (Object.keys(command).some((key) => !allowed.has(key))) {
    fail("INVALID_INPUT", "The label command contains unsupported fields.");
  }
  if (!isRecord(command.actor)) fail("INVALID_INPUT", "actor must be an object.");
  if (
    Object.keys(command.actor).some((key) => key !== "id" && key !== "role") ||
    (command.actor.role !== "user" && command.actor.role !== "admin")
  ) {
    fail("INVALID_INPUT", "actor is invalid.");
  }
  const actor = {
    id: stableIdentifier(command.actor.id, "actor.id"),
    role: command.actor.role,
  };
  if (
    !Array.isArray(command.expectedFixtures) ||
    command.expectedFixtures.length < 1 ||
    command.expectedFixtures.length > MAX_FIXTURE_COUNT
  ) {
    fail("INVALID_INPUT", "expectedFixtures has an invalid size.");
  }
  const expectedFixtures = command.expectedFixtures.map((fixture, index) => {
    const version = fixture.version;
    if (
      !isRecord(fixture) ||
      Object.keys(fixture).some(
        (key) => key !== "fixtureId" && key !== "version",
      ) ||
      !Number.isSafeInteger(version) ||
      typeof version !== "number" ||
      version < 0 ||
      version > 2_147_483_647
    ) {
      fail("INVALID_INPUT", "An expected Fixture target is invalid.", { index });
    }
    return {
      fixtureId: stableIdentifier(fixture.fixtureId, `expectedFixtures[${index}]`),
      version,
    };
  });
  if (
    new Set(expectedFixtures.map((fixture) => fixture.fixtureId)).size !==
    expectedFixtures.length
  ) {
    fail("INVALID_INPUT", "expectedFixtures contains duplicates.");
  }
  if (!isValidV2GroupTableLabels(command.labels)) {
    fail("INVALID_INPUT", "labels must be unique bounded display strings.");
  }
  return {
    actor,
    matchId: stableIdentifier(command.matchId, "matchId"),
    groupKey: stableIdentifier(command.groupKey, "groupKey"),
    expectedFixtures,
    labels: [...command.labels],
  };
}

function expectedPublication(
  type: V2RelationalGroupTableLabelsProfile["matchType"],
  format: "group_only" | "group_then_knockout",
) {
  const prefix = type === "single" ? "SINGLE" : type === "double" ? "DOUBLE" : "TEAM";
  return format === "group_only"
    ? `V2_${prefix}_GROUPING`
    : `V2_${prefix}_GROUP_THEN_KNOCKOUT_GROUPING`;
}

function parsePublicationMetadata(
  value: unknown,
  expected: Readonly<{
    publication: string;
    format: "group_only" | "group_then_knockout";
    qualifiersPerGroup: number | null;
    seedMethod: "min_diff" | "snake";
    groupPosition: number;
    groupName: string;
    sideAPosition: number;
    sideBPosition: number;
  }>,
) {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !METADATA_KEYS.includes(key as (typeof METADATA_KEYS)[number]),
    ) ||
    value.publication !== expected.publication ||
    value.publicationVersion !== 1 ||
    value.groupIndex !== expected.groupPosition ||
    value.groupName !== expected.groupName ||
    value.format !== expected.format ||
    value.qualifiersPerGroup !== expected.qualifiersPerGroup ||
    value.seedMethod !== expected.seedMethod ||
    value.sideAPosition !== expected.sideAPosition ||
    value.sideBPosition !== expected.sideBPosition
  ) {
    return null;
  }
  const labels = parseV2SingleGroupTableLabelsFromMetadata(value);
  return labels === null ? null : { value, labels };
}

async function updateInTransaction(
  tx: V2CompetitionTransaction,
  profile: V2RelationalGroupTableLabelsProfile,
  command: NormalizedCommand,
): Promise<UpdateV2SingleGroupTableLabelsResult> {
  const matchLocks = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Match" WHERE "id" = ${command.matchId} FOR UPDATE
  `);
  if (matchLocks.length !== 1) {
    fail("MATCH_NOT_FOUND", "The match does not exist.", { matchId: command.matchId });
  }
  const actorLocks = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "User" WHERE "id" = ${command.actor.id} FOR UPDATE
  `);
  if (actorLocks.length !== 1) {
    fail("ACTOR_NOT_ACTIVE", "The actor does not exist.", { actorId: command.actor.id });
  }
  const [actor, match] = await Promise.all([
    tx.user.findUnique({
      where: { id: command.actor.id },
      select: { id: true, role: true, isBanned: true, emailVerifiedAt: true },
    }),
    tx.match.findUnique({
      where: { id: command.matchId },
      select: {
        id: true,
        title: true,
        type: true,
        status: true,
        engineVersion: true,
        isQuickMatch: true,
        format: true,
        createdBy: true,
        groupingGeneratedAt: true,
        groupingResult: {
          select: {
            id: true,
            matchId: true,
            seedMethod: true,
            qualifiersPerGroup: true,
            createdAt: true,
          },
        },
      },
    }),
  ]);
  if (!actor || actor.isBanned || !actor.emailVerifiedAt) {
    fail("ACTOR_NOT_ACTIVE", "The actor is banned, missing, or unverified.");
  }
  if (actor.role !== command.actor.role) {
    fail("ACTOR_ROLE_STALE", "The actor role changed.");
  }
  if (
    !match ||
    match.engineVersion !== "V2" ||
    match.isQuickMatch ||
    match.type !== profile.matchType ||
    (match.format !== "group_only" && match.format !== "group_then_knockout") ||
    match.status !== "ongoing" ||
    match.groupingGeneratedAt === null ||
    !match.groupingResult ||
    match.groupingResult.matchId !== match.id ||
    match.groupingResult.createdAt.getTime() !== match.groupingGeneratedAt.getTime()
  ) {
    fail(
      "FIXTURE_CREATION_NOT_ALLOWED",
      "Labels require a published, ongoing formal V2 competition of the expected type.",
      { matchId: command.matchId, expectedType: profile.matchType },
    );
  }
  if (actor.role !== "admin" && match.createdBy !== actor.id) {
    fail("FORBIDDEN", "Only the match creator or an administrator may edit labels.");
  }

  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "match_fixture"
    WHERE "match_id" = ${match.id}
    ORDER BY "id" FOR UPDATE
  `);
  const group = await tx.matchGroup.findFirst({
    where: { matchId: match.id, groupKey: command.groupKey },
    select: {
      id: true,
      matchId: true,
      groupingId: true,
      groupKey: true,
      displayName: true,
      position: true,
      entries: {
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: { id: true, matchId: true, groupId: true, entryId: true, position: true },
      },
      fixtures: {
        orderBy: [{ fixtureKey: "asc" }, { id: "asc" }],
        select: {
          id: true,
          matchId: true,
          fixtureKey: true,
          stage: true,
          groupId: true,
          groupKey: true,
          roundNumber: true,
          position: true,
          sideAEntryId: true,
          sideBEntryId: true,
          version: true,
          metadata: true,
        },
      },
    },
  });
  if (!group) {
    fail("FIXTURE_NOT_FOUND", "The published group does not exist.", {
      groupKey: command.groupKey,
    });
  }
  const expectedGroupKey = `group:${String(group.position).padStart(4, "0")}`;
  if (
    group.matchId !== match.id ||
    group.groupingId !== match.groupingResult.id ||
    group.groupKey !== expectedGroupKey ||
    group.displayName !== `第 ${group.position} 组` ||
    group.entries.length < 2 ||
    group.entries.some(
      (entry, index) =>
        entry.matchId !== match.id ||
        entry.groupId !== group.id ||
        entry.position !== index + 1,
    )
  ) {
    fail("FIXTURE_KEY_CONFLICT", "The published group identity is corrupt.", {
      groupId: group.id,
    });
  }
  const expectedFixtureCount =
    (group.entries.length * (group.entries.length - 1)) / 2;
  if (group.fixtures.length !== expectedFixtureCount) {
    fail("FIXTURE_KEY_CONFLICT", "The published group has an incomplete round robin.");
  }
  const publication = expectedPublication(profile.matchType, match.format);
  const qualifiersPerGroup =
    match.format === "group_then_knockout"
      ? match.groupingResult.qualifiersPerGroup
      : null;
  if (
    match.format === "group_then_knockout" &&
    (!Number.isSafeInteger(qualifiersPerGroup) || (qualifiersPerGroup ?? 0) < 1)
  ) {
    fail("FIXTURE_KEY_CONFLICT", "The qualifier policy is invalid.");
  }
  const seedMethod = match.groupingResult.seedMethod === "MIN_DIFF"
    ? "min_diff"
    : match.groupingResult.seedMethod === "SNAKE"
      ? "snake"
      : null;
  if (!seedMethod) fail("FIXTURE_KEY_CONFLICT", "The seed method is invalid.");

  let currentLabels: readonly string[] | null = null;
  const parsedByFixture = new Map<string, Record<string, unknown>>();
  const pairKeys = new Set<string>();
  for (const fixture of group.fixtures) {
    const sideAPosition = group.entries.find(
      (entry) => entry.entryId === fixture.sideAEntryId,
    )?.position;
    const sideBPosition = group.entries.find(
      (entry) => entry.entryId === fixture.sideBEntryId,
    )?.position;
    if (
      fixture.matchId !== match.id ||
      fixture.stage !== "GROUP" ||
      fixture.groupId !== group.id ||
      fixture.groupKey !== group.groupKey ||
      fixture.roundNumber !== null ||
      fixture.position !== null ||
      sideAPosition === undefined ||
      sideBPosition === undefined ||
      sideAPosition >= sideBPosition ||
      fixture.fixtureKey !==
        `${group.groupKey}:pair:${String(sideAPosition).padStart(4, "0")}-${String(
          sideBPosition,
        ).padStart(4, "0")}`
    ) {
      fail("FIXTURE_KEY_CONFLICT", "A published group Fixture is malformed.", {
        fixtureId: fixture.id,
      });
    }
    const pairKey = `${sideAPosition}:${sideBPosition}`;
    if (pairKeys.has(pairKey)) {
      fail("FIXTURE_KEY_CONFLICT", "A group pair is duplicated.", {
        fixtureId: fixture.id,
      });
    }
    pairKeys.add(pairKey);
    const parsed = parsePublicationMetadata(fixture.metadata, {
      publication,
      format: match.format,
      qualifiersPerGroup,
      seedMethod,
      groupPosition: group.position,
      groupName: group.displayName,
      sideAPosition,
      sideBPosition,
    });
    if (!parsed) {
      fail("FIXTURE_KEY_CONFLICT", "A group Fixture has invalid metadata.", {
        fixtureId: fixture.id,
      });
    }
    if (
      currentLabels !== null &&
      !sameV2GroupTableLabels(currentLabels, parsed.labels)
    ) {
      fail("FIXTURE_KEY_CONFLICT", "Group Fixtures disagree on current labels.");
    }
    currentLabels = parsed.labels;
    parsedByFixture.set(fixture.id, parsed.value);
  }
  const expectedById = new Map(
    command.expectedFixtures.map((fixture) => [fixture.fixtureId, fixture.version]),
  );
  if (
    expectedById.size !== group.fixtures.length ||
    group.fixtures.some(
      (fixture) =>
        expectedById.get(fixture.id) === undefined ||
        expectedById.get(fixture.id) !== fixture.version,
    )
  ) {
    fail("FIXTURE_VERSION_CONFLICT", "The group Fixture snapshot is stale or incomplete.");
  }
  const labels = currentLabels ?? [];
  if (sameV2GroupTableLabels(labels, command.labels)) {
    return {
      matchId: match.id,
      groupKey: group.groupKey,
      groupName: group.displayName,
      labels: [...labels],
      changed: false,
      fixtures: group.fixtures.map((fixture) => ({
        fixtureId: fixture.id,
        version: fixture.version,
      })),
    };
  }
  for (const fixture of group.fixtures) {
    const metadata = parsedByFixture.get(fixture.id)!;
    const updated = await tx.matchFixture.updateMany({
      where: {
        id: fixture.id,
        matchId: match.id,
        version: fixture.version,
      },
      data: {
        metadata: {
          ...metadata,
          v2Display: { schemaVersion: 1, tableLabels: [...command.labels] },
        } as Prisma.InputJsonObject,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      fail("FIXTURE_VERSION_CONFLICT", "A group Fixture changed concurrently.", {
        fixtureId: fixture.id,
      });
    }
  }
  await tx.auditLog.create({
    data: {
      actorId: actor.id,
      action: `v2_${profile.matchType}_group_table_labels_update`,
      entityType: "MatchGroup",
      entityId: group.id,
      details: {
        targetLabel: `${match.title} / ${group.displayName}`,
        matchId: match.id,
        groupKey: group.groupKey,
        fixtureCount: group.fixtures.length,
        beforeLabels: [...labels],
        afterLabels: [...command.labels],
      },
    },
  });
  return {
    matchId: match.id,
    groupKey: group.groupKey,
    groupName: group.displayName,
    labels: [...command.labels],
    changed: true,
    fixtures: group.fixtures.map((fixture) => ({
      fixtureId: fixture.id,
      version: fixture.version + 1,
    })),
  };
}

export function createV2RelationalGroupTableLabelsApplicationService(
  dependencies: Readonly<{ db: Pick<PrismaClient, "$transaction"> }>,
  profile: V2RelationalGroupTableLabelsProfile,
): V2SingleGroupTableLabelsApplicationService {
  return Object.freeze({
    update: async (rawCommand) => {
      const command = normalize(rawCommand);
      return runV2Transaction(dependencies.db, (tx) =>
        updateInTransaction(tx, profile, command),
      );
    },
  });
}
