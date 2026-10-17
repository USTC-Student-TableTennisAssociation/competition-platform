import { Prisma } from "@prisma/client";

import { parseV2SingleGroupTableLabelsFromMetadata } from "../domain/group-fixture-metadata";
import { readGroupVenueAssignment } from "../domain/group-venue";
import { buildV2ProgressiveKnockoutPlan } from "../domain/progressive-knockout-plan";
import {
  assertV2Manager, loadV2WriteContext, V2CompetitionApplicationError, type V2Actor,
} from "./entries";
import {
  loadV2ProgressiveKnockoutGraph, reconcileV2ProgressiveKnockoutInTransaction,
  validateV2ProgressiveKnockoutGraph,
} from "./progressive-knockout-graph";

export type ReseedCampusKnockoutCommand = Readonly<{
  actor: V2Actor;
  matchId: string;
  expectedLayoutFingerprint: string;
  qualificationOrderBySlot: readonly number[];
  expectedCampusByPosition: readonly string[];
  reason: string;
}>;

function fail(code: "INVALID_INPUT" | "PERSISTENCE_CONFLICT" | "FIXTURE_CREATION_NOT_ALLOWED", message: string): never {
  throw new V2CompetitionApplicationError(code, message);
}

function normalize(command: ReseedCampusKnockoutCommand) {
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const identifier = (value: unknown): value is string => typeof value === "string" &&
    value.length > 0 && value.length <= 191 && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
  if (!record(command) || Object.keys(command).some(key => ![
    "actor", "matchId", "expectedLayoutFingerprint", "qualificationOrderBySlot", "expectedCampusByPosition", "reason",
  ].includes(key)) || !record(command.actor) || Object.keys(command.actor).some(key => !["id", "role"].includes(key)) ||
      !identifier(command.actor.id) || !["user", "admin"].includes(command.actor.role) || !identifier(command.matchId) ||
      typeof command.expectedLayoutFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(command.expectedLayoutFingerprint) ||
      !Array.isArray(command.qualificationOrderBySlot) || command.qualificationOrderBySlot.length > 1024 ||
      !Array.isArray(command.expectedCampusByPosition) || command.expectedCampusByPosition.length > 256 ||
      Array.from(command.expectedCampusByPosition).some(campus => campus !== "东区乒乓球馆" && campus !== "西区乒乓球馆") ||
      typeof command.reason !== "string" || !command.reason.trim() || command.reason !== command.reason.trim() ||
      command.reason.length > 1000 || /[\u0000-\u001f\u007f]/.test(command.reason)) {
    fail("INVALID_INPUT", "A stable actor, expected layout, explicit campus slots and reason are required.");
  }
  return { ...command, actor: { ...command.actor }, qualificationOrderBySlot: [...command.qualificationOrderBySlot],
    expectedCampusByPosition: [...command.expectedCampusByPosition] };
}

