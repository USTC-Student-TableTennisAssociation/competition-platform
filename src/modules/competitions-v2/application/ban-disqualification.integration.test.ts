import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";

import {
  setUserBanState,
  setUsersBanState,
} from "../../../lib/server/user/ban-user";
import { createV2Entry } from "./entries";
import { createV2Fixture, transitionV2FixtureStatus } from "./fixtures";
import {
  createV2ResultApplicationService,
  type V2ResultDatabase,
} from "./results";
import { V2ResultApplicationError } from "./results-errors";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;

test(
  "V2 SINGLE group_only ban disqualifies active identity without rewriting confirmed history",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const ids = {
      admin: `ban-admin-${suffix}`,
      target: `ban-target-${suffix}`,
      opponent: `ban-opponent-${suffix}`,
      match: `ban-match-${suffix}`,
    };
    const matchIds = [ids.match];
    const userIds = [ids.admin, ids.target, ids.opponent];

    try {
      const verifiedAt = new Date("2026-09-05T00:00:00.000Z");
      await db.user.createMany({
        data: [
          {
            id: ids.admin,
            email: `${ids.admin}@example.test`,
            nickname: ids.admin,
            role: "admin",
            emailVerifiedAt: verifiedAt,
          },
          {
            id: ids.target,
            email: `${ids.target}@example.test`,
            nickname: ids.target,
            emailVerifiedAt: verifiedAt,
          },
          {
            id: ids.opponent,
            email: `${ids.opponent}@example.test`,
            nickname: ids.opponent,
            emailVerifiedAt: verifiedAt,
          },
        ],
      });
      await db.match.create({
        data: {
          id: ids.match,
          title: ids.match,
          dateTime: new Date("2026-10-01T10:00:00.000Z"),
          type: "single",
          format: "group_only",
          status: "registration",
          engineVersion: "V2",
          maxParticipants: 8,
          createdBy: ids.admin,
          registrationDeadline: new Date("2099-01-01T00:00:00.000Z"),
        },
      });

      const targetEntry = await createV2Entry(db, {
        actor: { id: ids.target, role: "user" },
        matchId: ids.match,
        kind: "INDIVIDUAL",
        sourceId: ids.target,
        status: "ACTIVE",
      });
      const opponentEntry = await createV2Entry(db, {
        actor: { id: ids.opponent, role: "user" },
        matchId: ids.match,
        kind: "INDIVIDUAL",
        sourceId: ids.opponent,
        status: "ACTIVE",
      });
      await db.match.update({
        where: { id: ids.match },
        data: {
          status: "ongoing",
          registrationDeadline: new Date("2026-09-01T00:00:00.000Z"),
        },
      });

      const createFixture = (fixtureKey: string) =>
        createV2Fixture(db, {
          actor: { id: ids.admin, role: "admin" },
          matchId: ids.match,
          fixtureKey: `${fixtureKey}-${suffix}`,
          stage: { stage: "GROUP", groupKey: "A" },
          sideAEntryId: targetEntry.id,
          sideBEntryId: opponentEntry.id,
        });
      const makeReady = async (fixtureKey: string) => {
        const fixture = await createFixture(fixtureKey);
        return transitionV2FixtureStatus(db, {
          actor: { id: ids.admin, role: "admin" },
          matchId: ids.match,
          fixtureId: fixture.id,
          expectedVersion: fixture.version,
          to: "READY",
        });
      };

      const scheduledFixture = await createFixture("scheduled");
      const readyFixture = await makeReady("ready");
      const pendingFixture = await makeReady("pending");
      const completedFixture = await makeReady("completed");
      const resultService = createV2ResultApplicationService({
        db,
        clock: () => new Date("2026-09-05T08:00:00.000Z"),
      });
      const pendingRevision = await resultService.submitRevision({
        actor: { actorId: ids.target, role: "user" },
        matchId: ids.match,
        fixtureId: pendingFixture.id,
        expectedFixtureVersion: pendingFixture.version,
        winnerEntryId: targetEntry.id,
        loserEntryId: opponentEntry.id,
        score: { bestOf: 5, winnerScore: 3, loserScore: 1 },
      });
      const completedPendingRevision = await resultService.submitRevision({
        actor: { actorId: ids.target, role: "user" },
        matchId: ids.match,
        fixtureId: completedFixture.id,
        expectedFixtureVersion: completedFixture.version,
        winnerEntryId: targetEntry.id,
        loserEntryId: opponentEntry.id,
        score: { bestOf: 5, winnerScore: 3, loserScore: 1 },
      });
      const confirmedRevision = await resultService.confirmRevision({
        actor: { actorId: ids.opponent, role: "user" },
        matchId: ids.match,
        fixtureId: completedFixture.id,
        expectedFixtureVersion: completedFixture.version + 1,
        resultRevisionId: completedPendingRevision.id,
      });
      const correctionRevision = await resultService.submitCorrection({
        actor: { actorId: ids.admin, role: "admin" },
        matchId: ids.match,
        fixtureId: completedFixture.id,
        expectedFixtureVersion: completedFixture.version + 2,
        resultRevisionId: confirmedRevision.id,
        score: { bestOf: 5, winnerScore: 3, loserScore: 2 },
        reason: "integration correction",
      });

      const beforeBan = await db.user.findUniqueOrThrow({
        where: { id: ids.target },
        select: {
          points: true,
          eloRating: true,
          wins: true,
          losses: true,
          matchesPlayed: true,
          sessionVersion: true,
        },
      });
      const confirmedSettlement = await db.settlementEvent.findFirstOrThrow({
        where: {
          resultRevisionId: confirmedRevision.id,
          kind: "RESULT_APPLY",
        },
        select: { id: true, status: true },
      });
      assert.equal(confirmedSettlement.status, "APPLIED");

      const banResult = await db.$transaction(
        (tx) =>
          setUserBanState(tx, {
            userId: ids.target,
            banned: true,
            actorId: ids.admin,
          }),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5_000,
          timeout: 30_000,
        },
      );

      assert.deepEqual(banResult.removedMatches, [
        { id: ids.match, title: ids.match },
      ]);
      assert.equal(banResult.v2Disqualifications.length, 1);
      assert.equal(banResult.v2Disqualifications[0].entryId, targetEntry.id);
      assert.deepEqual(
        [...banResult.v2Disqualifications[0].voidedFixtureIds].sort(),
        [scheduledFixture.id, readyFixture.id, pendingFixture.id].sort(),
      );
      assert.deepEqual(
        [...banResult.v2Disqualifications[0].voidedResultRevisionIds].sort(),
        [pendingRevision.id, correctionRevision.id].sort(),
      );
      assert.deepEqual(banResult.v2CorrectionCleanups, []);
      assert.ok(banResult.notificationOutboxId);

      const [afterBan, entryAfterBan, memberAfterBan] = await Promise.all([
        db.user.findUniqueOrThrow({
          where: { id: ids.target },
          select: {
            isBanned: true,
            points: true,
            eloRating: true,
            wins: true,
            losses: true,
            matchesPlayed: true,
            sessionVersion: true,
          },
        }),
        db.matchEntry.findUniqueOrThrow({ where: { id: targetEntry.id } }),
        db.matchEntryMember.findFirstOrThrow({
          where: { entryId: targetEntry.id, userId: ids.target },
        }),
      ]);
      assert.deepEqual(afterBan, {
        isBanned: true,
        points: beforeBan.points - 1,
        eloRating: beforeBan.eloRating,
        wins: beforeBan.wins,
        losses: beforeBan.losses,
        matchesPlayed: beforeBan.matchesPlayed,
        sessionVersion: beforeBan.sessionVersion + 1,
      });
      assert.equal(entryAfterBan.status, "DISQUALIFIED");
      assert.ok(entryAfterBan.disqualifiedAt);
      assert.equal(memberAfterBan.status, "DISQUALIFIED");
      assert.ok(memberAfterBan.effectiveUntil);
      assert.equal(memberAfterBan.endReason, "USER_BANNED");

      const fixturesAfterBan = new Map(
        (
          await db.matchFixture.findMany({
            where: { matchId: ids.match },
            select: { id: true, status: true },
          })
        ).map((fixture) => [fixture.id, fixture.status]),
      );
      assert.equal(fixturesAfterBan.get(scheduledFixture.id), "VOIDED");
      assert.equal(fixturesAfterBan.get(readyFixture.id), "VOIDED");
      assert.equal(fixturesAfterBan.get(pendingFixture.id), "VOIDED");
      assert.equal(fixturesAfterBan.get(completedFixture.id), "COMPLETED");
      assert.equal(
        (await db.match.findUniqueOrThrow({ where: { id: ids.match } })).status,
        "ongoing",
      );

      const revisionsAfterBan = await db.resultRevision.findMany({
        where: {
          id: {
            in: [
              pendingRevision.id,
              confirmedRevision.id,
              correctionRevision.id,
            ],
          },
        },
        select: {
          id: true,
          status: true,
          reason: true,
          verifiedById: true,
          resolvedAt: true,
        },
      });
      const revisionsById = new Map(
        revisionsAfterBan.map((revision) => [revision.id, revision]),
      );
      for (const revisionId of [pendingRevision.id, correctionRevision.id]) {
        const revision = revisionsById.get(revisionId);
        assert.equal(revision?.status, "VOIDED");
        assert.equal(revision?.reason, "USER_BANNED");
        assert.equal(revision?.verifiedById, ids.admin);
        assert.ok(revision?.resolvedAt);
      }
      assert.equal(revisionsById.get(confirmedRevision.id)?.status, "CONFIRMED");
      assert.equal(
        (
          await db.settlementEvent.findUniqueOrThrow({
            where: { id: confirmedSettlement.id },
            select: { status: true },
          })
        ).status,
        "APPLIED",
      );
      assert.deepEqual(
        await db.settlementEvent.findMany({
          where: { matchEntryId: targetEntry.id },
          orderBy: { createdAt: "asc" },
          select: { kind: true, status: true },
        }),
        [
          { kind: "REGISTRATION_APPLY", status: "REVERSED" },
          { kind: "REGISTRATION_REVERSAL", status: "APPLIED" },
        ],
      );

      const audit = await db.auditLog.findFirstOrThrow({
        where: { action: "user.ban", entityId: ids.target },
        orderBy: { createdAt: "desc" },
        select: { details: true },
      });
      const auditDetails = audit.details as {
        removedMatchIds?: unknown;
        v2Disqualifications?: Array<{
          entryId: string;
          voidedFixtureIds: string[];
          voidedResultRevisionIds: string[];
        }>;
      };
      assert.deepEqual(auditDetails.removedMatchIds, [ids.match]);
      assert.equal(auditDetails.v2Disqualifications?.[0]?.entryId, targetEntry.id);
      assert.deepEqual(
        [...(auditDetails.v2Disqualifications?.[0]?.voidedFixtureIds ?? [])].sort(),
        [scheduledFixture.id, readyFixture.id, pendingFixture.id].sort(),
      );
      assert.deepEqual(
        [
          ...(auditDetails.v2Disqualifications?.[0]
            ?.voidedResultRevisionIds ?? []),
        ].sort(),
        [pendingRevision.id, correctionRevision.id].sort(),
      );

      const repeatedBan = await db.$transaction(
        (tx) =>
          setUserBanState(tx, {
            userId: ids.target,
            banned: true,
            actorId: ids.admin,
          }),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      assert.deepEqual(repeatedBan.removedMatches, []);
      assert.deepEqual(repeatedBan.v2Disqualifications, []);
      assert.deepEqual(repeatedBan.v2CorrectionCleanups, []);
      assert.equal(repeatedBan.notificationOutboxId, null);
      assert.equal(
        await db.settlementEvent.count({ where: { matchEntryId: targetEntry.id } }),
        2,
      );
      assert.equal(await db.notificationOutbox.count({ where: { userId: ids.target } }), 1);
      assert.deepEqual(
        new Map(
          (
            await db.matchFixture.findMany({
              where: { matchId: ids.match },
              select: { id: true, status: true },
            })
          ).map((fixture) => [fixture.id, fixture.status]),
        ),
        fixturesAfterBan,
      );

      const unbanResult = await db.$transaction(
        (tx) =>
          setUserBanState(tx, {
            userId: ids.target,
            banned: false,
            actorId: ids.admin,
          }),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      assert.deepEqual(unbanResult.removedMatches, []);
      assert.deepEqual(unbanResult.v2Disqualifications, []);
      assert.deepEqual(unbanResult.v2CorrectionCleanups, []);
      assert.equal(
        (
          await db.user.findUniqueOrThrow({
            where: { id: ids.target },
            select: { isBanned: true, sessionVersion: true },
          })
        ).isBanned,
        false,
      );
      assert.equal(
        (
          await db.matchEntry.findUniqueOrThrow({ where: { id: targetEntry.id } })
        ).status,
        "DISQUALIFIED",
      );
      assert.deepEqual(
        new Map(
          (
            await db.matchFixture.findMany({
              where: { matchId: ids.match },
              select: { id: true, status: true },
            })
          ).map((fixture) => [fixture.id, fixture.status]),
        ),
        fixturesAfterBan,
      );
    } finally {
      await cleanup(db, matchIds, userIds);
      await db.$disconnect();
    }
  },
);

