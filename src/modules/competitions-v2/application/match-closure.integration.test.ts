import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { finishV2Match, previewV2MatchClosure } from "./match-closure";
import {
  createV2GroupOnlyGroupingApplicationService,
  V2_SINGLE_GROUP_ONLY_GROUPING_PROFILE,
  V2_DOUBLE_GROUP_ONLY_GROUPING_PROFILE,
  V2_TEAM_GROUP_ONLY_GROUPING_PROFILE,
} from "./group-only-grouping";
import { createV2ResultApplicationService, startCompetitionFixture } from "./results";

const url = process.env.V2_CORE_INTEGRATION_DATABASE_URL;

async function setup(db: PrismaClient, type: "single" | "double" | "team") {
  const prefix = `closure-${randomUUID()}`;
  const adminId = `${prefix}-admin`, ownerId = `${prefix}-owner`, matchId = `${prefix}-match`;
  const before = new Date(Date.now() - 60_000);
  const rosters = Array.from({ length: 4 }, (_, i) => Array.from({ length: type === "single" ? 1 : 2 }, (_, j) => `${prefix}-${i}-${j}`));
  const userIds = [adminId, ownerId, ...rosters.flat()];
  await db.user.createMany({ data: userIds.map(id => ({ id, email: `${id}@example.test`, nickname: id, emailVerifiedAt: before, role: id === adminId ? "admin" : "user" })) });
  await db.match.create({ data: { id: matchId, title: `Closure ${type}`, type, engineVersion: "V2", format: "group_only", status: "registration", createdBy: ownerId, dateTime: new Date(), registrationDeadline: before, maxParticipants: 100, groupBestOf: 3, ...(type === "team" ? { teamMinMembers: 2, teamMaxMembers: 4, teamRegistrationStart: new Date(before.getTime() - 60_000), teamRegistrationDeadline: before } : {}) } });
  const entries = [];
  for (const [index, roster] of rosters.entries()) {
    const sourceId = `${prefix}-source-${index}`;
    if (type === "double") await db.matchDoublesTeam.create({ data: { id: sourceId, matchId, createdById: roster[0], registeredAt: before, members: { create: roster.map((userId, i) => ({ userId, slot: i + 1 })) } } });
    if (type === "team") await db.matchTeam.create({ data: { id: sourceId, matchId, captainId: roster[0], name: `Team ${index + 1}`, inviteCode: sourceId, status: "approved", members: { create: roster.map(userId => ({ userId })) } } });
    entries.push(await db.matchEntry.create({ data: {
      matchId, kind: type === "single" ? "INDIVIDUAL" : type === "double" ? "DOUBLES" : "TEAM", status: "ACTIVE",
      sourceKey: type === "single" ? `individual:${roster[0]}` : `${type === "double" ? "doubles" : "team"}:${sourceId}`,
      ...(type === "single" ? { sourceUserId: roster[0] } : type === "double" ? { sourceDoublesTeamId: sourceId } : { sourceMatchTeamId: sourceId }),
      displayNameSnapshot: `Entry ${index + 1}`,
      members: { create: roster.map((userId, i) => ({ userId, displayNameSnapshot: userId, role: type === "team" && i === 0 ? "captain" : "player", slot: i + 1, rosterVersion: 1, effectiveFrom: before })) },
    }, select: { id: true, version: true } }));
  }
  const profile = type === "single" ? V2_SINGLE_GROUP_ONLY_GROUPING_PROFILE : type === "double" ? V2_DOUBLE_GROUP_ONLY_GROUPING_PROFILE : V2_TEAM_GROUP_ONLY_GROUPING_PROFILE;
  await createV2GroupOnlyGroupingApplicationService({ db }, profile).publish({ actor: { id: ownerId, role: "user" }, matchId, expectedEntries: entries.map(e => ({ entryId: e.id, version: e.version })), draft: { format: "group_only", seedMethod: "snake", groups: [{ entryIds: entries.map(e => e.id) }] } });
  const actor = { id: adminId, role: "admin" as const };
  const results = createV2ResultApplicationService({ db });
  const fixtures = await db.matchFixture.findMany({ where: { matchId }, orderBy: { fixtureKey: "asc" } });
  async function submit(fixtureId: string) {
    const f = await db.matchFixture.findUniqueOrThrow({ where: { id: fixtureId } });
    return results.submitRevision({ actor: { actorId: adminId, role: "admin" }, matchId, fixtureId, expectedFixtureVersion: f.version, requiredFixtureStage: "GROUP", winnerEntryId: f.sideAEntryId!, loserEntryId: f.sideBEntryId!, score: type === "team" ? { winnerScore: 3, loserScore: 1 } : { bestOf: 3, winnerScore: 2, loserScore: 0 } });
  }
  async function confirm(fixtureId: string, revisionId: string) {
    const f = await db.matchFixture.findUniqueOrThrow({ where: { id: fixtureId } });
    return results.confirmRevision({ actor: { actorId: adminId, role: "admin" }, matchId, fixtureId, expectedFixtureVersion: f.version, requiredFixtureStage: "GROUP", resultRevisionId: revisionId });
  }
  const preview = () => previewV2MatchClosure(db, { actor, matchId });
  const finish = (fingerprint: string) => finishV2Match(db, { actor, matchId, expectedFingerprint: fingerprint, reason: "Integration closure" });
  const stats = () => db.user.findMany({ where: { id: { in: userIds } }, orderBy: { id: "asc" }, select: { id: true, points: true, eloRating: true, wins: true, losses: true, matchesPlayed: true } });
  const audits = () => db.auditLog.count({ where: { entityId: matchId, action: "v2_match_finish" } });
  const cleanup = () => db.user.update({ where: { id: adminId }, data: { role: "user" } });
  return { actor, adminId, ownerId, matchId, entries, fixtures, results, submit, confirm, preview, finish, stats, audits, cleanup };
}

