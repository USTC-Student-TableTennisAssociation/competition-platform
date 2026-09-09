import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { replaceCompetitionRoster } from "./roster-management";
import { createV2DoubleGroupingApplicationService } from "./double-grouping";
import { createV2TeamGroupingApplicationService } from "./team-grouping";
import { createV2ResultApplicationService, startCompetitionFixture } from "./results";
import { createV2EntryDisqualificationApplicationService } from "./entry-disqualification";
import { createV2QualificationAndKnockoutPublicationApplicationService } from "./qualification-and-knockout-publication";
import { getV2DoubleRegistrationReadState } from "../read-model/double-registration";
import { getV2TeamRegistrationReadState } from "../read-model/team-registration";
import { getV2CertificateReadState } from "../read-model/single-certificate";

const url = process.env.V2_CORE_INTEGRATION_DATABASE_URL;

async function setup(db: PrismaClient, type: "double" | "team", knockout = false) {
  const prefix = `roster-${randomUUID()}`;
  const adminId = `${prefix}-admin`;
  const matchId = `${prefix}-match`;
  const rosters = Array.from({ length: knockout ? 4 : 5 }, (_, i) => [`${prefix}-${i}-1`, `${prefix}-${i}-2`]);
  const extras = [`${prefix}-extra-1`, `${prefix}-extra-2`, `${prefix}-extra-3`];
  const allUserIds = [adminId, ...rosters.flat(), ...extras];
  const before = new Date(Date.now() - 60_000);
  await db.user.createMany({ data: allUserIds.map(id => ({ id, email: `${id}@example.test`, nickname: id, role: id === adminId ? "admin" : "user", emailVerifiedAt: before })) });
  await db.match.create({ data: { id: matchId, title: prefix, type, engineVersion: "V2", format: knockout ? "group_then_knockout" : "group_only", status: "registration", dateTime: new Date(Date.now() + 86_400_000), registrationDeadline: before, maxParticipants: 100, createdBy: adminId, groupBestOf: 3, knockoutBestOf: 7, ...(type === "team" ? { teamMinMembers: 2, teamMaxMembers: 4, teamRegistrationStart: new Date(before.getTime() - 60_000), teamRegistrationDeadline: before } : {}) } });
  const entries = [];
  for (const [index, roster] of rosters.entries()) {
    const sourceId = `${prefix}-source-${index}`;
    if (type === "double") {
      await db.matchDoublesTeam.create({ data: { id: sourceId, matchId, createdById: roster[0], members: { create: roster.map((userId, i) => ({ userId, slot: i + 1 })) } } });
    } else {
      await db.matchTeam.create({ data: { id: sourceId, matchId, name: `Team ${index}`, inviteCode: sourceId, captainId: roster[0], status: "approved", members: { create: roster.map(userId => ({ userId })) } } });
    }
    entries.push(await db.matchEntry.create({ data: {
      matchId, kind: type === "double" ? "DOUBLES" : "TEAM", status: "ACTIVE",
      sourceKey: `${type === "double" ? "doubles" : "team"}:${sourceId}`,
      ...(type === "double" ? { sourceDoublesTeamId: sourceId } : { sourceMatchTeamId: sourceId }),
      displayNameSnapshot: type === "team" ? `Team ${index}` : `Entry ${index}`,
      members: { create: roster.map((userId, i) => ({ userId, displayNameSnapshot: userId, role: type === "team" && i === 0 ? "captain" : "player", status: "ACTIVE", slot: i + 1, rosterVersion: 1, effectiveFrom: before, createdAt: before })) },
    }, select: { id: true, version: true } }));
  }
  const actor = { id: adminId, role: "admin" as const };
  const results = createV2ResultApplicationService({ db });
  const group = type === "double" ? createV2DoubleGroupingApplicationService({ db }) : createV2TeamGroupingApplicationService({ db });
  await group.publish({ actor, matchId, expectedEntries: entries.map(entry => ({ entryId: entry.id, version: entry.version })), draft: { format: knockout ? "group_then_knockout" : "group_only", seedMethod: "snake", ...(knockout ? { qualifiersPerGroup: 2 } : {}), groups: (knockout ? [entries.slice(0, 2), entries.slice(2)] : [entries]).map(items => ({ entryIds: items.map(entry => entry.id) })) } });
  const fixture = (id: string) => db.matchFixture.findUniqueOrThrow({ where: { id } });
  async function submit(id: string, winner: string) {
    const current = await fixture(id);
    const bestOf = current.bestOf;
    return results.submitRevision({ actor: { actorId: adminId, role: "admin" }, matchId, fixtureId: id, expectedFixtureVersion: current.version, requiredFixtureStage: current.stage as "GROUP" | "KNOCKOUT", winnerEntryId: winner, loserEntryId: current.sideAEntryId === winner ? current.sideBEntryId! : current.sideAEntryId!, score: type === "team" ? { winnerScore: 3, loserScore: 1 } : { bestOf, winnerScore: (bestOf + 1) / 2, loserScore: 0 } });
  }
  async function confirm(id: string, revisionId: string) {
    const current = await fixture(id);
    await results.confirmRevision({ actor: { actorId: adminId, role: "admin" }, matchId, fixtureId: id, expectedFixtureVersion: current.version, requiredFixtureStage: current.stage as "GROUP" | "KNOCKOUT", resultRevisionId: revisionId });
  }
  async function play(id: string, winner: string) { const revision = await submit(id, winner); await confirm(id, revision.id); return revision; }
  async function replace(entryId: string, memberIds: readonly string[]) {
    const entry = await db.matchEntry.findUniqueOrThrow({ where: { id: entryId } });
    return replaceCompetitionRoster(db, { actor, matchId, entryId, expectedEntryVersion: entry.version, memberIds, captainId: memberIds[0], reason: "Integration substitution" });
  }
  async function read() { return type === "double" ? getV2DoubleRegistrationReadState(db, matchId, adminId) : getV2TeamRegistrationReadState(db, matchId); }
  async function cleanup() {
    // The suite rebuilds its dedicated database. Keep fixtures for diagnostics,
    // but release admin identity so later global-admin mutex tests stay isolated.
    await db.user.update({ where: { id: adminId }, data: { role: "user" } });
  }
  return { actor, adminId, matchId, entries, rosters, extras, results, fixture, submit, confirm, play, replace, read, cleanup };
}

