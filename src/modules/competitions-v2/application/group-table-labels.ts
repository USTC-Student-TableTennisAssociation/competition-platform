import { Prisma, type PrismaClient } from "@prisma/client";

import { assertEngineCanWrite } from "../domain";
import {
  buildV2SingleGroupFixtureMetadata,
  isValidV2GroupTableLabels,
  parseV2SingleGroupFixtureMetadata,
  sameV2GroupTableLabels,
} from "../domain/group-fixture-metadata";
import {
  V2CompetitionApplicationError,
  runV2Transaction,
  type V2Actor,
  type V2CompetitionTransaction,
} from "./entries";

const PUBLICATION_SCHEMA_VERSION = 1;
const IDENTIFIER_PADDING = 4;
const MAX_FIXTURE_COUNT = 10_000;

export type V2SingleGroupExpectedFixture = Readonly<{
  fixtureId: string;
  version: number;
}>;

export type UpdateV2SingleGroupTableLabelsCommand = Readonly<{
  actor: V2Actor;
  matchId: string;
  groupKey: string;
  expectedFixtures: readonly V2SingleGroupExpectedFixture[];
  labels: readonly string[];
}>;

export type UpdateV2SingleGroupTableLabelsResult = Readonly<{
  matchId: string;
  groupKey: string;
  groupName: string;
  labels: readonly string[];
  changed: boolean;
  fixtures: readonly Readonly<{ fixtureId: string; version: number }>[];
}>;

export type V2SingleGroupTableLabelsApplicationService = Readonly<{
  update(
    command: UpdateV2SingleGroupTableLabelsCommand,
  ): Promise<UpdateV2SingleGroupTableLabelsResult>;
}>;

export type V2SingleGroupTableLabelsApplicationServiceDependencies = Readonly<{
  db: Pick<PrismaClient, "$transaction">;
}>;

type NormalizedCommand = Readonly<{
  actor: V2Actor;
  matchId: string;
  groupKey: string;
  expectedFixtures: readonly V2SingleGroupExpectedFixture[];
  labels: readonly string[];
}>;

type PublishedGroup = Readonly<{
  groupKey: string;
  groupName: string;
  groupIndex: number;
  entryIds: readonly string[];
  playerIds: readonly string[];
  seedMethod: "min_diff" | "snake";
}>;

type LockedFixture = Readonly<{
  id: string;
  fixtureKey: string;
  stage: "GROUP" | "KNOCKOUT" | "FREE_PLAY";
  groupKey: string | null;
  roundNumber: number | null;
  position: number | null;
  sideAEntryId: string | null;
  sideBEntryId: string | null;
  version: number;
  metadata: Prisma.JsonValue | null;
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
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unexpected.length === 0) return;
  fail("INVALID_INPUT", `${name} contains unsupported fields.`, {
    name,
    unexpected,
  });
}

function assertStableIdentifier(value: unknown, name: string): asserts value is string {
  if (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 191 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  ) {
    return;
  }
  fail("INVALID_INPUT", `${name} must be one stable identifier.`, { name });
}

function assertVersion(value: unknown, name: string): asserts value is number {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 2_147_483_647
  ) {
    return;
  }
  fail("INVALID_INPUT", `${name} must be a non-negative PostgreSQL integer.`, {
    name,
  });
}

function normalizeCommand(
  command: UpdateV2SingleGroupTableLabelsCommand,
): NormalizedCommand {
  if (!isRecord(command)) fail("INVALID_INPUT", "The label command must be an object.");
  assertOnlyKeys(
    command,
    ["actor", "matchId", "groupKey", "expectedFixtures", "labels"],
    "command",
  );
  if (!isRecord(command.actor)) fail("INVALID_INPUT", "actor must be an object.");
  assertOnlyKeys(command.actor, ["id", "role"], "actor");
  assertStableIdentifier(command.actor.id, "actor.id");
  if (command.actor.role !== "user" && command.actor.role !== "admin") {
    fail("INVALID_INPUT", "actor.role must be user or admin.");
  }
  assertStableIdentifier(command.matchId, "matchId");
  assertStableIdentifier(command.groupKey, "groupKey");

  if (
    !Array.isArray(command.expectedFixtures) ||
    command.expectedFixtures.length < 1 ||
    command.expectedFixtures.length > MAX_FIXTURE_COUNT
  ) {
    fail("INVALID_INPUT", "expectedFixtures has an invalid size.");
  }
  const expectedFixtures = command.expectedFixtures.map((value, index) => {
    if (!isRecord(value)) {
      fail("INVALID_INPUT", "Each expected fixture must be an object.", { index });
    }
    assertOnlyKeys(value, ["fixtureId", "version"], `expectedFixtures[${index}]`);
    assertStableIdentifier(value.fixtureId, `expectedFixtures[${index}].fixtureId`);
    assertVersion(value.version, `expectedFixtures[${index}].version`);
    return { fixtureId: value.fixtureId, version: value.version };
  });
  if (
    new Set(expectedFixtures.map((fixture) => fixture.fixtureId)).size !==
    expectedFixtures.length
  ) {
    fail("INVALID_INPUT", "expectedFixtures must not contain duplicates.");
  }
  if (!isValidV2GroupTableLabels(command.labels)) {
    fail("INVALID_INPUT", "labels must be unique, bounded display strings.");
  }

  return {
    actor: { id: command.actor.id, role: command.actor.role },
    matchId: command.matchId,
    groupKey: command.groupKey,
    expectedFixtures,
    labels: [...command.labels],
  };
}

