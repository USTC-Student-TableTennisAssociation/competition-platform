import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";

import { parseV2SingleGroupTableLabelsFromMetadata } from "../domain/group-fixture-metadata";
import { createV2Entry } from "./entries";
import { createV2SingleGroupTableLabelsApplicationService } from "./group-table-labels";
import { createV2SingleGroupingApplicationService } from "./grouping";
import { createV2ResultApplicationService } from "./results";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;

test(
  "real PostgreSQL serializes table labels with result versions and rolls every label write back if audit fails",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const ownerId = `labels-owner-${suffix}`;
    const participantIds = Array.from(
      { length: 3 },
      (_, index) => `labels-player-${index + 1}-${suffix}`,
    );
    const matchId = `labels-match-${suffix}`;

    try {
      const verifiedAt = new Date("2026-09-01T00:00:00.000Z");
      await db.user.createMany({
        data: [
          {
            id: ownerId,
            email: `${ownerId}@example.test`,
            nickname: "Label owner",
            emailVerifiedAt: verifiedAt,
          },
          ...participantIds.map((id, index) => ({
            id,
            email: `${id}@example.test`,
            nickname: `Label player ${index + 1}`,
            emailVerifiedAt: verifiedAt,
            eloRating: 1_400 - index * 50,
          })),
        ],
      });
      await db.match.create({
        data: {
          id: matchId,
          title: "V2 label integration",
          dateTime: new Date("2026-10-01T10:00:00.000Z"),
          type: "single",
          status: "registration",
          engineVersion: "V2",
          format: "group_only",
          maxParticipants: 3,
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
        data: { registrationDeadline: verifiedAt },
      });

      const groupingService = createV2SingleGroupingApplicationService({
        db,
        clock: () => new Date("2026-09-04T12:00:00.000Z"),
      });
      const publish = () =>
        groupingService.publish({
          actor: { id: ownerId, role: "user" },
          matchId,
          expectedEntries: entries.map((entry) => ({
            entryId: entry.id,
            version: entry.version,
          })),
          draft: {
            format: "group_only",
            seedMethod: "snake",
            groups: [{ entryIds: entries.map((entry) => entry.id) }],
          },
        });
      await publish();

      const initialFixtures = await db.matchFixture.findMany({
        where: { matchId, stage: "GROUP" },
        orderBy: { id: "asc" },
        select: {
          id: true,
          version: true,
          sideAEntryId: true,
          sideBEntryId: true,
        },
      });
      assert.equal(initialFixtures.length, 3);
      const labelCommand = {
        actor: { id: ownerId, role: "user" as const },
        matchId,
        groupKey: "group:0001",
        expectedFixtures: initialFixtures.map((fixture) => ({
          fixtureId: fixture.id,
          version: fixture.version,
        })),
        labels: ["并发桌号"],
      };
      const firstFixture = initialFixtures[0];
      const reporterEntryIndex = entries.findIndex(
        (entry) => entry.id === firstFixture.sideAEntryId,
      );
      assert.notEqual(reporterEntryIndex, -1);
      const reporterId = participantIds[reporterEntryIndex];
      const resultService = createV2ResultApplicationService({ db });
      const labelService = createV2SingleGroupTableLabelsApplicationService({ db });
      const contenders = await Promise.allSettled([
        labelService.update(labelCommand),
        resultService.submitRevision({
          actor: { actorId: reporterId, role: "user" },
          matchId,
          fixtureId: firstFixture.id,
          expectedFixtureVersion: firstFixture.version,
          requiredFixtureStage: "GROUP",
          winnerEntryId: firstFixture.sideAEntryId!,
          loserEntryId: firstFixture.sideBEntryId!,
          score: {
            bestOf: 5,
            winnerScore: 3,
            loserScore: 1,
            text: "3:1（5局3胜）",
          },
        }),
      ]);
      assert.equal(
        contenders.filter((result) => result.status === "fulfilled").length,
        1,
      );

      const labelWon = contenders[0].status === "fulfilled";
      const afterRace = await db.matchFixture.findMany({
        where: { matchId, stage: "GROUP" },
        orderBy: { id: "asc" },
        select: { id: true, version: true, metadata: true },
      });
      const raceLabels = afterRace.map((fixture) =>
        parseV2SingleGroupTableLabelsFromMetadata(fixture.metadata),
      );
      assert.deepEqual(
        raceLabels,
        Array.from({ length: 3 }, () => (labelWon ? ["并发桌号"] : [])),
      );
      assert.equal(
        await db.auditLog.count({
          where: {
            entityId: matchId,
            action: "v2_single_group_table_labels_update",
          },
        }),
        labelWon ? 1 : 0,
      );

      const beforeRollbackGrouping = await db.matchGrouping.findUniqueOrThrow({
        where: { matchId },
        select: { payload: true },
      });
      const auditCountBeforeRollback = await db.auditLog.count({
        where: { entityId: matchId, action: "v2_single_group_table_labels_update" },
      });
      const rollbackDb = {
        $transaction: async (
          operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options: {
            isolationLevel?: Prisma.TransactionIsolationLevel;
            maxWait?: number;
            timeout?: number;
          },
        ) =>
          db.$transaction((tx) => {
            const proxy = new Proxy(tx, {
              get(target, property) {
                if (property === "auditLog") {
                  return new Proxy(target.auditLog, {
                    get(delegate, auditProperty) {
                      if (auditProperty === "create") {
                        return async () => {
                          throw new Error("injected audit failure");
                        };
                      }
                      const value = Reflect.get(delegate, auditProperty, delegate);
                      return typeof value === "function" ? value.bind(delegate) : value;
                    },
                  });
                }
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
            return operation(proxy);
          }, options),
      } as unknown as Pick<PrismaClient, "$transaction">;
      const rollbackService = createV2SingleGroupTableLabelsApplicationService({
        db: rollbackDb,
      });
      const rollbackCommand = {
        ...labelCommand,
        expectedFixtures: afterRace.map((fixture) => ({
          fixtureId: fixture.id,
          version: fixture.version,
        })),
        labels: ["应被回滚"],
      };
      await assert.rejects(
        rollbackService.update(rollbackCommand),
        /injected audit failure/,
      );

      const afterRollback = await db.matchFixture.findMany({
        where: { matchId, stage: "GROUP" },
        orderBy: { id: "asc" },
        select: { id: true, version: true, metadata: true },
      });
      assert.deepEqual(afterRollback, afterRace);
      assert.deepEqual(
        await db.matchGrouping.findUniqueOrThrow({
          where: { matchId },
          select: { payload: true },
        }),
        beforeRollbackGrouping,
      );
      assert.equal(
        await db.auditLog.count({
          where: { entityId: matchId, action: "v2_single_group_table_labels_update" },
        }),
        auditCountBeforeRollback,
      );

      const saved = await labelService.update(rollbackCommand);
      assert.equal(saved.changed, true);
      const exactRetry = await labelService.update(rollbackCommand);
      assert.equal(exactRetry.changed, false);
      assert.equal((await publish()).created, false);
      const finalFixtures = await db.matchFixture.findMany({
        where: { matchId, stage: "GROUP" },
        select: { metadata: true },
      });
      assert.deepEqual(
        finalFixtures.map((fixture) =>
          parseV2SingleGroupTableLabelsFromMetadata(fixture.metadata),
        ),
        Array.from({ length: 3 }, () => ["应被回滚"]),
      );
      const projection = await db.matchGrouping.findUniqueOrThrow({
        where: { matchId },
        select: { payload: true },
      });
      assert.deepEqual(
        (projection.payload as { tableAssignments?: unknown }).tableAssignments,
        { group: { "第 1 组": ["应被回滚"] }, knockout: {} },
      );
    } finally {
      await db.$disconnect();
    }
  },
);