for (const type of ["single", "double", "team"] as const) {
  test(`PostgreSQL ${type}: administrator closes from a reviewed snapshot, preserving results and all personal statistics`, { skip: !url }, async () => {
    const db = new PrismaClient({ datasources: { db: { url } } });
    const s = await setup(db, type);
    try {
      const revision = await s.submit(s.fixtures[0].id);
      await s.confirm(s.fixtures[0].id, revision.id);
      const started = s.fixtures[1];
      await startCompetitionFixture(db, { actor: { actorId: s.adminId, role: "admin" }, matchId: s.matchId, fixtureId: started.id, expectedFixtureVersion: started.version, requiredFixtureStage: "GROUP" });
      const before = await s.stats();
      const ledger = await db.settlementEvent.findMany({ where: { resultRevisionId: revision.id }, orderBy: { id: "asc" } });
      const preview = await s.preview();
      assert.equal(preview.completedCount, 1);
      assert.equal(preview.unsubmitted.length, 5);
      assert.equal(preview.pending.length, 0);
      assert.equal(preview.unsubmitted.find(f => f.fixtureId === started.id)?.started, true);
      assert.equal((await s.preview()).fingerprint, preview.fingerprint);
      assert.deepEqual(await s.finish(preview.fingerprint), { alreadyFinished: false, voidedCount: 5 });
      assert.equal((await db.match.findUniqueOrThrow({ where: { id: s.matchId } })).status, "finished");
      assert.equal(await db.matchFixture.count({ where: { matchId: s.matchId, status: "VOIDED" } }), 5);
      assert.equal((await db.resultRevision.findUniqueOrThrow({ where: { id: revision.id } })).status, "CONFIRMED");
      assert.equal(await db.resultRevision.count({ where: { matchId: s.matchId } }), 1);
      assert.deepEqual(await s.stats(), before);
      assert.deepEqual(await db.settlementEvent.findMany({ where: { resultRevisionId: revision.id }, orderBy: { id: "asc" } }), ledger);
      assert.equal(await s.audits(), 1);
      const voidAudits = await db.auditLog.findMany({ where: { entityId: { in: s.fixtures.slice(1).map(f => f.id) }, actorId: s.adminId } });
      assert.equal(voidAudits.filter(a => a.action.includes("void_unplayed")).length, 5);
      assert.deepEqual(await s.finish(preview.fingerprint), { alreadyFinished: true, voidedCount: 0 });
      assert.equal(await s.audits(), 1);
    } finally { await s.cleanup(); await db.$disconnect(); }
  });
}

