import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import {
  createV2CertificateApplicationService,
  V2CertificateApplicationError,
} from "./certificates";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;

const sixCellCases = [
  { type: "single" as const, format: "group_only" as const, rosterSize: 1 },
  {
    type: "single" as const,
    format: "group_then_knockout" as const,
    rosterSize: 1,
  },
  { type: "double" as const, format: "group_only" as const, rosterSize: 2 },
  {
    type: "double" as const,
    format: "group_then_knockout" as const,
    rosterSize: 2,
  },
  { type: "team" as const, format: "group_only" as const, rosterSize: 2 },
  {
    type: "team" as const,
    format: "group_then_knockout" as const,
    rosterSize: 2,
  },
] as const;

test(
  "real PostgreSQL issuance is idempotent under concurrency and rechecks pending corrections",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const userAId = `certificate-a-${suffix}`;
    const userBId = `certificate-b-${suffix}`;
    const matchId = `certificate-match-${suffix}`;
    const entryAId = `certificate-entry-a-${suffix}`;
    const entryBId = `certificate-entry-b-${suffix}`;
    const memberAId = `certificate-member-a-${suffix}`;
    const memberBId = `certificate-member-b-${suffix}`;
    const groupingId = `certificate-grouping-${suffix}`;
    const groupId = `certificate-group-${suffix}`;
    const fixtureId = `certificate-fixture-${suffix}`;
    const revisionId = `certificate-revision-${suffix}`;
    const settlementId = `certificate-settlement-${suffix}`;
    const now = new Date("2026-09-05T08:00:00.000Z");

    try {
      await db.user.createMany({
        data: [
          {
            id: userAId,
            email: `${userAId}@example.test`,
            nickname: "Certificate A",
            emailVerifiedAt: now,
            eloRating: 1210,
            points: 1,
            wins: 1,
            matchesPlayed: 1,
          },
          {
            id: userBId,
            email: `${userBId}@example.test`,
            nickname: "Certificate B",
            emailVerifiedAt: now,
            eloRating: 1190,
            losses: 1,
            matchesPlayed: 1,
          },
        ],
      });
      await db.match.create({
        data: {
          id: matchId,
          title: "V2 certificate integration",
          dateTime: new Date("2026-09-06T08:00:00.000Z"),
          registrationDeadline: new Date("2026-09-04T08:00:00.000Z"),
          groupingGeneratedAt: now,
          type: "single",
          status: "finished",
          engineVersion: "V2",
          format: "group_only",
          maxParticipants: 2,
          createdBy: userAId,
        },
      });
      await db.matchEntry.createMany({
        data: [
          {
            id: entryAId,
            matchId,
            kind: "INDIVIDUAL",
            status: "ACTIVE",
            sourceKey: `individual:${userAId}`,
            sourceUserId: userAId,
            displayNameSnapshot: "Certificate A",
          },
          {
            id: entryBId,
            matchId,
            kind: "INDIVIDUAL",
            status: "ACTIVE",
            sourceKey: `individual:${userBId}`,
            sourceUserId: userBId,
            displayNameSnapshot: "Certificate B",
          },
        ],
      });
      await db.matchEntryMember.createMany({
        data: [
          {
            id: memberAId,
            matchId,
            entryId: entryAId,
            userId: userAId,
            displayNameSnapshot: "Certificate A",
            role: "player",
            status: "ACTIVE",
            slot: 1,
            rosterVersion: 1,
          },
          {
            id: memberBId,
            matchId,
            entryId: entryBId,
            userId: userBId,
            displayNameSnapshot: "Certificate B",
            role: "player",
            status: "ACTIVE",
            slot: 1,
            rosterVersion: 1,
          },
        ],
      });
      await db.matchGrouping.create({
        data: {
          id: groupingId,
          matchId,
          payload: {},
          v2SchemaVersion: 1,
          seedMethod: "MIN_DIFF",
          standingsPolicyVersion: 1,
          createdAt: now,
        },
      });
      await db.matchGroup.create({
        data: {
          id: groupId,
          matchId,
          groupingId,
          groupKey: "group:0001",
          displayName: "第 1 组",
          position: 1,
          createdAt: now,
        },
      });
      await db.matchGroupEntry.createMany({
        data: [
          {
            matchId,
            groupId,
            entryId: entryAId,
            position: 1,
            globalSeedRank: 1,
            seedElo: 1200,
            seedPoints: 0,
            entryVersion: 0,
            rosterVersion: 1,
            createdAt: now,
          },
          {
            matchId,
            groupId,
            entryId: entryBId,
            position: 2,
            globalSeedRank: 2,
            seedElo: 1200,
            seedPoints: 0,
            entryVersion: 0,
            rosterVersion: 1,
            createdAt: now,
          },
        ],
      });
      await db.matchFixture.create({
        data: {
          id: fixtureId,
          matchId,
          fixtureKey: "group:0001:pair:0001-0002",
          stage: "GROUP",
          status: "COMPLETED",
          groupId,
          groupKey: "group:0001",
          sideAEntryId: entryAId,
          sideBEntryId: entryBId,
          sideARosterVersion: 1,
          sideBRosterVersion: 1,
          completedAt: now,
        },
      });
      await db.matchFixtureLineupMember.createMany({
        data: [
          {
            matchId,
            fixtureId,
            entryId: entryAId,
            entryMemberId: memberAId,
            side: "SIDE_A",
            position: 1,
          },
          {
            matchId,
            fixtureId,
            entryId: entryBId,
            entryMemberId: memberBId,
            side: "SIDE_B",
            position: 1,
          },
        ],
      });
      await db.resultRevision.create({
        data: {
          id: revisionId,
          matchId,
          fixtureId,
          revisionNumber: 1,
          status: "CONFIRMED",
          winnerEntryId: entryAId,
          loserEntryId: entryBId,
          score: { bestOf: 3, winnerScore: 2, loserScore: 0 },
          reportedById: userAId,
          verifiedById: userBId,
          resolvedAt: now,
        },
      });
      await db.settlementEvent.create({
        data: {
          id: settlementId,
          idempotencyKey: `result:${revisionId}:apply`,
          kind: "RESULT_APPLY",
          status: "APPLIED",
          resultRevisionId: revisionId,
          appliedAt: now,
          effects: {
            create: [
              {
                userId: userAId,
                eloBefore: 1200,
                eloAfter: 1210,
                eloDelta: 10,
                pointsBefore: 0,
                pointsAfter: 1,
                pointsDelta: 1,
                winsDelta: 1,
                matchesPlayedDelta: 1,
              },
              {
                userId: userBId,
                eloBefore: 1200,
                eloAfter: 1190,
                eloDelta: -10,
                pointsBefore: 0,
                pointsAfter: 0,
                pointsDelta: 0,
                lossesDelta: 1,
                matchesPlayedDelta: 1,
              },
            ],
          },
        },
      });

      const service = createV2CertificateApplicationService({
        db,
        generateNumber: () => `PPC-TEST-${randomUUID().slice(0, 8)}`,
        hashIdentity: (value) => `test-hash:${value}`,
        verifyIdentity: (value, hash) => hash === `test-hash:${value}`,
        maximumTransactionAttempts: 5,
      });
      const command = {
        matchId,
        actorId: userAId,
        fullName: "张三",
        studentId: "PB00000001",
      };

      const concurrent = await Promise.all([
        service.issue(command),
        service.issue(command),
      ]);
      const retry = await service.issue(command);
      assert.equal(concurrent[0].certificateNo, concurrent[1].certificateNo);
      assert.equal(retry.certificateNo, concurrent[0].certificateNo);
      assert.equal(
        await db.participationCertificate.count({ where: { matchId, userId: userAId } }),
        1,
      );
      assert.equal(await db.userIdentity.count({ where: { userId: userAId } }), 1);

      await db.resultRevision.create({
        data: {
          matchId,
          fixtureId,
          revisionNumber: 2,
          status: "PENDING",
          winnerEntryId: entryBId,
          loserEntryId: entryAId,
          score: { bestOf: 3, winnerScore: 2, loserScore: 1 },
          reportedById: userAId,
          supersedesRevisionId: revisionId,
        },
      });
      await assert.rejects(
        service.issue(command),
        (error: unknown) =>
          error instanceof V2CertificateApplicationError &&
          error.code === "NOT_ELIGIBLE",
      );
      assert.equal(
        await db.participationCertificate.count({ where: { matchId, userId: userAId } }),
        1,
      );
    } finally {
      await db.participationCertificate.deleteMany({ where: { matchId } });
      await db.userIdentity.deleteMany({ where: { userId: { in: [userAId, userBId] } } });
      await db.settlementEffect.deleteMany({ where: { eventId: settlementId } });
      await db.settlementEvent.deleteMany({ where: { id: settlementId } });
      await db.resultRevision.deleteMany({ where: { matchId } });
      await db.matchFixtureLineupMember.deleteMany({ where: { matchId } });
      await db.matchFixture.deleteMany({ where: { matchId } });
      await db.matchGroupEntry.deleteMany({ where: { matchId } });
      await db.matchGroup.deleteMany({ where: { matchId } });
      await db.matchGrouping.deleteMany({ where: { matchId } });
      await db.matchEntryMember.deleteMany({ where: { matchId } });
      await db.matchEntry.deleteMany({ where: { matchId } });
      await db.match.deleteMany({ where: { id: matchId } });
      await db.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });
      await db.$disconnect();
    }
  },
);

