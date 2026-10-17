import { Prisma, type PrismaClient } from "@prisma/client";

import {
  V2CompetitionApplicationError,
  runV2Transaction,
  type V2Actor,
  type V2CompetitionTransaction,
} from "./entries";
import { loadV2QualificationSourceInTransaction } from "./qualification-snapshot";
import { reconcileV2ProgressiveKnockoutInTransaction } from "./progressive-knockout-graph";
import { reconcileUnavailableV2KnockoutFixtures } from "./results";

export type FreezeV2ProgressiveGroupQualificationCommand = Readonly<{
  actor: V2Actor;
  matchId: string;
  groupId: string;
}>;

export type FreezeV2ProgressiveGroupQualificationResult = Readonly<{
  matchId: string;
  groupId: string;
  snapshotId: string;
  created: boolean;
  frozenAt: Date;
  sourceRevisionFingerprint: string;
  qualificationCount: number;
}>;

function fail(code: V2CompetitionApplicationError["code"], message: string): never {
  throw new V2CompetitionApplicationError(code, message);
}

function normalize(command: FreezeV2ProgressiveGroupQualificationCommand) {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const identifier = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 191 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
  if (!record(command) || Object.keys(command).some(key => !["actor", "matchId", "groupId"].includes(key)) ||
      !identifier(command.matchId) || !identifier(command.groupId) || !record(command.actor) ||
      Object.keys(command.actor).some(key => !["id", "role"].includes(key)) ||
      !identifier(command.actor.id) || !["user", "admin"].includes(command.actor.role)) {
    fail("INVALID_INPUT", "A valid group qualification command is required.");
  }
  return { actor: { id: command.actor.id, role: command.actor.role }, matchId: command.matchId, groupId: command.groupId };
}

