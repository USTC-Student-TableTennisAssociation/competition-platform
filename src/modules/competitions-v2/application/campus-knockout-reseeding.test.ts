import assert from "node:assert/strict";
import test from "node:test";
import { Prisma, type Prisma as PrismaTypes } from "@prisma/client";

import { buildV2ProgressiveKnockoutPlan } from "../domain/progressive-knockout-plan";
import { reseedCampusKnockoutInTransaction, type ReseedCampusKnockoutCommand } from "./campus-knockout-reseeding";

const EAST = "东区乒乓球馆";
const WEST = "西区乒乓球馆";
const now = new Date("2026-10-17T00:00:00.000Z");

function fixture() {
  const groups = Array.from({ length: 4 }, (_, i) => ({ id: `group-${i + 1}`, matchId: "match",
    groupingId: "grouping", groupKey: `group:${String(i + 1).padStart(4, "0")}`, position: i + 1,
    entries: [{ entryId: `entry-${i + 1}` }, { entryId: `entry-${i + 5}` }], qualificationSnapshot: null,
  }));
  const plan = buildV2ProgressiveKnockoutPlan({ groupingId: "grouping", groups, qualifiersPerGroup: 2 });
  const state = {
    actor: { id: "manager", role: "user", isBanned: false, emailVerifiedAt: now },
    match: { id: "match", createdBy: "manager", engineVersion: "V2", isQuickMatch: false,
      type: "single", status: "ongoing", format: "group_then_knockout", createdAt: now,
      registrationDeadline: now, teamRegistrationStart: null, teamRegistrationDeadline: null, teamMinMembers: null, teamMaxMembers: null },
    grouping: { id: "grouping", matchId: "match", v2SchemaVersion: 1, standingsPolicyVersion: 1, qualifiersPerGroup: 2, bracketPolicyVersion: 1 },
    schedule: { id: "schedule", matchId: "match", groupingId: "grouping", schemaVersion: 1,
      bracketPolicyVersion: 2, layoutFingerprint: plan.layoutFingerprint, createdAt: now },
    groups,
    groupFixtures: groups.map(group => ({ id: `group-fixture-${group.position}`, groupId: group.id,
      metadata: { v2Display: { schemaVersion: 1, tableLabels: [EAST] } } })),
    fixtures: plan.fixtures.map(f => ({ id: f.fixtureKey, fixtureKey: f.fixtureKey, matchId: "match",
      stage: "KNOCKOUT", status: "SCHEDULED", groupId: null, groupKey: null,
      roundNumber: f.roundNumber, position: f.position, sideAEntryId: null, sideBEntryId: null,
      sideARosterVersion: null, sideBRosterVersion: null, startedAt: null as Date | null, completedAt: null as Date | null,
      version: 0, lineupMembers: [], resultRevisions: [] as unknown[], administrativeResolution: null as unknown,
      metadata: { publication: "V2_PROGRESSIVE_KNOCKOUT_BRACKET", schemaVersion: 1, bracketPolicyVersion: 2,
        groupingId: "grouping", layoutFingerprint: plan.layoutFingerprint, publishedAt: now.toISOString(),
        roundNumber: f.roundNumber, position: f.position, v2Display: { schemaVersion: 1, tableLabels: ["原桌号"] } } as Prisma.JsonObject,
    })),
    dependencies: plan.fixtures.flatMap(f => (["SIDE_A", "SIDE_B"] as const).map(side => {
      const source = side === "SIDE_A" ? f.sideA : f.sideB;
      return { id: `${f.fixtureKey}:${side}`, createdAt: now, matchId: "match", targetFixtureId: f.fixtureKey,
        targetSide: side, sourceGroupId: source.kind === "GROUP_RANK" ? source.groupId : null,
        sourceGroupRank: source.kind === "GROUP_RANK" ? source.rank : null,
        sourceFixtureId: source.kind === "WINNER" ? source.fixtureKey : null,
        sourceOutcome: source.kind === "WINNER" ? "WINNER" : null, sourceQualificationStandingId: null };
    })),
    writes: [] as string[], audits: [] as unknown[], protectedReads: 0, corruptProtectedAfter: false,
  };
  const change = (name: string) => state.writes.push(name);
  const tx = {
    $queryRaw: async (query: Prisma.Sql) => {
      if (query.sql.includes("SELECT md5")) {
        state.protectedReads += 1;
        return [{ fingerprint: (state.corruptProtectedAfter && state.protectedReads > 1 ? "b" : "a").repeat(32) }];
      }
      return [{ id: "locked" }];
    },
    user: { findUnique: async () => state.actor }, match: { findUnique: async () => state.match },
    matchGrouping: { findUnique: async () => state.grouping },
    matchKnockoutSchedule: {
      findUnique: async () => state.schedule,
      updateMany: async ({ data }: { data: Partial<typeof state.schedule> }) => {
        change("schedule"); state.schedule = { ...state.schedule, ...data }; return { count: 1 };
      },
    },
    matchGroup: { findMany: async () => state.groups },
    matchQualificationSnapshot: { findFirst: async () => null },
    matchEntryMember: { findMany: async () => Array.from({ length: 8 }, (_, i) => ({
      id: `member-${i + 1}`, entryId: `entry-${i + 1}`, rosterVersion: 1, slot: 1,
    })) },
    matchEntry: { findMany: async () => [] },
    matchFixture: {
      findMany: async ({ where }: { where: { stage: string } }) => where.stage === "GROUP" ? state.groupFixtures : state.fixtures,
      updateMany: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        change("fixture"); state.fixtures = state.fixtures.map(f => f.id === where.id
          ? { ...f, ...data, version: f.version + 1 } as typeof f : f); return { count: 1 };
      },
    },
    matchFixtureDependency: {
      findMany: async (args: { where: { targetFixtureId?: { in: string[] } } }) =>
        state.dependencies.filter(d => !args.where.targetFixtureId || args.where.targetFixtureId.in.includes(d.targetFixtureId)),
      deleteMany: async ({ where }: { where: { targetFixtureId: { in: string[] } } }) => {
        change("dependencies-delete"); const oldLength = state.dependencies.length;
        state.dependencies = state.dependencies.filter(d => !where.targetFixtureId.in.includes(d.targetFixtureId));
        return { count: oldLength - state.dependencies.length };
      },
      createMany: async ({ data }: { data: typeof state.dependencies }) => {
        change("dependencies-create"); state.dependencies = [...state.dependencies, ...data]; return { count: data.length };
      },
    },
    matchFixtureLineupMember: { deleteMany: async () => { change("lineups"); return { count: 0 }; } },
    auditLog: { create: async ({ data }: { data: unknown }) => { change("audit"); state.audits.push(data); return data; } },
  } as unknown as PrismaTypes.TransactionClient;
  const command: ReseedCampusKnockoutCommand = { actor: { id: "manager", role: "user" }, matchId: "match",
    expectedLayoutFingerprint: plan.layoutFingerprint, expectedCampusByPosition: [EAST, EAST, EAST, EAST],
    qualificationOrderBySlot: [1, 6, 2, 5, 3, 8, 4, 7], reason: "前两轮按校区组织，保留其余签位" };
  return { tx, state, command };
}

