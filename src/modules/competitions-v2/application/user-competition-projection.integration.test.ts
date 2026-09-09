import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { PrismaClient } from "@prisma/client";

import { getHomeUserCompetitionProjection } from "../read-model/home-user-competition";
import {
  getTermRegistrationCount,
  getUserCompetitionHistory,
} from "../read-model/user-competition-history";
import { createV2DoubleGroupingApplicationService } from "./double-grouping";
import { applyRegistrationSettlement } from "./registration-settlements";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;
const activatedAt = new Date("2026-09-01T08:00:00.000Z");
const publishedAt = new Date("2026-09-02T08:00:00.000Z");
const resolvedAt = new Date("2026-09-03T08:00:00.000Z");

test(
  "real PostgreSQL projects a non-source DOUBLE member through home, history, and term count",
  { skip: integrationDatabaseUrl ? false : "V2 integration database is not configured." },
  async () => {
    const db = new PrismaClient({
      datasources: { db: { url: integrationDatabaseUrl } },
    });
    const suffix = randomUUID().replaceAll("-", "");
    const managerId = `projection-manager-${suffix}`;
    const matchId = `projection-match-${suffix}`;
    const userIds = Array.from(
      { length: 4 },
      (_, index) => `projection-user-${index + 1}-${suffix}`,
    );
    const sourceIds = [
      `projection-source-1-${suffix}`,
      `projection-source-2-${suffix}`,
    ];

    try {
      await db.user.createMany({
        data: [
          {
            id: managerId,
            email: `${managerId}@example.test`,
            nickname: "Projection manager",
            emailVerifiedAt: activatedAt,
          },
          ...userIds.map((id, index) => ({
            id,
            email: `${id}@example.test`,
            nickname: `Current nickname ${index + 1}`,
            emailVerifiedAt: activatedAt,
            eloRating: 1_200 + index * 10,
            points: 20,
          })),
        ],
      });
      await db.match.create({
        data: {
          id: matchId,
          title: "Projection DOUBLE",
          dateTime: new Date("2026-09-10T08:00:00.000Z"),
          type: "double",
          status: "registration",
          engineVersion: "V2",
          format: "group_only",
          maxParticipants: 2,
          createdBy: managerId,
          registrationDeadline: new Date("2026-09-01T00:00:00.000Z"),
        },
      });

      const entries: Array<{ id: string; version: number }> = [];
      for (let entryIndex = 0; entryIndex < 2; entryIndex += 1) {
        const roster = userIds.slice(entryIndex * 2, entryIndex * 2 + 2);
        await db.matchDoublesTeam.create({
          data: {
            id: sourceIds[entryIndex],
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
        const entry = await db.$transaction(async (tx) => {
          const created = await tx.matchEntry.create({
            data: {
              matchId,
              kind: "DOUBLES",
              status: "ACTIVE",
              sourceKey: `doubles:${sourceIds[entryIndex]}`,
              sourceDoublesTeamId: sourceIds[entryIndex],
              displayNameSnapshot: `Frozen pair ${entryIndex + 1}`,
              createdAt: activatedAt,
              members: {
                create: roster.map((userId, index) => ({
                  userId,
                  displayNameSnapshot: `Frozen player ${entryIndex + 1}-${index + 1}`,
                  role: "player",
                  status: "ACTIVE",
                  slot: index + 1,
                  rosterVersion: 1,
                  effectiveFrom: activatedAt,
                })),
              },
            },
            select: { id: true, version: true },
          });
          await applyRegistrationSettlement(tx, {
            matchId,
            matchEntryId: created.id,
            rosterVersion: 1,
            origin: "STANDARD",
            clock: () => activatedAt,
          });
          return created;
        });
        entries.push({ id: entry.id, version: entry.version });
      }

      const grouping = createV2DoubleGroupingApplicationService({
        db,
        clock: () => publishedAt,
      });
      await grouping.publish({
        actor: { id: managerId, role: "user" },
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
      const fixture = await db.matchFixture.findFirstOrThrow({
        where: { matchId, stage: "GROUP" },
        select: { id: true },
      });
      await db.$transaction(async (tx) => {
        await tx.resultRevision.create({
          data: {
            matchId,
            fixtureId: fixture.id,
            revisionNumber: 1,
            status: "CONFIRMED",
            resolutionKind: "FORFEIT",
            winnerEntryId: entries[0].id,
            loserEntryId: entries[1].id,
            score: { winnerScore: 1, loserScore: 0 },
            reportedById: managerId,
            verifiedById: managerId,
            reason: "Opponent forfeited",
            resolvedAt,
            createdAt: resolvedAt,
            updatedAt: resolvedAt,
          },
        });
        await tx.matchFixture.update({
          where: { id: fixture.id },
          data: { status: "COMPLETED", completedAt: resolvedAt },
        });
        await tx.match.update({
          where: { id: matchId },
          data: { status: "finished" },
        });
      });

      const projectedUserId = userIds[1];
      const [home, history, termCount] = await Promise.all([
        getHomeUserCompetitionProjection(db, projectedUserId),
        getUserCompetitionHistory(db, projectedUserId, {
          legacyOrder: "verifiedAt",
        }),
        getTermRegistrationCount(
          db,
          projectedUserId,
          new Date("2026-09-01T00:00:00.000Z"),
        ),
      ]);

      assert.deepEqual(home.myMatches.map((match) => match.id), [matchId]);
      assert.equal(home.myMatches[0].phase, "比赛已结束");
      assert.deepEqual(home.recentResults, [
        {
          id: history[0].id,
          matchId,
          opponentLabel: "Frozen player 2-1 / Frozen player 2-2 · 弃权/1:0",
          isWin: true,
          eloDelta: null,
        },
      ]);
      assert.equal(history.length, 1);
      assert.equal(
        history[0].opponentLabel,
        "Frozen player 2-1 / Frozen player 2-2",
      );
      assert.equal(history[0].scoreText, "弃权/1:0");
      assert.equal(termCount, 1);
    } finally {
      await db.$disconnect();
    }
  },
);
