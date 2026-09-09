import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PrismaClient } from "@prisma/client";

import { createV2QualificationAndKnockoutPublicationApplicationService } from "./qualification-and-knockout-publication";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;
const groupedAt = new Date("2026-09-04T12:00:00.000Z");
const publishedAt = new Date("2026-09-05T12:00:00.000Z");

const cases = [
  {
    type: "single" as const,
    entryKind: "INDIVIDUAL" as const,
    membersPerEntry: 1,
    publishAuditAction: "v2_single_knockout_publish",
  },
  {
    type: "double" as const,
    entryKind: "DOUBLES" as const,
    membersPerEntry: 2,
    publishAuditAction: "v2_double_knockout_publish",
  },
  {
    type: "team" as const,
    entryKind: "TEAM" as const,
    membersPerEntry: 3,
    publishAuditAction: "v2_team_knockout_publish",
  },
];

type FixtureCase = (typeof cases)[number];

async function seedQualificationReadyMatch(
  db: PrismaClient,
  label: string,
  fixtureCase: FixtureCase,
) {
  const suffix = `${fixtureCase.type}-${label}-${randomUUID().replaceAll("-", "")}`;
  const ownerId = `atomic-owner-${suffix}`;
  const matchId = `atomic-match-${suffix}`;
  const groupingId = `atomic-grouping-${suffix}`;
  const entryIds = Array.from(
    { length: 4 },
    (_, index) => `atomic-entry-${index + 1}-${suffix}`,
  );
  const participantIds = Array.from(
    { length: entryIds.length * fixtureCase.membersPerEntry },
    (_, index) => `atomic-player-${index + 1}-${suffix}`,
  );
  const groupIds = [
    `atomic-group-1-${suffix}`,
    `atomic-group-2-${suffix}`,
  ];
  const memberIdsByEntry: string[][] = [];

  await db.user.createMany({
    data: [
      {
        id: ownerId,
        email: `${ownerId}@example.test`,
        nickname: "Atomic owner",
        emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      ...participantIds.map((id, index) => ({
        id,
        email: `${id}@example.test`,
        nickname: `Atomic player ${index + 1}`,
        emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
      })),
    ],
  });
  await db.match.create({
    data: {
      id: matchId,
      title: `Atomic ${fixtureCase.type} qualification publication ${label}`,
      dateTime: new Date("2026-09-10T12:00:00.000Z"),
      type: fixtureCase.type,
      status: "ongoing",
      engineVersion: "V2",
      format: "group_then_knockout",
      maxParticipants: 4,
      createdBy: ownerId,
      registrationDeadline: new Date("2026-09-01T00:00:00.000Z"),
      groupingGeneratedAt: groupedAt,
      ...(fixtureCase.type === "team"
        ? {
            teamRegistrationStart: new Date("2026-08-01T00:00:00.000Z"),
            teamRegistrationDeadline: new Date("2026-09-01T00:00:00.000Z"),
            teamMinMembers: 2,
            teamMaxMembers: 4,
          }
        : {}),
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

  for (let entryIndex = 0; entryIndex < entryIds.length; entryIndex += 1) {
    const roster = participantIds.slice(
      entryIndex * fixtureCase.membersPerEntry,
      (entryIndex + 1) * fixtureCase.membersPerEntry,
    );
    const memberIds = roster.map(
      (_, memberIndex) =>
        `atomic-member-${entryIndex + 1}-${memberIndex + 1}-${suffix}`,
    );
    memberIdsByEntry.push(memberIds);
    await db.matchEntry.create({
      data: {
        id: entryIds[entryIndex],
        matchId,
        kind: fixtureCase.entryKind,
        status: "ACTIVE",
        sourceKey:
          fixtureCase.type === "single"
            ? `individual:${roster[0]}`
            : fixtureCase.type === "double"
              ? `doubles:archived-${entryIndex + 1}-${suffix}`
              : `team:archived-${entryIndex + 1}-${suffix}`,
        ...(fixtureCase.type === "single" ? { sourceUserId: roster[0] } : {}),
        displayNameSnapshot: `Atomic ${fixtureCase.type} entry ${entryIndex + 1}`,
        createdAt: groupedAt,
        members: {
          create: roster.map((userId, memberIndex) => ({
            id: memberIds[memberIndex],
            userId,
            displayNameSnapshot: `Atomic player ${entryIndex + 1}-${memberIndex + 1}`,
            role:
              fixtureCase.type === "team" && memberIndex === 0
                ? "captain"
                : "player",
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

  for (let groupIndex = 0; groupIndex < groupIds.length; groupIndex += 1) {
    await db.matchGroup.create({
      data: {
        id: groupIds[groupIndex],
        matchId,
        groupingId,
        groupKey: `group:${String(groupIndex + 1).padStart(4, "0")}`,
        displayName: `第 ${groupIndex + 1} 组`,
        position: groupIndex + 1,
        createdAt: groupedAt,
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
      createdAt: groupedAt,
    })),
  });

  for (let groupIndex = 0; groupIndex < groupIds.length; groupIndex += 1) {
    const leftIndex = groupIndex * 2;
    const rightIndex = leftIndex + 1;
    const fixtureId = `atomic-group-fixture-${groupIndex + 1}-${suffix}`;
    const resolvedAt = new Date(
      `2026-09-05T0${groupIndex + 8}:00:00.000Z`,
    );
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
        completedAt: resolvedAt,
        createdAt: groupedAt,
        updatedAt: resolvedAt,
      },
    });
    await db.matchFixtureLineupMember.createMany({
      data: [leftIndex, rightIndex].flatMap((entryIndex, sideIndex) =>
        memberIdsByEntry[entryIndex].map((entryMemberId, memberIndex) => ({
          matchId,
          fixtureId,
          entryId: entryIds[entryIndex],
          entryMemberId,
          side: sideIndex === 0 ? ("SIDE_A" as const) : ("SIDE_B" as const),
          position: memberIndex + 1,
          createdAt: groupedAt,
        })),
      ),
    });
    await db.resultRevision.create({
      data: {
        id: `atomic-result-${groupIndex + 1}-${suffix}`,
        matchId,
        fixtureId,
        revisionNumber: 1,
        status: "CONFIRMED",
        resolutionKind: "FORFEIT",
        winnerEntryId: entryIds[leftIndex],
        loserEntryId: entryIds[rightIndex],
        score: { winnerScore: 1, loserScore: 0 },
        reportedById: ownerId,
        verifiedById: ownerId,
        reason: "atomic qualification fixture",
        resolvedAt,
        createdAt: resolvedAt,
        updatedAt: resolvedAt,
      },
    });
  }

  return { ownerId, matchId };
}

async function publicationCounts(
  db: PrismaClient,
  matchId: string,
  publishAuditAction: string,
) {
  const knockoutFixtures = await db.matchFixture.findMany({
    where: { matchId, stage: "KNOCKOUT" },
    select: { id: true },
  });
  const fixtureIds = knockoutFixtures.map((fixture) => fixture.id);
  return {
    snapshots: await db.matchQualificationSnapshot.count({ where: { matchId } }),
    standings: await db.matchQualificationStanding.count({ where: { matchId } }),
    freezeAudits: await db.auditLog.count({
      where: { entityId: matchId, action: "v2_qualification_snapshot_freeze" },
    }),
    knockoutFixtures: knockoutFixtures.length,
    dependencies: await db.matchFixtureDependency.count({ where: { matchId } }),
    knockoutLineups:
      fixtureIds.length === 0
        ? 0
        : await db.matchFixtureLineupMember.count({
            where: { matchId, fixtureId: { in: fixtureIds } },
          }),
    publishAudits: await db.auditLog.count({
      where: { entityId: matchId, action: publishAuditAction },
    }),
  };
}

for (const fixtureCase of cases) {
  test(
    `real PostgreSQL atomically freezes and publishes ${fixtureCase.type}, replays, and rolls back`,
    { skip: integrationDatabaseUrl === undefined },
    async () => {
      process.env.DATABASE_URL = integrationDatabaseUrl;
      process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
      const db = new PrismaClient();
      try {
        const success = await seedQualificationReadyMatch(
          db,
          "success",
          fixtureCase,
        );
        const service =
          createV2QualificationAndKnockoutPublicationApplicationService({
            db,
            clock: () => publishedAt,
          });
        const command = {
          actor: { id: success.ownerId, role: "user" as const },
          matchId: success.matchId,
        };
        const expectedCounts = {
          snapshots: 1,
          standings: 4,
          freezeAudits: 1,
          knockoutFixtures: 3,
          dependencies: 6,
          knockoutLineups: fixtureCase.membersPerEntry * 4,
          publishAudits: 1,
        };

        const first = await service.freezeAndPublish(command);
        assert.equal(first.qualification.created, true);
        assert.equal(first.knockout.created, true);
        assert.equal(first.qualification.frozenAt.getTime(), publishedAt.getTime());
        assert.equal(first.knockout.publishedAt.getTime(), publishedAt.getTime());
        assert.equal(
          first.knockout.qualificationSnapshotId,
          first.qualification.snapshotId,
        );
        assert.equal(
          first.knockout.sourceRevisionFingerprint,
          first.qualification.sourceRevisionFingerprint,
        );
        assert.deepEqual(
          await publicationCounts(
            db,
            success.matchId,
            fixtureCase.publishAuditAction,
          ),
          expectedCounts,
        );

        const retry = await service.freezeAndPublish(command);
        assert.equal(retry.qualification.created, false);
        assert.equal(retry.knockout.created, false);
        assert.equal(retry.qualification.snapshotId, first.qualification.snapshotId);
        assert.deepEqual(
          await publicationCounts(
            db,
            success.matchId,
            fixtureCase.publishAuditAction,
          ),
          expectedCounts,
        );

        const failure = await seedQualificationReadyMatch(
          db,
          "failure",
          fixtureCase,
        );
        const failingService =
          createV2QualificationAndKnockoutPublicationApplicationService({
            db,
            clock: () => publishedAt,
            internal: {
              knockoutHooks: {
                afterFixturesCreated: () => {
                  throw new Error("injected PostgreSQL publication failure");
                },
              },
            },
          });
        await assert.rejects(
          failingService.freezeAndPublish({
            actor: { id: failure.ownerId, role: "user" },
            matchId: failure.matchId,
          }),
          /injected PostgreSQL publication failure/,
        );
        assert.deepEqual(
          await publicationCounts(
            db,
            failure.matchId,
            fixtureCase.publishAuditAction,
          ),
          {
            snapshots: 0,
            standings: 0,
            freezeAudits: 0,
            knockoutFixtures: 0,
            dependencies: 0,
            knockoutLineups: 0,
            publishAudits: 0,
          },
        );
      } finally {
        await db.$disconnect();
      }
    },
  );
}
