import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PrismaClient } from "@prisma/client";

import { V2ResultApplicationError } from "./results-errors";
import { createV2ResultApplicationService } from "./results";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;

test(
  "real PostgreSQL advances, freezes, rebinds, and finishes one knockout bracket",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replace(/-/g, "");
    const matchId = `advance-match-${suffix}`;
    const ownerId = `advance-owner-${suffix}`;
    const groupingId = `advance-grouping-${suffix}`;
    const snapshotId = `advance-snapshot-${suffix}`;
    const fingerprint = suffix.padEnd(64, "a").slice(0, 64);
    const entryIds = Array.from(
      { length: 4 },
      (_, index) => `advance-entry-${index + 1}-${suffix}`,
    );
    const playerIds = Array.from(
      { length: 4 },
      (_, index) => `advance-player-${index + 1}-${suffix}`,
    );
    const memberIds = Array.from(
      { length: 4 },
      (_, index) => `advance-member-${index + 1}-${suffix}`,
    );
    const standingIds = Array.from(
      { length: 4 },
      (_, index) => `advance-standing-${index + 1}-${suffix}`,
    );
    const groupIds = [
      `advance-group-1-${suffix}`,
      `advance-group-2-${suffix}`,
    ];
    const firstFixtureIds = [
      `advance-r1-1-${suffix}`,
      `advance-r1-2-${suffix}`,
    ];
    const finalFixtureId = `advance-final-${suffix}`;
    const groupedAt = new Date("2026-09-05T08:00:00.000Z");
    const frozenAt = new Date("2026-09-05T10:00:00.000Z");
    const publishedAt = new Date("2026-09-05T12:00:00.000Z");
    const metadata = (roundNumber: number, position: number) => ({
      publication: "V2_KNOCKOUT_BRACKET",
      schemaVersion: 1,
      bracketPolicyVersion: 1,
      qualificationSnapshotId: snapshotId,
      sourceRevisionFingerprint: fingerprint,
      roundNumber,
      position,
      publishedAt: publishedAt.toISOString(),
    });

    try {
      await db.user.createMany({
        data: [
          {
            id: ownerId,
            email: `${ownerId}@example.test`,
            nickname: "Advancement owner",
            emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
          ...playerIds.map((id, index) => ({
            id,
            email: `${id}@example.test`,
            nickname: `Advancement player ${index + 1}`,
            emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
          })),
        ],
      });
      await db.match.create({
        data: {
          id: matchId,
          title: "Knockout advancement integration",
          dateTime: new Date("2026-09-10T12:00:00.000Z"),
          type: "single",
          status: "ongoing",
          engineVersion: "V2",
          format: "group_then_knockout",
          maxParticipants: 4,
          createdBy: ownerId,
          registrationDeadline: new Date("2026-09-01T00:00:00.000Z"),
          groupingGeneratedAt: groupedAt,
        },
      });
      await db.matchGrouping.create({
        data: {
          id: groupingId,
          matchId,
          payload: {},
          v2SchemaVersion: 1,
          seedMethod: "SNAKE",
          standingsPolicyVersion: 1,
          qualifiersPerGroup: 2,
          bracketPolicyVersion: 1,
          createdAt: groupedAt,
        },
      });
      for (let index = 0; index < entryIds.length; index += 1) {
        await db.matchEntry.create({
          data: {
            id: entryIds[index],
            matchId,
            kind: "INDIVIDUAL",
            status: "ACTIVE",
            sourceKey: `individual:${playerIds[index]}`,
            sourceUserId: playerIds[index],
            displayNameSnapshot: `Entry ${index + 1}`,
            createdAt: groupedAt,
            members: {
              create: {
                id: memberIds[index],
                userId: playerIds[index],
                displayNameSnapshot: `Player ${index + 1}`,
                role: "player",
                status: "ACTIVE",
                slot: 1,
                rosterVersion: 1,
                effectiveFrom: groupedAt,
                createdAt: groupedAt,
              },
            },
          },
        });
      }
      await db.matchGroup.createMany({
        data: groupIds.map((id, index) => ({
          id,
          matchId,
          groupingId,
          groupKey: `group:${String(index + 1).padStart(4, "0")}`,
          displayName: `第 ${index + 1} 组`,
          position: index + 1,
          createdAt: groupedAt,
        })),
      });
      await db.matchGroupEntry.createMany({
        data: entryIds.map((entryId, index) => ({
          matchId,
          groupId: groupIds[index % 2],
          entryId,
          position: Math.floor(index / 2) + 1,
          globalSeedRank: index + 1,
          seedElo: 1_500 - index * 100,
          seedPoints: 100 - index * 10,
          entryVersion: 0,
          rosterVersion: 1,
          createdAt: groupedAt,
        })),
      });
      await db.matchQualificationSnapshot.create({
        data: {
          id: snapshotId,
          matchId,
          groupingId,
          schemaVersion: 1,
          standingsPolicyVersion: 1,
          sourceRevisionFingerprint: fingerprint,
          createdAt: frozenAt,
        },
      });
      await db.matchQualificationStanding.createMany({
        data: entryIds.map((entryId, index) => ({
          id: standingIds[index],
          matchId,
          snapshotId,
          groupId: groupIds[index % 2],
          entryId,
          rank: Math.floor(index / 2) + 1,
          played: 1,
          wins: index < 2 ? 1 : 0,
          losses: index < 2 ? 0 : 1,
          scoreFor: index < 2 ? 2 : 0,
          scoreAgainst: index < 2 ? 0 : 2,
          scoreDifferential: index < 2 ? 2 : -2,
          qualified: true,
          qualificationOrder: index + 1,
          createdAt: frozenAt,
        })),
      });
      await db.matchFixture.createMany({
        data: [
          {
            id: firstFixtureIds[0],
            matchId,
            fixtureKey: "knockout:r0001:m0001",
            stage: "KNOCKOUT",
            status: "READY",
            roundNumber: 1,
            position: 1,
            sideAEntryId: entryIds[0],
            sideBEntryId: entryIds[3],
            sideARosterVersion: 1,
            sideBRosterVersion: 1,
            metadata: metadata(1, 1),
            createdAt: publishedAt,
            updatedAt: publishedAt,
          },
          {
            id: firstFixtureIds[1],
            matchId,
            fixtureKey: "knockout:r0001:m0002",
            stage: "KNOCKOUT",
            status: "READY",
            roundNumber: 1,
            position: 2,
            sideAEntryId: entryIds[1],
            sideBEntryId: entryIds[2],
            sideARosterVersion: 1,
            sideBRosterVersion: 1,
            metadata: metadata(1, 2),
            createdAt: publishedAt,
            updatedAt: publishedAt,
          },
          {
            id: finalFixtureId,
            matchId,
            fixtureKey: "knockout:r0002:m0001",
            stage: "KNOCKOUT",
            status: "SCHEDULED",
            roundNumber: 2,
            position: 1,
            metadata: metadata(2, 1),
            createdAt: publishedAt,
            updatedAt: publishedAt,
          },
        ],
      });
      await db.matchFixtureLineupMember.createMany({
        data: [
          { fixtureId: firstFixtureIds[0], index: 0, side: "SIDE_A" as const },
          { fixtureId: firstFixtureIds[0], index: 3, side: "SIDE_B" as const },
          { fixtureId: firstFixtureIds[1], index: 1, side: "SIDE_A" as const },
          { fixtureId: firstFixtureIds[1], index: 2, side: "SIDE_B" as const },
        ].map(({ fixtureId, index, side }) => {
          return {
            matchId,
            fixtureId,
            entryId: entryIds[index],
            entryMemberId: memberIds[index],
            side,
            position: 1,
            createdAt: publishedAt,
          };
        }),
      });
      await db.matchFixtureDependency.createMany({
        data: [
          [standingIds[0], firstFixtureIds[0], "SIDE_A"],
          [standingIds[3], firstFixtureIds[0], "SIDE_B"],
          [standingIds[1], firstFixtureIds[1], "SIDE_A"],
          [standingIds[2], firstFixtureIds[1], "SIDE_B"],
        ].map(([sourceQualificationStandingId, targetFixtureId, targetSide]) => ({
          matchId,
          sourceQualificationStandingId,
          targetFixtureId,
          targetSide: targetSide as "SIDE_A" | "SIDE_B",
          createdAt: publishedAt,
        })),
      });
      await db.matchFixtureDependency.createMany({
        data: firstFixtureIds.map((sourceFixtureId, index) => ({
          matchId,
          sourceFixtureId,
          sourceOutcome: "WINNER" as const,
          targetFixtureId: finalFixtureId,
          targetSide: index === 0 ? ("SIDE_A" as const) : ("SIDE_B" as const),
          createdAt: publishedAt,
        })),
      });

      let clockTick = 0;
      const service = createV2ResultApplicationService({
        db,
        clock: () =>
          new Date(
            new Date("2026-09-05T13:00:00.000Z").getTime() +
              clockTick++ * 60_000,
          ),
      });
      const firstPending = await service.submitRevision({
        actor: { actorId: playerIds[0], role: "user" },
        matchId,
        fixtureId: firstFixtureIds[0],
        expectedFixtureVersion: 0,
        requiredFixtureStage: "KNOCKOUT",
        winnerEntryId: entryIds[0],
        loserEntryId: entryIds[3],
        score: { bestOf: 5, winnerScore: 3, loserScore: 1 },
      });
      await service.confirmRevision({
        actor: { actorId: playerIds[3], role: "user" },
        matchId,
        fixtureId: firstFixtureIds[0],
        expectedFixtureVersion: 1,
        requiredFixtureStage: "KNOCKOUT",
        resultRevisionId: firstPending.id,
      });
      const firstApplication = await db.settlementEvent.findFirstOrThrow({
        where: {
          resultRevisionId: firstPending.id,
          kind: "RESULT_APPLY",
        },
        include: { effects: true },
      });
      assert.equal(firstApplication.status, "APPLIED");
      assert.equal(firstApplication.effects.length, 2);
      let finalFixture = await db.matchFixture.findUniqueOrThrow({
        where: { id: finalFixtureId },
        include: { lineupMembers: true },
      });
      assert.equal(finalFixture.status, "SCHEDULED");
      assert.equal(finalFixture.sideAEntryId, entryIds[0]);
      assert.equal(finalFixture.sideBEntryId, null);
      assert.equal(finalFixture.lineupMembers.length, 1);

      await service.confirmForfeit({
        actor: { actorId: ownerId, role: "user" },
        matchId,
        fixtureId: firstFixtureIds[1],
        expectedFixtureVersion: 0,
        requiredFixtureStage: "KNOCKOUT",
        winnerEntryId: entryIds[1],
        loserEntryId: entryIds[2],
        reason: "Opponent forfeited before play",
      });
      const semifinalForfeit = await db.resultRevision.findFirstOrThrow({
        where: {
          fixtureId: firstFixtureIds[1],
          status: "CONFIRMED",
        },
      });
      assert.equal(semifinalForfeit.resolutionKind, "FORFEIT");
      assert.equal(
        await db.settlementEvent.count({
          where: { resultRevisionId: semifinalForfeit.id },
        }),
        0,
      );
      finalFixture = await db.matchFixture.findUniqueOrThrow({
        where: { id: finalFixtureId },
        include: { lineupMembers: true },
      });
      assert.equal(finalFixture.status, "READY");
      assert.equal(finalFixture.sideBEntryId, entryIds[1]);
      assert.equal(finalFixture.lineupMembers.length, 2);

      const correction = await service.submitCorrection({
        actor: { actorId: ownerId, role: "user" },
        matchId,
        fixtureId: firstFixtureIds[0],
        expectedFixtureVersion: 2,
        requiredFixtureStage: "KNOCKOUT",
        resultRevisionId: firstPending.id,
        score: { bestOf: 5, winnerScore: 3, loserScore: 2 },
        reason: "Winner was recorded on the wrong side",
      });
      await assert.rejects(
        () =>
          service.submitRevision({
            actor: { actorId: playerIds[0], role: "user" },
            matchId,
            fixtureId: finalFixtureId,
            expectedFixtureVersion: 2,
            requiredFixtureStage: "KNOCKOUT",
            winnerEntryId: entryIds[0],
            loserEntryId: entryIds[1],
            score: { bestOf: 5, winnerScore: 3, loserScore: 0 },
          }),
        (error: unknown) =>
          error instanceof V2ResultApplicationError &&
          error.code === "INVALID_CORRECTION",
      );
      await service.confirmRevision({
        actor: { actorId: ownerId, role: "user" },
        matchId,
        fixtureId: firstFixtureIds[0],
        expectedFixtureVersion: 3,
        requiredFixtureStage: "KNOCKOUT",
        resultRevisionId: correction.id,
      });
      finalFixture = await db.matchFixture.findUniqueOrThrow({
        where: { id: finalFixtureId },
        include: { lineupMembers: { orderBy: { side: "asc" } } },
      });
      assert.equal(finalFixture.status, "READY");
      assert.equal(finalFixture.version, 3);
      assert.equal(finalFixture.sideAEntryId, entryIds[3]);
      assert.equal(finalFixture.sideARosterVersion, 1);
      assert.equal(finalFixture.lineupMembers.length, 2);
      assert.equal(finalFixture.lineupMembers[0].entryMemberId, memberIds[3]);
      assert.equal(finalFixture.lineupMembers[0].entryId, entryIds[3]);
      assert.equal(finalFixture.lineupMembers[0].side, "SIDE_A");
      assert.equal(finalFixture.lineupMembers[1].entryMemberId, memberIds[1]);
      assert.equal(finalFixture.lineupMembers[1].entryId, entryIds[1]);
      assert.equal(finalFixture.lineupMembers[1].side, "SIDE_B");
      const [reversedInitial, correctionApplication] = await Promise.all([
        db.settlementEvent.findFirstOrThrow({
          where: {
            resultRevisionId: firstPending.id,
            kind: "RESULT_APPLY",
          },
        }),
        db.settlementEvent.findFirstOrThrow({
          where: {
            resultRevisionId: correction.id,
            kind: "RESULT_APPLY",
          },
          include: { effects: true },
        }),
      ]);
      assert.equal(reversedInitial.status, "REVERSED");
      assert.equal(correctionApplication.status, "APPLIED");
      assert.equal(correctionApplication.effects.length, 2);
      assert.equal(
        await db.settlementEvent.count({
          where: {
            resultRevisionId: firstPending.id,
            kind: "RESULT_REVERSAL",
            status: "APPLIED",
          },
        }),
        1,
      );

      const finalPending = await service.submitRevision({
        actor: { actorId: playerIds[3], role: "user" },
        matchId,
        fixtureId: finalFixtureId,
        expectedFixtureVersion: 3,
        requiredFixtureStage: "KNOCKOUT",
        winnerEntryId: entryIds[3],
        loserEntryId: entryIds[1],
        score: { bestOf: 5, winnerScore: 3, loserScore: 2 },
      });
      await assert.rejects(
        () =>
          service.submitCorrection({
            actor: { actorId: ownerId, role: "user" },
            matchId,
            fixtureId: firstFixtureIds[0],
            expectedFixtureVersion: 4,
            requiredFixtureStage: "KNOCKOUT",
            resultRevisionId: correction.id,
            score: { bestOf: 5, winnerScore: 3, loserScore: 2 },
          }),
        (error: unknown) =>
          error instanceof V2ResultApplicationError &&
          error.code === "INVALID_CORRECTION",
      );
      await service.confirmRevision({
        actor: { actorId: playerIds[1], role: "user" },
        matchId,
        fixtureId: finalFixtureId,
        expectedFixtureVersion: 4,
        requiredFixtureStage: "KNOCKOUT",
        resultRevisionId: finalPending.id,
      });

      const [
        finishedMatch,
        completedFixtures,
        finalConfirmed,
        finalApplication,
      ] =
        await Promise.all([
          db.match.findUniqueOrThrow({ where: { id: matchId } }),
          db.matchFixture.count({
            where: { matchId, stage: "KNOCKOUT", status: "COMPLETED" },
          }),
          db.resultRevision.findUniqueOrThrow({ where: { id: finalPending.id } }),
          db.settlementEvent.findFirstOrThrow({
            where: {
              resultRevisionId: finalPending.id,
              kind: "RESULT_APPLY",
            },
            include: { effects: true },
          }),
        ]);
      assert.equal(finishedMatch.status, "finished");
      assert.equal(completedFixtures, 3);
      assert.equal(finalConfirmed.status, "CONFIRMED");
      assert.equal(finalApplication.status, "APPLIED");
      assert.equal(finalApplication.effects.length, 2);
    } finally {
      await db.$disconnect();
    }
  },
);
