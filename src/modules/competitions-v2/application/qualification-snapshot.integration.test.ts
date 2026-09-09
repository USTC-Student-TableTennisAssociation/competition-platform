import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PrismaClient } from "@prisma/client";

import { V2CompetitionApplicationError } from "./entries";
import { createV2QualificationSnapshotApplicationService } from "./qualification-snapshot";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;

test(
  "real PostgreSQL freezes one exact qualification snapshot and detects later history drift",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const managerId = `qualification-manager-${suffix}`;
    const matchId = `qualification-match-${suffix}`;
    const groupingId = `qualification-grouping-${suffix}`;
    const publishedAt = new Date("2026-09-04T12:00:00.000Z");
    const frozenAt = new Date("2026-09-05T12:00:00.000Z");
    const participantIds = Array.from(
      { length: 4 },
      (_, index) => `qualification-player-${index + 1}-${suffix}`,
    );
    const entryIds = Array.from(
      { length: 4 },
      (_, index) => `qualification-entry-${index + 1}-${suffix}`,
    );

    try {
      await db.user.createMany({
        data: [
          {
            id: managerId,
            email: `${managerId}@example.test`,
            nickname: "Qualification manager",
            emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
          ...participantIds.map((id, index) => ({
            id,
            email: `${id}@example.test`,
            nickname: `Qualification player ${index + 1}`,
            emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
          })),
        ],
      });
      await db.match.create({
        data: {
          id: matchId,
          title: "Qualification snapshot integration",
          dateTime: new Date("2026-09-10T12:00:00.000Z"),
          type: "single",
          status: "ongoing",
          engineVersion: "V2",
          format: "group_then_knockout",
          maxParticipants: 4,
          createdBy: managerId,
          registrationDeadline: new Date("2026-09-01T00:00:00.000Z"),
          groupingGeneratedAt: publishedAt,
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
          qualifiersPerGroup: 1,
          bracketPolicyVersion: 1,
          createdAt: publishedAt,
        },
      });

      const memberIds: string[] = [];
      for (let index = 0; index < entryIds.length; index += 1) {
        const memberId = `qualification-member-${index + 1}-${suffix}`;
        memberIds.push(memberId);
        await db.matchEntry.create({
          data: {
            id: entryIds[index],
            matchId,
            kind: "INDIVIDUAL",
            status: "ACTIVE",
            sourceKey: `individual:${participantIds[index]}`,
            sourceUserId: participantIds[index],
            displayNameSnapshot: `Qualification player ${index + 1}`,
            members: {
              create: {
                id: memberId,
                userId: participantIds[index],
                displayNameSnapshot: `Qualification player ${index + 1}`,
                role: "player",
                status: "ACTIVE",
                slot: 1,
                rosterVersion: 1,
                effectiveFrom: publishedAt,
              },
            },
          },
        });
      }

      const groupIds = [
        `qualification-group-1-${suffix}`,
        `qualification-group-2-${suffix}`,
      ];
      for (let groupIndex = 0; groupIndex < groupIds.length; groupIndex += 1) {
        await db.matchGroup.create({
          data: {
            id: groupIds[groupIndex],
            matchId,
            groupingId,
            groupKey: `group:${String(groupIndex + 1).padStart(4, "0")}`,
            displayName: `第 ${groupIndex + 1} 组`,
            position: groupIndex + 1,
            createdAt: publishedAt,
          },
        });
      }
      await db.matchGroupEntry.createMany({
        data: entryIds.map((entryId, index) => ({
          matchId,
          groupId: groupIds[Math.floor(index / 2)],
          entryId,
          position: (index % 2) + 1,
          globalSeedRank: index + 1,
          seedElo: 1_400 - index * 100,
          seedPoints: 100 - index * 10,
          entryVersion: 0,
          rosterVersion: 1,
          createdAt: publishedAt,
        })),
      });

      const fixtureIds = [
        `qualification-fixture-1-${suffix}`,
        `qualification-fixture-2-${suffix}`,
      ];
      const revisionIds: string[] = [];
      const settlementIds: string[] = [];
      for (let groupIndex = 0; groupIndex < groupIds.length; groupIndex += 1) {
        const leftIndex = groupIndex * 2;
        const rightIndex = leftIndex + 1;
        const fixtureId = fixtureIds[groupIndex];
        await db.matchFixture.create({
          data: {
            id: fixtureId,
            matchId,
            fixtureKey: `group:${String(groupIndex + 1).padStart(4, "0")}:pair:0001-0002`,
            stage: "GROUP",
            status: "COMPLETED",
            groupId: groupIds[groupIndex],
            groupKey: `group:${String(groupIndex + 1).padStart(4, "0")}`,
            sideAEntryId: entryIds[leftIndex],
            sideBEntryId: entryIds[rightIndex],
            sideARosterVersion: 1,
            sideBRosterVersion: 1,
            completedAt: new Date(`2026-09-05T0${groupIndex + 8}:00:00.000Z`),
          },
        });
        await db.matchFixtureLineupMember.createMany({
          data: [
            {
              matchId,
              fixtureId,
              entryId: entryIds[leftIndex],
              entryMemberId: memberIds[leftIndex],
              side: "SIDE_A",
              position: 1,
              createdAt: publishedAt,
            },
            {
              matchId,
              fixtureId,
              entryId: entryIds[rightIndex],
              entryMemberId: memberIds[rightIndex],
              side: "SIDE_B",
              position: 1,
              createdAt: publishedAt,
            },
          ],
        });
        const revisionId = `qualification-revision-${groupIndex + 1}-${suffix}`;
        revisionIds.push(revisionId);
        await db.resultRevision.create({
          data: {
            id: revisionId,
            matchId,
            fixtureId,
            revisionNumber: 1,
            status: "CONFIRMED",
            resolutionKind: "PLAYED",
            winnerEntryId: entryIds[leftIndex],
            loserEntryId: entryIds[rightIndex],
            score: { bestOf: 3, winnerScore: 2, loserScore: 0 },
            reportedById: participantIds[leftIndex],
            verifiedById: managerId,
            resolvedAt: new Date(`2026-09-05T0${groupIndex + 8}:00:00.000Z`),
          },
        });
        const eventId = `qualification-settlement-${groupIndex + 1}-${suffix}`;
        settlementIds.push(eventId);
        await db.settlementEvent.create({
          data: {
            id: eventId,
            idempotencyKey: `qualification:${revisionId}:apply`,
            kind: "RESULT_APPLY",
            status: "APPLIED",
            resultRevisionId: revisionId,
            appliedAt: new Date(`2026-09-05T0${groupIndex + 8}:00:00.000Z`),
            effects: {
              create: [leftIndex, rightIndex].map((participantIndex, sideIndex) => ({
                userId: participantIds[participantIndex],
                eloBefore: 1_200,
                eloAfter: sideIndex === 0 ? 1_210 : 1_190,
                eloDelta: sideIndex === 0 ? 10 : -10,
                pointsBefore: 0,
                pointsAfter: sideIndex === 0 ? 3 : 0,
                pointsDelta: sideIndex === 0 ? 3 : 0,
                winsDelta: sideIndex === 0 ? 1 : 0,
                lossesDelta: sideIndex === 0 ? 0 : 1,
                matchesPlayedDelta: 1,
              })),
            },
          },
        });
      }

      const service = createV2QualificationSnapshotApplicationService({
        db,
        clock: () => frozenAt,
      });
      const freeze = () =>
        service.freeze({
          actor: { id: managerId, role: "user" },
          matchId,
        });

      const outsideFixtureId = `qualification-outside-fixture-${suffix}`;
      const outsideRevisionId = `qualification-outside-revision-${suffix}`;
      const outsideReversalId = `qualification-outside-reversal-${suffix}`;
      await db.matchFixture.create({
        data: {
          id: outsideFixtureId,
          matchId,
          fixtureKey: "knockout:round:0001:position:0001",
          stage: "KNOCKOUT",
          status: "VOIDED",
          roundNumber: 1,
          position: 1,
          sideAEntryId: entryIds[0],
          sideBEntryId: entryIds[1],
          sideARosterVersion: 1,
          sideBRosterVersion: 1,
        },
      });
      await db.resultRevision.create({
        data: {
          id: outsideRevisionId,
          matchId,
          fixtureId: outsideFixtureId,
          revisionNumber: 1,
          status: "VOIDED",
          resolutionKind: "PLAYED",
          winnerEntryId: entryIds[0],
          loserEntryId: entryIds[1],
          score: { bestOf: 3, winnerScore: 2, loserScore: 0 },
          reportedById: managerId,
          verifiedById: managerId,
          resolvedAt: new Date("2026-09-05T11:00:00.000Z"),
        },
      });
      await db.settlementEvent.create({
        data: {
          id: outsideReversalId,
          idempotencyKey: `qualification:${outsideRevisionId}:reversal`,
          kind: "RESULT_REVERSAL",
          status: "APPLIED",
          resultRevisionId: outsideRevisionId,
          reversesEventId: settlementIds[0],
          appliedAt: new Date("2026-09-05T11:00:00.000Z"),
        },
      });
      await assert.rejects(freeze, (error: unknown) => {
        assert.ok(error instanceof V2CompetitionApplicationError);
        assert.equal(error.code, "PERSISTENCE_CONFLICT");
        return true;
      });
      await db.settlementEvent.delete({ where: { id: outsideReversalId } });
      await db.resultRevision.delete({ where: { id: outsideRevisionId } });
      await db.matchFixture.delete({ where: { id: outsideFixtureId } });

      const first = await freeze();
      assert.equal(first.created, true);
      assert.equal(first.qualificationCount, 2);
      assert.match(first.sourceRevisionFingerprint, /^[a-f0-9]{64}$/);
      const retry = await freeze();
      assert.equal(retry.created, false);
      assert.equal(retry.snapshotId, first.snapshotId);
      assert.equal(
        await db.matchQualificationSnapshot.count({ where: { matchId } }),
        1,
      );
      assert.equal(
        await db.matchQualificationStanding.count({ where: { matchId } }),
        4,
      );
      assert.equal(
        await db.auditLog.count({
          where: { entityId: matchId, action: "v2_qualification_snapshot_freeze" },
        }),
        1,
      );

      await db.resultRevision.update({
        where: { id: revisionIds[0] },
        data: { reason: "post-freeze history drift" },
      });
      await assert.rejects(freeze, (error: unknown) => {
        assert.ok(error instanceof V2CompetitionApplicationError);
        assert.equal(error.code, "PERSISTENCE_CONFLICT");
        return true;
      });
    } finally {
      await db.$disconnect();
    }
  },
);
