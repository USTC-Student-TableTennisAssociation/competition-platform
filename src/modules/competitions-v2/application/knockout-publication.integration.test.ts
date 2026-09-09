import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PrismaClient } from "@prisma/client";

import { V2CompetitionApplicationError } from "./entries";
import { createV2KnockoutPublicationApplicationService } from "./knockout-publication";
import { createV2KnockoutTableLabelsApplicationService } from "./knockout-table-labels";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;
const groupedAt = new Date("2026-09-05T08:00:00.000Z");
const frozenAt = new Date("2026-09-05T10:00:00.000Z");
const bracketPublishedAt = new Date("2026-09-05T12:00:00.000Z");

const cases = [
  {
    type: "single" as const,
    entryKind: "INDIVIDUAL" as const,
    membersPerEntry: 1,
    auditAction: "v2_single_knockout_publish",
  },
  {
    type: "double" as const,
    entryKind: "DOUBLES" as const,
    membersPerEntry: 2,
    auditAction: "v2_double_knockout_publish",
  },
  {
    type: "team" as const,
    entryKind: "TEAM" as const,
    membersPerEntry: 3,
    auditAction: "v2_team_knockout_publish",
  },
];

for (const fixtureCase of cases) {
  test(
    `real PostgreSQL publishes one relational ${fixtureCase.type} knockout graph`,
    { skip: integrationDatabaseUrl === undefined },
    async () => {
      process.env.DATABASE_URL = integrationDatabaseUrl;
      process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
      const db = new PrismaClient();
      const suffix = randomUUID().replaceAll("-", "");
      const ownerId = `ko-owner-${fixtureCase.type}-${suffix}`;
      const matchId = `ko-match-${fixtureCase.type}-${suffix}`;
      const groupingId = `ko-grouping-${fixtureCase.type}-${suffix}`;
      const snapshotId = `ko-snapshot-${fixtureCase.type}-${suffix}`;
      const fingerprint = suffix.padEnd(64, "a").slice(0, 64);
      const entryIds = Array.from(
        { length: 4 },
        (_, index) => `ko-entry-${fixtureCase.type}-${index + 1}-${suffix}`,
      );
      const participantIds = Array.from(
        { length: entryIds.length * fixtureCase.membersPerEntry },
        (_, index) => `ko-user-${fixtureCase.type}-${index + 1}-${suffix}`,
      );
      const groupIds = [
        `ko-group-${fixtureCase.type}-1-${suffix}`,
        `ko-group-${fixtureCase.type}-2-${suffix}`,
      ];
      const memberIdsByEntry: string[][] = [];

      try {
        const verifiedAt = new Date("2026-01-01T00:00:00.000Z");
        await db.user.createMany({
          data: [
            {
              id: ownerId,
              email: `${ownerId}@example.test`,
              nickname: "Knockout owner",
              emailVerifiedAt: verifiedAt,
            },
            ...participantIds.map((id, index) => ({
              id,
              email: `${id}@example.test`,
              nickname: `Knockout player ${index + 1}`,
              emailVerifiedAt: verifiedAt,
            })),
          ],
        });
        await db.match.create({
          data: {
            id: matchId,
            title: `${fixtureCase.type} knockout integration`,
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
              `ko-member-${fixtureCase.type}-${entryIndex + 1}-${memberIndex + 1}-${suffix}`,
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
              ...(fixtureCase.type === "single"
                ? { sourceUserId: roster[0] }
                : {}),
              displayNameSnapshot: `Entry ${entryIndex + 1}`,
              createdAt: groupedAt,
              members: {
                create: roster.map((userId, memberIndex) => ({
                  id: memberIds[memberIndex],
                  userId,
                  displayNameSnapshot: `Player ${entryIndex + 1}-${memberIndex + 1}`,
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

        for (let groupIndex = 0; groupIndex < groupIds.length; groupIndex += 1) {
          const sideAIndex = groupIndex;
          const sideBIndex = groupIndex + 2;
          const fixtureId = `ko-group-fixture-${fixtureCase.type}-${groupIndex + 1}-${suffix}`;
          await db.matchFixture.create({
            data: {
              id: fixtureId,
              matchId,
              fixtureKey: `group:${String(groupIndex + 1).padStart(4, "0")}:pair:0001-0002`,
              stage: "GROUP",
              status: "COMPLETED",
              groupId: groupIds[groupIndex],
              groupKey: `group:${String(groupIndex + 1).padStart(4, "0")}`,
              sideAEntryId: entryIds[sideAIndex],
              sideBEntryId: entryIds[sideBIndex],
              sideARosterVersion: 1,
              sideBRosterVersion: 1,
              completedAt: frozenAt,
              createdAt: groupedAt,
              updatedAt: frozenAt,
            },
          });
          await db.matchFixtureLineupMember.createMany({
            data: [sideAIndex, sideBIndex].flatMap((entryIndex, sideIndex) =>
              memberIdsByEntry[entryIndex].map((memberId, memberIndex) => ({
                matchId,
                fixtureId,
                entryId: entryIds[entryIndex],
                entryMemberId: memberId,
                side: sideIndex === 0 ? ("SIDE_A" as const) : ("SIDE_B" as const),
                position: memberIndex + 1,
                createdAt: groupedAt,
              })),
            ),
          });
          await db.resultRevision.create({
            data: {
              id: `ko-group-result-${fixtureCase.type}-${groupIndex + 1}-${suffix}`,
              matchId,
              fixtureId,
              revisionNumber: 1,
              status: "CONFIRMED",
              resolutionKind: "FORFEIT",
              winnerEntryId: entryIds[sideAIndex],
              loserEntryId: entryIds[sideBIndex],
              score: { winnerScore: 1, loserScore: 0 },
              reportedById: ownerId,
              verifiedById: ownerId,
              reason: "integration qualification",
              resolvedAt: frozenAt,
              createdAt: frozenAt,
              updatedAt: frozenAt,
            },
          });
        }

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
        const qualificationOrders = [1, 2, 3, 4];
        await db.matchQualificationStanding.createMany({
          data: entryIds.map((entryId, index) => {
            const won = index < 2;
            return {
              id: `ko-standing-${fixtureCase.type}-${index + 1}-${suffix}`,
              matchId,
              snapshotId,
              groupId: groupIds[index % 2],
              entryId,
              rank: Math.floor(index / 2) + 1,
              played: 1,
              wins: won ? 1 : 0,
              losses: won ? 0 : 1,
              scoreFor: won ? 1 : 0,
              scoreAgainst: won ? 0 : 1,
              scoreDifferential: won ? 1 : -1,
              qualified: true,
              qualificationOrder: qualificationOrders[index],
              createdAt: frozenAt,
            };
          }),
        });

        const service = createV2KnockoutPublicationApplicationService({
          db,
          clock: () => bracketPublishedAt,
        });
        const publish = () =>
          service.publish({
            actor: { id: ownerId, role: "user" },
            matchId,
            expectedQualificationSnapshotId: snapshotId,
            expectedSourceRevisionFingerprint: fingerprint,
          });

        const first = await publish();
        assert.equal(first.created, true);
        assert.equal(first.qualificationCount, 4);
        assert.equal(first.roundCount, 2);
        assert.equal(first.fixtureCount, 3);

        const knockoutFixtures = await db.matchFixture.findMany({
          where: { matchId, stage: "KNOCKOUT" },
          orderBy: [{ roundNumber: "asc" }, { position: "asc" }],
          include: {
            lineupMembers: true,
            incomingDependencies: {
              include: {
                sourceFixture: true,
                sourceQualificationStanding: true,
              },
            },
          },
        });
        assert.equal(knockoutFixtures.length, 3);
        const firstRound = knockoutFixtures.filter(
          (fixture) => fixture.roundNumber === 1,
        );
        assert.equal(firstRound.length, 2);
        assert.ok(firstRound.every((fixture) => fixture.status === "READY"));
        assert.ok(
          firstRound.every(
            (fixture) =>
              fixture.sideAEntryId !== null &&
              fixture.sideBEntryId !== null &&
              fixture.lineupMembers.length === fixtureCase.membersPerEntry * 2 &&
              fixture.incomingDependencies.length === 2 &&
              fixture.incomingDependencies.every(
                (dependency) =>
                  dependency.sourceFixtureId === null &&
                  dependency.sourceOutcome === null &&
                  dependency.sourceQualificationStanding !== null,
              ),
          ),
        );
        const final = knockoutFixtures.find((fixture) => fixture.roundNumber === 2)!;
        assert.equal(final.status, "SCHEDULED");
        assert.equal(final.sideAEntryId, null);
        assert.equal(final.sideBEntryId, null);
        assert.equal(final.sideARosterVersion, null);
        assert.equal(final.sideBRosterVersion, null);
        assert.equal(final.lineupMembers.length, 0);
        assert.equal(final.incomingDependencies.length, 2);
        assert.ok(
          final.incomingDependencies.every(
            (dependency) =>
              dependency.sourceFixture !== null &&
              dependency.sourceOutcome === "WINNER" &&
              dependency.sourceQualificationStandingId === null,
          ),
        );
        assert.equal(
          await db.matchFixtureDependency.count({ where: { matchId } }),
          6,
        );
        assert.equal(
          await db.matchFixtureLineupMember.count({
            where: { fixture: { matchId, stage: "KNOCKOUT" } },
          }),
          fixtureCase.membersPerEntry * 4,
        );

        const labelService = createV2KnockoutTableLabelsApplicationService({ db });
        const labelledFixture = firstRound[0]!;
        const labelUpdate = await labelService.update({
          actor: { id: ownerId, role: "user" },
          matchId,
          fixtureId: labelledFixture.id,
          expectedFixtureVersion: labelledFixture.version,
          labels: ["3 号台", "西区馆"],
        });
        assert.equal(labelUpdate.changed, true);
        assert.equal(labelUpdate.fixtureVersion, labelledFixture.version + 1);
        assert.deepEqual(labelUpdate.labels, ["3 号台", "西区馆"]);
        assert.deepEqual(
          await db.matchFixture.findUnique({
            where: { id: labelledFixture.id },
            select: { version: true, metadata: true },
          }),
          {
            version: labelledFixture.version + 1,
            metadata: {
              ...(labelledFixture.metadata as Record<string, unknown>),
              v2Display: {
                schemaVersion: 1,
                tableLabels: ["3 号台", "西区馆"],
              },
            },
          },
        );
        assert.equal(
          await db.auditLog.count({
            where: {
              entityId: labelledFixture.id,
              action: `v2_${fixtureCase.type}_knockout_table_labels_update`,
            },
          }),
          1,
        );
        const sameLabels = await labelService.update({
          actor: { id: ownerId, role: "user" },
          matchId,
          fixtureId: labelledFixture.id,
          expectedFixtureVersion: labelUpdate.fixtureVersion,
          labels: ["3 号台", "西区馆"],
        });
        assert.equal(sameLabels.changed, false);
        assert.equal(sameLabels.fixtureVersion, labelUpdate.fixtureVersion);
        await assert.rejects(
          labelService.update({
            actor: { id: participantIds[0]!, role: "user" },
            matchId,
            fixtureId: labelledFixture.id,
            expectedFixtureVersion: labelUpdate.fixtureVersion,
            labels: ["越权修改"],
          }),
          (error: unknown) =>
            error instanceof V2CompetitionApplicationError &&
            error.code === "FORBIDDEN",
        );
        await assert.rejects(
          labelService.update({
            actor: { id: ownerId, role: "user" },
            matchId,
            fixtureId: labelledFixture.id,
            expectedFixtureVersion: labelledFixture.version,
            labels: ["陈旧版本"],
          }),
          (error: unknown) =>
            error instanceof V2CompetitionApplicationError &&
            error.code === "FIXTURE_VERSION_CONFLICT",
        );

        const retry = await publish();
        assert.equal(retry.created, false);
        assert.equal(retry.publishedAt.toISOString(), first.publishedAt.toISOString());
        assert.equal(
          await db.auditLog.count({
            where: { entityId: matchId, action: fixtureCase.auditAction },
          }),
          1,
        );
      } finally {
        await db.$disconnect();
      }
    },
  );
}