for (const certificateCase of sixCellCases) {
  test(
    `real PostgreSQL issues ${certificateCase.type} + ${certificateCase.format} from relational V2 facts`,
    { skip: integrationDatabaseUrl === undefined },
    async () => {
      process.env.DATABASE_URL = integrationDatabaseUrl;
      process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
      const db = new PrismaClient();
      const suffix = randomUUID().replaceAll("-", "");
      const prefix = `certificate-six-${certificateCase.type}-${certificateCase.format}-${suffix}`;
      const matchId = `${prefix}-match`;
      const groupingId = `${prefix}-grouping`;
      const groupId = `${prefix}-group`;
      const fixtureId = `${prefix}-fixture`;
      const revisionId = `${prefix}-revision`;
      const settlementId = `${prefix}-settlement`;
      const entryIds = [`${prefix}-entry-a`, `${prefix}-entry-b`] as const;
      const userIdsByEntry = entryIds.map((_, entryIndex) =>
        Array.from(
          { length: certificateCase.rosterSize },
          (_unused, memberIndex) =>
            `${prefix}-user-${entryIndex + 1}-${memberIndex + 1}`,
        ),
      );
      const memberIdsByEntry = entryIds.map((_, entryIndex) =>
        Array.from(
          { length: certificateCase.rosterSize },
          (_unused, memberIndex) =>
            `${prefix}-member-${entryIndex + 1}-${memberIndex + 1}`,
        ),
      );
      const allUserIds = userIdsByEntry.flat();
      const groupedAt = new Date("2026-09-05T08:00:00.000Z");

      try {
        await db.user.createMany({
          data: allUserIds.map((id, index) => ({
            id,
            email: `${id}@example.test`,
            nickname: `Certificate participant ${index + 1}`,
            emailVerifiedAt: groupedAt,
          })),
        });
        await db.match.create({
          data: {
            id: matchId,
            title: `${certificateCase.type} ${certificateCase.format} certificate`,
            dateTime: new Date("2026-09-06T08:00:00.000Z"),
            registrationDeadline: new Date("2026-09-04T08:00:00.000Z"),
            groupingGeneratedAt: groupedAt,
            type: certificateCase.type,
            status:
              certificateCase.format === "group_only" ? "finished" : "ongoing",
            engineVersion: "V2",
            format: certificateCase.format,
            maxParticipants: 2,
            createdBy: userIdsByEntry[0][0],
            ...(certificateCase.type === "team"
              ? {
                  teamRegistrationStart: new Date("2026-09-01T00:00:00.000Z"),
                  teamRegistrationDeadline: new Date("2026-09-04T08:00:00.000Z"),
                  teamMinMembers: 2,
                  teamMaxMembers: 4,
                }
              : {}),
          },
        });
        for (const [entryIndex, entryId] of entryIds.entries()) {
          const users = userIdsByEntry[entryIndex];
          const memberIds = memberIdsByEntry[entryIndex];
          const sourcePrefix = certificateCase.type === "single"
            ? "individual"
            : certificateCase.type === "double"
              ? "doubles"
              : "team";
          await db.matchEntry.create({
            data: {
              id: entryId,
              matchId,
              kind:
                certificateCase.type === "single"
                  ? "INDIVIDUAL"
                  : certificateCase.type === "double"
                    ? "DOUBLES"
                    : "TEAM",
              status: "ACTIVE",
              sourceKey:
                certificateCase.type === "single"
                  ? `individual:${users[0]}`
                  : `${sourcePrefix}:${prefix}-${entryIndex + 1}`,
              ...(certificateCase.type === "single"
                ? { sourceUserId: users[0] }
                : {}),
              displayNameSnapshot: `Entry ${entryIndex + 1}`,
              members: {
                create: users.map((userId, memberIndex) => ({
                  id: memberIds[memberIndex],
                  userId,
                  displayNameSnapshot: `Member ${entryIndex + 1}-${memberIndex + 1}`,
                  role:
                    certificateCase.type === "team" && memberIndex === 0
                      ? ("captain" as const)
                      : ("player" as const),
                  status: "ACTIVE",
                  slot: memberIndex + 1,
                  rosterVersion: 1,
                  effectiveFrom: groupedAt,
                  createdAt: groupedAt,
                })),
              },
            },
          });
        }
        await db.matchGrouping.create({
          data: {
            id: groupingId,
            matchId,
            payload: {},
            v2SchemaVersion: 1,
            seedMethod: "MIN_DIFF",
            standingsPolicyVersion: 1,
            qualifiersPerGroup:
              certificateCase.format === "group_then_knockout" ? 1 : null,
            bracketPolicyVersion:
              certificateCase.format === "group_then_knockout" ? 1 : null,
            createdAt: groupedAt,
          },
        });
        await db.matchGroup.create({
          data: {
            id: groupId,
            matchId,
            groupingId,
            groupKey: "group:0001",
            displayName: "第 1 组",
            position: 1,
            createdAt: groupedAt,
          },
        });
        await db.matchGroupEntry.createMany({
          data: entryIds.map((entryId, entryIndex) => ({
            matchId,
            groupId,
            entryId,
            position: entryIndex + 1,
            globalSeedRank: entryIndex + 1,
            seedElo: 1200,
            seedPoints: 0,
            entryVersion: 0,
            rosterVersion: 1,
            createdAt: groupedAt,
          })),
        });
        await db.matchFixture.create({
          data: {
            id: fixtureId,
            matchId,
            fixtureKey: "group:0001:pair:0001-0002",
            stage: "GROUP",
            status: "COMPLETED",
            groupId,
            groupKey: "group:0001",
            sideAEntryId: entryIds[0],
            sideBEntryId: entryIds[1],
            sideARosterVersion: 1,
            sideBRosterVersion: 1,
            completedAt: groupedAt,
          },
        });
        await db.matchFixtureLineupMember.createMany({
          data: entryIds.flatMap((entryId, entryIndex) =>
            memberIdsByEntry[entryIndex].map((entryMemberId, memberIndex) => ({
              matchId,
              fixtureId,
              entryId,
              entryMemberId,
              side: entryIndex === 0 ? ("SIDE_A" as const) : ("SIDE_B" as const),
              position: memberIndex + 1,
              createdAt: groupedAt,
            })),
          ),
        });
        await db.resultRevision.create({
          data: {
            id: revisionId,
            matchId,
            fixtureId,
            revisionNumber: 1,
            status: "CONFIRMED",
            resolutionKind: "PLAYED",
            winnerEntryId: entryIds[0],
            loserEntryId: entryIds[1],
            score:
              certificateCase.type === "team"
                ? { winnerScore: 3, loserScore: 1 }
                : { bestOf: 3, winnerScore: 2, loserScore: 0 },
            reportedById: userIdsByEntry[0][0],
            verifiedById: userIdsByEntry[1][0],
            resolvedAt: groupedAt,
          },
        });
        await db.settlementEvent.create({
          data: {
            id: settlementId,
            idempotencyKey: `result:${revisionId}:apply`,
            kind: "RESULT_APPLY",
            status: "APPLIED",
            resultRevisionId: revisionId,
            appliedAt: groupedAt,
            effects: {
              create: allUserIds.map((userId) => ({ userId })),
            },
          },
        });

        const service = createV2CertificateApplicationService({
          db,
          generateNumber: () => `PPC-SIX-${randomUUID().slice(0, 8)}`,
          hashIdentity: (value) => `test-hash:${value}`,
          verifyIdentity: (value, hash) => hash === `test-hash:${value}`,
        });
        const command = {
          matchId,
          actorId: userIdsByEntry[0][0],
          fullName: "张三",
          studentId: "PB00000001",
        };
        const first = await service.issue(command);
        const repeated = await service.issue(command);
        assert.equal(first.created, true);
        assert.equal(repeated.created, false);
        assert.equal(first.certificateNo, repeated.certificateNo);
      } finally {
        await db.participationCertificate.deleteMany({ where: { matchId } });
        await db.userIdentity.deleteMany({ where: { userId: { in: allUserIds } } });
        await db.settlementEffect.deleteMany({ where: { eventId: settlementId } });
        await db.settlementEvent.deleteMany({ where: { id: settlementId } });
        await db.resultRevision.deleteMany({ where: { matchId } });
        await db.matchFixtureLineupMember.deleteMany({ where: { matchId } });
        await db.matchFixture.deleteMany({ where: { matchId } });
        await db.matchGroupEntry.deleteMany({ where: { matchId } });
        await db.matchGroup.deleteMany({ where: { matchId } });
        await db.matchGrouping.deleteMany({ where: { matchId } });
        await db.matchEntryMember.deleteMany({ where: { matchId } });
        await db.matchEntry.deleteMany({ where: { matchId } });
        await db.match.deleteMany({ where: { id: matchId } });
        await db.user.deleteMany({ where: { id: { in: allUserIds } } });
        await db.$disconnect();
      }
    },
  );
}
