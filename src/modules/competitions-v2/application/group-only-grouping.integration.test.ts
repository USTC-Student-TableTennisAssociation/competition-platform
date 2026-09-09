import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import {
  createV2GroupOnlyGroupingApplicationService,
  V2_DOUBLE_GROUP_ONLY_GROUPING_PROFILE,
  V2_DOUBLE_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE,
  V2_SINGLE_GROUP_ONLY_GROUPING_PROFILE,
  V2_SINGLE_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE,
  V2_TEAM_GROUP_ONLY_GROUPING_PROFILE,
  V2_TEAM_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE,
  type V2GroupOnlyGroupingProfile,
} from "./group-only-grouping";
import {
  getV2GroupOnlyGroupingReadModel,
  V2_DOUBLE_GROUPING_READ_PROFILE,
  V2_SINGLE_GROUPING_READ_PROFILE,
  V2_TEAM_GROUPING_READ_PROFILE,
  type V2GroupOnlyGroupingReadProfile,
} from "../read-model/group-only-grouping";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;
const publicationTime = new Date("2026-09-05T12:00:00.000Z");

const cases: ReadonlyArray<{
  type: "single" | "double" | "team";
  profile: V2GroupOnlyGroupingProfile;
  groupThenProfile: V2GroupOnlyGroupingProfile;
  readProfile: V2GroupOnlyGroupingReadProfile;
  membersPerEntry: number;
  entryKind: "INDIVIDUAL" | "DOUBLES" | "TEAM";
}> = [
  {
    type: "single",
    profile: V2_SINGLE_GROUP_ONLY_GROUPING_PROFILE,
    groupThenProfile: V2_SINGLE_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE,
    readProfile: V2_SINGLE_GROUPING_READ_PROFILE,
    membersPerEntry: 1,
    entryKind: "INDIVIDUAL",
  },
  {
    type: "double",
    profile: V2_DOUBLE_GROUP_ONLY_GROUPING_PROFILE,
    groupThenProfile: V2_DOUBLE_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE,
    readProfile: V2_DOUBLE_GROUPING_READ_PROFILE,
    membersPerEntry: 2,
    entryKind: "DOUBLES",
  },
  {
    type: "team",
    profile: V2_TEAM_GROUP_ONLY_GROUPING_PROFILE,
    groupThenProfile: V2_TEAM_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE,
    readProfile: V2_TEAM_GROUPING_READ_PROFILE,
    membersPerEntry: 3,
    entryKind: "TEAM",
  },
];