function stableOrdinal(value: number) {
  return String(value).padStart(IDENTIFIER_PADDING, "0");
}

function expectedGroupKey(groupIndex: number) {
  return `group:${stableOrdinal(groupIndex)}`;
}

function expectedFixtureKey(
  groupKey: string,
  sideAPosition: number,
  sideBPosition: number,
) {
  return `${groupKey}:pair:${stableOrdinal(sideAPosition)}-${stableOrdinal(sideBPosition)}`;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function parsePublishedGroups(
  payload: unknown,
  generatedAt: Date,
): readonly PublishedGroup[] | null {
  if (
    !isRecord(payload) ||
    !hasOnlyKeys(payload, [
      "generatedAt",
      "competitorType",
      "format",
      "config",
      "groups",
      "v2Publication",
      "tableAssignments",
    ]) ||
    payload.competitorType !== "user" ||
    payload.format !== "group_only" ||
    typeof payload.generatedAt !== "string" ||
    payload.generatedAt !== generatedAt.toISOString() ||
    !isRecord(payload.config) ||
    !Array.isArray(payload.groups) ||
    !isRecord(payload.v2Publication) ||
    !hasOnlyKeys(payload.v2Publication, ["schemaVersion", "groups"]) ||
    payload.v2Publication.schemaVersion !== PUBLICATION_SCHEMA_VERSION ||
    !Array.isArray(payload.v2Publication.groups)
  ) {
    return null;
  }
  if (
    !hasOnlyKeys(payload.config, ["groupCount", "seedMethod"]) ||
    !Number.isSafeInteger(payload.config.groupCount) ||
    payload.config.groupCount !== payload.groups.length ||
    payload.v2Publication.groups.length !== payload.groups.length ||
    (payload.config.seedMethod !== "min_diff" &&
      payload.config.seedMethod !== "snake") ||
    payload.groups.length < 1
  ) {
    return null;
  }

  const groups: PublishedGroup[] = [];
  const seenGroupKeys = new Set<string>();
  const seenEntryIds = new Set<string>();
  for (let index = 0; index < payload.groups.length; index += 1) {
    const displayGroup = payload.groups[index];
    const publicationGroup = payload.v2Publication.groups[index];
    const groupIndex = index + 1;
    const groupKey = expectedGroupKey(groupIndex);
    const groupName = `第 ${groupIndex} 组`;
    if (
      !isRecord(displayGroup) ||
      !hasOnlyKeys(displayGroup, ["name", "players", "averagePoints"]) ||
      displayGroup.name !== groupName ||
      typeof displayGroup.averagePoints !== "number" ||
      !Number.isFinite(displayGroup.averagePoints) ||
      !Array.isArray(displayGroup.players) ||
      !isRecord(publicationGroup) ||
      !hasOnlyKeys(publicationGroup, ["groupKey", "entryIds"]) ||
      publicationGroup.groupKey !== groupKey ||
      !Array.isArray(publicationGroup.entryIds) ||
      publicationGroup.entryIds.length < 2 ||
      displayGroup.players.length !== publicationGroup.entryIds.length
    ) {
      return null;
    }
    const entryIds: string[] = [];
    for (const entryId of publicationGroup.entryIds) {
      if (
        typeof entryId !== "string" ||
        entryId.length < 1 ||
        entryId.length > 191 ||
        entryId !== entryId.trim() ||
        /[\u0000-\u001f\u007f]/.test(entryId) ||
        seenEntryIds.has(entryId)
      ) {
        return null;
      }
      seenEntryIds.add(entryId);
      entryIds.push(entryId);
    }
    const playerIds: string[] = [];
    for (const player of displayGroup.players) {
      if (
        !isRecord(player) ||
        !hasOnlyKeys(player, ["id", "nickname", "points", "eloRating"]) ||
        typeof player.id !== "string" ||
        player.id.length < 1 ||
        player.id.length > 191 ||
        player.id !== player.id.trim() ||
        /[\u0000-\u001f\u007f]/.test(player.id) ||
        typeof player.nickname !== "string" ||
        player.nickname.length > 200 ||
        typeof player.points !== "number" ||
        !Number.isFinite(player.points) ||
        typeof player.eloRating !== "number" ||
        !Number.isFinite(player.eloRating)
      ) {
        return null;
      }
      playerIds.push(player.id);
    }
    if (new Set(playerIds).size !== playerIds.length) return null;
    if (seenGroupKeys.has(groupKey)) return null;
    seenGroupKeys.add(groupKey);
    groups.push({
      groupKey,
      groupName,
      groupIndex,
      entryIds,
      playerIds,
      seedMethod: payload.config.seedMethod,
    });
  }
  return groups;
}

function projectionPlayersMatchEntries(
  groups: readonly PublishedGroup[],
  entries: readonly Readonly<{
    id: string;
    kind: "INDIVIDUAL" | "DOUBLES" | "TEAM";
    sourceUserId: string | null;
  }>[],
) {
  const expectedEntryIds = groups.flatMap((group) => group.entryIds);
  const entriesById = new Map(entries.map((entry) => [entry.id, entry] as const));
  if (
    expectedEntryIds.length !== entries.length ||
    entriesById.size !== entries.length ||
    expectedEntryIds.some((entryId) => !entriesById.has(entryId))
  ) {
    return false;
  }
  return groups.every((group) =>
    group.entryIds.every((entryId, index) => {
      const entry = entriesById.get(entryId);
      return (
        entry?.kind === "INDIVIDUAL" &&
        entry.sourceUserId !== null &&
        group.playerIds[index] === entry.sourceUserId
      );
    }),
  );
}

function groupLabelsByKey(
  publishedGroups: readonly PublishedGroup[],
  fixtures: readonly LockedFixture[],
) {
  const groupByKey = new Map(
    publishedGroups.map((group) => [group.groupKey, group] as const),
  );
  const fixtureGroups = new Map<string, LockedFixture[]>();
  const labelsByKey = new Map<string, readonly string[]>();
  const pairKeysByGroup = new Map<string, Set<string>>();

  for (const fixture of fixtures) {
    if (
      fixture.stage !== "GROUP" ||
      fixture.groupKey === null ||
      fixture.roundNumber !== null ||
      fixture.position !== null ||
      fixture.sideAEntryId === null ||
      fixture.sideBEntryId === null
    ) {
      return null;
    }
    const group = groupByKey.get(fixture.groupKey);
    const metadata = parseV2SingleGroupFixtureMetadata(fixture.metadata);
    if (!group || !metadata) return null;
    const publication = metadata.publication;
    if (
      publication.groupIndex !== group.groupIndex ||
      publication.groupName !== group.groupName ||
      publication.seedMethod !== group.seedMethod ||
      publication.sideAPosition > group.entryIds.length ||
      publication.sideBPosition > group.entryIds.length ||
      fixture.sideAEntryId !== group.entryIds[publication.sideAPosition - 1] ||
      fixture.sideBEntryId !== group.entryIds[publication.sideBPosition - 1] ||
      fixture.fixtureKey !==
        expectedFixtureKey(
          group.groupKey,
          publication.sideAPosition,
          publication.sideBPosition,
        )
    ) {
      return null;
    }

    const pairKey = `${publication.sideAPosition}:${publication.sideBPosition}`;
    const pairKeys = pairKeysByGroup.get(group.groupKey) ?? new Set<string>();
    if (pairKeys.has(pairKey)) return null;
    pairKeys.add(pairKey);
    pairKeysByGroup.set(group.groupKey, pairKeys);

    const groupFixtures = fixtureGroups.get(group.groupKey) ?? [];
    groupFixtures.push(fixture);
    fixtureGroups.set(group.groupKey, groupFixtures);
    const currentLabels = labelsByKey.get(group.groupKey);
    if (
      currentLabels !== undefined &&
      !sameV2GroupTableLabels(currentLabels, metadata.tableLabels)
    ) {
      return null;
    }
    labelsByKey.set(group.groupKey, metadata.tableLabels);
  }

  for (const group of publishedGroups) {
    const expectedCount = (group.entryIds.length * (group.entryIds.length - 1)) / 2;
    if (
      fixtureGroups.get(group.groupKey)?.length !== expectedCount ||
      pairKeysByGroup.get(group.groupKey)?.size !== expectedCount ||
      !labelsByKey.has(group.groupKey)
    ) {
      return null;
    }
  }
  return { fixtureGroups, labelsByKey };
}

function canonicalTableAssignments(
  groups: readonly PublishedGroup[],
  labelsByKey: ReadonlyMap<string, readonly string[]>,
) {
  const groupAssignments: Record<string, readonly string[]> = {};
  for (const group of groups) {
    const labels = labelsByKey.get(group.groupKey);
    if (!labels) return null;
    if (labels.length > 0) groupAssignments[group.groupName] = [...labels];
  }
  return Object.keys(groupAssignments).length === 0
    ? undefined
    : { group: groupAssignments, knockout: {} };
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

function projectionHasCanonicalAssignments(
  payload: Record<string, unknown>,
  assignments: ReturnType<typeof canonicalTableAssignments>,
) {
  if (assignments === null) return false;
  return stableJson(payload.tableAssignments) === stableJson(assignments);
}

function projectionWithAssignments(
  payload: Record<string, unknown>,
  assignments: Exclude<ReturnType<typeof canonicalTableAssignments>, null>,
) {
  const next = { ...payload };
  if (assignments === undefined) delete next.tableAssignments;
  else next.tableAssignments = assignments;
  return next as Prisma.InputJsonObject;
}

async function updateInTransaction(
  tx: V2CompetitionTransaction,
  command: NormalizedCommand,
): Promise<UpdateV2SingleGroupTableLabelsResult> {
  const lockedMatch = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Match" WHERE "id" = ${command.matchId} FOR UPDATE
  `);
  if (lockedMatch.length === 0) {
    fail("MATCH_NOT_FOUND", "The match does not exist.", { matchId: command.matchId });
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
      groupingGeneratedAt: true,
    },
  });
  if (!match) {
    fail("MATCH_NOT_FOUND", "The match does not exist.", { matchId: command.matchId });
  }
  assertEngineCanWrite(match.engineVersion, "V2");
  if (
    match.isQuickMatch ||
    match.type !== "single" ||
    match.format !== "group_only" ||
    match.status !== "ongoing" ||
    match.groupingGeneratedAt === null
  ) {
    fail(
      "FIXTURE_CREATION_NOT_ALLOWED",
      "Table labels can be edited only for a published, ongoing formal SINGLE V2 group-only match.",
      { matchId: match.id },
    );
  }
  if (actor.role !== "admin" && match.createdBy !== actor.id) {
    fail("FORBIDDEN", "Only the match creator or an administrator can edit table labels.", {
      actorId: actor.id,
      matchId: match.id,
    });
  }

  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "match_fixture"
    WHERE "match_id" = ${command.matchId}
    ORDER BY "id"
    FOR UPDATE
  `);
  const [grouping, fixtures, entries] = await Promise.all([
    tx.matchGrouping.findUnique({
      where: { matchId: command.matchId },
      select: { payload: true, createdAt: true },
    }),
    tx.matchFixture.findMany({
      where: { matchId: command.matchId },
      orderBy: { id: "asc" },
      select: {
        id: true,
        fixtureKey: true,
        stage: true,
        groupKey: true,
        roundNumber: true,
        position: true,
        sideAEntryId: true,
        sideBEntryId: true,
        version: true,
        metadata: true,
      },
    }),
    tx.matchEntry.findMany({
      where: { matchId: command.matchId },
      orderBy: { id: "asc" },
      select: { id: true, kind: true, sourceUserId: true },
    }),
  ]);
  if (
    !grouping ||
    grouping.createdAt.getTime() !== match.groupingGeneratedAt.getTime() ||
    !isRecord(grouping.payload)
  ) {
    fail("FIXTURE_KEY_CONFLICT", "The grouping publication is missing or inconsistent.", {
      matchId: match.id,
    });
  }
  const publishedGroups = parsePublishedGroups(
    grouping.payload,
    match.groupingGeneratedAt,
  );
  const grouped = publishedGroups
    ? groupLabelsByKey(publishedGroups, fixtures as LockedFixture[])
    : null;
  if (
    !publishedGroups ||
    !projectionPlayersMatchEntries(publishedGroups, entries) ||
    !grouped
  ) {
    fail("FIXTURE_KEY_CONFLICT", "The published GROUP fixture set is incomplete or corrupt.", {
      matchId: match.id,
    });
  }
  const targetGroup = publishedGroups.find(
    (group) => group.groupKey === command.groupKey,
  );
  const targetFixtures = grouped.fixtureGroups.get(command.groupKey);
  if (!targetGroup || !targetFixtures) {
    fail("FIXTURE_NOT_FOUND", "The requested published group does not exist.", {
      matchId: match.id,
      groupKey: command.groupKey,
    });
  }

  const expectedById = new Map(
    command.expectedFixtures.map((fixture) => [fixture.fixtureId, fixture.version]),
  );
  if (
    expectedById.size !== targetFixtures.length ||
    targetFixtures.some((fixture) => !expectedById.has(fixture.id))
  ) {
    fail(
      "FIXTURE_VERSION_CONFLICT",
      "The expected fixture snapshot does not contain the complete group.",
      { groupKey: command.groupKey },
    );
  }

  const currentAssignments = canonicalTableAssignments(
    publishedGroups,
    grouped.labelsByKey,
  );
  if (
    currentAssignments === null ||
    !projectionHasCanonicalAssignments(grouping.payload, currentAssignments)
  ) {
    fail(
      "PERSISTENCE_CONFLICT",
      "The compatibility grouping projection does not match Fixture display metadata.",
      { matchId: match.id },
    );
  }
  const currentLabels = grouped.labelsByKey.get(command.groupKey)!;
  if (sameV2GroupTableLabels(currentLabels, command.labels)) {
    return {
      matchId: match.id,
      groupKey: targetGroup.groupKey,
      groupName: targetGroup.groupName,
      labels: [...currentLabels],
      changed: false,
      fixtures: targetFixtures.map((fixture) => ({
        fixtureId: fixture.id,
        version: fixture.version,
      })),
    };
  }

  for (const fixture of targetFixtures) {
    const expectedVersion = expectedById.get(fixture.id)!;
    if (fixture.version !== expectedVersion) {
      fail("FIXTURE_VERSION_CONFLICT", "A group fixture changed after the form was loaded.", {
        fixtureId: fixture.id,
        expectedVersion,
        actualVersion: fixture.version,
      });
    }
  }

  for (const fixture of targetFixtures) {
    const parsed = parseV2SingleGroupFixtureMetadata(fixture.metadata)!;
    const metadata = buildV2SingleGroupFixtureMetadata(
      parsed.publication,
      command.labels,
    );
    if (!metadata) fail("INVALID_INPUT", "labels are invalid.");
    const updated = await tx.matchFixture.updateMany({
      where: {
        id: fixture.id,
        matchId: command.matchId,
        version: fixture.version,
      },
      data: {
        metadata,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      fail("FIXTURE_VERSION_CONFLICT", "A group fixture changed concurrently.", {
        fixtureId: fixture.id,
        expectedVersion: fixture.version,
      });
    }
  }

  const nextLabelsByKey = new Map(grouped.labelsByKey);
  nextLabelsByKey.set(command.groupKey, command.labels);
  const nextAssignments = canonicalTableAssignments(
    publishedGroups,
    nextLabelsByKey,
  );
  if (nextAssignments === null) {
    fail("PERSISTENCE_CONFLICT", "The grouping projection cannot be rebuilt.");
  }
  await tx.matchGrouping.update({
    where: { matchId: command.matchId },
    data: {
      payload: projectionWithAssignments(grouping.payload, nextAssignments),
    },
  });
  await tx.auditLog.create({
    data: {
      actorId: actor.id,
      action: "v2_single_group_table_labels_update",
      entityType: "Match",
      entityId: match.id,
      details: {
        targetLabel: match.title,
        groupKey: targetGroup.groupKey,
        groupName: targetGroup.groupName,
        fixtureCount: targetFixtures.length,
        beforeLabels: [...currentLabels],
        afterLabels: [...command.labels],
      },
    },
  });

  return {
    matchId: match.id,
    groupKey: targetGroup.groupKey,
    groupName: targetGroup.groupName,
    labels: [...command.labels],
    changed: true,
    fixtures: targetFixtures.map((fixture) => ({
      fixtureId: fixture.id,
      version: fixture.version + 1,
    })),
  };
}

export function createV2SingleGroupTableLabelsApplicationService(
  dependencies: V2SingleGroupTableLabelsApplicationServiceDependencies,
): V2SingleGroupTableLabelsApplicationService {
  return Object.freeze({
    update: async (rawCommand) => {
      const command = normalizeCommand(rawCommand);
      return runV2Transaction(dependencies.db, (tx) =>
        updateInTransaction(tx, command),
      );
    },
  });
}