/** Only an anonymous digest leaves PostgreSQL; business rows and credentials are never logged. */
async function protectedAuthority(tx: Prisma.TransactionClient, matchId: string) {
  const [row] = await tx.$queryRaw<Array<{ fingerprint: string }>>(Prisma.sql`
    SELECT md5(jsonb_build_object(
      'grouping',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM "MatchGrouping" t WHERE t."matchId"=${matchId}),
      'groups',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM match_group t WHERE t.match_id=${matchId}),
      'groupEntries',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM match_group_entry t WHERE t.match_id=${matchId}),
      'entries',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM match_entry t WHERE t.match_id=${matchId}),
      'members',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM match_entry_member t WHERE t.match_id=${matchId}),
      'groupFixtures',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM match_fixture t WHERE t.match_id=${matchId} AND t.stage='GROUP'),
      'groupLineups',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM match_fixture_lineup_member t WHERE t.match_id=${matchId} AND EXISTS(SELECT 1 FROM match_fixture f WHERE f.id=t.fixture_id AND f.stage='GROUP')),
      'groupRevisions',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM result_revision t WHERE t.match_id=${matchId} AND EXISTS(SELECT 1 FROM match_fixture f WHERE f.id=t.fixture_id AND f.stage='GROUP')),
      'legacySnapshot',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM match_qualification_snapshot t WHERE t.match_id=${matchId}),
      'legacyStanding',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM match_qualification_standing t WHERE t.match_id=${matchId}),
      'groupSnapshot',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM match_group_qualification_snapshot t WHERE t.match_id=${matchId}),
      'groupStanding',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM match_group_qualification_standing t WHERE t.match_id=${matchId}),
      'winnerDependencies',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM match_fixture_dependency t WHERE t.match_id=${matchId} AND t.source_fixture_id IS NOT NULL),
      'knockoutIdentity',(SELECT coalesce(jsonb_agg(jsonb_build_array(t.id,t.match_id,t.fixture_key,t.stage,t.best_of,t.group_id,t.group_key,t.round_number,t.position,t.scheduled_at,t.created_at) ORDER BY t.id),'[]'::jsonb) FROM match_fixture t WHERE t.match_id=${matchId} AND t.stage='KNOCKOUT'),
      'users',(SELECT coalesce(jsonb_agg(jsonb_build_array(t.id,t.points,t."eloRating",t.wins,t.losses,t."matchesPlayed") ORDER BY t.id),'[]'::jsonb) FROM "User" t),
      'points',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM "PointsTransaction" t),
      'elo',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM "EloHistory" t),
      'settlements',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM settlement_event t),
      'effects',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY t.id),'[]'::jsonb) FROM settlement_effect t)
    )::text) AS fingerprint`);
  if (!row || !/^[a-f0-9]{32}$/.test(row.fingerprint)) fail("PERSISTENCE_CONFLICT", "Cannot verify protected competition authority.");
  return row.fingerprint;
}