test("campus reseeding rejects stale roles, forbidden actors, stale layouts and non-ongoing matches before writes", async () => {
  for (const arrange of [
    (f: ReturnType<typeof fixture>) => { f.state.actor.role = "admin"; },
    (f: ReturnType<typeof fixture>) => { f.state.actor.isBanned = true; },
    (f: ReturnType<typeof fixture>) => { f.state.match.createdBy = "another-user"; },
    (f: ReturnType<typeof fixture>) => { f.state.match.status = "finished"; },
    (f: ReturnType<typeof fixture>) => { f.state.schedule.layoutFingerprint = "f".repeat(64); },
  ]) {
    const f = fixture(); arrange(f);
    await assert.rejects(reseedCampusKnockoutInTransaction(f.tx, f.command));
    assert.deepEqual(f.state.writes, []);
  }
});

test("every kind of knockout progress or historical result blocks campus reseeding", async () => {
  for (const arrange of [
    (f: ReturnType<typeof fixture>) => { f.state.fixtures[0].startedAt = now; },
    (f: ReturnType<typeof fixture>) => { f.state.fixtures[0].completedAt = now; },
    (f: ReturnType<typeof fixture>) => { f.state.fixtures[0].status = "IN_PROGRESS"; },
    (f: ReturnType<typeof fixture>) => { f.state.fixtures[0].status = "VOIDED"; },
    (f: ReturnType<typeof fixture>) => { f.state.fixtures[0].administrativeResolution = {}; },
    ...["PENDING", "CONFIRMED", "REJECTED", "VOIDED", "SUPERSEDED"].map(status => (f: ReturnType<typeof fixture>) => {
      f.state.fixtures[0].resultRevisions = [{ id: "historical", status, winnerEntryId: null, loserEntryId: null, supersedesRevisionId: null }];
    }),
  ]) {
    const f = fixture(); arrange(f);
    await assert.rejects(reseedCampusKnockoutInTransaction(f.tx, f.command));
    assert.deepEqual(f.state.writes, []);
  }
});

