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

const KNOCKOUT_PUBLICATION = "V2_KNOCKOUT_BRACKET";
const KNOCKOUT_SCHEMA_VERSION = 1;
const KNOCKOUT_POLICY_VERSION = 1;
const CORE_METADATA_KEYS = [
  "bracketPolicyVersion",
  "position",
  "publication",
  "publishedAt",
  "qualificationSnapshotId",
  "roundNumber",
  "schemaVersion",
  "sourceRevisionFingerprint",
] as const;

export type UpdateV2KnockoutTableLabelsCommand = Readonly<{
  actor: V2Actor;
  matchId: string;
  fixtureId: string;
  expectedFixtureVersion: number;
  labels: readonly string[];
}>;

export type UpdateV2KnockoutTableLabelsResult = Readonly<{
  matchId: string;
  fixtureId: string;
  fixtureVersion: number;
  roundNumber: number;
  position: number;
  labels: readonly string[];
  changed: boolean;
}>;

type NormalizedCommand = UpdateV2KnockoutTableLabelsCommand;

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
  command: UpdateV2KnockoutTableLabelsCommand,
): NormalizedCommand {
  if (!isRecord(command)) {
    fail("INVALID_INPUT", "The knockout label command must be an object.");
  }
  const allowed = new Set([
    "actor",
    "matchId",
    "fixtureId",
    "expectedFixtureVersion",
    "labels",
  ]);
  if (Object.keys(command).some((key) => !allowed.has(key))) {
    fail("INVALID_INPUT", "The knockout label command contains unsupported fields.");
  }
  if (
    !isRecord(command.actor) ||
    Object.keys(command.actor).some((key) => key !== "id" && key !== "role") ||
    (command.actor.role !== "user" && command.actor.role !== "admin")
  ) {
    fail("INVALID_INPUT", "actor is invalid.");
  }
  if (
    !Number.isSafeInteger(command.expectedFixtureVersion) ||
    command.expectedFixtureVersion < 0 ||
    command.expectedFixtureVersion > 2_147_483_647
  ) {
    fail("INVALID_INPUT", "expectedFixtureVersion is invalid.");
  }
  if (!isValidV2GroupTableLabels(command.labels)) {
    fail("INVALID_INPUT", "labels must be unique bounded display strings.");
  }
  return Object.freeze({
    actor: Object.freeze({
      id: stableIdentifier(command.actor.id, "actor.id"),
      role: command.actor.role,
    }),
    matchId: stableIdentifier(command.matchId, "matchId"),
    fixtureId: stableIdentifier(command.fixtureId, "fixtureId"),
    expectedFixtureVersion: command.expectedFixtureVersion,
    labels: Object.freeze([...command.labels]),
  });
}

function parseKnockoutMetadata(
  value: unknown,
  expected: Readonly<{
    snapshotId: string;
    sourceRevisionFingerprint: string;
    roundNumber: number;
    position: number;
  }>,
) {
  if (!isRecord(value)) return null;
  const allowed = new Set([...CORE_METADATA_KEYS, "v2Display"]);
  const coreKeys = Object.keys(value).filter((key) => key !== "v2Display").sort();
  const expectedCoreKeys = [...CORE_METADATA_KEYS].sort();
  const labels = parseV2SingleGroupTableLabelsFromMetadata(value);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    coreKeys.length !== expectedCoreKeys.length ||
    coreKeys.some((key, index) => key !== expectedCoreKeys[index]) ||
    value.publication !== KNOCKOUT_PUBLICATION ||
    value.schemaVersion !== KNOCKOUT_SCHEMA_VERSION ||
    value.bracketPolicyVersion !== KNOCKOUT_POLICY_VERSION ||
    value.qualificationSnapshotId !== expected.snapshotId ||
    value.sourceRevisionFingerprint !== expected.sourceRevisionFingerprint ||
    value.roundNumber !== expected.roundNumber ||
    value.position !== expected.position ||
    typeof value.publishedAt !== "string" ||
    !Number.isFinite(Date.parse(value.publishedAt)) ||
    labels === null
  ) {
    return null;
  }
  return { value, labels };
}

