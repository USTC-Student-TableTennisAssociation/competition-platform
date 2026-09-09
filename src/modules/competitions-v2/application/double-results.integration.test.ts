import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import { createV2DoubleActionHandlers } from "../adapters/double-actions";
import { getV2DoubleRegistrationReadState } from "../read-model/double-registration";
import { createV2DoubleGroupingApplicationService } from "./double-grouping";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;
const VERIFIED_AT = new Date("2026-08-01T00:00:00.000Z");
const PUBLISHED_AT = new Date("2026-09-05T12:00:00.000Z");

type SeededMatch = Readonly<{
  matchId: string;
  entryIds: readonly string[];
  userIdsByEntry: readonly (readonly string[])[];
  fixtureIds: readonly string[];
}>;

function targetForm(fixtureId: string, fixtureVersion: number) {
  const formData = new FormData();
  formData.set("csrfToken", "integration-csrf");
  formData.set("fixtureId", fixtureId);
  formData.set("expectedFixtureVersion", String(fixtureVersion));
  return formData;
}

function playedForm(
  fixtureId: string,
  fixtureVersion: number,
  winnerEntryId: string,
) {
  const formData = targetForm(fixtureId, fixtureVersion);
  formData.set("winnerEntryId", winnerEntryId);
  formData.set("bestOf", "5");
  formData.set("winnerScore", "3");
  formData.set("loserScore", "1");
  return formData;
}

