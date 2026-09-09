import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import { createV2Entry } from "./entries";
import { createV2SingleGroupingApplicationService } from "./grouping";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;

test(
  "a real PostgreSQL transaction publishes READY singles fixtures and lineups once",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const ownerId = `grouping-owner-${suffix}`;
    const participantIds = Array.from(
      { length: 4 },
      (_, index) => `grouping-player-${index + 1}-${suffix}`,
    );
    const matchId = `grouping-match-${suffix}`;

    try {
      const verifiedAt = new Date("2026-09-01T00:00:00.000Z");
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
            nickname: `Authoritative player ${index + 1}`,
            emailVerifiedAt: verifiedAt,
            eloRating: 1400 - index * 50,
            points: index + 1,
          })),
        ],
      });
      await db.match.create({
        data: {
          id: matchId,
          title: "V2 grouping integration",
          dateTime: new Date("2026-10-01T10:00:00.000Z"),
          type: "single",
          status: "registration",
          engineVersion: "V2",
          format: "group_only",
          maxParticipants: 4,
          createdBy: ownerId,
          registrationDeadline: new Date("2099-01-01T00:00:00.000Z"),
        },
      });
      const entries: Awaited<ReturnType<typeof createV2Entry>>[] = [];
      for (const participantId of participantIds) {
        entries.push(
          await createV2Entry(db, {
            actor: { id: participantId, role: "user" },
            matchId,
            kind: "INDIVIDUAL",
            sourceId: participantId,
            status: "ACTIVE",
          }),
        );
      }
      await db.match.update({
        where: { id: matchId },
        data: { registrationDeadline: new Date("2026-09-01T00:00:00.000Z") },
      });

      const service = createV2SingleGroupingApplicationService({
        db,
        clock: () => new Date("2026-09-04T12:00:00.000Z"),
      });
      const publish = () =>
        service.publish({
          actor: { id: ownerId, role: "user" },
          matchId,
          expectedEntries: entries.map((entry) => ({
            entryId: entry.id,
            version: entry.version,
          })),
          draft: {
            format: "group_only",
            groups: [
              { entryIds: [entries[0].id, entries[1].id] },
              { entryIds: [entries[2].id, entries[3].id] },
            ],
          },
        });

      const first = await publish();
      const retry = await publish();
      assert.equal(first.created, true);
      assert.equal(retry.created, false);
      assert.equal(retry.publishedAt.toISOString(), first.publishedAt.toISOString());

      const fixtures = await db.matchFixture.findMany({
        where: { matchId },
        include: { lineupMembers: true },
        orderBy: { fixtureKey: "asc" },
      });
      assert.equal(fixtures.length, 2);
      assert.equal(
        fixtures.every(
          (fixture) =>
            fixture.stage === "GROUP" &&
            fixture.status === "READY" &&
            fixture.lineupMembers.length === 2,
        ),
        true,
      );
      assert.equal(
        await db.matchFixture.count({ where: { matchId, stage: "KNOCKOUT" } }),
        0,
      );
      assert.equal(await db.matchGrouping.count({ where: { matchId } }), 1);
      assert.equal(
        await db.auditLog.count({
          where: {
            entityId: matchId,
            action: "v2_single_grouping_publish",
          },
        }),
        1,
      );
    } finally {
      await db.$disconnect();
    }
  },
);
