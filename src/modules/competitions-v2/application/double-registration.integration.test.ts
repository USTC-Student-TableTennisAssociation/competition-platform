import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import { createV2DoubleActionHandlers } from "../adapters/double-actions";
import { createV2DoubleMatchApplicationService } from "./double-matches";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;

function csrfForm() {
  const formData = new FormData();
  formData.set("csrfToken", "integration-token");
  return formData;
}

test(
  "real PostgreSQL closes DOUBLE source -> ACTIVE/DRAFT Entry and two-member settlement",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const ids = {
      owner: `double-owner-${suffix}`,
      partnerA: `double-a-${suffix}`,
      partnerB: `double-b-${suffix}`,
      sourceTeam: `double-source-${suffix}`,
    };

    try {
      const verifiedAt = new Date("2026-09-01T00:00:00Z");
      await db.user.createMany({
        data: [
          {
            id: ids.owner,
            email: `${ids.owner}@example.test`,
            nickname: "Double owner",
            emailVerifiedAt: verifiedAt,
          },
          {
            id: ids.partnerA,
            email: `${ids.partnerA}@example.test`,
            nickname: "Partner A",
            emailVerifiedAt: verifiedAt,
          },
          {
            id: ids.partnerB,
            email: `${ids.partnerB}@example.test`,
            nickname: "Partner B",
            emailVerifiedAt: verifiedAt,
          },
        ],
      });

      const match = await createV2DoubleMatchApplicationService({ db }).create({
        actor: { id: ids.owner, role: "user" },
        requestKey: randomUUID(),
        title: "DOUBLE lifecycle integration",
        description: null,
        location: "West Campus Gym",
        dateTime: new Date("2099-02-01T10:00:00Z"),
        registrationDeadline: new Date("2099-01-01T00:00:00Z"),
        type: "double",
        format: "group_only",
      });
      await db.matchDoublesTeam.create({
        data: {
          id: ids.sourceTeam,
          matchId: match.id,
          createdById: ids.partnerA,
          members: {
            create: [
              { userId: ids.partnerA, slot: 1 },
              { userId: ids.partnerB, slot: 2 },
            ],
          },
        },
      });

      const actionFor = (userId: string) =>
        createV2DoubleActionHandlers({
          db,
          validateCsrfToken: async () => null,
          getCurrentUser: async () => ({ id: userId, role: "user" }),
          logError: async () => undefined,
        });
      const partnerA = actionFor(ids.partnerA);
      const partnerB = actionFor(ids.partnerB);

      const registrations = await Promise.all([
        partnerA.register(match.id, csrfForm()),
        partnerB.register(match.id, csrfForm()),
      ]);
      assert.equal(registrations.every((state) => state.success), true);

      const entries = await db.matchEntry.findMany({
        where: { matchId: match.id },
        include: { members: { orderBy: [{ rosterVersion: "asc" }, { slot: "asc" }] } },
      });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].kind, "DOUBLES");
      assert.equal(entries[0].status, "ACTIVE");
      assert.equal(entries[0].sourceDoublesTeamId, ids.sourceTeam);
      assert.deepEqual(
        entries[0].members.map((member) => [member.userId, member.slot, member.rosterVersion]),
        [
          [ids.partnerA, 1, 1],
          [ids.partnerB, 2, 1],
        ],
      );
      const apply = await db.settlementEvent.findMany({
        where: { matchEntryId: entries[0].id, kind: "REGISTRATION_APPLY" },
        include: { effects: true },
      });
      assert.equal(apply.length, 1);
      assert.equal(apply[0].status, "APPLIED");
      assert.equal(apply[0].effects.length, 2);
      assert.equal(
        await db.pointsTransaction.count({
          where: {
            userId: { in: [ids.partnerA, ids.partnerB] },
            referenceId: { startsWith: `match-points:${match.id}:register:` },
          },
        }),
        2,
      );
      assert.equal(await db.registration.count({ where: { matchId: match.id } }), 0);
      assert.equal(
        (await db.matchDoublesTeam.findUniqueOrThrow({
          where: { id: ids.sourceTeam },
          select: { registeredAt: true },
        })).registeredAt,
        null,
      );

      const cancellations = await Promise.all([
        partnerA.cancelRegistration(match.id, csrfForm()),
        partnerB.cancelRegistration(match.id, csrfForm()),
      ]);
      assert.equal(cancellations.every((state) => state.success), true);
      const cancelled = await db.matchEntry.findUniqueOrThrow({
        where: { id: entries[0].id },
        include: { members: true },
      });
      assert.equal(cancelled.status, "DRAFT");
      assert.equal(
        cancelled.members.every(
          (member) => member.status !== "ACTIVE" && member.effectiveUntil !== null,
        ),
        true,
      );
      const reversals = await db.settlementEvent.findMany({
        where: {
          matchEntryId: entries[0].id,
          kind: "REGISTRATION_REVERSAL",
        },
        include: { effects: true },
      });
      assert.equal(reversals.length, 1);
      assert.equal(reversals[0].status, "APPLIED");
      assert.equal(reversals[0].effects.length, 2);
      assert.equal(await db.registration.count({ where: { matchId: match.id } }), 0);
      assert.equal(
        (await db.matchDoublesTeam.findUniqueOrThrow({
          where: { id: ids.sourceTeam },
          select: { registeredAt: true },
        })).registeredAt,
        null,
      );

      assert.equal((await partnerB.register(match.id, csrfForm())).error, undefined);
      const reactivated = await db.matchEntry.findUniqueOrThrow({
        where: { id: entries[0].id },
        include: {
          members: {
            where: { status: "ACTIVE", effectiveUntil: null },
            orderBy: { slot: "asc" },
          },
        },
      });
      assert.equal(reactivated.status, "ACTIVE");
      assert.equal(reactivated.members.length, 2);
      assert.equal(reactivated.members.every((member) => member.rosterVersion === 2), true);
      assert.equal(
        await db.settlementEvent.count({
          where: { matchEntryId: entries[0].id, kind: "REGISTRATION_APPLY" },
        }),
        2,
      );
      assert.equal(await db.registration.count({ where: { matchId: match.id } }), 0);
    } finally {
      await db.$disconnect();
    }
  },
);
