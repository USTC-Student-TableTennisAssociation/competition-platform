import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;

function isForeignKeyConflict(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003"
  );
}

test(
  "real PostgreSQL rejects cross-match doubles and team source edges",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const ownerId = `source-fk-owner-${suffix}`;
    const memberId = `source-fk-member-${suffix}`;
    const matchAId = `source-fk-match-a-${suffix}`;
    const matchBId = `source-fk-match-b-${suffix}`;
    const doublesTeamId = `source-fk-double-${suffix}`;
    const matchTeamId = `source-fk-team-${suffix}`;

    try {
      const verifiedAt = new Date("2026-09-05T00:00:00.000Z");
      await db.user.createMany({
        data: [
          {
            id: ownerId,
            email: `${ownerId}@example.test`,
            nickname: "Source FK owner",
            emailVerifiedAt: verifiedAt,
          },
          {
            id: memberId,
            email: `${memberId}@example.test`,
            nickname: "Source FK member",
            emailVerifiedAt: verifiedAt,
          },
        ],
      });
      for (const matchId of [matchAId, matchBId]) {
        await db.match.create({
          data: {
            id: matchId,
            title: matchId,
            dateTime: new Date("2027-01-01T00:00:00.000Z"),
            type: "team",
            format: "group_only",
            status: "registration",
            engineVersion: "V2",
            maxParticipants: 999_999,
            createdBy: ownerId,
            registrationDeadline: new Date("2026-12-01T00:00:00.000Z"),
            teamRegistrationStart: new Date("2026-10-01T00:00:00.000Z"),
            teamRegistrationDeadline: new Date("2026-12-01T00:00:00.000Z"),
            teamMinMembers: 2,
            teamMaxMembers: 4,
          },
        });
      }
      await db.matchDoublesTeam.create({
        data: { id: doublesTeamId, matchId: matchAId, createdById: ownerId },
      });
      await db.matchTeam.create({
        data: {
          id: matchTeamId,
          matchId: matchAId,
          captainId: ownerId,
          name: "Source FK team",
          inviteCode: `source-fk-${suffix}`,
        },
      });

      await assert.rejects(
        db.matchDoublesTeamMember.create({
          data: {
            teamId: doublesTeamId,
            matchId: matchBId,
            userId: memberId,
            slot: 1,
          },
        }),
        isForeignKeyConflict,
      );
      await assert.rejects(
        db.matchTeamMember.create({
          data: { teamId: matchTeamId, matchId: matchBId, userId: memberId },
        }),
        isForeignKeyConflict,
      );
      await assert.rejects(
        db.matchEntry.create({
          data: {
            matchId: matchBId,
            kind: "DOUBLES",
            status: "DRAFT",
            sourceKey: `doubles:${doublesTeamId}`,
            sourceDoublesTeamId: doublesTeamId,
            displayNameSnapshot: "Cross-match doubles",
          },
        }),
        isForeignKeyConflict,
      );
      await assert.rejects(
        db.matchEntry.create({
          data: {
            matchId: matchBId,
            kind: "TEAM",
            status: "DRAFT",
            sourceKey: `team:${matchTeamId}`,
            sourceMatchTeamId: matchTeamId,
            displayNameSnapshot: "Cross-match team",
          },
        }),
        isForeignKeyConflict,
      );

      assert.equal(
        await db.matchEntry.count({
          where: { matchId: matchBId, OR: [{ sourceDoublesTeamId: doublesTeamId }, { sourceMatchTeamId: matchTeamId }] },
        }),
        0,
      );
    } finally {
      await db.match.deleteMany({ where: { id: { in: [matchAId, matchBId] } } });
      await db.user.deleteMany({ where: { id: { in: [ownerId, memberId] } } });
      await db.$disconnect();
    }
  },
);