for (const fixtureCase of cases) {
  for (const format of ["group_only", "group_then_knockout"] as const) {
  test(
    `real PostgreSQL atomically publishes and exactly replays ${fixtureCase.type} ${format}`,
    { skip: integrationDatabaseUrl === undefined },
    async () => {
      process.env.DATABASE_URL = integrationDatabaseUrl;
      process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
      const db = new PrismaClient();
      const suffix = randomUUID().replaceAll("-", "");
      const ownerId = `generic-grouping-owner-${fixtureCase.type}-${suffix}`;
      const matchId = `generic-grouping-match-${fixtureCase.type}-${suffix}`;
      const participantIds = Array.from(
        { length: fixtureCase.membersPerEntry * 2 },
        (_, index) => `generic-grouping-player-${fixtureCase.type}-${index + 1}-${suffix}`,
      );

      try {
        const verifiedAt = new Date("2026-01-01T00:00:00.000Z");
        await db.user.createMany({
          data: [
            {
              id: ownerId,
              email: `${ownerId}@example.test`,
              nickname: "Grouping owner",
              emailVerifiedAt: verifiedAt,
            },
            ...participantIds.map((id, index) => ({
              id,
              email: `${id}@example.test`,
              nickname: `Player ${index + 1}`,
              emailVerifiedAt: verifiedAt,
              eloRating:
                1100 + Math.floor(index / fixtureCase.membersPerEntry) * 100 +
                (index % fixtureCase.membersPerEntry),
              points:
                10 + Math.floor(index / fixtureCase.membersPerEntry) * 10 +
                (index % fixtureCase.membersPerEntry),
            })),
          ],
        });
        await db.match.create({
          data: {
            id: matchId,
            title: `Generic ${fixtureCase.type} grouping`,
            dateTime: new Date("2026-10-01T10:00:00.000Z"),
            type: fixtureCase.type,
            status: "registration",
            engineVersion: "V2",
            format,
            maxParticipants: 2,
            createdBy: ownerId,
            registrationDeadline: new Date("2026-09-01T00:00:00.000Z"),
            ...(fixtureCase.type === "team"
              ? {
                  teamRegistrationStart: new Date("2026-08-01T00:00:00.000Z"),
                  teamRegistrationDeadline: new Date("2026-09-02T00:00:00.000Z"),
                  teamMinMembers: 2,
                  teamMaxMembers: 4,
                }
              : {}),
          },
        });

        const entries: Array<{ id: string; version: number }> = [];
        for (let entryIndex = 0; entryIndex < 2; entryIndex += 1) {
          const entryId = `generic-entry-${entryIndex + 1}-${suffix}`;
          const roster = participantIds.slice(
            entryIndex * fixtureCase.membersPerEntry,
            (entryIndex + 1) * fixtureCase.membersPerEntry,
          );
          let sourceKey: string;
          let sourceUserId: string | undefined;
          let sourceDoublesTeamId: string | undefined;
          let sourceMatchTeamId: string | undefined;

          if (fixtureCase.type === "single") {
            sourceUserId = roster[0];
            sourceKey = `individual:${sourceUserId}`;
          } else if (fixtureCase.type === "double") {
            sourceDoublesTeamId = `generic-doubles-${entryIndex + 1}-${suffix}`;
            sourceKey = `doubles:${sourceDoublesTeamId}`;
            await db.matchDoublesTeam.create({
              data: {
                id: sourceDoublesTeamId,
                matchId,
                createdById: roster[0],
                members: {
                  create: roster.map((userId, index) => ({
                    userId,
                    slot: index + 1,
                  })),
                },
              },
            });
          } else {
            sourceMatchTeamId = `generic-team-${entryIndex + 1}-${suffix}`;
            sourceKey = `team:${sourceMatchTeamId}`;
            await db.matchTeam.create({
              data: {
                id: sourceMatchTeamId,
                matchId,
                captainId: roster[0],
                name: `Team ${entryIndex + 1}`,
                inviteCode: `generic-invite-${entryIndex + 1}-${suffix}`,
                status: "approved",
                submittedAt: new Date("2026-08-20T00:00:00.000Z"),
                reviewedAt: new Date("2026-08-21T00:00:00.000Z"),
                reviewedById: ownerId,
                members: {
                  create: roster.map((userId) => ({ userId })),
                },
              },
            });
          }

          const entry = await db.matchEntry.create({
            data: {
              id: entryId,
              matchId,
              kind: fixtureCase.entryKind,
              status: "ACTIVE",
              sourceKey,
              sourceUserId,
              sourceDoublesTeamId,
              sourceMatchTeamId,
              displayNameSnapshot:
                fixtureCase.type === "single"
                  ? `Player ${entryIndex + 1}`
                  : `${fixtureCase.type} competitor ${entryIndex + 1}`,
              members: {
                create: roster.map((userId, index) => ({
                  userId,
                  displayNameSnapshot: `Player ${entryIndex * fixtureCase.membersPerEntry + index + 1}`,
                  role:
                    fixtureCase.type === "team" && index === 0
                      ? "captain"
                      : "player",
                  status: "ACTIVE",
                  slot: index + 1,
                  rosterVersion: 1,
                })),
              },
            },
            select: { id: true, version: true },
          });
          entries.push(entry);
        }

        const service = createV2GroupOnlyGroupingApplicationService(
          { db, clock: () => publicationTime },
          format === "group_then_knockout"
            ? fixtureCase.groupThenProfile
            : fixtureCase.profile,
        );
        const publish = () =>
          service.publish({
            actor: { id: ownerId, role: "user" },
            matchId,
            expectedEntries: entries.map((entry) => ({
              entryId: entry.id,
              version: entry.version,
            })),
            draft: {
              format,
              ...(format === "group_then_knockout"
                ? { qualifiersPerGroup: 2 }
                : {}),
              seedMethod: "snake",
              groups: [{ entryIds: entries.map((entry) => entry.id) }],
            },
          });

        const first = await publish();
        assert.equal(first.created, true);
        const grouping = await db.matchGrouping.findUniqueOrThrow({
          where: { matchId },
          include: {
            groups: {
              include: {
                entries: { orderBy: { position: "asc" } },
                fixtures: { include: { lineupMembers: true } },
              },
            },
          },
        });
        assert.equal(grouping.v2SchemaVersion, 1);
        assert.equal(grouping.seedMethod, "SNAKE");
        assert.equal(grouping.standingsPolicyVersion, 1);
        assert.equal(
          grouping.qualifiersPerGroup,
          format === "group_then_knockout" ? 2 : null,
        );
        assert.equal(
          grouping.bracketPolicyVersion,
          format === "group_then_knockout" ? 1 : null,
        );
        assert.equal(grouping.groups.length, 1);
        assert.equal(grouping.groups[0].entries.length, 2);
        assert.equal(grouping.groups[0].fixtures.length, 1);
        assert.equal(
          grouping.groups[0].fixtures[0].lineupMembers.length,
          fixtureCase.membersPerEntry * 2,
        );
        assert.equal(
          grouping.groups[0].fixtures[0].groupId,
          grouping.groups[0].id,
        );
        const readModel = await getV2GroupOnlyGroupingReadModel(
          db,
          matchId,
          fixtureCase.readProfile,
        );
        assert.equal(
          readModel.kind,
          format === "group_then_knockout"
            ? "GROUP_THEN_KNOCKOUT_V2_MATCH"
            : "GROUP_ONLY_V2_MATCH",
        );
        if (
          readModel.kind !== "GROUP_ONLY_V2_MATCH" &&
          readModel.kind !== "GROUP_THEN_KNOCKOUT_V2_MATCH"
        ) {
          assert.fail("published relational grouping was not readable");
        }
        assert.equal(readModel.published, true);
        assert.equal(readModel.groups.length, 1);
        assert.equal(readModel.groups[0].entries.length, 2);
        assert.equal(readModel.groups[0].fixtures.length, 1);
        assert.equal(
          readModel.groups[0].fixtures[0].sideA.members.length,
          fixtureCase.membersPerEntry,
        );
        assert.equal(
          readModel.groups[0].fixtures[0].sideB.members.length,
          fixtureCase.membersPerEntry,
        );
        if (fixtureCase.type === "double") {
          assert.equal(await db.registration.count({ where: { matchId } }), 0);
          assert.equal(
            await db.matchDoublesTeam.count({
              where: { matchId, registeredAt: { not: null } },
            }),
            0,
          );
        }

        await db.user.updateMany({
          where: { id: { in: participantIds } },
          data: { eloRating: { increment: 25 }, points: { increment: 1 } },
        });
        const fixture = grouping.groups[0].fixtures[0];
        await db.matchFixture.update({
          where: { id: fixture.id },
          data: {
            metadata: {
              ...(fixture.metadata as Record<string, unknown>),
              v2Display: { schemaVersion: 1, tableLabels: ["1 号台"] },
            },
          },
        });

        const retry = await publish();
        assert.equal(retry.created, false);
        assert.equal(retry.publishedAt.toISOString(), first.publishedAt.toISOString());
        assert.equal(await db.matchGrouping.count({ where: { matchId } }), 1);
        assert.equal(await db.matchGroup.count({ where: { matchId } }), 1);
        assert.equal(await db.matchGroupEntry.count({ where: { matchId } }), 2);
        assert.equal(await db.matchFixture.count({ where: { matchId } }), 1);
        assert.equal(
          await db.matchFixtureLineupMember.count({ where: { matchId } }),
          fixtureCase.membersPerEntry * 2,
        );
        assert.equal(
          await db.auditLog.count({
            where: {
              entityId: matchId,
              action:
                format === "group_then_knockout"
                  ? fixtureCase.groupThenProfile.auditAction
                  : fixtureCase.profile.auditAction,
            },
          }),
          1,
        );
      } finally {
        await db.$disconnect();
      }
    },
  );
  }
}