test(
  "finished V2 SINGLE cleanup voids only a pending correction and preserves historical identity",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const ids = {
      admin: `ban-finished-admin-${suffix}`,
      target: `ban-finished-target-${suffix}`,
      opponent: `ban-finished-opponent-${suffix}`,
      match: `ban-finished-match-${suffix}`,
    };
    const matchIds = [ids.match];
    const userIds = [ids.admin, ids.target, ids.opponent];

    try {
      const entries = await seedFormalV2SingleMatch(db, {
        adminId: ids.admin,
        matchId: ids.match,
        playerIds: [ids.target, ids.opponent],
      });
      const targetEntry = entries.get(ids.target)!;
      const opponentEntry = entries.get(ids.opponent)!;
      const fixture = await createV2Fixture(db, {
        actor: { id: ids.admin, role: "admin" },
        matchId: ids.match,
        fixtureKey: `finished-${suffix}`,
        stage: { stage: "GROUP", groupKey: "A" },
        sideAEntryId: targetEntry.id,
        sideBEntryId: opponentEntry.id,
      });
      await seedRelationalSingleGroupOnlyTopology(db, {
        matchId: ids.match,
        entryIds: [targetEntry.id, opponentEntry.id],
        fixtureId: fixture.id,
        suffix,
      });
      const readyFixture = await transitionV2FixtureStatus(db, {
        actor: { id: ids.admin, role: "admin" },
        matchId: ids.match,
        fixtureId: fixture.id,
        expectedVersion: fixture.version,
        to: "READY",
      });
      const resultService = createV2ResultApplicationService({
        db,
        clock: () => new Date("2026-09-05T09:00:00.000Z"),
      });
      const initialRevision = await resultService.submitRevision({
        actor: { actorId: ids.target, role: "user" },
        matchId: ids.match,
        fixtureId: fixture.id,
        expectedFixtureVersion: readyFixture.version,
        winnerEntryId: targetEntry.id,
        loserEntryId: opponentEntry.id,
        score: { bestOf: 5, winnerScore: 3, loserScore: 1 },
      });
      const confirmedRevision = await resultService.confirmRevision({
        actor: { actorId: ids.opponent, role: "user" },
        matchId: ids.match,
        fixtureId: fixture.id,
        expectedFixtureVersion: readyFixture.version + 1,
        resultRevisionId: initialRevision.id,
      });
      assert.equal(
        (await db.match.findUniqueOrThrow({ where: { id: ids.match } })).status,
        "finished",
      );
      const correctionRevision = await resultService.submitCorrection({
        actor: { actorId: ids.admin, role: "admin" },
        matchId: ids.match,
        fixtureId: fixture.id,
        expectedFixtureVersion: readyFixture.version + 2,
        resultRevisionId: confirmedRevision.id,
        score: { bestOf: 5, winnerScore: 3, loserScore: 2 },
        reason: "finished correction",
      });

      const [targetBefore, entryBefore, memberBefore, registrationBefore, fixtureBefore] =
        await Promise.all([
          db.user.findUniqueOrThrow({
            where: { id: ids.target },
            select: {
              points: true,
              eloRating: true,
              wins: true,
              losses: true,
              matchesPlayed: true,
              sessionVersion: true,
            },
          }),
          db.matchEntry.findUniqueOrThrow({
            where: { id: targetEntry.id },
            select: {
              status: true,
              version: true,
              withdrawnAt: true,
              disqualifiedAt: true,
              archivedAt: true,
            },
          }),
          db.matchEntryMember.findFirstOrThrow({
            where: { entryId: targetEntry.id, userId: ids.target },
            select: {
              status: true,
              effectiveUntil: true,
              endReason: true,
              rosterVersion: true,
            },
          }),
          db.settlementEvent.findMany({
            where: { matchEntryId: targetEntry.id },
            orderBy: { createdAt: "asc" },
            select: { id: true, kind: true, status: true },
          }),
          db.matchFixture.findUniqueOrThrow({
            where: { id: fixture.id },
            select: { status: true, version: true, completedAt: true },
          }),
        ]);
      const confirmedSettlementBefore = await db.settlementEvent.findFirstOrThrow({
        where: { resultRevisionId: confirmedRevision.id, kind: "RESULT_APPLY" },
        select: { id: true, status: true },
      });

      const banResult = await db.$transaction(
        (tx) =>
          setUserBanState(tx, {
            userId: ids.target,
            banned: true,
            actorId: ids.admin,
          }),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      assert.deepEqual(banResult.removedMatches, []);
      assert.deepEqual(banResult.v2Disqualifications, []);
      assert.deepEqual(banResult.v2CorrectionCleanups, [
        {
          matchId: ids.match,
          matchTitle: ids.match,
          fixtureId: fixture.id,
          participantEntryId: targetEntry.id,
          voidedResultRevisionId: correctionRevision.id,
        },
      ]);

      const [targetAfter, entryAfter, memberAfter, registrationAfter, fixtureAfter] =
        await Promise.all([
          db.user.findUniqueOrThrow({
            where: { id: ids.target },
            select: {
              isBanned: true,
              points: true,
              eloRating: true,
              wins: true,
              losses: true,
              matchesPlayed: true,
              sessionVersion: true,
            },
          }),
          db.matchEntry.findUniqueOrThrow({
            where: { id: targetEntry.id },
            select: {
              status: true,
              version: true,
              withdrawnAt: true,
              disqualifiedAt: true,
              archivedAt: true,
            },
          }),
          db.matchEntryMember.findFirstOrThrow({
            where: { entryId: targetEntry.id, userId: ids.target },
            select: {
              status: true,
              effectiveUntil: true,
              endReason: true,
              rosterVersion: true,
            },
          }),
          db.settlementEvent.findMany({
            where: { matchEntryId: targetEntry.id },
            orderBy: { createdAt: "asc" },
            select: { id: true, kind: true, status: true },
          }),
          db.matchFixture.findUniqueOrThrow({
            where: { id: fixture.id },
            select: { status: true, version: true, completedAt: true },
          }),
        ]);
      assert.deepEqual(targetAfter, {
        isBanned: true,
        points: targetBefore.points,
        eloRating: targetBefore.eloRating,
        wins: targetBefore.wins,
        losses: targetBefore.losses,
        matchesPlayed: targetBefore.matchesPlayed,
        sessionVersion: targetBefore.sessionVersion + 1,
      });
      assert.deepEqual(entryAfter, entryBefore);
      assert.deepEqual(memberAfter, memberBefore);
      assert.deepEqual(registrationAfter, registrationBefore);
      assert.deepEqual(fixtureAfter, {
        ...fixtureBefore,
        version: fixtureBefore.version + 1,
      });
      assert.equal(
        (await db.match.findUniqueOrThrow({ where: { id: ids.match } })).status,
        "finished",
      );
      const revisionsAfter = new Map(
        (
          await db.resultRevision.findMany({
            where: { id: { in: [confirmedRevision.id, correctionRevision.id] } },
            select: {
              id: true,
              status: true,
              reason: true,
              verifiedById: true,
              resolvedAt: true,
            },
          })
        ).map((revision) => [revision.id, revision]),
      );
      assert.deepEqual(revisionsAfter.get(confirmedRevision.id), {
        id: confirmedRevision.id,
        status: "CONFIRMED",
        reason: null,
        verifiedById: ids.opponent,
        resolvedAt: new Date("2026-09-05T09:00:00.000Z"),
      });
      const correctionAfter = revisionsAfter.get(correctionRevision.id);
      assert.equal(correctionAfter?.status, "VOIDED");
      assert.equal(correctionAfter?.reason, "USER_BANNED");
      assert.equal(correctionAfter?.verifiedById, ids.admin);
      assert.ok(correctionAfter?.resolvedAt);
      assert.deepEqual(
        await db.settlementEvent.findUniqueOrThrow({
          where: { id: confirmedSettlementBefore.id },
          select: { id: true, status: true },
        }),
        confirmedSettlementBefore,
      );

      const audit = await db.auditLog.findFirstOrThrow({
        where: { action: "user.ban", entityId: ids.target },
        orderBy: { createdAt: "desc" },
        select: { details: true },
      });
      const details = audit.details as {
        removedMatchIds?: unknown;
        v2Disqualifications?: unknown;
        v2CorrectionCleanups?: unknown;
      };
      assert.deepEqual(details.removedMatchIds, []);
      assert.deepEqual(details.v2Disqualifications, []);
      assert.deepEqual(details.v2CorrectionCleanups, banResult.v2CorrectionCleanups);

      const repeatedBan = await db.$transaction(
        (tx) =>
          setUserBanState(tx, {
            userId: ids.target,
            banned: true,
            actorId: ids.admin,
          }),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      assert.deepEqual(repeatedBan.v2CorrectionCleanups, []);
      assert.equal(
        (
          await db.matchFixture.findUniqueOrThrow({
            where: { id: fixture.id },
            select: { version: true },
          })
        ).version,
        fixtureAfter.version,
      );
    } finally {
      await cleanup(db, matchIds, userIds);
      await db.$disconnect();
    }
  },
);

test(
  "non-active V2 identity cleanup does not repeat disqualification or registration reversal",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const ids = {
      admin: `ban-history-admin-${suffix}`,
      target: `ban-history-target-${suffix}`,
      opponent: `ban-history-opponent-${suffix}`,
      otherA: `ban-history-other-a-${suffix}`,
      otherB: `ban-history-other-b-${suffix}`,
      match: `ban-history-match-${suffix}`,
    };
    const matchIds = [ids.match];
    const userIds = [ids.admin, ids.target, ids.opponent, ids.otherA, ids.otherB];

    try {
      const entries = await seedFormalV2SingleMatch(db, {
        adminId: ids.admin,
        matchId: ids.match,
        playerIds: [ids.target, ids.opponent, ids.otherA, ids.otherB],
      });
      const targetEntry = entries.get(ids.target)!;
      const opponentEntry = entries.get(ids.opponent)!;
      const otherAEntry = entries.get(ids.otherA)!;
      const otherBEntry = entries.get(ids.otherB)!;
      const targetFixture = await createV2Fixture(db, {
        actor: { id: ids.admin, role: "admin" },
        matchId: ids.match,
        fixtureKey: `history-target-${suffix}`,
        stage: { stage: "GROUP", groupKey: "A" },
        sideAEntryId: targetEntry.id,
        sideBEntryId: opponentEntry.id,
      });
      const unrelatedFixture = await createV2Fixture(db, {
        actor: { id: ids.admin, role: "admin" },
        matchId: ids.match,
        fixtureKey: `history-unrelated-${suffix}`,
        stage: { stage: "GROUP", groupKey: "A" },
        sideAEntryId: otherAEntry.id,
        sideBEntryId: otherBEntry.id,
      });
      const readyTargetFixture = await transitionV2FixtureStatus(db, {
        actor: { id: ids.admin, role: "admin" },
        matchId: ids.match,
        fixtureId: targetFixture.id,
        expectedVersion: targetFixture.version,
        to: "READY",
      });
      const resultService = createV2ResultApplicationService({
        db,
        clock: () => new Date("2026-09-05T10:00:00.000Z"),
      });
      const initialRevision = await resultService.submitRevision({
        actor: { actorId: ids.target, role: "user" },
        matchId: ids.match,
        fixtureId: targetFixture.id,
        expectedFixtureVersion: readyTargetFixture.version,
        winnerEntryId: targetEntry.id,
        loserEntryId: opponentEntry.id,
        score: { bestOf: 5, winnerScore: 3, loserScore: 1 },
      });
      const confirmedRevision = await resultService.confirmRevision({
        actor: { actorId: ids.opponent, role: "user" },
        matchId: ids.match,
        fixtureId: targetFixture.id,
        expectedFixtureVersion: readyTargetFixture.version + 1,
        resultRevisionId: initialRevision.id,
      });
      assert.equal(
        (await db.match.findUniqueOrThrow({ where: { id: ids.match } })).status,
        "ongoing",
      );

      const firstBan = await db.$transaction(
        (tx) =>
          setUserBanState(tx, {
            userId: ids.target,
            banned: true,
            actorId: ids.admin,
          }),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      assert.equal(firstBan.v2Disqualifications.length, 1);
      assert.deepEqual(firstBan.v2CorrectionCleanups, []);
      await db.$transaction(
        (tx) =>
          setUserBanState(tx, {
            userId: ids.target,
            banned: false,
            actorId: ids.admin,
          }),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );

      const fixtureBeforeCorrection = await db.matchFixture.findUniqueOrThrow({
        where: { id: targetFixture.id },
        select: { status: true, version: true },
      });
      assert.equal(fixtureBeforeCorrection.status, "COMPLETED");
      const correctionRevision = await resultService.submitCorrection({
        actor: { actorId: ids.admin, role: "admin" },
        matchId: ids.match,
        fixtureId: targetFixture.id,
        expectedFixtureVersion: fixtureBeforeCorrection.version,
        resultRevisionId: confirmedRevision.id,
        score: { bestOf: 5, winnerScore: 3, loserScore: 2 },
        reason: "non-active identity correction",
      });
      const [entryBefore, memberBefore, registrationBefore, fixtureBefore, matchBefore] =
        await Promise.all([
          db.matchEntry.findUniqueOrThrow({
            where: { id: targetEntry.id },
            select: {
              status: true,
              version: true,
              disqualifiedAt: true,
              withdrawnAt: true,
              archivedAt: true,
            },
          }),
          db.matchEntryMember.findFirstOrThrow({
            where: { entryId: targetEntry.id, userId: ids.target },
            select: {
              status: true,
              effectiveUntil: true,
              endReason: true,
              rosterVersion: true,
            },
          }),
          db.settlementEvent.findMany({
            where: { matchEntryId: targetEntry.id },
            orderBy: { createdAt: "asc" },
            select: { id: true, kind: true, status: true },
          }),
          db.matchFixture.findUniqueOrThrow({
            where: { id: targetFixture.id },
            select: { status: true, version: true, completedAt: true },
          }),
          db.match.findUniqueOrThrow({
            where: { id: ids.match },
            select: { status: true },
          }),
        ]);
      assert.equal(entryBefore.status, "DISQUALIFIED");
      assert.deepEqual(
        registrationBefore.map((event) => ({ kind: event.kind, status: event.status })),
        [
          { kind: "REGISTRATION_APPLY", status: "REVERSED" },
          { kind: "REGISTRATION_REVERSAL", status: "APPLIED" },
        ],
      );

      const secondBan = await db.$transaction(
        (tx) =>
          setUserBanState(tx, {
            userId: ids.target,
            banned: true,
            actorId: ids.admin,
          }),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      assert.deepEqual(secondBan.removedMatches, []);
      assert.deepEqual(secondBan.v2Disqualifications, []);
      assert.deepEqual(secondBan.v2CorrectionCleanups, [
        {
          matchId: ids.match,
          matchTitle: ids.match,
          fixtureId: targetFixture.id,
          participantEntryId: targetEntry.id,
          voidedResultRevisionId: correctionRevision.id,
        },
      ]);

      const [entryAfter, memberAfter, registrationAfter, fixtureAfter, matchAfter] =
        await Promise.all([
          db.matchEntry.findUniqueOrThrow({
            where: { id: targetEntry.id },
            select: {
              status: true,
              version: true,
              disqualifiedAt: true,
              withdrawnAt: true,
              archivedAt: true,
            },
          }),
          db.matchEntryMember.findFirstOrThrow({
            where: { entryId: targetEntry.id, userId: ids.target },
            select: {
              status: true,
              effectiveUntil: true,
              endReason: true,
              rosterVersion: true,
            },
          }),
          db.settlementEvent.findMany({
            where: { matchEntryId: targetEntry.id },
            orderBy: { createdAt: "asc" },
            select: { id: true, kind: true, status: true },
          }),
          db.matchFixture.findUniqueOrThrow({
            where: { id: targetFixture.id },
            select: { status: true, version: true, completedAt: true },
          }),
          db.match.findUniqueOrThrow({
            where: { id: ids.match },
            select: { status: true },
          }),
        ]);
      assert.deepEqual(entryAfter, entryBefore);
      assert.deepEqual(memberAfter, memberBefore);
      assert.deepEqual(registrationAfter, registrationBefore);
      assert.deepEqual(fixtureAfter, {
        ...fixtureBefore,
        version: fixtureBefore.version + 1,
      });
      assert.deepEqual(matchAfter, matchBefore);
      assert.equal(matchAfter.status, "ongoing");
      assert.equal(
        (
          await db.matchFixture.findUniqueOrThrow({
            where: { id: unrelatedFixture.id },
            select: { status: true },
          })
        ).status,
        "SCHEDULED",
      );
      assert.equal(
        (
          await db.resultRevision.findUniqueOrThrow({
            where: { id: confirmedRevision.id },
            select: { status: true },
          })
        ).status,
        "CONFIRMED",
      );
      const correctionAfter = await db.resultRevision.findUniqueOrThrow({
        where: { id: correctionRevision.id },
        select: { status: true, reason: true, verifiedById: true, resolvedAt: true },
      });
      assert.equal(correctionAfter.status, "VOIDED");
      assert.equal(correctionAfter.reason, "USER_BANNED");
      assert.equal(correctionAfter.verifiedById, ids.admin);
      assert.ok(correctionAfter.resolvedAt);
    } finally {
      await cleanup(db, matchIds, userIds);
      await db.$disconnect();
    }
  },
);

test(
  "a V2 ban holding the Match mutex defeats a concurrent correction submission without partial settlement",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const banDb = new PrismaClient();
    const correctionDb = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const ids = correctionRaceIds("ban-submit", suffix);
    const matchIds = [ids.match];
    const userIds = [
      ids.admin,
      ids.target,
      ids.opponent,
      ids.otherA,
      ids.otherB,
    ];
    const banMatchLocked = deferred<void>();
    const releaseBan = deferred<void>();
    const correctionSnapshotReady = deferred<void>();
    const allowCorrectionStart = deferred<void>();
    const correctionMatchLockIssued = deferred<void>();
    let banAttempt: Promise<unknown> | null = null;
    let correctionAttempt: Promise<unknown> | null = null;

    try {
      const scenario = await seedCorrectionRaceScenario(db, ids, suffix);
      const [targetBefore, fixtureBefore] = await Promise.all([
        db.user.findUniqueOrThrow({
          where: { id: ids.target },
          select: {
            points: true,
            eloRating: true,
            wins: true,
            losses: true,
            matchesPlayed: true,
            sessionVersion: true,
          },
        }),
        db.matchFixture.findUniqueOrThrow({
          where: { id: scenario.fixture.id },
          select: { status: true, version: true, completedAt: true },
        }),
      ]);
      const confirmedApply = await db.settlementEvent.findFirstOrThrow({
        where: {
          resultRevisionId: scenario.confirmedRevision.id,
          kind: "RESULT_APPLY",
        },
        select: { id: true, status: true },
      });
      assert.equal(confirmedApply.status, "APPLIED");

      banAttempt = banDb.$transaction(
        async (tx) => {
          const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
            SELECT "id"
            FROM "Match"
            WHERE "id" = ${ids.match}
            FOR UPDATE
          `);
          assert.deepEqual(locked, [{ id: ids.match }]);
          banMatchLocked.resolve();
          await releaseBan.promise;
          return setUserBanState(tx, {
            userId: ids.target,
            banned: true,
            actorId: ids.admin,
          });
        },
        serializableTransactionOptions,
      );
      await waitForSignal(banMatchLocked.promise, "ban Match lock");

      const correctionService = createV2ResultApplicationService({
        db: databaseWithSnapshotBeforeMatchLock(correctionDb, {
          snapshotReady: correctionSnapshotReady,
          allowOperation: allowCorrectionStart,
          matchLockIssued: correctionMatchLockIssued,
        }),
        clock: () => new Date("2026-09-05T11:00:00.000Z"),
      });
      correctionAttempt = correctionService.submitCorrection({
        actor: { actorId: ids.admin, role: "admin" },
        matchId: ids.match,
        fixtureId: scenario.fixture.id,
        expectedFixtureVersion: fixtureBefore.version,
        resultRevisionId: scenario.confirmedRevision.id,
        score: { bestOf: 5, winnerScore: 3, loserScore: 2 },
        reason: "concurrent correction must lose to ban",
      });
      await waitForSignal(
        correctionSnapshotReady.promise,
        "correction transaction snapshot",
      );
      allowCorrectionStart.resolve();
      await waitForSignal(
        correctionMatchLockIssued.promise,
        "correction Match lock attempt",
      );
      releaseBan.resolve();

      const [banOutcome, correctionOutcome] = await Promise.allSettled([
        banAttempt,
        correctionAttempt,
      ]);
      assert.equal(banOutcome.status, "fulfilled");
      assert.equal(correctionOutcome.status, "rejected");
      if (correctionOutcome.status === "rejected") {
        assertV2ConcurrentWriteConflict(correctionOutcome.reason);
      }
      const banResult = banOutcome.value as Awaited<
        ReturnType<typeof setUserBanState>
      >;
      assert.equal(banResult.v2Disqualifications.length, 1);
      assert.deepEqual(banResult.v2Disqualifications[0], {
        matchId: ids.match,
        matchTitle: ids.match,
        entryId: scenario.targetEntry.id,
        voidedFixtureIds: [],
        voidedResultRevisionIds: [],
      });
      assert.deepEqual(banResult.v2CorrectionCleanups, []);

      const [targetAfter, targetEntryAfter, targetMemberAfter, fixtureAfter] =
        await Promise.all([
          db.user.findUniqueOrThrow({
            where: { id: ids.target },
            select: {
              isBanned: true,
              points: true,
              eloRating: true,
              wins: true,
              losses: true,
              matchesPlayed: true,
              sessionVersion: true,
            },
          }),
          db.matchEntry.findUniqueOrThrow({
            where: { id: scenario.targetEntry.id },
            select: { status: true, version: true, disqualifiedAt: true },
          }),
          db.matchEntryMember.findFirstOrThrow({
            where: { entryId: scenario.targetEntry.id, userId: ids.target },
            select: { status: true, effectiveUntil: true, endReason: true },
          }),
          db.matchFixture.findUniqueOrThrow({
            where: { id: scenario.fixture.id },
            select: { status: true, version: true, completedAt: true },
          }),
        ]);
      assert.deepEqual(targetAfter, {
        isBanned: true,
        points: targetBefore.points - 1,
        eloRating: targetBefore.eloRating,
        wins: targetBefore.wins,
        losses: targetBefore.losses,
        matchesPlayed: targetBefore.matchesPlayed,
        sessionVersion: targetBefore.sessionVersion + 1,
      });
      assert.equal(targetEntryAfter.status, "DISQUALIFIED");
      assert.equal(targetEntryAfter.version, scenario.targetEntry.version + 1);
      assert.ok(targetEntryAfter.disqualifiedAt);
      assert.deepEqual(
        {
          status: targetMemberAfter.status,
          endReason: targetMemberAfter.endReason,
        },
        { status: "DISQUALIFIED", endReason: "USER_BANNED" },
      );
      assert.ok(targetMemberAfter.effectiveUntil);
      assert.deepEqual(fixtureAfter, fixtureBefore);
      assert.equal(
        (await db.match.findUniqueOrThrow({ where: { id: ids.match } })).status,
        "ongoing",
      );

      assert.deepEqual(
        await db.resultRevision.findMany({
          where: { fixtureId: scenario.fixture.id },
          orderBy: { revisionNumber: "asc" },
          select: { id: true, status: true, supersedesRevisionId: true },
        }),
        [
          {
            id: scenario.confirmedRevision.id,
            status: "CONFIRMED",
            supersedesRevisionId: null,
          },
        ],
      );
      assert.deepEqual(
        await db.settlementEvent.findMany({
          where: { resultRevisionId: scenario.confirmedRevision.id },
          orderBy: { createdAt: "asc" },
          select: { id: true, kind: true, status: true },
        }),
        [
          {
            id: confirmedApply.id,
            kind: "RESULT_APPLY",
            status: "APPLIED",
          },
        ],
      );
      assert.equal(
        await db.settlementEvent.count({
          where: {
            matchEntryId: scenario.targetEntry.id,
            kind: "REGISTRATION_REVERSAL",
          },
        }),
        1,
      );
    } finally {
      allowCorrectionStart.resolve();
      releaseBan.resolve();
      await Promise.allSettled(
        [banAttempt, correctionAttempt].filter(
          (attempt): attempt is Promise<unknown> => attempt !== null,
        ),
      );
      await cleanup(db, matchIds, userIds);
      await Promise.all([
        db.$disconnect(),
        banDb.$disconnect(),
        correctionDb.$disconnect(),
      ]);
    }
  },
);

test(
  "a V2 correction confirmation holding the Match mutex defeats a concurrent ban without partial account writes",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const correctionDb = new PrismaClient();
    const banDb = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const ids = correctionRaceIds("confirm-ban", suffix);
    const matchIds = [ids.match];
    const userIds = [
      ids.admin,
      ids.target,
      ids.opponent,
      ids.otherA,
      ids.otherB,
    ];
    const correctionMatchLocked = deferred<void>();
    const releaseCorrection = deferred<void>();
    const banSnapshotReady = deferred<void>();
    const allowBanStart = deferred<void>();
    const banMatchLockIssued = deferred<void>();
    let confirmationAttempt: Promise<unknown> | null = null;
    let banAttempt: Promise<unknown> | null = null;

    try {
      const scenario = await seedCorrectionRaceScenario(db, ids, suffix);
      const setupService = createV2ResultApplicationService({
        db,
        clock: () => new Date("2026-09-05T12:00:00.000Z"),
      });
      const fixtureBeforeCorrection = await db.matchFixture.findUniqueOrThrow({
        where: { id: scenario.fixture.id },
        select: { version: true },
      });
      const correctionRevision = await setupService.submitCorrection({
        actor: { actorId: ids.admin, role: "admin" },
        matchId: ids.match,
        fixtureId: scenario.fixture.id,
        expectedFixtureVersion: fixtureBeforeCorrection.version,
        resultRevisionId: scenario.confirmedRevision.id,
        score: { bestOf: 5, winnerScore: 3, loserScore: 2 },
        reason: "concurrent correction confirmation",
      });
      const [targetBefore, entryBefore, memberBefore, fixtureBefore] =
        await Promise.all([
          db.user.findUniqueOrThrow({
            where: { id: ids.target },
            select: {
              isBanned: true,
              sessionVersion: true,
            },
          }),
          db.matchEntry.findUniqueOrThrow({
            where: { id: scenario.targetEntry.id },
            select: {
              status: true,
              version: true,
              disqualifiedAt: true,
              withdrawnAt: true,
              archivedAt: true,
            },
          }),
          db.matchEntryMember.findFirstOrThrow({
            where: { entryId: scenario.targetEntry.id, userId: ids.target },
            select: {
              status: true,
              effectiveUntil: true,
              endReason: true,
              rosterVersion: true,
            },
          }),
          db.matchFixture.findUniqueOrThrow({
            where: { id: scenario.fixture.id },
            select: { status: true, version: true, completedAt: true },
          }),
        ]);
      const registrationBefore = await db.settlementEvent.findMany({
        where: { matchEntryId: scenario.targetEntry.id },
        orderBy: { createdAt: "asc" },
        select: { id: true, kind: true, status: true },
      });

      const confirmationService = createV2ResultApplicationService({
        db: databaseHoldingMatchLock(correctionDb, {
          matchId: ids.match,
          matchLocked: correctionMatchLocked,
          releaseOperation: releaseCorrection,
        }),
        clock: () => new Date("2026-09-05T12:01:00.000Z"),
      });
      confirmationAttempt = confirmationService.confirmRevision({
        actor: { actorId: ids.admin, role: "admin" },
        matchId: ids.match,
        fixtureId: scenario.fixture.id,
        expectedFixtureVersion: fixtureBefore.version,
        resultRevisionId: correctionRevision.id,
      });
      await waitForSignal(
        correctionMatchLocked.promise,
        "correction-confirmation Match lock",
      );

      banAttempt = banDb.$transaction(
        async (tx) => {
          await tx.$queryRaw<Array<{ value: number }>>(Prisma.sql`
            SELECT 1 AS "value"
          `);
          banSnapshotReady.resolve();
          await allowBanStart.promise;
          return setUserBanState(
            signalOnFirstMatchLock(tx, banMatchLockIssued),
            {
              userId: ids.target,
              banned: true,
              actorId: ids.admin,
            },
          );
        },
        serializableTransactionOptions,
      );
      await waitForSignal(banSnapshotReady.promise, "ban transaction snapshot");
      allowBanStart.resolve();
      await waitForSignal(banMatchLockIssued.promise, "ban Match lock attempt");
      releaseCorrection.resolve();

      const [confirmationOutcome, banOutcome] = await Promise.allSettled([
        confirmationAttempt,
        banAttempt,
      ]);
      assert.equal(confirmationOutcome.status, "fulfilled");
      assert.equal(banOutcome.status, "rejected");
      if (banOutcome.status === "rejected") {
        assertSerializableConflict(banOutcome.reason);
      }
      assert.equal(
        (confirmationOutcome.value as { status: string }).status,
        "CONFIRMED",
      );

      const [targetAfter, entryAfter, memberAfter, fixtureAfter] =
        await Promise.all([
          db.user.findUniqueOrThrow({
            where: { id: ids.target },
            select: { isBanned: true, sessionVersion: true },
          }),
          db.matchEntry.findUniqueOrThrow({
            where: { id: scenario.targetEntry.id },
            select: {
              status: true,
              version: true,
              disqualifiedAt: true,
              withdrawnAt: true,
              archivedAt: true,
            },
          }),
          db.matchEntryMember.findFirstOrThrow({
            where: { entryId: scenario.targetEntry.id, userId: ids.target },
            select: {
              status: true,
              effectiveUntil: true,
              endReason: true,
              rosterVersion: true,
            },
          }),
          db.matchFixture.findUniqueOrThrow({
            where: { id: scenario.fixture.id },
            select: { status: true, version: true, completedAt: true },
          }),
        ]);
      assert.deepEqual(targetAfter, targetBefore);
      assert.deepEqual(entryAfter, entryBefore);
      assert.deepEqual(memberAfter, memberBefore);
      assert.deepEqual(fixtureAfter, {
        ...fixtureBefore,
        version: fixtureBefore.version + 1,
      });
      assert.deepEqual(
        await db.settlementEvent.findMany({
          where: { matchEntryId: scenario.targetEntry.id },
          orderBy: { createdAt: "asc" },
          select: { id: true, kind: true, status: true },
        }),
        registrationBefore,
      );
      assert.equal(
        await db.settlementEvent.count({
          where: {
            matchEntryId: scenario.targetEntry.id,
            kind: "REGISTRATION_REVERSAL",
          },
        }),
        0,
      );
      assert.equal(
        await db.auditLog.count({
          where: { action: "user.ban", entityId: ids.target },
        }),
        0,
      );
      assert.equal(
        await db.notificationOutbox.count({ where: { userId: ids.target } }),
        0,
      );

      assert.deepEqual(
        await db.resultRevision.findMany({
          where: {
            id: { in: [scenario.confirmedRevision.id, correctionRevision.id] },
          },
          orderBy: { revisionNumber: "asc" },
          select: { id: true, status: true, supersedesRevisionId: true },
        }),
        [
          {
            id: scenario.confirmedRevision.id,
            status: "SUPERSEDED",
            supersedesRevisionId: null,
          },
          {
            id: correctionRevision.id,
            status: "CONFIRMED",
            supersedesRevisionId: scenario.confirmedRevision.id,
          },
        ],
      );
      assert.deepEqual(
        await db.settlementEvent.findMany({
          where: {
            resultRevisionId: {
              in: [scenario.confirmedRevision.id, correctionRevision.id],
            },
          },
          orderBy: [{ createdAt: "asc" }, { kind: "asc" }],
          select: { resultRevisionId: true, kind: true, status: true },
        }),
        [
          {
            resultRevisionId: scenario.confirmedRevision.id,
            kind: "RESULT_APPLY",
            status: "REVERSED",
          },
          {
            resultRevisionId: scenario.confirmedRevision.id,
            kind: "RESULT_REVERSAL",
            status: "APPLIED",
          },
          {
            resultRevisionId: correctionRevision.id,
            kind: "RESULT_APPLY",
            status: "APPLIED",
          },
        ],
      );
    } finally {
      allowBanStart.resolve();
      releaseCorrection.resolve();
      await Promise.allSettled(
        [confirmationAttempt, banAttempt].filter(
          (attempt): attempt is Promise<unknown> => attempt !== null,
        ),
      );
      await cleanup(db, matchIds, userIds);
      await Promise.all([
        db.$disconnect(),
        correctionDb.$disconnect(),
        banDb.$disconnect(),
      ]);
    }
  },
);

test(
  "bulk V2 ban of both fixture sides disqualifies both identities and voids shared state once",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const ids = {
      admin: `ban-bulk-admin-${suffix}`,
      left: `ban-bulk-left-${suffix}`,
      right: `ban-bulk-right-${suffix}`,
      match: `ban-bulk-match-${suffix}`,
    };
    const matchIds = [ids.match];
    const userIds = [ids.admin, ids.left, ids.right];

    try {
      const entries = await seedFormalV2SingleMatch(db, {
        adminId: ids.admin,
        matchId: ids.match,
        playerIds: [ids.left, ids.right],
      });
      const leftEntry = entries.get(ids.left)!;
      const rightEntry = entries.get(ids.right)!;
      const fixture = await createV2Fixture(db, {
        actor: { id: ids.admin, role: "admin" },
        matchId: ids.match,
        fixtureKey: `bulk-both-sides-${suffix}`,
        stage: { stage: "GROUP", groupKey: "A" },
        sideAEntryId: leftEntry.id,
        sideBEntryId: rightEntry.id,
      });
      await seedRelationalSingleGroupOnlyTopology(db, {
        matchId: ids.match,
        entryIds: [leftEntry.id, rightEntry.id],
        fixtureId: fixture.id,
        suffix,
      });
      const readyFixture = await transitionV2FixtureStatus(db, {
        actor: { id: ids.admin, role: "admin" },
        matchId: ids.match,
        fixtureId: fixture.id,
        expectedVersion: fixture.version,
        to: "READY",
      });
      const resultService = createV2ResultApplicationService({
        db,
        clock: () => new Date("2026-09-05T13:00:00.000Z"),
      });
      const pendingRevision = await resultService.submitRevision({
        actor: { actorId: ids.left, role: "user" },
        matchId: ids.match,
        fixtureId: fixture.id,
        expectedFixtureVersion: readyFixture.version,
        winnerEntryId: leftEntry.id,
        loserEntryId: rightEntry.id,
        score: { bestOf: 5, winnerScore: 3, loserScore: 1 },
      });
      const fixtureBefore = await db.matchFixture.findUniqueOrThrow({
        where: { id: fixture.id },
        select: { status: true, version: true },
      });

      const banResults = await db.$transaction(
        (tx) =>
          setUsersBanState(tx, {
            userIds: [ids.right, ids.left, ids.right],
            banned: true,
            actorId: ids.admin,
          }),
        serializableTransactionOptions,
      );
      assert.equal(banResults.length, 2);
      const resultsByUserId = new Map(
        banResults.map((result) => [result.userId, result]),
      );
      assert.deepEqual([...resultsByUserId.keys()], [ids.left, ids.right].sort());
      for (const [userId, entry] of [
        [ids.left, leftEntry],
        [ids.right, rightEntry],
      ] as const) {
        const result = resultsByUserId.get(userId);
        assert.ok(result);
        assert.deepEqual(result.removedMatches, [
          { id: ids.match, title: ids.match },
        ]);
        assert.deepEqual(result.v2Disqualifications, [
          {
            matchId: ids.match,
            matchTitle: ids.match,
            entryId: entry.id,
            voidedFixtureIds: [fixture.id],
            voidedResultRevisionIds: [pendingRevision.id],
          },
        ]);
        assert.deepEqual(result.v2CorrectionCleanups, []);
        assert.ok(result.notificationOutboxId);
      }

      const [usersAfter, entriesAfter, membersAfter, fixtureAfter, revisionAfter] =
        await Promise.all([
          db.user.findMany({
            where: { id: { in: [ids.left, ids.right] } },
            orderBy: { id: "asc" },
            select: {
              id: true,
              isBanned: true,
              points: true,
              sessionVersion: true,
            },
          }),
          db.matchEntry.findMany({
            where: { id: { in: [leftEntry.id, rightEntry.id] } },
            orderBy: { id: "asc" },
            select: { id: true, status: true, version: true, disqualifiedAt: true },
          }),
          db.matchEntryMember.findMany({
            where: { entryId: { in: [leftEntry.id, rightEntry.id] } },
            orderBy: { entryId: "asc" },
            select: {
              entryId: true,
              status: true,
              effectiveUntil: true,
              endReason: true,
            },
          }),
          db.matchFixture.findUniqueOrThrow({
            where: { id: fixture.id },
            select: { status: true, version: true },
          }),
          db.resultRevision.findUniqueOrThrow({
            where: { id: pendingRevision.id },
            select: {
              status: true,
              reason: true,
              verifiedById: true,
              resolvedAt: true,
            },
          }),
        ]);
      assert.deepEqual(
        usersAfter,
        [ids.left, ids.right].sort().map((id) => ({
          id,
          isBanned: true,
          points: 0,
          sessionVersion: 1,
        })),
      );
      for (const entry of entriesAfter) {
        const original = entry.id === leftEntry.id ? leftEntry : rightEntry;
        assert.equal(entry.status, "DISQUALIFIED");
        assert.equal(entry.version, original.version + 1);
        assert.ok(entry.disqualifiedAt);
      }
      for (const member of membersAfter) {
        assert.equal(member.status, "DISQUALIFIED");
        assert.equal(member.endReason, "USER_BANNED");
        assert.ok(member.effectiveUntil);
      }
      assert.deepEqual(fixtureAfter, {
        status: "VOIDED",
        version: fixtureBefore.version + 1,
      });
      assert.equal(revisionAfter.status, "VOIDED");
      assert.equal(revisionAfter.reason, "USER_BANNED");
      assert.equal(revisionAfter.verifiedById, ids.admin);
      assert.ok(revisionAfter.resolvedAt);
      assert.equal(
        (await db.match.findUniqueOrThrow({ where: { id: ids.match } })).status,
        "finished",
      );
      assert.equal(
        await db.resultRevision.count({ where: { fixtureId: fixture.id } }),
        1,
      );
      assert.equal(
        await db.settlementEvent.count({
          where: { resultRevisionId: pendingRevision.id },
        }),
        0,
      );
      assert.equal(
        await db.settlementEvent.count({
          where: {
            matchEntryId: { in: [leftEntry.id, rightEntry.id] },
            kind: "REGISTRATION_REVERSAL",
          },
        }),
        2,
      );
      for (const entryId of [leftEntry.id, rightEntry.id]) {
        assert.deepEqual(
          await db.settlementEvent.findMany({
            where: { matchEntryId: entryId },
            orderBy: { createdAt: "asc" },
            select: { kind: true, status: true },
          }),
          [
            { kind: "REGISTRATION_APPLY", status: "REVERSED" },
            { kind: "REGISTRATION_REVERSAL", status: "APPLIED" },
          ],
        );
      }
      const banAudits = await db.auditLog.findMany({
        where: {
          action: "user.ban",
          entityId: { in: [ids.left, ids.right] },
        },
        orderBy: { entityId: "asc" },
        select: { entityId: true, details: true },
      });
      assert.equal(banAudits.length, 2);
      for (const audit of banAudits) {
        const entryId =
          audit.entityId === ids.left ? leftEntry.id : rightEntry.id;
        const details = audit.details as {
          removedMatchIds?: string[];
          v2Disqualifications?: Array<{
            entryId: string;
            voidedFixtureIds: string[];
            voidedResultRevisionIds: string[];
          }>;
          v2CorrectionCleanups?: unknown[];
        };
        assert.deepEqual(details.removedMatchIds, [ids.match]);
        assert.deepEqual(details.v2Disqualifications, [
          {
            matchId: ids.match,
            matchTitle: ids.match,
            entryId,
            voidedFixtureIds: [fixture.id],
            voidedResultRevisionIds: [pendingRevision.id],
          },
        ]);
        assert.deepEqual(details.v2CorrectionCleanups, []);
      }
      assert.equal(
        await db.auditLog.count({
          where: {
            action: "user.ban",
            entityId: { in: [ids.left, ids.right] },
          },
        }),
        2,
      );
      assert.equal(
        await db.notificationOutbox.count({
          where: { userId: { in: [ids.left, ids.right] } },
        }),
        2,
      );
    } finally {
      await cleanup(db, matchIds, userIds);
      await db.$disconnect();
    }
  },
);

test(
  "V2 ban rolls back entry, settlement, account, outbox, and audit writes on failure",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const ids = {
      admin: `ban-rollback-admin-${suffix}`,
      corruptTarget: `ban-corrupt-target-${suffix}`,
      downstreamTarget: `ban-downstream-target-${suffix}`,
      corruptMatch: `ban-corrupt-match-${suffix}`,
      downstreamMatch: `ban-downstream-match-${suffix}`,
    };
    const matchIds = [ids.corruptMatch, ids.downstreamMatch];
    const userIds = [ids.admin, ids.corruptTarget, ids.downstreamTarget];

    try {
      const verifiedAt = new Date("2026-09-05T00:00:00.000Z");
      await db.user.createMany({
        data: [
          {
            id: ids.admin,
            email: `${ids.admin}@example.test`,
            nickname: ids.admin,
            role: "admin",
            emailVerifiedAt: verifiedAt,
          },
          {
            id: ids.corruptTarget,
            email: `${ids.corruptTarget}@example.test`,
            nickname: ids.corruptTarget,
            emailVerifiedAt: verifiedAt,
          },
          {
            id: ids.downstreamTarget,
            email: `${ids.downstreamTarget}@example.test`,
            nickname: ids.downstreamTarget,
            emailVerifiedAt: verifiedAt,
          },
        ],
      });
      for (const matchId of matchIds) {
        await db.match.create({
          data: {
            id: matchId,
            title: matchId,
            dateTime: new Date("2026-10-01T10:00:00.000Z"),
            type: "single",
            format: "group_only",
            status: "registration",
            engineVersion: "V2",
            maxParticipants: 8,
            createdBy: ids.admin,
            registrationDeadline: new Date("2099-01-01T00:00:00.000Z"),
          },
        });
      }
      const corruptEntry = await createV2Entry(db, {
        actor: { id: ids.corruptTarget, role: "user" },
        matchId: ids.corruptMatch,
        kind: "INDIVIDUAL",
        sourceId: ids.corruptTarget,
        status: "ACTIVE",
      });
      const downstreamEntry = await createV2Entry(db, {
        actor: { id: ids.downstreamTarget, role: "user" },
        matchId: ids.downstreamMatch,
        kind: "INDIVIDUAL",
        sourceId: ids.downstreamTarget,
        status: "ACTIVE",
      });
      const corruptApplication = await db.settlementEvent.findFirstOrThrow({
        where: {
          matchEntryId: corruptEntry.id,
          kind: "REGISTRATION_APPLY",
        },
        select: { id: true },
      });
      await db.settlementEvent.update({
        where: { id: corruptApplication.id },
        data: { metadata: { schemaVersion: 999 } },
      });

      await assert.rejects(
        db.$transaction(
          (tx) =>
            setUserBanState(tx, {
              userId: ids.corruptTarget,
              banned: true,
              actorId: ids.admin,
            }),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
        /registration settlement metadata/,
      );
      await assertUnchangedAfterRollback(
        db,
        ids.corruptTarget,
        corruptEntry.id,
      );

      await assert.rejects(
        db.$transaction(
          async (tx) => {
            await setUserBanState(tx, {
              userId: ids.downstreamTarget,
              banned: true,
              actorId: ids.admin,
            });
            throw new Error("forced failure after user.ban audit");
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        ),
        /forced failure after user\.ban audit/,
      );
      await assertUnchangedAfterRollback(
        db,
        ids.downstreamTarget,
        downstreamEntry.id,
      );
    } finally {
      await cleanup(db, matchIds, userIds);
      await db.$disconnect();
    }
  },
);

type CorrectionRaceIds = ReturnType<typeof correctionRaceIds>;

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
};

type InteractiveTransactionOptions = {
  isolationLevel?: Prisma.TransactionIsolationLevel;
  maxWait?: number;
  timeout?: number;
};

const serializableTransactionOptions = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 5_000,
  timeout: 30_000,
} as const;

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (value) => resolvePromise(value as T | PromiseLike<T>),
    reject: rejectPromise,
  };
}

async function waitForSignal(signal: Promise<void>, label: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}.`)),
          10_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function correctionRaceIds(prefix: string, suffix: string) {
  return {
    admin: `${prefix}-admin-${suffix}`,
    target: `${prefix}-target-${suffix}`,
    opponent: `${prefix}-opponent-${suffix}`,
    otherA: `${prefix}-other-a-${suffix}`,
    otherB: `${prefix}-other-b-${suffix}`,
    match: `${prefix}-match-${suffix}`,
  };
}

async function seedCorrectionRaceScenario(
  db: PrismaClient,
  ids: CorrectionRaceIds,
  suffix: string,
) {
  const entries = await seedFormalV2SingleMatch(db, {
    adminId: ids.admin,
    matchId: ids.match,
    playerIds: [ids.target, ids.opponent, ids.otherA, ids.otherB],
  });
  const targetEntry = entries.get(ids.target)!;
  const opponentEntry = entries.get(ids.opponent)!;
  const otherAEntry = entries.get(ids.otherA)!;
  const otherBEntry = entries.get(ids.otherB)!;
  const fixture = await createV2Fixture(db, {
    actor: { id: ids.admin, role: "admin" },
    matchId: ids.match,
    fixtureKey: `race-target-${suffix}`,
    stage: { stage: "GROUP", groupKey: "A" },
    sideAEntryId: targetEntry.id,
    sideBEntryId: opponentEntry.id,
  });
  await createV2Fixture(db, {
    actor: { id: ids.admin, role: "admin" },
    matchId: ids.match,
    fixtureKey: `race-unrelated-${suffix}`,
    stage: { stage: "GROUP", groupKey: "A" },
    sideAEntryId: otherAEntry.id,
    sideBEntryId: otherBEntry.id,
  });
  const readyFixture = await transitionV2FixtureStatus(db, {
    actor: { id: ids.admin, role: "admin" },
    matchId: ids.match,
    fixtureId: fixture.id,
    expectedVersion: fixture.version,
    to: "READY",
  });
  const service = createV2ResultApplicationService({
    db,
    clock: () => new Date("2026-09-05T10:30:00.000Z"),
  });
  const pendingRevision = await service.submitRevision({
    actor: { actorId: ids.target, role: "user" },
    matchId: ids.match,
    fixtureId: fixture.id,
    expectedFixtureVersion: readyFixture.version,
    winnerEntryId: targetEntry.id,
    loserEntryId: opponentEntry.id,
    score: { bestOf: 5, winnerScore: 3, loserScore: 1 },
  });
  const confirmedRevision = await service.confirmRevision({
    actor: { actorId: ids.opponent, role: "user" },
    matchId: ids.match,
    fixtureId: fixture.id,
    expectedFixtureVersion: readyFixture.version + 1,
    resultRevisionId: pendingRevision.id,
  });
  assert.equal(confirmedRevision.status, "CONFIRMED");
  assert.equal(
    (await db.match.findUniqueOrThrow({ where: { id: ids.match } })).status,
    "ongoing",
  );
  return { targetEntry, opponentEntry, fixture, confirmedRevision };
}

function sqlText(argument: unknown) {
  if (argument === null || typeof argument !== "object") return "";
  const strings = (argument as { strings?: unknown }).strings;
  return Array.isArray(strings) && strings.every((item) => typeof item === "string")
    ? strings.join("?")
    : "";
}

function signalOnFirstMatchLock(
  tx: Prisma.TransactionClient,
  matchLockIssued: Deferred<void>,
) {
  const queryRaw = tx.$queryRaw.bind(tx) as (...args: unknown[]) => Promise<unknown>;
  let signalled = false;
  return new Proxy(tx, {
    get(target, property) {
      if (property === "$queryRaw") {
        return (...args: unknown[]) => {
          const operation = queryRaw(...args);
          if (!signalled && sqlText(args[0]).includes('FROM "Match"')) {
            signalled = true;
            matchLockIssued.resolve();
          }
          return operation;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Prisma.TransactionClient;
}

function databaseWithSnapshotBeforeMatchLock(
  db: PrismaClient,
  controls: {
    snapshotReady: Deferred<void>;
    allowOperation: Deferred<void>;
    matchLockIssued: Deferred<void>;
  },
): V2ResultDatabase {
  const transaction = async <T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: InteractiveTransactionOptions,
  ) =>
    db.$transaction(
      async (tx) => {
        await tx.$queryRaw<Array<{ value: number }>>(Prisma.sql`
          SELECT 1 AS "value"
        `);
        controls.snapshotReady.resolve();
        await controls.allowOperation.promise;
        return operation(signalOnFirstMatchLock(tx, controls.matchLockIssued));
      },
      { ...serializableTransactionOptions, ...options },
    );
  return { $transaction: transaction } as unknown as V2ResultDatabase;
}

function databaseHoldingMatchLock(
  db: PrismaClient,
  controls: {
    matchId: string;
    matchLocked: Deferred<void>;
    releaseOperation: Deferred<void>;
  },
): V2ResultDatabase {
  const transaction = async <T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: InteractiveTransactionOptions,
  ) =>
    db.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "Match"
          WHERE "id" = ${controls.matchId}
          FOR UPDATE
        `);
        assert.deepEqual(locked, [{ id: controls.matchId }]);
        controls.matchLocked.resolve();
        await controls.releaseOperation.promise;
        return operation(tx);
      },
      { ...serializableTransactionOptions, ...options },
    );
  return { $transaction: transaction } as unknown as V2ResultDatabase;
}

function assertV2ConcurrentWriteConflict(error: unknown) {
  assert.equal(error instanceof V2ResultApplicationError, true, String(error));
  if (!(error instanceof V2ResultApplicationError)) return;
  assert.equal(error.code, "CONCURRENT_WRITE_CONFLICT", JSON.stringify(error.details));
}

function assertSerializableConflict(error: unknown) {
  assert.equal(
    error instanceof Prisma.PrismaClientKnownRequestError,
    true,
    String(error),
  );
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return;
  const databaseCode =
    typeof error.meta?.code === "string" ? error.meta.code : null;
  assert.equal(
    error.code === "P2034" ||
      (error.code === "P2010" &&
        (databaseCode === "40001" || databaseCode === "40P01")),
    true,
    JSON.stringify({ prismaCode: error.code, databaseCode, meta: error.meta }),
  );
}

async function seedRelationalSingleGroupOnlyTopology(
  db: PrismaClient,
  input: {
    matchId: string;
    entryIds: readonly [string, string];
    fixtureId: string;
    suffix: string;
  },
) {
  const entries = await db.matchEntry.findMany({
    where: { matchId: input.matchId, id: { in: [...input.entryIds] } },
    select: {
      id: true,
      version: true,
      members: {
        where: { status: "ACTIVE", effectiveUntil: null },
        select: { rosterVersion: true },
      },
    },
  });
  assert.equal(entries.length, 2);
  const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
  const publishedAt = new Date("2026-09-05T00:00:00.000Z");
  const groupingId = `ban-grouping-${input.suffix}`;
  const groupId = `ban-group-${input.suffix}`;

  await db.$transaction(async (tx) => {
    await tx.matchGrouping.create({
      data: {
        id: groupingId,
        matchId: input.matchId,
        payload: {},
        v2SchemaVersion: 1,
        seedMethod: "MIN_DIFF",
        standingsPolicyVersion: 1,
        createdAt: publishedAt,
      },
    });
    await tx.matchGroup.create({
      data: {
        id: groupId,
        matchId: input.matchId,
        groupingId,
        groupKey: "group:0001",
        displayName: "第 1 组",
        position: 1,
        createdAt: publishedAt,
      },
    });
    await tx.matchGroupEntry.createMany({
      data: input.entryIds.map((entryId, index) => {
        const entry = entriesById.get(entryId);
        assert.ok(entry);
        assert.equal(entry.members.length, 1);
        return {
          matchId: input.matchId,
          groupId,
          entryId,
          position: index + 1,
          globalSeedRank: index + 1,
          seedElo: 0,
          seedPoints: 0,
          entryVersion: entry.version,
          rosterVersion: entry.members[0].rosterVersion,
          createdAt: publishedAt,
        };
      }),
    });
    await tx.matchFixture.update({
      where: { id: input.fixtureId },
      data: { groupId, groupKey: "group:0001" },
    });
    await tx.match.update({
      where: { id: input.matchId },
      data: { groupingGeneratedAt: publishedAt },
    });
  });
}

async function seedFormalV2SingleMatch(
  db: PrismaClient,
  input: {
    adminId: string;
    matchId: string;
    playerIds: readonly string[];
  },
) {
  const verifiedAt = new Date("2026-09-05T00:00:00.000Z");
  await db.user.createMany({
    data: [
      {
        id: input.adminId,
        email: `${input.adminId}@example.test`,
        nickname: input.adminId,
        role: "admin",
        emailVerifiedAt: verifiedAt,
      },
      ...input.playerIds.map((id) => ({
        id,
        email: `${id}@example.test`,
        nickname: id,
        emailVerifiedAt: verifiedAt,
      })),
    ],
  });
  await db.match.create({
    data: {
      id: input.matchId,
      title: input.matchId,
      dateTime: new Date("2026-10-01T10:00:00.000Z"),
      type: "single",
      format: "group_only",
      status: "registration",
      engineVersion: "V2",
      maxParticipants: 16,
      createdBy: input.adminId,
      registrationDeadline: new Date("2099-01-01T00:00:00.000Z"),
    },
  });

  const entries = new Map<string, Awaited<ReturnType<typeof createV2Entry>>>();
  for (const userId of input.playerIds) {
    entries.set(
      userId,
      await createV2Entry(db, {
        actor: { id: userId, role: "user" },
        matchId: input.matchId,
        kind: "INDIVIDUAL",
        sourceId: userId,
        status: "ACTIVE",
      }),
    );
  }
  await db.match.update({
    where: { id: input.matchId },
    data: {
      status: "ongoing",
      registrationDeadline: new Date("2026-09-01T00:00:00.000Z"),
    },
  });
  return entries;
}

async function assertUnchangedAfterRollback(
  db: PrismaClient,
  userId: string,
  entryId: string,
) {
  const [user, entry, member] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: userId } }),
    db.matchEntry.findUniqueOrThrow({ where: { id: entryId } }),
    db.matchEntryMember.findFirstOrThrow({ where: { entryId, userId } }),
  ]);
  assert.equal(user.isBanned, false);
  assert.equal(user.sessionVersion, 0);
  assert.equal(user.points, 1);
  assert.equal(entry.status, "ACTIVE");
  assert.equal(entry.disqualifiedAt, null);
  assert.equal(member.status, "ACTIVE");
  assert.equal(member.effectiveUntil, null);
  assert.equal(member.endReason, null);
  assert.equal(
    await db.settlementEvent.count({
      where: { matchEntryId: entryId, kind: "REGISTRATION_REVERSAL" },
    }),
    0,
  );
  assert.equal(
    await db.auditLog.count({ where: { action: "user.ban", entityId: userId } }),
    0,
  );
  assert.equal(await db.notificationOutbox.count({ where: { userId } }), 0);
}

async function cleanup(
  db: PrismaClient,
  matchIds: readonly string[],
  userIds: readonly string[],
) {
  const entries = await db.matchEntry.findMany({
    where: { matchId: { in: [...matchIds] } },
    select: { id: true },
  });
  const entryIds = entries.map((entry) => entry.id);
  const revisions = await db.resultRevision.findMany({
    where: { matchId: { in: [...matchIds] } },
    select: { id: true },
  });
  const revisionIds = revisions.map((revision) => revision.id);
  const events = await db.settlementEvent.findMany({
    where: {
      OR: [
        { matchEntryId: { in: entryIds } },
        { resultRevisionId: { in: revisionIds } },
      ],
    },
    select: { id: true },
  });
  const eventIds = events.map((event) => event.id);

  await db.settlementEffect.deleteMany({ where: { eventId: { in: eventIds } } });
  await db.settlementEvent.deleteMany({
    where: {
      id: { in: eventIds },
      kind: { in: ["RESULT_REVERSAL", "REGISTRATION_REVERSAL"] },
    },
  });
  await db.settlementEvent.deleteMany({ where: { id: { in: eventIds } } });
  await db.pointsTransaction.deleteMany({ where: { userId: { in: [...userIds] } } });
  await db.resultRevision.deleteMany({
    where: {
      id: { in: revisionIds },
      supersedesRevisionId: { not: null },
    },
  });
  await db.resultRevision.deleteMany({ where: { id: { in: revisionIds } } });
  await db.matchFixtureDependency.deleteMany({
    where: { matchId: { in: [...matchIds] } },
  });
  await db.matchFixtureLineupMember.deleteMany({
    where: { matchId: { in: [...matchIds] } },
  });
  await db.matchFixture.deleteMany({ where: { matchId: { in: [...matchIds] } } });
  await db.matchQualificationStanding.deleteMany({
    where: { matchId: { in: [...matchIds] } },
  });
  await db.matchQualificationSnapshot.deleteMany({
    where: { matchId: { in: [...matchIds] } },
  });
  await db.matchGroupEntry.deleteMany({
    where: { matchId: { in: [...matchIds] } },
  });
  await db.matchGroup.deleteMany({
    where: { matchId: { in: [...matchIds] } },
  });
  await db.matchGrouping.deleteMany({
    where: { matchId: { in: [...matchIds] } },
  });
  await db.matchEntryMember.deleteMany({
    where: { matchId: { in: [...matchIds] } },
  });
  await db.matchEntry.deleteMany({ where: { id: { in: entryIds } } });
  await db.registration.deleteMany({ where: { matchId: { in: [...matchIds] } } });
  await db.auditLog.deleteMany({
    where: {
      OR: [
        { actorId: { in: [...userIds] } },
        { entityId: { in: [...userIds, ...matchIds] } },
      ],
    },
  });
  await db.notificationOutbox.deleteMany({ where: { userId: { in: [...userIds] } } });
  await db.match.deleteMany({ where: { id: { in: [...matchIds] } } });
  await db.user.deleteMany({ where: { id: { in: [...userIds] } } });
}