async function updateInTransaction(
  tx: V2CompetitionTransaction,
  command: NormalizedCommand,
): Promise<UpdateV2KnockoutTableLabelsResult> {
  const matchLocks = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Match" WHERE "id" = ${command.matchId} FOR UPDATE
  `);
  if (matchLocks.length !== 1) {
    fail("MATCH_NOT_FOUND", "The match does not exist.", {
      matchId: command.matchId,
    });
  }
  const actorLocks = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "User" WHERE "id" = ${command.actor.id} FOR UPDATE
  `);
  if (actorLocks.length !== 1) {
    fail("ACTOR_NOT_ACTIVE", "The actor does not exist.", {
      actorId: command.actor.id,
    });
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
        groupingResult: {
          select: {
            qualificationSnapshot: {
              select: { id: true, sourceRevisionFingerprint: true },
            },
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
    match.status !== "ongoing" ||
    match.format !== "group_then_knockout" ||
    (match.type !== "single" && match.type !== "double" && match.type !== "team") ||
    !match.groupingResult?.qualificationSnapshot
  ) {
    fail(
      "FIXTURE_CREATION_NOT_ALLOWED",
      "Labels require a published, ongoing formal V2 knockout bracket.",
      { matchId: command.matchId },
    );
  }
  if (actor.role !== "admin" && match.createdBy !== actor.id) {
    fail("FORBIDDEN", "Only the match creator or an administrator may edit labels.");
  }

  const fixtureLocks = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "match_fixture"
    WHERE "id" = ${command.fixtureId} AND "match_id" = ${match.id}
    FOR UPDATE
  `);
  if (fixtureLocks.length !== 1) {
    fail("FIXTURE_NOT_FOUND", "The knockout Fixture does not exist.", {
      fixtureId: command.fixtureId,
    });
  }
  const fixture = await tx.matchFixture.findFirst({
    where: { id: command.fixtureId, matchId: match.id },
    select: {
      id: true,
      matchId: true,
      fixtureKey: true,
      stage: true,
      roundNumber: true,
      position: true,
      version: true,
      metadata: true,
    },
  });
  if (
    !fixture ||
    fixture.stage !== "KNOCKOUT" ||
    fixture.roundNumber === null ||
    fixture.position === null ||
    fixture.fixtureKey !==
      `knockout:r${String(fixture.roundNumber).padStart(4, "0")}:m${String(
        fixture.position,
      ).padStart(4, "0")}`
  ) {
    fail("FIXTURE_KEY_CONFLICT", "The knockout Fixture identity is invalid.", {
      fixtureId: command.fixtureId,
    });
  }
  if (fixture.version !== command.expectedFixtureVersion) {
    fail("FIXTURE_VERSION_CONFLICT", "The knockout Fixture snapshot is stale.", {
      fixtureId: fixture.id,
      expectedVersion: command.expectedFixtureVersion,
      actualVersion: fixture.version,
    });
  }
  const snapshot = match.groupingResult.qualificationSnapshot;
  const metadata = parseKnockoutMetadata(fixture.metadata, {
    snapshotId: snapshot.id,
    sourceRevisionFingerprint: snapshot.sourceRevisionFingerprint,
    roundNumber: fixture.roundNumber,
    position: fixture.position,
  });
  if (!metadata) {
    fail("FIXTURE_KEY_CONFLICT", "The knockout Fixture metadata is invalid.", {
      fixtureId: fixture.id,
    });
  }
  if (sameV2GroupTableLabels(metadata.labels, command.labels)) {
    return {
      matchId: match.id,
      fixtureId: fixture.id,
      fixtureVersion: fixture.version,
      roundNumber: fixture.roundNumber,
      position: fixture.position,
      labels: [...metadata.labels],
      changed: false,
    };
  }
  const updated = await tx.matchFixture.updateMany({
    where: { id: fixture.id, matchId: match.id, version: fixture.version },
    data: {
      metadata: {
        ...metadata.value,
        v2Display: { schemaVersion: 1, tableLabels: [...command.labels] },
      } as Prisma.InputJsonObject,
      version: { increment: 1 },
    },
  });
  if (updated.count !== 1) {
    fail("FIXTURE_VERSION_CONFLICT", "The knockout Fixture changed concurrently.", {
      fixtureId: fixture.id,
    });
  }
  await tx.auditLog.create({
    data: {
      actorId: actor.id,
      action: `v2_${match.type}_knockout_table_labels_update`,
      entityType: "MatchFixture",
      entityId: fixture.id,
      details: {
        targetLabel: `${match.title} / 淘汰赛第 ${fixture.roundNumber} 轮第 ${fixture.position} 场`,
        matchId: match.id,
        roundNumber: fixture.roundNumber,
        position: fixture.position,
        beforeLabels: [...metadata.labels],
        afterLabels: [...command.labels],
      },
    },
  });
  return {
    matchId: match.id,
    fixtureId: fixture.id,
    fixtureVersion: fixture.version + 1,
    roundNumber: fixture.roundNumber,
    position: fixture.position,
    labels: [...command.labels],
    changed: true,
  };
}

export function createV2KnockoutTableLabelsApplicationService(
  dependencies: Readonly<{ db: Pick<PrismaClient, "$transaction"> }>,
) {
  return Object.freeze({
    update: async (rawCommand: UpdateV2KnockoutTableLabelsCommand) => {
      const command = normalize(rawCommand);
      return runV2Transaction(dependencies.db, (tx) =>
        updateInTransaction(tx, command),
      );
    },
  });
}
