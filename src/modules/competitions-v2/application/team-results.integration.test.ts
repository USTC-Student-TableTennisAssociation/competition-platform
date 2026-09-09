import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import { createV2TeamResultActionHandlers } from "../adapters/team-result-actions";
import { getV2TeamRegistrationReadState } from "../read-model/team-registration";
import { createV2TeamGroupingApplicationService } from "./team-grouping";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;
const VERIFIED_AT = new Date("2026-08-01T00:00:00.000Z");
const PUBLISHED_AT = new Date("2026-09-05T12:00:00.000Z");

type SeededTeamMatch = Readonly<{
  matchId: string;
  managerId: string;
  entryIds: readonly string[];
  userIdsByEntry: readonly (readonly string[])[];
  captainByEntryId: ReadonlyMap<string, string>;
  fixtureIds: readonly string[];
}>;

function targetForm(fixtureId: string, fixtureVersion: number) {
  const formData = new FormData();
  formData.set("csrfToken", "integration-csrf");
  formData.set("fixtureId", fixtureId);
  formData.set("expectedFixtureVersion", String(fixtureVersion));
  return formData;
}

function aggregateResultForm(
  fixtureId: string,
  fixtureVersion: number,
  winnerEntryId: string,
  winnerScore = 5,
  loserScore = 3,
) {
  const formData = targetForm(fixtureId, fixtureVersion);
  formData.set("winnerEntryId", winnerEntryId);
  formData.set("winnerScore", String(winnerScore));
  formData.set("loserScore", String(loserScore));
  return formData;
}