test("campus reseeding rejects unknown, conflicting, changed and inconsistent GROUP campuses before writes", async () => {
  for (const labels of [[], [WEST], [EAST, WEST], ["东区附近"], ["东区", "西区馆"]]) {
    const f = fixture(); f.state.groupFixtures[0].metadata.v2Display.tableLabels = labels;
    await assert.rejects(reseedCampusKnockoutInTransaction(f.tx, f.command));
    assert.deepEqual(f.state.writes, []);
  }
  const f = fixture();
  f.state.groupFixtures.push({ ...f.state.groupFixtures[0], id: "same-group-other-fixture",
    metadata: { v2Display: { schemaVersion: 1, tableLabels: [WEST] } } });
  await assert.rejects(reseedCampusKnockoutInTransaction(f.tx, f.command));
  assert.deepEqual(f.state.writes, []);
});

test("slot gates reject invalid permutations, same-group matches, same-rank matches and cross-campus opening blocks", async () => {
  for (const slots of [[1, 2], [1, 6, 2, 5, 3, 8, 4, 4], [1, 5, 2, 6, 3, 7, 4, 8], [1, 2, 3, 4, 5, 6, 7, 8]]) {
    const f = fixture();
    await assert.rejects(reseedCampusKnockoutInTransaction(f.tx, { ...f.command, qualificationOrderBySlot: slots }));
    assert.deepEqual(f.state.writes, []);
  }
  const f = fixture();
  f.state.groupFixtures[2].metadata.v2Display.tableLabels = [WEST];
  f.state.groupFixtures[3].metadata.v2Display.tableLabels = [WEST];
  await assert.rejects(reseedCampusKnockoutInTransaction(f.tx, { ...f.command,
    expectedCampusByPosition: [EAST, EAST, WEST, WEST], qualificationOrderBySlot: [1, 8, 4, 5, 2, 7, 3, 6] }));
  assert.deepEqual(f.state.writes, []);
});

test("reseeding preserves first-round dependency identities, higher edges, publication time and later-round display", async () => {
  const f = fixture();
  const originalEdges = structuredClone(f.state.dependencies);
  const originalGroups = structuredClone(f.state.groups);
  const result = await reseedCampusKnockoutInTransaction(f.tx, f.command);
  assert.equal(result.oldLayoutFingerprint, f.command.expectedLayoutFingerprint);
  assert.notEqual(result.newLayoutFingerprint, result.oldLayoutFingerprint);
  assert.equal(result.protectedAuthorityBefore, result.protectedAuthorityAfter);
  assert.deepEqual(f.state.groups, originalGroups);
  for (const edge of f.state.dependencies) {
    const previous = originalEdges.find(row => row.id === edge.id)!;
    assert(previous);
    assert.equal(edge.createdAt.getTime(), previous.createdAt.getTime());
    assert.equal(edge.targetFixtureId, previous.targetFixtureId);
    assert.equal(edge.targetSide, previous.targetSide);
    if (edge.sourceFixtureId) assert.deepEqual(edge, previous);
  }
  assert.equal(f.state.dependencies.length, originalEdges.length);
  for (const current of f.state.fixtures) {
    assert.equal(current.version, 1);
    assert.equal(current.metadata.publishedAt, now.toISOString());
    assert.equal(current.metadata.layoutFingerprint, result.newLayoutFingerprint);
    assert.deepEqual(current.metadata.qualificationOrderBySlot, f.command.qualificationOrderBySlot);
    const display = current.metadata.v2Display as Prisma.JsonObject;
    assert.deepEqual(display.tableLabels, current.roundNumber <= 2 ? [EAST] : ["原桌号"]);
  }
  assert.equal(f.state.audits.length, 1);
  assert.equal(f.state.protectedReads, 2);
});

test("protected authority mismatch aborts before an audit can report success", async () => {
  const f = fixture(); f.state.corruptProtectedAfter = true;
  await assert.rejects(reseedCampusKnockoutInTransaction(f.tx, f.command), /altered protected/);
  assert.deepEqual(f.state.audits, []);
});

test("operator command rejects actor impersonation fields and missing review reasons without reading the database", async () => {
  for (const change of [{ reason: "" }, { actor: { id: "manager", role: "user", actualRole: "admin" } },
    { expectedCampusByPosition: ["东区", EAST, EAST, EAST] }, { unexpected: true }]) {
    const f = fixture();
    await assert.rejects(reseedCampusKnockoutInTransaction(f.tx, { ...f.command, ...change } as ReseedCampusKnockoutCommand));
    assert.deepEqual(f.state.writes, []);
    assert.equal(f.state.protectedReads, 0);
  }
});
