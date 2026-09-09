import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "@prisma/client";

import {
  createV2Entry,
  replaceV2EntryRoster,
  transitionV2EntryStatus,
} from "./entries";
import { createV2Fixture, transitionV2FixtureStatus } from "./fixtures";
import { V2ResultApplicationError } from "./results-errors";
import { createV2ResultApplicationService } from "./results";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;

test(
  "V2 entries, fixtures, results, correction, and reversal commit end to end",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const ids = {
      owner: `it-owner-${suffix}`,
      playerA: `it-a-${suffix}`,
      playerB: `it-b-${suffix}`,
      match: `it-match-${suffix}`,
    };

    try {
      const verifiedAt = new Date("2026-09-01T00:00:00Z");
      await db.user.createMany({
        data: [
          {
            id: ids.owner,
            email: `${ids.owner}@example.test`,
            nickname: "Integration owner",
            emailVerifiedAt: verifiedAt,
          },
          {
            id: ids.playerA,
            email: `${ids.playerA}@example.test`,
            nickname: "Integration A",
            emailVerifiedAt: verifiedAt,
          },
          {
            id: ids.playerB,
            email: `${ids.playerB}@example.test`,
            nickname: "Integration B",
            emailVerifiedAt: verifiedAt,
          },
        ],
      });
      await db.match.create({
        data: {
          id: ids.match,
          title: "V2 core integration",
          dateTime: new Date("2026-10-01T10:00:00Z"),
          type: "single",
          status: "registration",
          engineVersion: "V2",
          maxParticipants: 2,
          createdBy: ids.owner,
          registrationDeadline: new Date("2099-01-01T00:00:00Z"),
        },
      });

      const entryA = await createV2Entry(db, {
        actor: { id: ids.playerA, role: "user" },
        matchId: ids.match,
        kind: "INDIVIDUAL",
        sourceId: ids.playerA,
        status: "ACTIVE",
      });
      const entryB = await createV2Entry(db, {
        actor: { id: ids.playerB, role: "user" },
        matchId: ids.match,
        kind: "INDIVIDUAL",
        sourceId: ids.playerB,
        status: "ACTIVE",
      });
      const registrationEvents = await db.settlementEvent.findMany({
        where: {
          matchEntryId: { in: [entryA.id, entryB.id] },
          kind: "REGISTRATION_APPLY",
        },
        include: { effects: true },
      });
      assert.equal(registrationEvents.length, 2);
      assert.equal(
        registrationEvents.every(
          (event) => event.status === "APPLIED" && event.effects.length === 1,
        ),
        true,
      );
      assert.equal(
        await db.pointsTransaction.count({
          where: {
            userId: { in: [ids.playerA, ids.playerB] },
            referenceId: { startsWith: `match-points:${ids.match}:register:` },
          },
        }),
        2,
      );
      await db.match.update({
        where: { id: ids.match },
        data: {
          status: "ongoing",
          registrationDeadline: new Date("2026-09-01T00:00:00Z"),
        },
      });

      const readyFixture = async (fixtureKey: string) => {
        const fixture = await createV2Fixture(db, {
          actor: { id: ids.owner, role: "user" },
          matchId: ids.match,
          fixtureKey,
          stage: { stage: "FREE_PLAY" },
          sideAEntryId: entryA.id,
          sideBEntryId: entryB.id,
        });
        const ready = await transitionV2FixtureStatus(db, {
          actor: { id: ids.owner, role: "user" },
          matchId: ids.match,
          fixtureId: fixture.id,
          expectedVersion: fixture.version,
          to: "READY",
        });
        return { id: fixture.id, version: ready.version };
      };

      const firstFixture = await readyFixture(`integration-1-${suffix}`);
      const secondFixture = await readyFixture(`integration-2-${suffix}`);
      const service = createV2ResultApplicationService({
        db,
        clock: () => new Date("2026-09-04T12:00:00Z"),
      });

      const voidFixtureAfterTerminalPending = async (
        fixtureKey: string,
        terminalStatus: "REJECTED" | "VOIDED",
      ) => {
        const fixture = await readyFixture(fixtureKey);
        const revision = await service.submitRevision({
          actor: { actorId: ids.playerA, role: "user" },
          matchId: ids.match,
          fixtureId: fixture.id,
          expectedFixtureVersion: fixture.version,
          winnerEntryId: entryA.id,
          loserEntryId: entryB.id,
          score: { bestOf: 5, winnerScore: 3, loserScore: 1 },
        });
        const terminalCommand = {
          actor: { actorId: ids.owner, role: "user" as const },
          matchId: ids.match,
          fixtureId: fixture.id,
          expectedFixtureVersion: fixture.version + 1,
          resultRevisionId: revision.id,
        };
        const terminalRevision =
          terminalStatus === "REJECTED"
            ? await service.rejectRevision(terminalCommand)
            : await service.voidRevision(terminalCommand);
        assert.equal(terminalRevision.status, terminalStatus);

        const voided = await transitionV2FixtureStatus(db, {
          actor: { id: ids.owner, role: "user" },
          matchId: ids.match,
          fixtureId: fixture.id,
          expectedVersion: fixture.version + 2,
          to: "VOIDED",
        });
        assert.equal(voided.status, "VOIDED");
        assert.equal(voided.version, fixture.version + 3);
        assert.equal(
          await db.resultRevision.count({ where: { fixtureId: fixture.id } }),
          1,
        );
      };

      await voidFixtureAfterTerminalPending(
        `integration-rejected-${suffix}`,
        "REJECTED",
      );
      await voidFixtureAfterTerminalPending(
        `integration-voided-${suffix}`,
        "VOIDED",
      );

      const confirmAWin = async (
        fixture: { id: string; version: number },
        concurrently = false,
      ) => {
        const submitted = await service.submitRevision({
          actor: { actorId: ids.playerA, role: "user" },
          matchId: ids.match,
          fixtureId: fixture.id,
          expectedFixtureVersion: fixture.version,
          winnerEntryId: entryA.id,
          loserEntryId: entryB.id,
          score: { bestOf: 5, winnerScore: 3, loserScore: 1 },
        });
        const confirm = () => service.confirmRevision({
          actor: { actorId: ids.playerB, role: "user" },
          matchId: ids.match,
          fixtureId: fixture.id,
          expectedFixtureVersion: fixture.version + 1,
          resultRevisionId: submitted.id,
        });
        if (!concurrently) return confirm();

        const attempts = await Promise.allSettled([
          confirm(),
          service.confirmRevision({
            actor: { actorId: ids.owner, role: "user" },
            matchId: ids.match,
            fixtureId: fixture.id,
            expectedFixtureVersion: fixture.version + 1,
            resultRevisionId: submitted.id,
          }),
        ]);
        const fulfilled = attempts.filter(
          (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof confirm>>> =>
            attempt.status === "fulfilled",
        );
        assert.equal(fulfilled.length >= 1, true);
        for (const attempt of attempts) {
          if (attempt.status === "rejected") {
            assert.equal(
              attempt.reason instanceof V2ResultApplicationError &&
                attempt.reason.code,
              "CONCURRENT_WRITE_CONFLICT",
              attempt.reason instanceof V2ResultApplicationError
                ? JSON.stringify(attempt.reason.details)
                : String(attempt.reason),
            );
          }
        }
        return fulfilled[0].value;
      };

      const firstResult = await confirmAWin(firstFixture, true);
      assert.equal(
        (await db.match.findUniqueOrThrow({ where: { id: ids.match } })).status,
        "ongoing",
      );
      await confirmAWin(secondFixture);
      assert.equal(
        (await db.match.findUniqueOrThrow({ where: { id: ids.match } })).status,
        "ongoing",
      );
      const afterLaterFixture = await db.user.findMany({
        where: { id: { in: [ids.playerA, ids.playerB] } },
        orderBy: { id: "asc" },
      });
      const afterLaterById = new Map(
        afterLaterFixture.map((user) => [user.id, user]),
      );
      assert.equal(afterLaterById.get(ids.playerA)?.eloRating, 1238);
      assert.equal(afterLaterById.get(ids.playerB)?.eloRating, 1162);

      const correction = await service.submitCorrection({
        actor: { actorId: ids.owner, role: "user" },
        matchId: ids.match,
        fixtureId: firstFixture.id,
        expectedFixtureVersion: firstFixture.version + 2,
        score: { bestOf: 5, winnerScore: 3, loserScore: 1 },
        resultRevisionId: firstResult.id,
        reason: "integration winner swap",
      });
      const corrected = await service.confirmRevision({
        actor: { actorId: ids.owner, role: "user" },
        matchId: ids.match,
        fixtureId: firstFixture.id,
        expectedFixtureVersion: firstFixture.version + 3,
        resultRevisionId: correction.id,
      });
      assert.equal(corrected.status, "CONFIRMED");

      const afterCorrection = await db.user.findMany({
        where: { id: { in: [ids.playerA, ids.playerB] } },
      });
      const correctedById = new Map(
        afterCorrection.map((user) => [user.id, user]),
      );
      assert.deepEqual(
        {
          elo: correctedById.get(ids.playerA)?.eloRating,
          points: correctedById.get(ids.playerA)?.points,
          wins: correctedById.get(ids.playerA)?.wins,
          losses: correctedById.get(ids.playerA)?.losses,
          matches: correctedById.get(ids.playerA)?.matchesPlayed,
        },
        { elo: 1198, points: 2, wins: 1, losses: 1, matches: 2 },
      );
      assert.deepEqual(
        {
          elo: correctedById.get(ids.playerB)?.eloRating,
          points: correctedById.get(ids.playerB)?.points,
          wins: correctedById.get(ids.playerB)?.wins,
          losses: correctedById.get(ids.playerB)?.losses,
          matches: correctedById.get(ids.playerB)?.matchesPlayed,
        },
        { elo: 1202, points: 2, wins: 1, losses: 1, matches: 2 },
      );

      const correctionEffects = await db.settlementEffect.findMany({
        where: {
          event: {
            resultRevisionId: correction.id,
            kind: "RESULT_APPLY",
          },
        },
      });
      const correctionEffectById = new Map(
        correctionEffects.map((effect) => [effect.userId, effect]),
      );
      assert.deepEqual(
        {
          before: correctionEffectById.get(ids.playerA)?.eloBefore,
          delta: correctionEffectById.get(ids.playerA)?.eloDelta,
          after: correctionEffectById.get(ids.playerA)?.eloAfter,
        },
        { before: 1218, delta: -20, after: 1198 },
      );
      assert.deepEqual(
        {
          before: correctionEffectById.get(ids.playerB)?.eloBefore,
          delta: correctionEffectById.get(ids.playerB)?.eloDelta,
          after: correctionEffectById.get(ids.playerB)?.eloAfter,
        },
        { before: 1182, delta: 20, after: 1202 },
      );

      await service.confirmRevision({
        actor: { actorId: ids.owner, role: "user" },
        matchId: ids.match,
        fixtureId: firstFixture.id,
        expectedFixtureVersion: firstFixture.version + 3,
        resultRevisionId: correction.id,
      });
      assert.equal(
        await db.settlementEvent.count({
          where: { resultRevisionId: correction.id },
        }),
        1,
      );

      await db.user.update({
        where: { id: ids.playerB },
        data: { points: 0, isBanned: true },
      });
      await service.voidRevision({
        actor: { actorId: ids.owner, role: "user" },
        matchId: ids.match,
        fixtureId: firstFixture.id,
        expectedFixtureVersion: firstFixture.version + 4,
        resultRevisionId: correction.id,
        reason: "integration void",
      });
      const reversal = await db.settlementEvent.findFirstOrThrow({
        where: {
          resultRevisionId: correction.id,
          kind: "RESULT_REVERSAL",
        },
      });
      assert.deepEqual(
        (reversal.metadata as { unrecoveredPoints: unknown }).unrecoveredPoints,
        [{ userId: ids.playerB, amount: 1 }],
      );
      const voidedFixture = await db.matchFixture.findUniqueOrThrow({
        where: { id: firstFixture.id },
      });
      assert.equal(voidedFixture.status, "VOIDED");
      assert.equal(
        (await db.match.findUniqueOrThrow({ where: { id: ids.match } })).status,
        "ongoing",
      );

      const teamMatchId = `it-team-match-${suffix}`;
      const sourceTeamId = `it-source-team-${suffix}`;
      await db.user.update({
        where: { id: ids.playerB },
        data: { isBanned: false },
      });
      await db.match.create({
        data: {
          id: teamMatchId,
          title: "V2 team roster integration",
          dateTime: new Date("2026-11-01T10:00:00Z"),
          type: "team",
          status: "registration",
          engineVersion: "V2",
          maxParticipants: 8,
          createdBy: ids.owner,
          registrationDeadline: new Date("2099-01-01T00:00:00Z"),
          teamRegistrationDeadline: new Date("2099-01-01T00:00:00Z"),
          teamMinMembers: 2,
          teamMaxMembers: 4,
        },
      });
      await db.matchTeam.create({
        data: {
          id: sourceTeamId,
          matchId: teamMatchId,
          captainId: ids.playerA,
          name: "Integration team",
          inviteCode: `it-team-${suffix}`,
          status: "approved",
          members: {
            create: [
              { userId: ids.playerA },
              { userId: ids.playerB },
            ],
          },
        },
      });

      const teamEntry = await createV2Entry(db, {
        actor: { id: ids.playerA, role: "user" },
        matchId: teamMatchId,
        kind: "TEAM",
        sourceId: sourceTeamId,
        status: "ACTIVE",
      });
      await db.matchTeamMember.delete({
        where: {
          teamId_userId: { teamId: sourceTeamId, userId: ids.playerB },
        },
      });
      await db.matchTeamMember.create({
        data: {
          teamId: sourceTeamId,
          matchId: teamMatchId,
          userId: ids.owner,
        },
      });

      const successor = await replaceV2EntryRoster(db, {
        actor: { id: ids.playerA, role: "user" },
        matchId: teamMatchId,
        entryId: teamEntry.id,
        expectedVersion: teamEntry.version,
        memberIds: [ids.playerA, ids.owner],
      });
      await transitionV2EntryStatus(db, {
        actor: { id: ids.playerA, role: "user" },
        matchId: teamMatchId,
        entryId: teamEntry.id,
        expectedVersion: successor.version,
        to: "WITHDRAWN",
      });

      const teamEvents = await db.settlementEvent.findMany({
        where: { matchEntryId: teamEntry.id },
        include: { effects: true },
      });
      const rosterVersionOf = (event: (typeof teamEvents)[number]) =>
        (event.metadata as { rosterVersion?: number } | null)?.rosterVersion;
      const rosterOneApply = teamEvents.find(
        (event) =>
          event.kind === "REGISTRATION_APPLY" &&
          rosterVersionOf(event) === 1,
      );
      const rosterTwoApply = teamEvents.find(
        (event) =>
          event.kind === "REGISTRATION_APPLY" &&
          rosterVersionOf(event) === 2,
      );
      const rosterTwoReversal = teamEvents.find(
        (event) =>
          event.kind === "REGISTRATION_REVERSAL" &&
          rosterVersionOf(event) === 2,
      );
      assert.ok(rosterOneApply);
      assert.ok(rosterTwoApply);
      assert.ok(rosterTwoReversal);
      assert.equal(teamEvents.length, 3);
      assert.equal(rosterOneApply.status, "APPLIED");
      assert.equal(rosterTwoApply.status, "REVERSED");
      assert.equal(rosterTwoReversal.status, "APPLIED");
      assert.equal(rosterTwoReversal.reversesEventId, rosterTwoApply.id);
      assert.equal(
        teamEvents.every(
          (event) =>
            event.effects.length === 2 &&
            event.effects.every(
              (effect) =>
                effect.eloBefore === null &&
                effect.eloAfter === null &&
                effect.eloDelta === null &&
                effect.pointsDelta === 0 &&
                effect.winsDelta === 0 &&
                effect.lossesDelta === 0 &&
                effect.matchesPlayedDelta === 0,
            ),
        ),
        true,
      );
      assert.equal(
        await db.pointsTransaction.count({
          where: {
            referenceId: { startsWith: `match-points:${teamMatchId}:` },
          },
        }),
        0,
      );
    } finally {
      await db.$disconnect();
    }
  },
);