/** Confirms only the selected group's complete authoritative source and binds its fixed slots. */
export async function freezeV2ProgressiveGroupQualificationInTransaction(
  tx: V2CompetitionTransaction,
  rawCommand: FreezeV2ProgressiveGroupQualificationCommand,
  clock: () => Date,
): Promise<FreezeV2ProgressiveGroupQualificationResult> {
  const command = normalize(rawCommand);
  const source = await loadV2QualificationSourceInTransaction(tx,
    { actor: command.actor, matchId: command.matchId }, clock, { groupId: command.groupId });
  const { match, grouping, groups, evaluation, frozenAt, sourceRevisionFingerprint } = source;
  const schedule = await tx.matchKnockoutSchedule.findUnique({ where: { matchId: match.id } });
  if (!schedule || schedule.groupingId !== grouping.id || schedule.schemaVersion !== 1 ||
      ![2, 3].includes(schedule.bracketPolicyVersion) || !/^[a-f0-9]{64}$/.test(schedule.layoutFingerprint) ||
      !(schedule.createdAt instanceof Date) || !Number.isFinite(schedule.createdAt.getTime()) ||
      schedule.createdAt < grouping.createdAt || schedule.createdAt > frozenAt) {
    fail("FIXTURE_CREATION_NOT_ALLOWED", "Publish the fixed knockout schedule before confirming a group.");
  }
  if (await tx.matchQualificationSnapshot.findUnique({ where: { groupingId: grouping.id }, select: { id: true } })) {
    fail("PERSISTENCE_CONFLICT", "A legacy qualification snapshot cannot coexist with progressive qualification.");
  }
  const group = groups.find(row => row.id === command.groupId)!;
  const expected = evaluation.standings.map(standing => ({
    ...standing,
    entryVersion: source.entriesById.get(standing.entryId)!.version,
    rosterVersion: source.currentRosters.get(standing.entryId)?.rosterVersion ??
      source.frozenRosters.get(standing.entryId)!.rosterVersion,
  }));
  const snapshot = await tx.matchGroupQualificationSnapshot.findUnique({ where: { groupId: group.id } });
  const existingStandings = await tx.matchGroupQualificationStanding.findMany({
    where: { matchId: match.id, groupId: group.id }, orderBy: [{ rank: "asc" }, { entryId: "asc" }],
  });
  if (snapshot) {
    if (snapshot.matchId !== match.id || snapshot.schemaVersion !== 1 || snapshot.standingsPolicyVersion !== 1 ||
        snapshot.sourceRevisionFingerprint !== sourceRevisionFingerprint || snapshot.createdAt > frozenAt ||
        existingStandings.length !== expected.length || existingStandings.some(row => {
          // Prisma's field order is not an identity. Compare the explicit expected keys.
          return row.matchId !== match.id || row.snapshotId !== snapshot.id || row.groupId !== group.id ||
            row.createdAt.getTime() !== snapshot.createdAt.getTime() || !expected.some(candidate =>
              candidate.entryId === row.entryId && Object.keys(candidate).every(key =>
                candidate[key as keyof typeof candidate] === row[key as keyof typeof row]));
        })) {
      fail("PERSISTENCE_CONFLICT", "The frozen group qualification no longer matches its source.");
    }
    await reconcileV2ProgressiveKnockoutInTransaction(tx, match.id, { actorId: command.actor.id, clock: () => frozenAt });
    await reconcileUnavailableV2KnockoutFixtures(tx, { match, actor: { actorId: command.actor.id, role: command.actor.role },
      reason: "小组晋级已确认，按当前参赛资格处理淘汰对局", now: frozenAt });
    return { matchId: match.id, groupId: group.id, snapshotId: snapshot.id, created: false,
      frozenAt: snapshot.createdAt, sourceRevisionFingerprint, qualificationCount: evaluation.qualificationCount };
  }
  if (existingStandings.length || expected.length !== new Set(expected.map(row => row.entryId)).size) {
    fail("PERSISTENCE_CONFLICT", "A group has incomplete or duplicate qualification state.");
  }
  const created = await tx.matchGroupQualificationSnapshot.create({ data: {
    matchId: match.id, groupId: group.id, schemaVersion: 1, standingsPolicyVersion: 1,
    sourceRevisionFingerprint, createdAt: frozenAt,
  } });
  const persisted = await tx.matchGroupQualificationStanding.createMany({ data: expected.map(standing => ({
    ...standing, matchId: match.id, snapshotId: created.id, createdAt: frozenAt,
  })) });
  if (persisted.count !== expected.length) fail("PERSISTENCE_CONFLICT", "The complete group standings were not persisted.");
  await tx.auditLog.create({ data: {
    actorId: command.actor.id, action: "v2_group_qualification_freeze", entityType: "MatchGroup", entityId: group.id,
    createdAt: frozenAt, details: {
      targetLabel: `${match.title} / ${group.displayName}`, matchId: match.id, groupingId: grouping.id,
      snapshotId: created.id, sourceRevisionFingerprint, standingCount: expected.length,
      qualificationCount: evaluation.qualificationCount,
    } as Prisma.InputJsonObject,
  } });
  await reconcileV2ProgressiveKnockoutInTransaction(tx, match.id, { actorId: command.actor.id, clock: () => frozenAt });
  await reconcileUnavailableV2KnockoutFixtures(tx, { match, actor: { actorId: command.actor.id, role: command.actor.role },
    reason: "小组晋级已确认，按当前参赛资格处理淘汰对局", now: frozenAt });
  return { matchId: match.id, groupId: group.id, snapshotId: created.id, created: true,
    frozenAt, sourceRevisionFingerprint, qualificationCount: evaluation.qualificationCount };
}

export function createV2ProgressiveQualificationApplicationService(
  dependencies: Readonly<{ db: Pick<PrismaClient, "$transaction">; clock?: () => Date }>,
) {
  const clock = dependencies.clock ?? (() => new Date());
  return Object.freeze({
    freezeGroup: (command: FreezeV2ProgressiveGroupQualificationCommand) => runV2Transaction(dependencies.db,
      tx => freezeV2ProgressiveGroupQualificationInTransaction(tx, command, clock)),
  });
}
