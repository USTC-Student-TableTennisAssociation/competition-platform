import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PrismaClient } from "@prisma/client";

import { createV2EntryDisqualificationApplicationService } from "./entry-disqualification";
import { applyRegistrationSettlement } from "./registration-settlements";
import { createV2ResultApplicationService } from "./results";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;

test(
  "real PostgreSQL carries a DQ empty slot through a later feeder result and finishes by ADMIN_BYE",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const matchId = `dq-match-${suffix}`;
    const ownerId = `dq-owner-${suffix}`;
    const groupingId = `dq-grouping-${suffix}`;
    const snapshotId = `dq-snapshot-${suffix}`;
    const fingerprint = suffix.padEnd(64, "a").slice(0, 64);
    const entryIds = Array.from({ length: 4 }, (_, index) => `dq-entry-${index + 1}-${suffix}`);
    const playerIds = Array.from({ length: 4 }, (_, index) => `dq-player-${index + 1}-${suffix}`);
    const memberIds = Array.from({ length: 4 }, (_, index) => `dq-member-${index + 1}-${suffix}`);
    const standingIds = Array.from({ length: 4 }, (_, index) => `dq-standing-${index + 1}-${suffix}`);
    const groupIds = [`dq-group-1-${suffix}`, `dq-group-2-${suffix}`];
    const fixtureIds = [
      `dq-r1-1-${suffix}`,
      `dq-r1-2-${suffix}`,
      `dq-final-${suffix}`,
    ];
    const groupedAt = new Date("2026-09-06T08:00:00.000Z");
    const frozenAt = new Date("2026-09-06T10:00:00.000Z");
    const publishedAt = new Date("2026-09-06T12:00:00.000Z");
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
            nickname: "DQ manager",
            emailVerifiedAt: groupedAt,
          },
          ...playerIds.map((id, index) => ({
            id,
            email: `${id}@example.test`,
            nickname: `DQ player ${index + 1}`,
            emailVerifiedAt: groupedAt,
          })),
        ],
      });
      await db.match.create({
        data: {
          id: matchId,
          title: "Administrative knockout integration",
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
      for (let index = 0; index < 4; index += 1) {
        const unavailable = index === 3;
        await db.matchEntry.create({
          data: {
            id: entryIds[index],
            matchId,
            kind: "INDIVIDUAL",
            status: unavailable ? "DISQUALIFIED" : "ACTIVE",
            sourceKey: `individual:${playerIds[index]}`,
            sourceUserId: playerIds[index],
            displayNameSnapshot: `Entry ${index + 1}`,
            disqualifiedAt: unavailable ? frozenAt : null,
            createdAt: groupedAt,
            members: {
              create: {
                id: memberIds[index],
                userId: playerIds[index],
                displayNameSnapshot: `Player ${index + 1}`,
                role: "player",
                status: unavailable ? "DISQUALIFIED" : "ACTIVE",
                slot: 1,
                rosterVersion: 1,
                effectiveFrom: groupedAt,
                effectiveUntil: unavailable ? frozenAt : null,
                endReason: unavailable ? "ENTRY_DISQUALIFIED" : null,
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
            id: fixtureIds[0],
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
            id: fixtureIds[1],
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
            id: fixtureIds[2],
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
          [fixtureIds[0], 0, "SIDE_A"],
          [fixtureIds[0], 3, "SIDE_B"],
          [fixtureIds[1], 1, "SIDE_A"],
          [fixtureIds[1], 2, "SIDE_B"],
        ].map(([fixtureId, rawIndex, rawSide]) => {
          const index = rawIndex as number;
          return {
            matchId,
            fixtureId: fixtureId as string,
            entryId: entryIds[index],
            entryMemberId: memberIds[index],
            side: rawSide as "SIDE_A" | "SIDE_B",
            position: 1,
            createdAt: publishedAt,
          };
        }),
      });
      await db.matchFixtureDependency.createMany({
        data: [
          [standingIds[0], fixtureIds[0], "SIDE_A"],
          [standingIds[3], fixtureIds[0], "SIDE_B"],
          [standingIds[1], fixtureIds[1], "SIDE_A"],
          [standingIds[2], fixtureIds[1], "SIDE_B"],
        ].map(([sourceQualificationStandingId, targetFixtureId, targetSide]) => ({
          matchId,
          sourceQualificationStandingId,
          targetFixtureId,
          targetSide: targetSide as "SIDE_A" | "SIDE_B",
          createdAt: publishedAt,
        })),
      });
      await db.matchFixtureDependency.createMany({
        data: [
          {
            matchId,
            sourceFixtureId: fixtureIds[0],
            sourceOutcome: "WINNER",
            targetFixtureId: fixtureIds[2],
            targetSide: "SIDE_A",
            createdAt: publishedAt,
          },
          {
            matchId,
            sourceFixtureId: fixtureIds[1],
            sourceOutcome: "WINNER",
            targetFixtureId: fixtureIds[2],
            targetSide: "SIDE_B",
            createdAt: publishedAt,
          },
        ],
      });
      await db.$transaction((tx) =>
        applyRegistrationSettlement(tx, {
          matchId,
          matchEntryId: entryIds[0],
          rosterVersion: 1,
          origin: "STANDARD",
          clock: () => groupedAt,
        }),
      );

      const before = await db.user.findUniqueOrThrow({ where: { id: playerIds[0] } });
      assert.equal(before.points, 1);
      const result = await createV2EntryDisqualificationApplicationService({ db }).disqualify({
        actor: { id: ownerId, role: "user" },
        matchId,
        entryId: entryIds[0],
        expectedEntryVersion: 0,
        reason: "确认无法继续参赛",
      });

      assert.deepEqual(result.noContestFixtureIds, [fixtureIds[0]]);
      assert.deepEqual(result.adminByeFixtureIds, []);
      assert.deepEqual(result.forfeitedFixtureIds, []);
      assert.equal(
        (await db.match.findUniqueOrThrow({ where: { id: matchId } })).status,
        "ongoing",
      );

      await createV2ResultApplicationService({ db }).confirmForfeit({
        actor: { actorId: ownerId, role: "user" },
        matchId,
        fixtureId: fixtureIds[1],
        expectedFixtureVersion: 0,
        requiredFixtureStage: "KNOCKOUT",
        winnerEntryId: entryIds[1],
        loserEntryId: entryIds[2],
        reason: "确认无法继续参赛",
      });
      const [match, targetEntry, targetMember, resolutions, adminResultCount, targetUser] =
        await Promise.all([
          db.match.findUniqueOrThrow({ where: { id: matchId } }),
          db.matchEntry.findUniqueOrThrow({ where: { id: entryIds[0] } }),
          db.matchEntryMember.findUniqueOrThrow({ where: { id: memberIds[0] } }),
          db.matchFixtureAdministrativeResolution.findMany({
            where: { matchId },
            orderBy: { createdAt: "asc" },
          }),
          db.resultRevision.count({ where: { fixtureId: { in: [fixtureIds[0], fixtureIds[2]] } } }),
          db.user.findUniqueOrThrow({ where: { id: playerIds[0] } }),
        ]);
      assert.equal(match.status, "finished");
      assert.equal(targetEntry.status, "DISQUALIFIED");
      assert.equal(targetMember.status, "DISQUALIFIED");
      assert.equal(targetUser.points, 0);
      assert.equal(adminResultCount, 0);
      assert.deepEqual(
        resolutions.map((resolution) => ({
          fixtureId: resolution.fixtureId,
          kind: resolution.kind,
          advancingEntryId: resolution.advancingEntryId,
        })),
        [
          {
            fixtureId: fixtureIds[0],
            kind: "NO_CONTEST",
            advancingEntryId: null,
          },
          {
            fixtureId: fixtureIds[2],
            kind: "ADMIN_BYE",
            advancingEntryId: entryIds[1],
          },
        ],
      );
      const reversal = await db.settlementEvent.findFirstOrThrow({
        where: { matchEntryId: entryIds[0], kind: "REGISTRATION_REVERSAL" },
      });
      assert.equal(reversal.status, "APPLIED");
    } finally {
      await db.$disconnect();
    }
  },
);
