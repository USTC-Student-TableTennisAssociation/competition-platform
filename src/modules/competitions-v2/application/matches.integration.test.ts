import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import { V2CompetitionApplicationError } from "./entries";
import {
  V2_SINGLE_MATCH_UNLIMITED_PARTICIPANTS,
  createV2SingleMatchApplicationService,
} from "./matches";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;

test(
  "a real PostgreSQL transaction creates an audited V2 match without implicit registration",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const actorId = `match-create-actor-${suffix}`;

    try {
      await db.user.create({
        data: {
          id: actorId,
          email: `${actorId}@example.test`,
          nickname: "V2 match creator",
          emailVerifiedAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      });

      const invalidIdentityBase = {
        title: "Invalid V2 request identity",
        description: null,
        location: "West Campus Gym",
        dateTime: new Date("2026-10-01T11:00:00.000Z"),
        registrationDeadline: new Date("2026-09-30T11:00:00.000Z"),
        type: "single" as const,
        format: "group_only" as const,
        maxParticipants: V2_SINGLE_MATCH_UNLIMITED_PARTICIPANTS,
        status: "registration" as const,
        isQuickMatch: false,
        createdBy: actorId,
      };
      await assert.rejects(
        db.match.create({
          data: {
            ...invalidIdentityBase,
            engineVersion: "V2",
            creationRequestKey: randomUUID(),
          },
        }),
      );
      await assert.rejects(
        db.match.create({
          data: {
            ...invalidIdentityBase,
            engineVersion: "LEGACY",
            creationRequestKey: randomUUID(),
            creationRequestFingerprint: "a".repeat(64),
          },
        }),
      );
      await assert.rejects(
        db.match.create({
          data: {
            ...invalidIdentityBase,
            engineVersion: "V2",
            creationRequestKey: randomUUID(),
            creationRequestFingerprint: "not-a-sha256-fingerprint",
          },
        }),
      );

      const service = createV2SingleMatchApplicationService({ db });
      const requestKey = randomUUID();
      const created = await service.create({
        actor: { id: actorId, role: "user" },
        requestKey,
        title: "V2 match creation integration",
        description: null,
        location: "West Campus Gym",
        dateTime: new Date("2026-10-01T11:00:00.000Z"),
        registrationDeadline: new Date("2026-09-30T11:00:00.000Z"),
        type: "single",
        format: "group_only",
      });

      assert.equal(created.engineVersion, "V2");
      assert.equal(created.isQuickMatch, false);
      assert.equal(created.status, "registration");
      assert.equal(created.maxParticipants, V2_SINGLE_MATCH_UNLIMITED_PARTICIPANTS);
      assert.equal(created.createdBy, actorId);
      assert.equal(created.created, true);

      const retried = await service.create({
        actor: { id: actorId, role: "user" },
        requestKey,
        title: "V2 match creation integration",
        description: null,
        location: "West Campus Gym",
        dateTime: new Date("2026-10-01T11:00:00.000Z"),
        registrationDeadline: new Date("2026-09-30T11:00:00.000Z"),
        type: "single",
        format: "group_only",
      });
      assert.equal(retried.id, created.id);
      assert.equal(retried.created, false);
      const resolvedAfterDisable = await service.resolveExisting({
        actor: { id: actorId, role: "user" },
        requestKey,
        title: "V2 match creation integration",
        description: null,
        location: "West Campus Gym",
        dateTime: new Date("2026-10-01T11:00:00.000Z"),
        registrationDeadline: new Date("2026-09-30T11:00:00.000Z"),
        type: "single",
        format: "group_only",
      });
      assert.equal(resolvedAfterDisable?.id, created.id);
      assert.equal(resolvedAfterDisable?.created, false);
      assert.equal(
        await service.resolveExisting({
          actor: { id: actorId, role: "user" },
          requestKey: randomUUID(),
          title: "V2 match creation integration",
          description: null,
          location: "West Campus Gym",
          dateTime: new Date("2026-10-01T11:00:00.000Z"),
          registrationDeadline: new Date("2026-09-30T11:00:00.000Z"),
          type: "single",
          format: "group_only",
        }),
        null,
      );
      assert.equal(
        await db.registration.count({
          where: { matchId: created.id, userId: actorId },
        }),
        0,
      );
      assert.equal(
        await db.matchEntry.count({
          where: { matchId: created.id },
        }),
        0,
      );
      assert.equal(
        await db.auditLog.count({
          where: {
            actorId,
            entityId: created.id,
            entityType: "Match",
            action: "match.create",
          },
        }),
        1,
      );

      const concurrentRequestKey = randomUUID();
      const concurrentCommand = {
        actor: { id: actorId, role: "user" as const },
        requestKey: concurrentRequestKey,
        title: "V2 concurrent retry integration",
        description: "Both requests describe one command",
        location: "West Campus Gym",
        dateTime: new Date("2026-10-02T11:00:00.000Z"),
        registrationDeadline: new Date("2026-10-01T11:00:00.000Z"),
        type: "single" as const,
        format: "group_only" as const,
      };
      const concurrentResults = await Promise.all([
        service.create(concurrentCommand),
        service.create(concurrentCommand),
      ]);
      assert.equal(concurrentResults[0].id, concurrentResults[1].id);
      assert.deepEqual(
        concurrentResults.map((result) => result.created).sort(),
        [false, true],
      );
      assert.equal(
        await db.match.count({
          where: { createdBy: actorId, creationRequestKey: concurrentRequestKey },
        }),
        1,
      );
      assert.equal(
        await db.auditLog.count({
          where: {
            actorId,
            entityId: concurrentResults[0].id,
            entityType: "Match",
            action: "match.create",
          },
        }),
        1,
      );

      const conflictingRequestKey = randomUUID();
      const conflictingResults = await Promise.allSettled([
        service.create({
          ...concurrentCommand,
          requestKey: conflictingRequestKey,
          title: "V2 conflicting request A",
        }),
        service.create({
          ...concurrentCommand,
          requestKey: conflictingRequestKey,
          title: "V2 conflicting request B",
        }),
      ]);
      const fulfilled = conflictingResults.filter(
        (result) => result.status === "fulfilled",
      );
      const rejected = conflictingResults.filter(
        (result) => result.status === "rejected",
      );
      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.ok(
        rejected[0].status === "rejected" &&
          rejected[0].reason instanceof V2CompetitionApplicationError &&
          rejected[0].reason.code === "PERSISTENCE_CONFLICT",
      );
      assert.equal(
        await db.match.count({
          where: { createdBy: actorId, creationRequestKey: conflictingRequestKey },
        }),
        1,
      );
    } finally {
      await db.auditLog.deleteMany({ where: { actorId } });
      await db.match.deleteMany({ where: { createdBy: actorId } });
      await db.user.deleteMany({ where: { id: actorId } });
      await db.$disconnect();
    }
  },
);