for (const type of ["double", "team"] as const) {
  test(`PostgreSQL ${type}: substitution preserves played/pending/started rosters and withdrawal preserves personal history`, { skip: !url }, async () => {
    const db = new PrismaClient({ datasources: { db: { url } } });
    const seeded = await setup(db, type);
    const { matchId, entries, rosters, extras, actor, adminId } = seeded;
    const entryId = entries[0].id;
    try {
      const fixtures = await db.matchFixture.findMany({ where: { matchId, OR: [{ sideAEntryId: entryId }, { sideBEntryId: entryId }] }, orderBy: { fixtureKey: "asc" } });
      assert.equal(fixtures.length, 4);
      assert.ok(fixtures.every(item => item.bestOf === 3));
      if (type === "double") {
        await assert.rejects(seeded.results.submitRevision({ actor: { actorId: adminId, role: "admin" }, matchId, fixtureId: fixtures[0].id, expectedFixtureVersion: fixtures[0].version, winnerEntryId: entryId, loserEntryId: fixtures[0].sideAEntryId === entryId ? fixtures[0].sideBEntryId! : fixtures[0].sideAEntryId!, score: { bestOf: 5, winnerScore: 3, loserScore: 1 } }), { code: "INVALID_COMMAND" });
      }
      const confirmed = await seeded.play(fixtures[0].id, entryId);
      const pending = await seeded.submit(fixtures[1].id, entryId);
      await assert.rejects(startCompetitionFixture(db, { actor: { actorId: extras[0], role: "user" }, matchId, fixtureId: fixtures[2].id, expectedFixtureVersion: fixtures[2].version, requiredFixtureStage: "GROUP" }), { code: "FORBIDDEN" });
      await startCompetitionFixture(db, { actor: { actorId: adminId, role: "admin" }, matchId, fixtureId: fixtures[2].id, expectedFixtureVersion: fixtures[2].version, requiredFixtureStage: "GROUP" });
      const snapshot = await db.matchFixtureLineupMember.findMany({ where: { fixtureId: { in: fixtures.slice(0, 3).map(item => item.id) } }, orderBy: { id: "asc" } });
      const oldPersonal = await db.user.findUniqueOrThrow({ where: { id: rosters[0][1] }, select: { eloRating: true, points: true, wins: true, losses: true, matchesPlayed: true } });
      const originalEntry = await db.matchEntry.findUniqueOrThrow({ where: { id: entryId } });
      await assert.rejects(replaceCompetitionRoster(db, { actor: { id: rosters[0][0], role: "user" }, matchId, entryId, expectedEntryVersion: originalEntry.version, memberIds: [rosters[0][0], extras[0]], reason: "not admin" }), { code: "FORBIDDEN" });
      const replacement = await seeded.replace(entryId, [rosters[0][0], extras[0]]);
      assert.equal(replacement.updatedFixtureCount, 1);
      assert.equal(replacement.rosterVersion, 2);
      assert.deepEqual(await db.matchFixtureLineupMember.findMany({ where: { fixtureId: { in: fixtures.slice(0, 3).map(item => item.id) } }, orderBy: { id: "asc" } }), snapshot);
      assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: rosters[0][1] }, select: { eloRating: true, points: true, wins: true, losses: true, matchesPlayed: true } }), oldPersonal);
      const incoming = await db.user.findUniqueOrThrow({ where: { id: extras[0] } });
      assert.equal(incoming.matchesPlayed, 0);
      assert.equal(incoming.wins, 0);
      const futureRoster = await db.matchFixtureLineupMember.findMany({ where: { fixtureId: fixtures[3].id, entryId }, select: { entryMember: { select: { userId: true } } } });
      assert.deepEqual(futureRoster.map(item => item.entryMember.userId).sort(), [rosters[0][0], extras[0]].sort());
      await assert.rejects(replaceCompetitionRoster(db, { actor, matchId, entryId, expectedEntryVersion: originalEntry.version, memberIds: [rosters[0][0], extras[1]], reason: "stale" }), { code: "ENTRY_VERSION_CONFLICT" });
      await seeded.read();
      const withdrawal = createV2EntryDisqualificationApplicationService({ db });
      const certificate = await getV2CertificateReadState(db, matchId, rosters[0][0]);
      assert.equal(certificate.kind, "CERTIFICATE_STATE");
      if (certificate.kind === "CERTIFICATE_STATE") {
        assert.equal(certificate.eligibility.state, "INELIGIBLE");
        if (certificate.eligibility.state === "INELIGIBLE") assert.equal(certificate.eligibility.code, "PENDING_RESULT");
      }
      await assert.rejects(withdrawal.withdraw({ actor, matchId, entryId, expectedEntryVersion: replacement.entryVersion, reason: "Injury" }), { code: "PENDING_RESULT_REQUIRES_REVIEW" });
      assert.equal((await db.resultRevision.findUniqueOrThrow({ where: { id: pending.id } })).status, "PENDING");
      await seeded.confirm(fixtures[1].id, pending.id);
      await seeded.play(fixtures[3].id, entryId);
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: extras[0] } })).wins, 1);
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: rosters[0][1] } })).wins, 2);
      const beforeWithdrawal = await db.user.findMany({ where: { id: { in: rosters.flat().concat(extras) } }, select: { id: true, eloRating: true, wins: true, losses: true, matchesPlayed: true }, orderBy: { id: "asc" } });
      const currentEntry = await db.matchEntry.findUniqueOrThrow({ where: { id: entryId } });
      await withdrawal.withdraw({ actor, matchId, entryId, expectedEntryVersion: currentEntry.version, reason: "Injury" });
      assert.deepEqual(await db.user.findMany({ where: { id: { in: rosters.flat().concat(extras) } }, select: { id: true, eloRating: true, wins: true, losses: true, matchesPlayed: true }, orderBy: { id: "asc" } }), beforeWithdrawal);
      assert.equal((await db.resultRevision.findUniqueOrThrow({ where: { id: confirmed.id } })).status, "CONFIRMED");
      const forfeit = await db.resultRevision.findFirstOrThrow({ where: { fixtureId: fixtures[2].id, status: "CONFIRMED" } });
      assert.equal(forfeit.resolutionKind, "FORFEIT");
      assert.equal(await db.settlementEvent.count({ where: { resultRevisionId: forfeit.id } }), 0);
      assert.equal((await db.matchEntry.findUniqueOrThrow({ where: { id: entryId } })).status, "WITHDRAWN");
      await seeded.read();
    } finally { await seeded.cleanup(); await db.$disconnect(); }
  });

  test(`PostgreSQL ${type}: group and knockout advancement use current rosters while completed rounds retain history`, { skip: !url }, async () => {
    const db = new PrismaClient({ datasources: { db: { url } } });
    const seeded = await setup(db, type, true);
    try {
      const { matchId, entries, rosters, extras, actor } = seeded;
      const groupFixtures = await db.matchFixture.findMany({ where: { matchId, stage: "GROUP" }, orderBy: { fixtureKey: "asc" } });
      for (const fixture of groupFixtures) await seeded.play(fixture.id, fixture.sideAEntryId!);
      await seeded.replace(entries[0].id, [rosters[0][0], extras[0]]);
      await createV2QualificationAndKnockoutPublicationApplicationService({ db }).freezeAndPublish({ actor, matchId });
      const knockout = await db.matchFixture.findMany({ where: { matchId, stage: "KNOCKOUT" }, orderBy: [{ roundNumber: "asc" }, { position: "asc" }] });
      assert.equal(knockout.length, 3);
      assert.ok(knockout.every(item => item.bestOf === 7));
      const first = knockout.find(item => item.sideAEntryId === entries[0].id || item.sideBEntryId === entries[0].id)!;
      await seeded.replace(entries[0].id, [rosters[0][0], extras[1]]);
      await seeded.play(first.id, entries[0].id);
      await seeded.replace(entries[0].id, [rosters[0][0], extras[2]]);
      const second = knockout.find(item => item.roundNumber === 1 && item.id !== first.id)!;
      await seeded.play(second.id, second.sideAEntryId!);
      const final = await seeded.fixture(knockout.find(item => item.roundNumber === 2)!.id);
      assert.equal(final.status, "READY");
      assert.equal(final.sideAEntryId === entries[0].id ? final.sideARosterVersion : final.sideBRosterVersion, 4);
      await seeded.read();
      await seeded.play(final.id, entries[0].id);
      await seeded.read();
      assert.equal((await db.match.findUniqueOrThrow({ where: { id: matchId } })).status, "finished");
      const wins = await Promise.all(extras.map(id => db.user.findUniqueOrThrow({ where: { id }, select: { wins: true } })));
      assert.deepEqual(wins.map(user => user.wins), [0, 1, 1]);
      const incomingCertificate = await getV2CertificateReadState(db, matchId, extras[2]);
      assert.equal(incomingCertificate.kind, "CERTIFICATE_STATE");
      if (incomingCertificate.kind === "CERTIFICATE_STATE") {
        assert.equal(incomingCertificate.eligibility.state, "ELIGIBLE");
        if (incomingCertificate.eligibility.state === "ELIGIBLE") assert.equal(incomingCertificate.eligibility.qualifyingRevisionIds.length, 1);
      }
      assert.equal((await db.user.findUniqueOrThrow({ where: { id: rosters[0][1] } })).matchesPlayed, 1);
    } finally { await seeded.cleanup(); await db.$disconnect(); }
  });
}