async function seedDoubleGroupOnlyMatch(
  db: PrismaClient,
  suffix: string,
  label: string,
  entryCount: 2 | 3,
): Promise<SeededMatch> {
  const managerId = `double-result-manager-${suffix}`;
  const matchId = `double-result-${label}-${suffix}`;
  const userIdsByEntry = Array.from({ length: entryCount }, (_, entryIndex) =>
    [1, 2].map(
      (slot) => `double-result-${label}-${entryIndex + 1}-${slot}-${suffix}`,
    ),
  );
  await db.user.createMany({
    data: [
      {
        id: managerId,
        email: `${managerId}@example.test`,
        nickname: "Double result manager",
        emailVerifiedAt: VERIFIED_AT,
      },
      ...userIdsByEntry.flatMap((userIds, entryIndex) =>
        userIds.map((id, memberIndex) => ({
          id,
          email: `${id}@example.test`,
          nickname: `${label} pair ${entryIndex + 1}-${memberIndex + 1}`,
          emailVerifiedAt: VERIFIED_AT,
          eloRating: 1_200 + entryIndex * 40 + memberIndex,
        })),
      ),
    ],
  });
  await db.match.create({
    data: {
      id: matchId,
      title: `DOUBLE result ${label}`,
      dateTime: new Date("2026-10-01T10:00:00.000Z"),
      type: "double",
      status: "registration",
      engineVersion: "V2",
      format: "group_only",
      maxParticipants: entryCount,
      createdBy: managerId,
      registrationDeadline: new Date("2026-09-01T00:00:00.000Z"),
    },
  });

  const entries: Array<{ id: string; version: number }> = [];
  for (const [entryIndex, userIds] of userIdsByEntry.entries()) {
    const sourceId = `double-result-source-${label}-${entryIndex + 1}-${suffix}`;
    await db.matchDoublesTeam.create({
      data: {
        id: sourceId,
        matchId,
        createdById: userIds[0],
        members: {
          create: userIds.map((userId, memberIndex) => ({
            userId,
            slot: memberIndex + 1,
          })),
        },
      },
    });
    entries.push(
      await db.matchEntry.create({
        data: {
          matchId,
          kind: "DOUBLES",
          status: "ACTIVE",
          sourceKey: `doubles:${sourceId}`,
          sourceDoublesTeamId: sourceId,
          displayNameSnapshot: `${label} 双打 ${entryIndex + 1}`,
          members: {
            create: userIds.map((userId, memberIndex) => ({
              userId,
              displayNameSnapshot: `${label} member ${entryIndex + 1}-${memberIndex + 1}`,
              role: "player",
              status: "ACTIVE",
              slot: memberIndex + 1,
              rosterVersion: 1,
            })),
          },
        },
        select: { id: true, version: true },
      }),
    );
  }
  const grouping = createV2DoubleGroupingApplicationService({
    db,
    clock: () => PUBLISHED_AT,
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
  const fixtures = await db.matchFixture.findMany({
    where: { matchId },
    orderBy: { fixtureKey: "asc" },
    select: { id: true },
  });
  return {
    matchId,
    entryIds: entries.map((entry) => entry.id),
    userIdsByEntry,
    fixtureIds: fixtures.map((fixture) => fixture.id),
  };
}

test(
  "real PostgreSQL closes DOUBLE group results, four-user settlement, reversals, forfeit, void, and completion",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const managerId = `double-result-manager-${suffix}`;
    let actorId = managerId;
    const handlers = createV2DoubleActionHandlers({
      db,
      validateCsrfToken: async () => null,
      getCurrentUser: async () => ({ id: actorId, role: "user" }),
      logError: async () => undefined,
    });

    try {
      const correctionMatch = await seedDoubleGroupOnlyMatch(
        db,
        suffix,
        "correction",
        3,
      );
      const playedFixtureId = correctionMatch.fixtureIds[0];
      let playedFixture = await db.matchFixture.findUniqueOrThrow({
        where: { id: playedFixtureId },
      });
      const [winnerEntryId, loserEntryId] = [
        playedFixture.sideAEntryId,
        playedFixture.sideBEntryId,
      ];
      assert.ok(winnerEntryId && loserEntryId);
      assert.deepEqual(
        await handlers.submitResult(
          correctionMatch.matchId,
          playedForm(
            playedFixtureId,
            playedFixture.version,
            winnerEntryId,
          ),
        ),
        { success: "已登记，等待另一方非登记搭档或管理员确认。" },
      );
      const pending = await db.resultRevision.findFirstOrThrow({
        where: { fixtureId: playedFixtureId, status: "PENDING" },
      });
      const pendingRead = await getV2DoubleRegistrationReadState(
        db,
        correctionMatch.matchId,
        correctionMatch.userIdsByEntry[0][1],
        PUBLISHED_AT,
      );
      assert.equal(pendingRead.kind, "DOUBLE_V2_REGISTRATION");
      if (pendingRead.kind !== "DOUBLE_V2_REGISTRATION") assert.fail("read failed");
      const relationalFixture = pendingRead.grouping.groups[0].fixtures.find(
        (fixture) => fixture.fixtureId === playedFixtureId,
      );
      assert.equal(relationalFixture?.sideA.members.length, 2);
      assert.equal(relationalFixture?.sideB.members.length, 2);
      assert.equal(relationalFixture?.activeResult.state, "PENDING");

      actorId = correctionMatch.userIdsByEntry[0][1];
      playedFixture = await db.matchFixture.findUniqueOrThrow({
        where: { id: playedFixtureId },
      });
      const confirm = targetForm(playedFixtureId, playedFixture.version);
      confirm.set("resultRevisionId", pending.id);
      assert.equal(
        (await handlers.confirmResult(correctionMatch.matchId, confirm)).error,
        undefined,
      );
      const initialApply = await db.settlementEvent.findFirstOrThrow({
        where: { resultRevisionId: pending.id, kind: "RESULT_APPLY" },
        include: { effects: true },
      });
      assert.equal(initialApply.effects.length, 4);
      assert.deepEqual(
        initialApply.effects.map((effect) => effect.userId).sort(),
        [
          ...correctionMatch.userIdsByEntry[0],
          ...correctionMatch.userIdsByEntry[1],
        ].sort(),
      );
      const settledUserIds = [
        ...correctionMatch.userIdsByEntry[0],
        ...correctionMatch.userIdsByEntry[1],
      ].sort();
      const usersAfterInitial = await db.user.findMany({
        where: { id: { in: settledUserIds } },
        orderBy: { id: "asc" },
        select: {
          id: true,
          eloRating: true,
          points: true,
          wins: true,
          losses: true,
          matchesPlayed: true,
        },
      });

      actorId = managerId;
      playedFixture = await db.matchFixture.findUniqueOrThrow({
        where: { id: playedFixtureId },
      });
      const correction = targetForm(playedFixtureId, playedFixture.version);
      correction.set("resultRevisionId", pending.id);
      correction.set("bestOf", "5");
      correction.set("winnerScore", "3");
      correction.set("loserScore", "2");
      correction.set("correctionMode", "KEEP_WINNER");
      assert.equal(
        (await handlers.submitCorrection(correctionMatch.matchId, correction)).error,
        undefined,
      );
      const correctionRevision = await db.resultRevision.findFirstOrThrow({
        where: { fixtureId: playedFixtureId, status: "PENDING" },
      });
      playedFixture = await db.matchFixture.findUniqueOrThrow({
        where: { id: playedFixtureId },
      });
      const confirmCorrection = targetForm(
        playedFixtureId,
        playedFixture.version,
      );
      confirmCorrection.set("resultRevisionId", correctionRevision.id);
      assert.equal(
        (
          await handlers.confirmResult(
            correctionMatch.matchId,
            confirmCorrection,
          )
        ).error,
        undefined,
      );
      assert.equal(
        await db.settlementEvent.count({
          where: { resultRevisionId: pending.id, kind: "RESULT_REVERSAL" },
        }),
        1,
      );
      const correctionApply = await db.settlementEvent.findFirstOrThrow({
        where: {
          resultRevisionId: correctionRevision.id,
          kind: "RESULT_APPLY",
        },
        include: { effects: true },
      });
      assert.equal(correctionApply.effects.length, 4);
      if (
        correctionApply.metadata === null ||
        typeof correctionApply.metadata !== "object" ||
        Array.isArray(correctionApply.metadata)
      ) {
        assert.fail("correction settlement metadata is malformed");
      }
      assert.equal(correctionApply.metadata.correctionMode, "KEEP_WINNER");
      assert.equal(correctionRevision.winnerEntryId, pending.winnerEntryId);
      assert.equal(correctionRevision.loserEntryId, pending.loserEntryId);
      const usersAfterCorrection = await db.user.findMany({
        where: { id: { in: settledUserIds } },
        orderBy: { id: "asc" },
        select: {
          id: true,
          eloRating: true,
          points: true,
          wins: true,
          losses: true,
          matchesPlayed: true,
        },
      });
      assert.deepEqual(usersAfterCorrection, usersAfterInitial);
      assert.equal(
        await db.settlementEvent.count({
          where: {
            resultRevisionId: { in: [pending.id, correctionRevision.id] },
          },
        }),
        3,
      );
      assert.equal(
        (
          await handlers.confirmResult(
            correctionMatch.matchId,
            confirmCorrection,
          )
        ).error,
        undefined,
      );
      assert.deepEqual(
        await db.user.findMany({
          where: { id: { in: settledUserIds } },
          orderBy: { id: "asc" },
          select: {
            id: true,
            eloRating: true,
            points: true,
            wins: true,
            losses: true,
            matchesPlayed: true,
          },
        }),
        usersAfterInitial,
      );
      assert.equal(
        await db.settlementEvent.count({
          where: {
            resultRevisionId: { in: [pending.id, correctionRevision.id] },
          },
        }),
        3,
      );

      playedFixture = await db.matchFixture.findUniqueOrThrow({
        where: { id: playedFixtureId },
      });
      const voidResult = targetForm(playedFixtureId, playedFixture.version);
      voidResult.set("resultRevisionId", correctionRevision.id);
      voidResult.set("reason", "录入错误，整场作废");
      assert.equal(
        (await handlers.voidResult(correctionMatch.matchId, voidResult)).error,
        undefined,
      );
      const voidReversal = await db.settlementEvent.findFirstOrThrow({
        where: {
          resultRevisionId: correctionRevision.id,
          kind: "RESULT_REVERSAL",
        },
        include: { effects: true },
      });
      assert.equal(voidReversal.effects.length, 4);
      assert.equal(
        (await db.matchFixture.findUniqueOrThrow({ where: { id: playedFixtureId } }))
          .status,
        "VOIDED",
      );

      const unplayedFixture = await db.matchFixture.findUniqueOrThrow({
        where: { id: correctionMatch.fixtureIds[1] },
      });
      assert.equal(
        (
          await handlers.voidUnplayedFixture(
            correctionMatch.matchId,
            targetForm(unplayedFixture.id, unplayedFixture.version),
          )
        ).error,
        undefined,
      );
      assert.equal(
        await db.resultRevision.count({ where: { fixtureId: unplayedFixture.id } }),
        0,
      );

      const forfeitMatch = await seedDoubleGroupOnlyMatch(
        db,
        `${suffix}forfeit`,
        "forfeit",
        2,
      );
      actorId = `double-result-manager-${suffix}forfeit`;
      const forfeitFixture = await db.matchFixture.findUniqueOrThrow({
        where: { id: forfeitMatch.fixtureIds[0] },
      });
      assert.ok(forfeitFixture.sideAEntryId);
      const forfeit = targetForm(forfeitFixture.id, forfeitFixture.version);
      forfeit.set("winnerEntryId", forfeitFixture.sideAEntryId);
      forfeit.set("reason", "对方赛前弃权");
      assert.equal(
        (await handlers.confirmForfeit(forfeitMatch.matchId, forfeit)).error,
        undefined,
      );
      const forfeitRevision = await db.resultRevision.findFirstOrThrow({
        where: { fixtureId: forfeitFixture.id, status: "CONFIRMED" },
      });
      assert.equal(forfeitRevision.resolutionKind, "FORFEIT");
      assert.equal(
        await db.settlementEvent.count({
          where: { resultRevisionId: forfeitRevision.id },
        }),
        0,
      );
      const forfeitFixtureAfterConfirmation =
        await db.matchFixture.findUniqueOrThrow({
          where: { id: forfeitFixture.id },
        });
      const forfeitCorrection = targetForm(
        forfeitFixture.id,
        forfeitFixtureAfterConfirmation.version,
      );
      forfeitCorrection.set("resultRevisionId", forfeitRevision.id);
      forfeitCorrection.set("reason", "原弃权胜方录反");
      assert.equal(
        (
          await handlers.correctForfeit(
            forfeitMatch.matchId,
            forfeitCorrection,
          )
        ).error,
        undefined,
      );
      const correctedForfeit = await db.resultRevision.findFirstOrThrow({
        where: {
          fixtureId: forfeitFixture.id,
          status: "CONFIRMED",
          supersedesRevisionId: forfeitRevision.id,
        },
      });
      assert.equal(correctedForfeit.resolutionKind, "FORFEIT");
      assert.equal(correctedForfeit.revisionNumber, forfeitRevision.revisionNumber + 1);
      assert.equal(correctedForfeit.winnerEntryId, forfeitRevision.loserEntryId);
      assert.equal(correctedForfeit.loserEntryId, forfeitRevision.winnerEntryId);
      assert.deepEqual(correctedForfeit.score, {
        winnerScore: 1,
        loserScore: 0,
      });
      assert.equal(correctedForfeit.createdAt.getTime(), correctedForfeit.resolvedAt?.getTime());
      assert.equal(
        await db.settlementEvent.count({
          where: {
            resultRevisionId: { in: [forfeitRevision.id, correctedForfeit.id] },
          },
        }),
        0,
      );
      assert.equal(
        await db.auditLog.count({
          where: {
            action: "v2_double_group_forfeit_correct",
            entityType: "ResultRevision",
            entityId: correctedForfeit.id,
          },
        }),
        1,
      );
      assert.equal(
        (
          await handlers.correctForfeit(
            forfeitMatch.matchId,
            forfeitCorrection,
          )
        ).error,
        undefined,
      );
      assert.equal(
        await db.resultRevision.count({
          where: { fixtureId: forfeitFixture.id },
        }),
        2,
      );
      assert.equal(
        await db.auditLog.count({
          where: {
            action: "v2_double_group_forfeit_correct",
            entityType: "ResultRevision",
            entityId: correctedForfeit.id,
          },
        }),
        1,
      );
      assert.equal(
        (await db.match.findUniqueOrThrow({ where: { id: forfeitMatch.matchId } }))
          .status,
        "finished",
      );

      const completionMatch = await seedDoubleGroupOnlyMatch(
        db,
        `${suffix}completion`,
        "completion",
        2,
      );
      actorId = `double-result-manager-${suffix}completion`;
      let completionFixture = await db.matchFixture.findUniqueOrThrow({
        where: { id: completionMatch.fixtureIds[0] },
      });
      assert.ok(
        completionFixture.sideAEntryId && completionFixture.sideBEntryId,
      );
      assert.equal(
        (
          await handlers.submitResult(
            completionMatch.matchId,
            playedForm(
              completionFixture.id,
              completionFixture.version,
              completionFixture.sideAEntryId,
            ),
          )
        ).error,
        undefined,
      );
      const completionRevision = await db.resultRevision.findFirstOrThrow({
        where: { fixtureId: completionFixture.id, status: "PENDING" },
      });
      completionFixture = await db.matchFixture.findUniqueOrThrow({
        where: { id: completionFixture.id },
      });
      actorId = completionMatch.userIdsByEntry[1][0];
      const complete = targetForm(
        completionFixture.id,
        completionFixture.version,
      );
      complete.set("resultRevisionId", completionRevision.id);
      assert.equal(
        (await handlers.confirmResult(completionMatch.matchId, complete)).error,
        undefined,
      );
      assert.equal(
        (await db.match.findUniqueOrThrow({ where: { id: completionMatch.matchId } }))
          .status,
        "finished",
      );
      assert.equal(
        await db.settlementEffect.count({
          where: {
            event: {
              resultRevisionId: completionRevision.id,
              kind: "RESULT_APPLY",
            },
          },
        }),
        4,
      );
      assert.equal(
        await db.registration.count({
          where: {
            matchId: {
              in: [
                correctionMatch.matchId,
                forfeitMatch.matchId,
                completionMatch.matchId,
              ],
            },
          },
        }),
        0,
      );
    } finally {
      await db.$disconnect();
    }
  },
);