test("PostgreSQL closure protects submitted scores and pending corrections, and rejects stale previews", { skip: !url }, async () => {
  const db = new PrismaClient({ datasources: { db: { url } } });
  const s = await setup(db, "single");
  try {
    const initial = await s.preview();
    const pending = await s.submit(s.fixtures[0].id);
    let preview = await s.preview();
    assert.equal(preview.pending.length, 1);
    assert.equal(preview.unsubmitted.length, 5);
    await assert.rejects(s.finish(initial.fingerprint), { code: "PENDING_RESULTS" });
    assert.equal(await db.matchFixture.count({ where: { matchId: s.matchId, status: "VOIDED" } }), 0);
    await s.confirm(s.fixtures[0].id, pending.id);
    const f = await db.matchFixture.findUniqueOrThrow({ where: { id: s.fixtures[0].id } });
    const correction = await s.results.submitCorrection({ actor: { actorId: s.adminId, role: "admin" }, matchId: s.matchId, fixtureId: f.id, expectedFixtureVersion: f.version, requiredFixtureStage: "GROUP", resultRevisionId: pending.id, correctionMode: "KEEP_WINNER", score: { bestOf: 3, winnerScore: 2, loserScore: 1 }, reason: "Correct score" });
    preview = await s.preview();
    assert.equal(preview.pending[0].correction, true);
    await assert.rejects(s.finish(preview.fingerprint), { code: "PENDING_RESULTS" });
    const changed = await db.matchFixture.findUniqueOrThrow({ where: { id: f.id } });
    await s.results.rejectRevision({ actor: { actorId: s.adminId, role: "admin" }, matchId: s.matchId, fixtureId: f.id, expectedFixtureVersion: changed.version, requiredFixtureStage: "GROUP", resultRevisionId: correction.id });
    preview = await s.preview();
    await startCompetitionFixture(db, { actor: { actorId: s.adminId, role: "admin" }, matchId: s.matchId, fixtureId: s.fixtures[1].id, expectedFixtureVersion: s.fixtures[1].version, requiredFixtureStage: "GROUP" });
    await assert.rejects(s.finish(preview.fingerprint), { code: "STALE_PREVIEW" });
    assert.equal(await s.audits(), 0);
    await s.finish((await s.preview()).fingerprint);
    assert.equal((await db.resultRevision.findUniqueOrThrow({ where: { id: correction.id } })).status, "REJECTED");
    assert.equal((await db.resultRevision.findUniqueOrThrow({ where: { id: pending.id } })).status, "CONFIRMED");
  } finally { await s.cleanup(); await db.$disconnect(); }
});