async function seedTeamGroupOnlyMatch(
  db: PrismaClient,
  suffix: string,
  label: string,
  entryCount: 2 | 3,
): Promise<SeededTeamMatch> {
  const managerId = `team-result-manager-${label}-${suffix}`;
  const matchId = `team-result-match-${label}-${suffix}`;
  const userIdsByEntry = Array.from({ length: entryCount }, (_, entryIndex) =>
    [1, 2, 3].map(
      (slot) => `team-result-${label}-${entryIndex + 1}-${slot}-${suffix}`,
    ),
  );
  await db.user.createMany({
    data: [
      {
        id: managerId,
        email: `${managerId}@example.test`,
        nickname: `${label} TEAM manager`,
        emailVerifiedAt: VERIFIED_AT,
      },
      ...userIdsByEntry.flatMap((userIds, entryIndex) =>
        userIds.map((id, memberIndex) => ({
          id,
          email: `${id}@example.test`,
          nickname: `${label} team ${entryIndex + 1}-${memberIndex + 1}`,
          emailVerifiedAt: VERIFIED_AT,
          eloRating: 1_180 + entryIndex * 60 + memberIndex * 5,
          points: 10 + entryIndex + memberIndex,
        })),
      ),
    ],
  });
  await db.match.create({
    data: {
      id: matchId,
      title: `TEAM result ${label}`,
      dateTime: new Date("2026-10-01T10:00:00.000Z"),
      type: "team",
      status: "registration",
      engineVersion: "V2",
      format: "group_only",
      maxParticipants: entryCount,
      createdBy: managerId,
      registrationDeadline: new Date("2026-09-02T00:00:00.000Z"),
      teamRegistrationStart: new Date("2026-08-01T00:00:00.000Z"),
      teamRegistrationDeadline: new Date("2026-09-02T00:00:00.000Z"),
      teamMinMembers: 3,
      teamMaxMembers: 6,
    },
  });

  const entries: Array<{ id: string; version: number }> = [];
  for (const [entryIndex, userIds] of userIdsByEntry.entries()) {
    const sourceId = `team-result-source-${label}-${entryIndex + 1}-${suffix}`;
    await db.matchTeam.create({
      data: {
        id: sourceId,
        matchId,
        captainId: userIds[0],
        name: `${label} TEAM ${entryIndex + 1}`,
        inviteCode: `team-result-invite-${label}-${entryIndex + 1}-${suffix}`,
        status: "approved",
        submittedAt: new Date("2026-08-20T00:00:00.000Z"),
        reviewedAt: new Date("2026-08-21T00:00:00.000Z"),
        members: {
          create: userIds.map((userId, memberIndex) => ({
            userId,
            joinedAt: new Date(
              Date.UTC(2026, 7, 10 + entryIndex, memberIndex),
            ),
          })),
        },
      },
    });
    entries.push(
      await db.matchEntry.create({
        data: {
          matchId,
          kind: "TEAM",
          status: "ACTIVE",
          sourceKey: `team:${sourceId}`,
          sourceMatchTeamId: sourceId,
          displayNameSnapshot: `${label} TEAM ${entryIndex + 1}`,
          members: {
            create: userIds.map((userId, memberIndex) => ({
              userId,
              displayNameSnapshot: `${label} frozen ${entryIndex + 1}-${memberIndex + 1}`,
              role: memberIndex === 0 ? "captain" : "player",
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

  const grouping = createV2TeamGroupingApplicationService({
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
    managerId,
    entryIds: entries.map((entry) => entry.id),
    userIdsByEntry,
    captainByEntryId: new Map(
      entries.map((entry, index) => [entry.id, userIdsByEntry[index][0]]),
    ),
    fixtureIds: fixtures.map((fixture) => fixture.id),
  };
}

test(
  "real PostgreSQL closes TEAM group results with captain auth, full rosters, reversals, forfeits, voids, and completion",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    let actorId = "";
    const handlers = createV2TeamResultActionHandlers({
      db,
      validateCsrfToken: async () => null,
      getCurrentUser: async () => ({ id: actorId, role: "user" }),
      logError: async () => undefined,
    });

    try {
      const correctionMatch = await seedTeamGroupOnlyMatch(
        db,
        suffix,
        "correction",
        3,
      );
      const playedFixtureId = correctionMatch.fixtureIds[0];
      let playedFixture = await db.matchFixture.findUniqueOrThrow({
        where: { id: playedFixtureId },
      });
      const winnerEntryId = playedFixture.sideAEntryId;
      const loserEntryId = playedFixture.sideBEntryId;
      assert.ok(winnerEntryId && loserEntryId);

      actorId = correctionMatch.userIdsByEntry[
        correctionMatch.entryIds.indexOf(winnerEntryId)
      ][1];
      assert.equal(
        typeof (
          await handlers.submitResult(
            correctionMatch.matchId,
            aggregateResultForm(
              playedFixtureId,
              playedFixture.version,
              winnerEntryId,
            ),
          )
        ).error,
        "string",
      );
      assert.equal(
        await db.resultRevision.count({ where: { fixtureId: playedFixtureId } }),
        0,
      );

      actorId = correctionMatch.captainByEntryId.get(winnerEntryId)!;
      assert.deepEqual(
        await handlers.submitResult(
          correctionMatch.matchId,
          aggregateResultForm(
            playedFixtureId,
            playedFixture.version,
            winnerEntryId,
          ),
        ),
        { success: "已登记，等待对方队长或管理员确认。" },
      );
      let pending = await db.resultRevision.findFirstOrThrow({
        where: { fixtureId: playedFixtureId, status: "PENDING" },
      });
      const pendingRead = await getV2TeamRegistrationReadState(
        db,
        correctionMatch.matchId,
        PUBLISHED_AT,
      );
      assert.equal(pendingRead.kind, "TEAM_V2_REGISTRATION");
      if (pendingRead.kind !== "TEAM_V2_REGISTRATION") {
        assert.fail("TEAM result projection was unavailable");
      }
      const relationalFixture = pendingRead.grouping.groups[0].fixtures.find(
        (fixture) => fixture.fixtureId === playedFixtureId,
      );
      assert.equal(relationalFixture?.sideA.members.length, 3);
      assert.equal(relationalFixture?.sideB.members.length, 3);
      assert.equal(
        relationalFixture?.sideA.members.filter(
          (member) => member.role === "captain",
        ).length,
        1,
      );
      assert.equal(relationalFixture?.activeResult.state, "PENDING");

      playedFixture = await db.matchFixture.findUniqueOrThrow({
        where: { id: playedFixtureId },
      });
      const reject = targetForm(playedFixtureId, playedFixture.version);
      reject.set("resultRevisionId", pending.id);
      reject.set("reason", "首次录入需重新确认");
      actorId = correctionMatch.managerId;
      assert.equal(
        (await handlers.rejectResult(correctionMatch.matchId, reject)).error,
        undefined,
      );
      assert.equal(
        (await db.resultRevision.findUniqueOrThrow({ where: { id: pending.id } }))
          .status,
        "REJECTED",
      );

      playedFixture = await db.matchFixture.findUniqueOrThrow({
        where: { id: playedFixtureId },
      });
      actorId = correctionMatch.captainByEntryId.get(winnerEntryId)!;
      assert.equal(
        (
          await handlers.submitResult(
            correctionMatch.matchId,
            aggregateResultForm(
              playedFixtureId,
              playedFixture.version,
              winnerEntryId,
              4,
              2,
            ),
          )
        ).error,
        undefined,
      );
      pending = await db.resultRevision.findFirstOrThrow({
        where: { fixtureId: playedFixtureId, status: "PENDING" },
      });
      playedFixture = await db.matchFixture.findUniqueOrThrow({
        where: { id: playedFixtureId },
      });

      actorId = correctionMatch.userIdsByEntry[
        correctionMatch.entryIds.indexOf(loserEntryId)
      ][1];
      const memberConfirm = targetForm(playedFixtureId, playedFixture.version);
      memberConfirm.set("resultRevisionId", pending.id);
      assert.equal(
        typeof (
          await handlers.confirmResult(correctionMatch.matchId, memberConfirm)
        ).error,
        "string",
      );

      actorId = correctionMatch.captainByEntryId.get(loserEntryId)!;
      assert.equal(
        (
          await handlers.confirmResult(correctionMatch.matchId, memberConfirm)
        ).error,
        undefined,
      );
      const initialApply = await db.settlementEvent.findFirstOrThrow({
        where: { resultRevisionId: pending.id, kind: "RESULT_APPLY" },
        include: { effects: true },
      });
      assert.equal(initialApply.effects.length, 6);
      const participatingUserIds = [winnerEntryId, loserEntryId]
        .flatMap(
          (entryId) =>
            correctionMatch.userIdsByEntry[
              correctionMatch.entryIds.indexOf(entryId)
            ],
        )
        .sort();
      assert.deepEqual(
        initialApply.effects.map((effect) => effect.userId).sort(),
        participatingUserIds,
      );

      playedFixture = await db.matchFixture.findUniqueOrThrow({
        where: { id: playedFixtureId },
      });
      actorId = correctionMatch.managerId;
      const correction = targetForm(playedFixtureId, playedFixture.version);
      correction.set("resultRevisionId", pending.id);
      correction.set("winnerScore", "5");
      correction.set("loserScore", "4");
      assert.equal(
        (
          await handlers.submitCorrection(
            correctionMatch.matchId,
            correction,
          )
        ).error,
        undefined,
      );
      const correctionRevision = await db.resultRevision.findFirstOrThrow({
        where: { fixtureId: playedFixtureId, status: "PENDING" },
      });
      assert.equal(correctionRevision.winnerEntryId, loserEntryId);
      assert.equal(correctionRevision.loserEntryId, winnerEntryId);
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
      const reversal = await db.settlementEvent.findFirstOrThrow({
        where: { resultRevisionId: pending.id, kind: "RESULT_REVERSAL" },
        include: { effects: true },
      });
      const correctionApply = await db.settlementEvent.findFirstOrThrow({
        where: {
          resultRevisionId: correctionRevision.id,
          kind: "RESULT_APPLY",
        },
        include: { effects: true },
      });
      assert.equal(reversal.effects.length, 6);
      assert.equal(correctionApply.effects.length, 6);

      playedFixture = await db.matchFixture.findUniqueOrThrow({
        where: { id: playedFixtureId },
      });
      const voidConfirmed = targetForm(
        playedFixtureId,
        playedFixture.version,
      );
      voidConfirmed.set("resultRevisionId", correctionRevision.id);
      voidConfirmed.set("reason", "整场录入无效");
      assert.equal(
        (
          await handlers.voidResult(
            correctionMatch.matchId,
            voidConfirmed,
          )
        ).error,
        undefined,
      );
      const voidReversal = await db.settlementEvent.findFirstOrThrow({
        where: {
          resultRevisionId: correctionRevision.id,
          kind: "RESULT_REVERSAL",
        },
        include: { effects: true },
      });
      assert.equal(voidReversal.effects.length, 6);
      assert.equal(
        (
          await db.matchFixture.findUniqueOrThrow({
            where: { id: playedFixtureId },
          })
        ).status,
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

      const forfeitMatch = await seedTeamGroupOnlyMatch(
        db,
        `${suffix}forfeit`,
        "forfeit",
        2,
      );
      actorId = forfeitMatch.managerId;
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
      assert.equal(
        (
          await db.match.findUniqueOrThrow({
            where: { id: forfeitMatch.matchId },
          })
        ).status,
        "finished",
      );

      const completionMatch = await seedTeamGroupOnlyMatch(
        db,
        `${suffix}completion`,
        "completion",
        2,
      );
      let completionFixture = await db.matchFixture.findUniqueOrThrow({
        where: { id: completionMatch.fixtureIds[0] },
      });
      assert.ok(
        completionFixture.sideAEntryId && completionFixture.sideBEntryId,
      );
      actorId = completionMatch.captainByEntryId.get(
        completionFixture.sideAEntryId,
      )!;
      assert.equal(
        (
          await handlers.submitResult(
            completionMatch.matchId,
            aggregateResultForm(
              completionFixture.id,
              completionFixture.version,
              completionFixture.sideAEntryId,
              3,
              1,
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
      actorId = completionMatch.captainByEntryId.get(
        completionFixture.sideBEntryId!,
      )!;
      const complete = targetForm(
        completionFixture.id,
        completionFixture.version,
      );
      complete.set("resultRevisionId", completionRevision.id);
      assert.equal(
        (
          await handlers.confirmResult(completionMatch.matchId, complete)
        ).error,
        undefined,
      );
      assert.equal(
        (
          await db.match.findUniqueOrThrow({
            where: { id: completionMatch.matchId },
          })
        ).status,
        "finished",
      );
      assert.equal(
        await db.settlementEffect.count({
          where: { event: { resultRevisionId: completionRevision.id } },
        }),
        6,
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
