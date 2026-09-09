import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import { createV2MatchSettingsApplicationService } from "./match-settings";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;

test(
  "a real PostgreSQL TEAM group-then settings save synchronizes both deadlines and audits once",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const actorId = `settings-owner-${suffix}`;
    const matchId = `settings-match-${suffix}`;
    const requestKey = randomUUID();
    const requestFingerprint = "a".repeat(64);
    const createdAt = new Date("2026-09-01T00:00:00.000Z");
    const dateTime = new Date("2026-10-01T11:00:00.000Z");
    const registrationDeadline = new Date("2026-09-30T11:00:00.000Z");
    const teamRegistrationStart = new Date("2026-09-01T08:00:00.000Z");

    try {
      await db.user.create({
        data: {
          id: actorId,
          email: `${actorId}@example.test`,
          nickname: "V2 settings owner",
          emailVerifiedAt: createdAt,
        },
      });
      await db.match.create({
        data: {
          id: matchId,
          title: "Original settings title",
          description: "Original description",
          location: "西区乒乓球馆",
          dateTime,
          type: "team",
          status: "registration",
          engineVersion: "V2",
          creationRequestKey: requestKey,
          creationRequestFingerprint: requestFingerprint,
          format: "group_then_knockout",
          maxParticipants: 2_147_483_647,
          createdBy: actorId,
          registrationDeadline,
          teamRegistrationStart,
          teamRegistrationDeadline: registrationDeadline,
          teamMinMembers: 3,
          teamMaxMembers: 6,
          rule: { note: "immutable TEAM policy" },
          createdAt,
        },
      });
      const before = await db.match.findUniqueOrThrow({ where: { id: matchId } });
      const service = createV2MatchSettingsApplicationService({
        db,
        clock: () => new Date("2026-09-05T08:00:00.000Z"),
      });
      const command = {
        actor: { id: actorId, role: "user" as const },
        matchId,
        expectedUpdatedAt: before.updatedAt,
        title: "Updated settings title",
        description: null,
        location: "东区乒乓球馆",
        dateTime: new Date("2026-10-03T11:00:00.000Z"),
        registrationDeadline: new Date("2026-10-02T11:00:00.000Z"),
      };

      const saved = await service.update(command);
      const retried = await service.update(command);
      assert.equal(saved.changed, true);
      assert.equal(retried.changed, false);
      assert.equal(retried.updatedAt.toISOString(), saved.updatedAt.toISOString());

      const after = await db.match.findUniqueOrThrow({ where: { id: matchId } });
      assert.equal(after.title, command.title);
      assert.equal(after.description, null);
      assert.equal(after.location, command.location);
      assert.equal(after.dateTime.toISOString(), command.dateTime.toISOString());
      assert.equal(
        after.registrationDeadline.toISOString(),
        command.registrationDeadline.toISOString(),
      );
      assert.equal(after.type, "team");
      assert.equal(after.format, "group_then_knockout");
      assert.equal(after.status, "registration");
      assert.equal(after.engineVersion, "V2");
      assert.equal(after.isQuickMatch, false);
      assert.equal(after.maxParticipants, before.maxParticipants);
      assert.equal(after.createdBy, actorId);
      assert.equal(after.creationRequestKey, requestKey);
      assert.equal(after.creationRequestFingerprint, requestFingerprint);
      assert.equal(after.groupingGeneratedAt, null);
      assert.equal(
        after.teamRegistrationStart?.toISOString(),
        teamRegistrationStart.toISOString(),
      );
      assert.equal(
        after.teamRegistrationDeadline?.toISOString(),
        command.registrationDeadline.toISOString(),
      );
      assert.equal(
        after.teamRegistrationDeadline?.toISOString(),
        after.registrationDeadline.toISOString(),
      );
      assert.equal(after.teamMinMembers, 3);
      assert.equal(after.teamMaxMembers, 6);
      assert.deepEqual(after.rule, { note: "immutable TEAM policy" });
      assert.equal(
        await db.matchGrouping.count({ where: { matchId } }),
        0,
      );
      assert.equal(await db.matchFixture.count({ where: { matchId } }), 0);
      assert.equal(await db.matchEntry.count({ where: { matchId } }), 0);
      assert.equal(
        await db.registration.count({ where: { matchId } }),
        0,
      );
      assert.equal(
        await db.auditLog.count({
          where: {
            actorId,
            entityId: matchId,
            entityType: "Match",
            action: "v2_match_settings_update",
          },
        }),
        1,
      );
    } finally {
      await db.auditLog.deleteMany({ where: { actorId } });
      await db.match.deleteMany({ where: { id: matchId } });
      await db.user.deleteMany({ where: { id: actorId } });
      await db.$disconnect();
    }
  },
);
