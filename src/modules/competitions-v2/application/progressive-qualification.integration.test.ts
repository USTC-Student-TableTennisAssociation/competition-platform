import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";

import { createV2EntryKernel, V2CompetitionApplicationError } from "./entries";
import { createV2SingleGroupingApplicationService } from "./grouping";
import { createV2ResultApplicationService } from "./results";
import { createV2ProgressiveQualificationApplicationService } from "./progressive-qualification";
import { V2ResultApplicationError } from "./results-errors";
import { createV2ProgressiveKnockoutPublicationApplicationService } from "./progressive-knockout-publication";
import { getV2GroupOnlyGroupingReadModel, V2_SINGLE_GROUPING_READ_PROFILE } from "../read-model/group-only-grouping";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;

for (const admissionCase of ["complete", "short", "empty"] as const) {
test(`real progressive qualification ${admissionCase} advances while unrelated groups are still unplayed`, {
  skip: integrationDatabaseUrl === undefined,
}, async () => {
  const db = new PrismaClient({ datasourceUrl: integrationDatabaseUrl });
  const suffix = randomUUID().replaceAll("-", "");
  const matchId = `progressive-admission-match-${suffix}`;
  const ownerId = `progressive-admission-owner-${suffix}`;
  const playerIds = Array.from({ length: 9 }, (_, index) => `progressive-admission-user-${index}-${suffix}`);
  const userIds = [ownerId, ...playerIds];
  const originalEntryIds = Array.from({ length: 8 }, (_, index) => `progressive-admission-entry-${index}-${suffix}`);
  const publishedAt = new Date(Date.now() - 60_000);
  const qualifiersPerGroup = admissionCase === "complete" ? 1 : 2;
  try {
    await db.user.createMany({ data: [
      { id: ownerId, email: `${ownerId}@example.test`, nickname: "Late admission organizer", emailVerifiedAt: publishedAt },
      ...playerIds.slice(0, 8).map((id, index) => ({
        id, email: `${id}@example.test`, nickname: `Existing player ${index}`, emailVerifiedAt: publishedAt,
        eloRating: 2000 - index * 100,
      })),
    ] });
    await db.match.create({ data: {
      id: matchId, title: "Late singles admission lifecycle", type: "single", engineVersion: "V2",
      format: "group_then_knockout", status: "registration", createdBy: ownerId, maxParticipants: 16,
      dateTime: new Date(Date.now() + 86_400_000), registrationDeadline: new Date(publishedAt.getTime() - 1_000),
    } });
    for (const [index, id] of originalEntryIds.entries()) {
      await db.matchEntry.create({ data: {
        id, matchId, kind: "INDIVIDUAL", status: "ACTIVE", sourceKey: `individual:${playerIds[index]}`,
        sourceUserId: playerIds[index], displayNameSnapshot: `Existing player ${index}`, createdAt: publishedAt,
        members: { create: {
          userId: playerIds[index], displayNameSnapshot: `Existing player ${index}`, slot: 1,
          effectiveFrom: publishedAt, createdAt: publishedAt,
        } },
      } });
    }
    await createV2SingleGroupingApplicationService({ db, clock: () => publishedAt }).publish({
      actor: { id: ownerId, role: "user" }, matchId,
      expectedEntries: originalEntryIds.map(entryId => ({ entryId, version: 0 })),
      draft: { format: "group_then_knockout", qualifiersPerGroup, seedMethod: "snake",
        groups: Array.from({ length: 4 }, (_, index) => ({ entryIds: originalEntryIds.slice(index * 2, index * 2 + 2) })) },
    });
    const grouping = await db.matchGrouping.findUniqueOrThrow({ where: { matchId } });
    const group = await db.matchGroup.findFirstOrThrow({ where: { matchId, position: 1 } });
    const resultService = createV2ResultApplicationService({ db });
    async function play(fixtureId: string, winnerEntryId: string) {
      const fixture = await db.matchFixture.findUniqueOrThrow({ where: { id: fixtureId }, include: { sideAEntry: true, sideBEntry: true } });
      const winner = fixture.sideAEntryId === winnerEntryId ? fixture.sideAEntry! : fixture.sideBEntry!;
      const loser = fixture.sideAEntryId === winnerEntryId ? fixture.sideBEntry! : fixture.sideAEntry!;
      const pending = await resultService.submitRevision({
        actor: { actorId: winner.sourceUserId!, role: "user" }, matchId, fixtureId,
        expectedFixtureVersion: fixture.version, requiredFixtureStage: fixture.stage as "GROUP" | "KNOCKOUT",
        winnerEntryId: winner.id, loserEntryId: loser.id,
        score: { bestOf: fixture.bestOf!, winnerScore: (fixture.bestOf! + 1) / 2, loserScore: 0 },
      });
      await resultService.confirmRevision({
        actor: { actorId: loser.sourceUserId!, role: "user" }, matchId, fixtureId,
        expectedFixtureVersion: fixture.version + 1, requiredFixtureStage: fixture.stage as "GROUP" | "KNOCKOUT", resultRevisionId: pending.id,
      });
    }
    const existingFixtures = await db.matchFixture.findMany({ where: { matchId }, orderBy: { fixtureKey: "asc" } });
    for (const fixture of [existingFixtures[0], existingFixtures[3]]) await play(fixture.id, fixture.sideAEntryId!);
    const priorResults = await db.resultRevision.findMany({ where: { matchId }, orderBy: { id: "asc" } });
    const priorFixtures = await db.matchFixture.findMany({ where: { matchId }, orderBy: { id: "asc" } });

    // This account did not exist at the original grouping publication.
    const lateUser = await db.user.create({ data: {
      id: playerIds[8], email: `${playerIds[8]}@example.test`, nickname: "Late singles player",
      emailVerifiedAt: new Date(), eloRating: 1200,
    } });
    assert.ok(lateUser.createdAt > publishedAt);
    const admitted = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
      const entry = await createV2EntryKernel(tx, {
        match: { id: matchId, type: "single", teamMinMembers: null, teamMaxMembers: null },
        command: { kind: "INDIVIDUAL", sourceId: lateUser.id, status: "ACTIVE" },
        source: { displayNameSnapshot: lateUser.nickname, ownerId: lateUser.id,
          members: [{ userId: lateUser.id, displayNameSnapshot: lateUser.nickname, role: "player" }] },
        settlementOrigin: "ADMIN_BULK",
      });
      const member = await tx.matchEntryMember.findFirstOrThrow({ where: { entryId: entry.id } });
      const [{ now: admittedAt }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
      const marker = { schemaVersion: 1, groupingId: grouping.id, groupId: group.id,
        admittedAt: admittedAt.toISOString(), requestKey: `late-request-${suffix}`, reason: "Organizer approved a late singles admission" };
      await tx.matchEntry.update({ where: { id: entry.id }, data: { metadata: { v2LateAdmission: marker } } });
      await tx.matchGroupEntry.create({ data: {
        matchId, groupId: group.id, entryId: entry.id, position: 3, globalSeedRank: 9,
        seedElo: lateUser.eloRating, seedPoints: lateUser.points, entryVersion: entry.version, rosterVersion: 1, createdAt: admittedAt,
      } });
      const baseMetadata = existingFixtures[0].metadata as Prisma.JsonObject;
      for (const [index, existingEntryId] of originalEntryIds.slice(0, 2).entries()) {
        const existingMember = await tx.matchEntryMember.findFirstOrThrow({ where: { entryId: existingEntryId } });
        const fixture = await tx.matchFixture.create({ data: {
          matchId, groupId: group.id, groupKey: group.groupKey, stage: "GROUP", status: "READY", bestOf: existingFixtures[0].bestOf,
          fixtureKey: `${group.groupKey}:pair:${String(index + 1).padStart(4, "0")}-0003`,
          sideAEntryId: existingEntryId, sideBEntryId: entry.id, sideARosterVersion: 1, sideBRosterVersion: 1,
          metadata: { ...baseMetadata, sideAPosition: index + 1, sideBPosition: 3 },
        } });
        await tx.matchFixtureLineupMember.createMany({ data: [
          { matchId, fixtureId: fixture.id, entryId: existingEntryId, entryMemberId: existingMember.id, side: "SIDE_A", position: 1 },
          { matchId, fixtureId: fixture.id, entryId: entry.id, entryMemberId: member.id, side: "SIDE_B", position: 1 },
        ] });
      }
      const payload = structuredClone(grouping.payload) as Prisma.JsonObject;
      const projectedGroup = (payload.groups as Prisma.JsonObject[])[0];
      const players = projectedGroup.players as Prisma.JsonObject[];
      players.push({ id: lateUser.id, nickname: lateUser.nickname, eloRating: lateUser.eloRating, points: lateUser.points });
      projectedGroup.averagePoints = Math.round(players.reduce((sum, player) => sum + Number(player.eloRating), 0) / players.length);
      const publication = payload.v2Publication as Prisma.JsonObject;
      const projectedPublicationGroup = (publication.groups as Prisma.JsonObject[])[0];
      (projectedPublicationGroup.entryIds as string[]).push(entry.id);
      await tx.matchGrouping.update({ where: { id: grouping.id }, data: { payload } });
      return { entryId: entry.id, memberId: member.id, marker, admittedAt };
    }, { isolationLevel: "Serializable" });
    assert.deepEqual(await db.resultRevision.findMany({ where: { id: { in: priorResults.map(row => row.id) } }, orderBy: { id: "asc" } }), priorResults);
    assert.deepEqual(await db.matchFixture.findMany({ where: { id: { in: priorFixtures.map(row => row.id) } }, orderBy: { id: "asc" } }), priorFixtures);
    const newFixtures = await db.matchFixture.findMany({ where: { matchId, sideBEntryId: admitted.entryId } });
    for (const fixture of newFixtures) await play(fixture.id, admitted.entryId);
    const model = await getV2GroupOnlyGroupingReadModel(db, matchId, V2_SINGLE_GROUPING_READ_PROFILE);
    assert.equal(model.kind, "GROUP_THEN_KNOCKOUT_V2_MATCH");
    if (model.kind !== "GROUP_THEN_KNOCKOUT_V2_MATCH") assert.fail("grouping unreadable after admission");
    assert.equal(model.groups[0].entries.length, 3);
    assert.equal(model.groups[0].fixtures.length, 3);
    if (admissionCase !== "complete") {
      const removed = [...originalEntryIds.slice(0, 2), ...(admissionCase === "empty" ? [admitted.entryId] : [])];
      const removedAt = new Date();
      await db.$transaction(async tx => {
        await tx.matchEntry.updateMany({ where: { id: { in: removed } }, data: { status: "WITHDRAWN", withdrawnAt: removedAt, version: { increment: 1 } } });
        await tx.matchEntryMember.updateMany({ where: { entryId: { in: removed } }, data: { status: "WITHDRAWN", effectiveUntil: removedAt, endReason: "WITHDRAWN" } });
      });
    }
    const publication = await createV2ProgressiveKnockoutPublicationApplicationService({ db }).publish({ actor: { id: ownerId, role: "user" }, matchId });
    assert.equal(publication.fixtureCount, qualifiersPerGroup * 4 - 1);
    const qualification = createV2ProgressiveQualificationApplicationService({ db });
    const freeze = () => qualification.freezeGroup({ actor: { id: ownerId, role: "user" }, matchId, groupId: group.id });
    const expectConflict = () => assert.rejects(freeze, (error: unknown) => error instanceof V2CompetitionApplicationError && error.code === "PERSISTENCE_CONFLICT");
    for (const metadata of [Prisma.DbNull, { v2LateAdmission: { ...admitted.marker, groupId: "another-group" } },
      { v2LateAdmission: { ...admitted.marker, admittedAt: publishedAt.toISOString() } }]) {
      await db.matchEntry.update({ where: { id: admitted.entryId }, data: { metadata } });
      await expectConflict();
      assert.equal(await db.matchGroupQualificationSnapshot.count({ where: { matchId } }), 0);
    }
    await db.matchEntry.update({ where: { id: admitted.entryId }, data: { metadata: { v2LateAdmission: admitted.marker } } });
    const snapshot = await freeze();
    assert.equal(snapshot.created, true);
    assert.equal(snapshot.qualificationCount, admissionCase === "empty" ? 0 : 1);
    assert.equal(Boolean(await db.matchGroupQualificationStanding.findFirst({ where: { matchId, entryId: admitted.entryId, qualified: true } })), admissionCase !== "empty");
    assert.equal(await db.matchQualificationSnapshot.count({ where: { matchId } }), 0);
    assert.equal(await db.matchFixture.count({ where: { matchId, stage: "KNOCKOUT", status: "READY" } }), 0);
    const fourthGroup = await db.matchGroup.findFirstOrThrow({ where: { matchId, position: 4 } });
    await qualification.freezeGroup({ actor: { id: ownerId, role: "user" }, matchId, groupId: fourthGroup.id });
    const semifinal = await db.matchFixture.findFirstOrThrow({ where: { matchId, stage: "KNOCKOUT", status: "READY" } });
    if (admissionCase !== "empty") assert.ok([semifinal.sideAEntryId, semifinal.sideBEntryId].includes(admitted.entryId));
    const byes = await db.matchFixtureAdministrativeResolution.count({ where: { matchId, kind: "ADMIN_BYE" } });
    assert.equal(byes, admissionCase === "complete" ? 0 : admissionCase === "short" ? 1 : 2);
    const unfinishedGroup = await db.matchGroup.findFirstOrThrow({ where: { matchId, position: 2 } });
    await assert.rejects(() => qualification.freezeGroup({ actor: { id: ownerId, role: "user" }, matchId, groupId: unfinishedGroup.id }),
      (error: unknown) => error instanceof V2CompetitionApplicationError && error.code === "FIXTURE_RESULT_REQUIRED");
    assert.equal(await db.matchGroupQualificationSnapshot.count({ where: { matchId } }), 2);
    assert.equal(await db.matchFixture.count({ where: { matchId, stage: "GROUP", status: "READY" } }), 2);
    const advancingEntryId = admissionCase === "empty" ? semifinal.sideAEntryId! : admitted.entryId;
    await play(semifinal.id, advancingEntryId);
    assert.equal((await db.matchFixture.findUniqueOrThrow({ where: { id: semifinal.id } })).status, "COMPLETED");
    const final = await db.matchFixture.findFirstOrThrow({ where: { matchId, stage: "KNOCKOUT", roundNumber: Math.log2(qualifiersPerGroup * 4) } });
    assert.equal(final.status, "SCHEDULED");
    if (admissionCase !== "short") assert.ok([final.sideAEntryId, final.sideBEntryId].includes(advancingEntryId));
    // No unknown source may be promoted as a bye merely because another group froze.
    assert.equal(await db.matchFixture.count({ where: { matchId, stage: "GROUP", status: "READY" } }), 2);
    const frozenFixture = await db.matchFixture.findUniqueOrThrow({ where: { id: existingFixtures[0].id } });
    await assert.rejects(() => resultService.submitCorrection({
      actor: { actorId: ownerId, role: "user" }, matchId, fixtureId: frozenFixture.id,
      expectedFixtureVersion: frozenFixture.version, requiredFixtureStage: "GROUP",
      resultRevisionId: priorResults.find(row => row.fixtureId === frozenFixture.id)!.id,
      score: { bestOf: frozenFixture.bestOf!, winnerScore: (frozenFixture.bestOf! + 1) / 2, loserScore: 0 }, reason: "Cannot change a frozen group",
    }), (error: unknown) => error instanceof V2ResultApplicationError && error.code === "INVALID_FIXTURE_STATE");
    // An unrelated group can still record a normal result after the first semifinal.
    await play(existingFixtures[1].id, existingFixtures[1].sideAEntryId!);
    assert.equal((await freeze()).created, false);
    const savedMember = await db.matchEntryMember.findUniqueOrThrow({ where: { id: admitted.memberId } });
    assert.ok(savedMember.effectiveFrom > publishedAt);
    assert.ok(savedMember.createdAt > publishedAt);
    assert.equal((await db.matchGrouping.findUniqueOrThrow({ where: { matchId } })).createdAt.getTime(), publishedAt.getTime());
    await db.matchEntry.update({ where: { id: admitted.entryId }, data: { metadata: { v2LateAdmission: { ...admitted.marker, reason: "Changed after freeze" } } } });
    await expectConflict();
  } finally {
    // Delete only this test's graph, including the real result and registration ledgers.
    await db.matchFixtureDependency.deleteMany({ where: { matchId } });
    await db.matchFixtureAdministrativeResolution.deleteMany({ where: { matchId } });
    await db.settlementEffect.deleteMany({ where: { userId: { in: userIds } } });
    await db.settlementEvent.deleteMany({ where: { OR: [{ matchEntry: { matchId } }, { resultRevision: { matchId } }] } });
    await db.resultRevision.deleteMany({ where: { matchId } });
    await db.matchFixtureLineupMember.deleteMany({ where: { matchId } });
    await db.matchFixture.deleteMany({ where: { matchId } });
    await db.matchGroupQualificationStanding.deleteMany({ where: { matchId } });
    await db.matchGroupQualificationSnapshot.deleteMany({ where: { matchId } });
    await db.matchKnockoutSchedule.deleteMany({ where: { matchId } });
    await db.matchQualificationStanding.deleteMany({ where: { matchId } });
    await db.matchQualificationSnapshot.deleteMany({ where: { matchId } });
    await db.matchGroupEntry.deleteMany({ where: { matchId } });
    await db.matchGroup.deleteMany({ where: { matchId } });
    await db.matchGrouping.deleteMany({ where: { matchId } });
    await db.matchEntryMember.deleteMany({ where: { matchId } });
    await db.matchEntry.deleteMany({ where: { matchId } });
    await db.pointsTransaction.deleteMany({ where: { userId: { in: userIds } } });
    await db.eloHistory.deleteMany({ where: { userId: { in: userIds } } });
    await db.auditLog.deleteMany({ where: { OR: [{ entityId: matchId }, { actorId: { in: userIds } }] } });
    await db.match.deleteMany({ where: { id: matchId } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.$disconnect();
  }
});

}