/** Caller must own a SERIALIZABLE transaction; this operation never commits or opens one. */
export async function reseedCampusKnockoutInTransaction(
  tx: Prisma.TransactionClient,
  rawCommand: ReseedCampusKnockoutCommand,
) {
  const command = normalize(rawCommand);
  const context = await loadV2WriteContext(tx, command.matchId, command.actor);
  assertV2Manager(context);
  if (context.match.status !== "ongoing" || context.match.format !== "group_then_knockout") {
    fail("FIXTURE_CREATION_NOT_ALLOWED", "Only an ongoing group-then-knockout schedule can be reseeded.");
  }
  await tx.$queryRaw(Prisma.sql`SELECT id FROM match_knockout_schedule WHERE match_id=${command.matchId} FOR UPDATE`);
  const graph = await loadV2ProgressiveKnockoutGraph(tx, context.match);
  validateV2ProgressiveKnockoutGraph(graph);
  if (graph.schedule.layoutFingerprint !== command.expectedLayoutFingerprint) {
    fail("PERSISTENCE_CONFLICT", "The published knockout layout changed after review.");
  }
  if (graph.fixtures.some(fixture => fixture.startedAt !== null || fixture.completedAt !== null ||
      fixture.resultRevisions.length > 0 || fixture.administrativeResolution != null ||
      (fixture.status !== "SCHEDULED" && fixture.status !== "READY"))) {
    fail("FIXTURE_CREATION_NOT_ALLOWED", "A knockout fixture has started or has recorded result history; its bracket cannot be reseeded.");
  }
  if (graph.grouping.qualifiersPerGroup !== 2 || graph.groups.length * 2 < 8 ||
      command.expectedCampusByPosition.length !== graph.groups.length) {
    fail("INVALID_INPUT", "Campus reseeding requires two qualifiers per group and a complete campus map.");
  }
  await tx.$queryRaw(Prisma.sql`SELECT id FROM match_fixture WHERE match_id=${command.matchId} AND stage='GROUP' ORDER BY id FOR UPDATE`);
  const groupFixtures = await tx.matchFixture.findMany({ where: { matchId: command.matchId, stage: "GROUP" },
    select: { id: true, groupId: true, metadata: true } });
  const campusByGroup = new Map<string, string>();
  for (const group of graph.groups) {
    const fixtures = groupFixtures.filter(fixture => fixture.groupId === group.id);
    if (!fixtures.length) fail("PERSISTENCE_CONFLICT", "A published group has no campus-labelled fixtures.");
    for (const fixture of fixtures) {
      const labels = parseV2SingleGroupTableLabelsFromMetadata(fixture.metadata);
      const assignment = labels === null ? null : readGroupVenueAssignment(labels);
      if (!assignment?.venue || assignment.conflicting ||
          assignment.venue !== command.expectedCampusByPosition[group.position - 1] ||
          (campusByGroup.has(group.id) && campusByGroup.get(group.id) !== assignment.venue)) {
        fail("PERSISTENCE_CONFLICT", "A group's current campus is missing, conflicting or different from the reviewed campus map.");
      }
      campusByGroup.set(group.id, assignment.venue);
    }
  }
  if (groupFixtures.some(fixture => !fixture.groupId || !campusByGroup.has(fixture.groupId))) {
    fail("PERSISTENCE_CONFLICT", "A GROUP fixture is outside the published grouping.");
  }
  let plan;
  try {
    plan = buildV2ProgressiveKnockoutPlan({ groupingId: graph.grouping.id, groups: graph.groups,
      qualifiersPerGroup: 2, qualificationOrderBySlot: command.qualificationOrderBySlot });
  } catch { fail("INVALID_INPUT", "The reviewed slot order is not a complete qualification permutation."); }
  const firstRound = plan.fixtures.filter(fixture => fixture.roundNumber === 1);
  const sources = firstRound.flatMap(fixture => [fixture.sideA, fixture.sideB]);
  for (let offset = 0; offset < sources.length; offset += 4) {
    const block = sources.slice(offset, offset + 4);
    if (block.some(source => source.kind !== "GROUP_RANK")) fail("PERSISTENCE_CONFLICT", "A first-round slot is not a group source.");
    const ranks = block.filter(source => source.kind === "GROUP_RANK");
    if (new Set(ranks.map(source => campusByGroup.get(source.groupId))).size !== 1 ||
        ranks[0].groupId === ranks[1].groupId || ranks[2].groupId === ranks[3].groupId ||
        ranks[0].rank === ranks[1].rank || ranks[2].rank === ranks[3].rank) {
      fail("INVALID_INPUT", "Both opening rounds must stay within one campus and pair first with second from different groups.");
    }
  }
  const before = await protectedAuthority(tx, command.matchId);
  const firstIds = graph.fixtures.filter(fixture => fixture.roundNumber === 1).map(fixture => fixture.id);
  const originalDependencies = await tx.matchFixtureDependency.findMany({
    where: { matchId: command.matchId, targetFixtureId: { in: firstIds } }, orderBy: { id: "asc" },
  });
  if (originalDependencies.length !== firstRound.length * 2) fail("PERSISTENCE_CONFLICT", "The first-round dependency set is incomplete.");
  const fixtureIdsByKey = new Map(graph.fixtures.map(fixture => [fixture.fixtureKey, fixture.id]));
  const replacements = firstRound.flatMap(fixture => (["SIDE_A", "SIDE_B"] as const).map(side => {
    const source = side === "SIDE_A" ? fixture.sideA : fixture.sideB;
    const targetFixtureId = fixtureIdsByKey.get(fixture.fixtureKey)!;
    const original = originalDependencies.find(row => row.targetFixtureId === targetFixtureId && row.targetSide === side);
    if (!original || source.kind !== "GROUP_RANK") fail("PERSISTENCE_CONFLICT", "A first-round dependency cannot be replaced safely.");
    return { id: original.id, createdAt: original.createdAt, matchId: command.matchId, targetFixtureId,
      targetSide: side, sourceGroupId: source.groupId, sourceGroupRank: source.rank,
      sourceFixtureId: null, sourceOutcome: null, sourceQualificationStandingId: null };
  }));
  const removed = await tx.matchFixtureDependency.deleteMany({ where: { matchId: command.matchId, targetFixtureId: { in: firstIds } } });
  if (removed.count !== replacements.length) fail("PERSISTENCE_CONFLICT", "The first-round dependency set changed during replacement.");
  await tx.matchFixtureDependency.createMany({ data: replacements });
  await tx.matchFixtureLineupMember.deleteMany({ where: { matchId: command.matchId, fixtureId: { in: graph.fixtures.map(fixture => fixture.id) } } });
  for (const fixture of graph.fixtures) {
    const metadata = { ...(fixture.metadata as Prisma.JsonObject), bracketPolicyVersion: 3,
      layoutFingerprint: plan.layoutFingerprint, qualificationOrderBySlot: [...command.qualificationOrderBySlot] };
    if (fixture.roundNumber === 1 || fixture.roundNumber === 2) {
      const offset = (fixture.position! - 1) * (fixture.roundNumber === 1 ? 2 : 4);
      const source = sources[offset];
      if (source.kind !== "GROUP_RANK") fail("PERSISTENCE_CONFLICT", "The campus display has no group source.");
      Object.assign(metadata, { v2Display: { schemaVersion: 1, tableLabels: [campusByGroup.get(source.groupId)!] } });
    }
    const updated = await tx.matchFixture.updateMany({ where: { id: fixture.id, matchId: command.matchId,
      version: fixture.version, startedAt: null, completedAt: null, status: fixture.status }, data: {
      sideAEntryId: null, sideBEntryId: null, sideARosterVersion: null, sideBRosterVersion: null,
      status: "SCHEDULED", metadata, version: { increment: 1 },
    } });
    if (updated.count !== 1) fail("PERSISTENCE_CONFLICT", "A knockout fixture changed during reseeding.");
  }
  const scheduleUpdated = await tx.matchKnockoutSchedule.updateMany({ where: { id: graph.schedule.id,
    matchId: command.matchId, layoutFingerprint: command.expectedLayoutFingerprint }, data: {
    bracketPolicyVersion: 3, layoutFingerprint: plan.layoutFingerprint,
  } });
  if (scheduleUpdated.count !== 1) fail("PERSISTENCE_CONFLICT", "The knockout publication changed during reseeding.");
  await reconcileV2ProgressiveKnockoutInTransaction(tx, command.matchId, { actorId: context.actor.id });
  validateV2ProgressiveKnockoutGraph(await loadV2ProgressiveKnockoutGraph(tx, context.match));
  const after = await protectedAuthority(tx, command.matchId);
  if (after !== before) fail("PERSISTENCE_CONFLICT", "Reseeding altered protected grouping, results, qualification, roster or account authority.");
  const details = { matchId: command.matchId, reason: command.reason,
    oldLayoutFingerprint: graph.schedule.layoutFingerprint, newLayoutFingerprint: plan.layoutFingerprint,
    oldQualificationOrderBySlot: graph.fixtures.filter(fixture => fixture.roundNumber === 1).flatMap(fixture =>
      (["SIDE_A", "SIDE_B"] as const).map(side => {
        const dependency = graph.dependencies.find(row => row.targetFixtureId === fixture.id && row.targetSide === side)!;
        const group = graph.groups.find(row => row.id === dependency.sourceGroupId)!;
        return (dependency.sourceGroupRank! - 1) * graph.groups.length + group.position;
      })),
    qualificationOrderBySlot: [...command.qualificationOrderBySlot],
    campusByPosition: [...command.expectedCampusByPosition],
    campusByPositionBefore: [...command.expectedCampusByPosition], campusByPositionAfter: [...command.expectedCampusByPosition],
    protectedAuthorityBefore: before, protectedAuthorityAfter: after };
  await tx.auditLog.create({ data: { actorId: context.actor.id, action: "v2_campus_knockout_reseed",
    entityType: "MatchKnockoutSchedule", entityId: graph.schedule.id, details } });
  return { scheduleId: graph.schedule.id, ...details };
}