test("PostgreSQL closure is administrator-only, rechecks role, and rejects registration/knockout/quick/legacy competitions", { skip: !url }, async () => {
  const db = new PrismaClient({ datasources: { db: { url } } });
  const s = await setup(db, "single");
  try {
    await assert.rejects(previewV2MatchClosure(db, { actor: { id: s.ownerId, role: "user" }, matchId: s.matchId }), { code: "FORBIDDEN" });
    const preview = await s.preview();
    await db.user.update({ where: { id: s.adminId }, data: { role: "user" } });
    await assert.rejects(s.finish(preview.fingerprint), { code: "ACTOR_ROLE_STALE" });
    await db.user.update({ where: { id: s.adminId }, data: { role: "admin" } });
    await db.match.update({ where: { id: s.matchId }, data: { status: "registration" } });
    await assert.rejects(s.preview(), { code: "NOT_STARTED" });
    await db.match.update({ where: { id: s.matchId }, data: { status: "ongoing", format: "group_then_knockout" } });
    await assert.rejects(s.preview(), { code: "NOT_SUPPORTED" });
    await db.match.update({ where: { id: s.matchId }, data: { format: "group_only", isQuickMatch: true } });
    await assert.rejects(s.preview(), { code: "ENGINE_WRITE_MISMATCH" });
    await db.match.update({ where: { id: s.matchId }, data: { isQuickMatch: false, engineVersion: "LEGACY" } });
    await assert.rejects(s.preview(), { code: "ENGINE_WRITE_MISMATCH" });
    assert.equal(await s.audits(), 0);
    assert.equal(await db.matchFixture.count({ where: { matchId: s.matchId, status: "VOIDED" } }), 0);
  } finally { await s.cleanup(); await db.$disconnect(); }
});

test("PostgreSQL closure rolls back every void and audit when the persisted pairing topology is incomplete", { skip: !url }, async () => {
  const db = new PrismaClient({ datasources: { db: { url } } });
  const s = await setup(db, "single");
  try {
    const f = s.fixtures[0];
    await db.matchFixture.create({ data: { matchId: s.matchId, fixtureKey: "duplicate-pair", stage: "GROUP", groupId: f.groupId, groupKey: f.groupKey, status: "READY", sideAEntryId: f.sideAEntryId, sideBEntryId: f.sideBEntryId, sideARosterVersion: 1, sideBRosterVersion: 1 } });
    const preview = await s.preview();
    const auditCount = await db.auditLog.count({ where: { entityId: { in: [s.matchId, ...s.fixtures.map(fixture => fixture.id)] } } });
    await assert.rejects(s.finish(preview.fingerprint), { code: "INVALID_STATE" });
    assert.equal(await db.matchFixture.count({ where: { matchId: s.matchId, status: "VOIDED" } }), 0);
    assert.equal(await db.auditLog.count({ where: { entityId: { in: [s.matchId, ...s.fixtures.map(fixture => fixture.id)] } } }), auditCount);
    assert.equal((await db.match.findUniqueOrThrow({ where: { id: s.matchId } })).status, "ongoing");
  } finally { await s.cleanup(); await db.$disconnect(); }
});

test("PostgreSQL concurrent score submission and closure cannot both commit", { skip: !url }, async () => {
  const db = new PrismaClient({ datasources: { db: { url } } });
  const s = await setup(db, "single");
  try {
    const preview = await s.preview();
    const [closure, submission] = await Promise.allSettled([
      s.finish(preview.fingerprint),
      s.submit(s.fixtures[0].id),
    ]);
    assert.ok(closure.status === "rejected" || submission.status === "rejected");
    const match = await db.match.findUniqueOrThrow({ where: { id: s.matchId } });
    if (closure.status === "fulfilled") {
      assert.equal(match.status, "finished");
      assert.equal(await db.matchFixture.count({ where: { matchId: s.matchId, status: "VOIDED" } }), 6);
      assert.equal(await db.resultRevision.count({ where: { matchId: s.matchId } }), 0);
    } else {
      assert.equal(match.status, "ongoing");
      assert.equal(await db.matchFixture.count({ where: { matchId: s.matchId, status: "VOIDED" } }), 0);
      assert.equal(await s.audits(), 0);
      if (submission.status === "fulfilled") {
        assert.equal((await db.resultRevision.findUniqueOrThrow({ where: { id: submission.value.id } })).status, "PENDING");
      }
    }
  } finally { await s.cleanup(); await db.$disconnect(); }
});
