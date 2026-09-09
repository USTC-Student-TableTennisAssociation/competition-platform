import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";

import { isRetryableTeamSourceConflict } from "../../../lib/server/match/team-source";
import {
  applyRegistrationSettlement,
  reverseRegistrationSettlement,
} from "./registration-settlements";
import {
  lockV2TeamEntryRegistrationContext,
  lockV2TeamEntryRegistrationCreationContext,
  reconcileV2TeamEntryRegistration,
  reconcileV2TeamEntryRegistrationInTransaction,
} from "./team-entry-registration";
import type { V2EntrySettlementPort } from "./entries";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;

test(
  "real PostgreSQL atomically reconciles a TEAM source and rolls back settlement faults",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const ownerId = `team-reconcile-owner-${suffix}`;
    const playerIds = Array.from(
      { length: 8 },
      (_, index) => `team-reconcile-player-${index + 1}-${suffix}`,
    );
    const matchId = `team-reconcile-match-${suffix}`;
    const teamId = `team-reconcile-source-${suffix}`;
    const faultMatchId = `team-reconcile-fault-match-${suffix}`;
    const faultTeamId = `team-reconcile-fault-source-${suffix}`;

    try {
      const verifiedAt = new Date("2026-01-01T00:00:00.000Z");
      await db.user.createMany({
        data: [ownerId, ...playerIds].map((id, index) => ({
          id,
          email: `${id}@example.test`,
          nickname: `Team player ${index}`,
          emailVerifiedAt: verifiedAt,
        })),
      });
      await db.match.createMany({
        data: [matchId, faultMatchId].map((id) => ({
          id,
          title: `TEAM Entry reconciliation ${id}`,
          dateTime: new Date("2099-02-01T10:00:00.000Z"),
          type: "team" as const,
          status: "registration" as const,
          engineVersion: "V2" as const,
          format: "group_only" as const,
          maxParticipants: 8,
          createdBy: ownerId,
          registrationDeadline: new Date("2099-01-01T00:00:00.000Z"),
          teamRegistrationStart: new Date("2026-01-01T00:00:00.000Z"),
          teamRegistrationDeadline: new Date("2099-01-01T00:00:00.000Z"),
          teamMinMembers: 3,
          teamMaxMembers: 5,
        })),
      });
      await db.matchTeam.create({
        data: {
          id: teamId,
          matchId,
          captainId: playerIds[0],
          name: "TEAM source",
          inviteCode: `team-reconcile-${suffix}`,
          status: "draft",
          members: {
            create: playerIds.slice(0, 2).map((userId) => ({ userId })),
          },
        },
      });

      assert.equal(
        (
          await reconcileV2TeamEntryRegistration(db, { matchId, teamId })
        ).action,
        "NOOP_DRAFT_SOURCE",
      );
      assert.equal(await db.matchEntry.count({ where: { matchId } }), 0);

      await db.matchTeamMember.create({
        data: { teamId, matchId, userId: playerIds[2] },
      });
      await db.matchTeam.update({
        where: { id: teamId },
        data: { status: "approved", submittedAt: new Date() },
      });
      const created = await reconcileV2TeamEntryRegistration(db, {
        matchId,
        teamId,
      });
      assert.equal(created.action, "CREATED_ACTIVE");
      assert.equal(created.rosterVersion, 1);

      await db.matchTeam.update({
        where: { id: teamId },
        data: { name: "Renamed TEAM source" },
      });
      assert.equal(
        (
          await reconcileV2TeamEntryRegistration(db, { matchId, teamId })
        ).action,
        "SYNCHRONIZED_NAME",
      );

      await db.matchTeamMember.delete({
        where: { teamId_userId: { teamId, userId: playerIds[1] } },
      });
      await db.matchTeamMember.create({
        data: { teamId, matchId, userId: playerIds[3] },
      });
      const replaced = await reconcileV2TeamEntryRegistration(db, {
        matchId,
        teamId,
      });
      assert.equal(replaced.action, "REPLACED_ACTIVE_ROSTER");
      assert.equal(replaced.rosterVersion, 2);

      await db.matchTeamMember.delete({
        where: { teamId_userId: { teamId, userId: playerIds[2] } },
      });
      await db.matchTeam.update({
        where: { id: teamId },
        data: { status: "draft", submittedAt: null },
      });
      const deactivated = await reconcileV2TeamEntryRegistration(db, {
        matchId,
        teamId,
      });
      assert.equal(deactivated.action, "DEACTIVATED_TO_DRAFT");

      await db.matchTeamMember.create({
        data: { teamId, matchId, userId: playerIds[4] },
      });
      await db.matchTeam.update({
        where: { id: teamId },
        data: { status: "approved", submittedAt: new Date() },
      });
      const reactivated = await reconcileV2TeamEntryRegistration(db, {
        matchId,
        teamId,
      });
      assert.equal(reactivated.action, "REACTIVATED");
      assert.equal(reactivated.rosterVersion, 3);

      const entry = await db.matchEntry.findFirstOrThrow({
        where: { matchId, sourceMatchTeamId: teamId },
        include: { members: { orderBy: [{ rosterVersion: "asc" }, { slot: "asc" }] } },
      });
      assert.equal(entry.status, "ACTIVE");
      assert.equal(entry.displayNameSnapshot, "Renamed TEAM source");
      assert.equal(entry.version, 4);
      assert.deepEqual(
        entry.members
          .filter((member) => member.status === "ACTIVE")
          .map((member) => [member.userId, member.rosterVersion]),
        [
          [playerIds[0], 3],
          [playerIds[3], 3],
          [playerIds[4], 3],
        ],
      );
      const events = await db.settlementEvent.findMany({
        where: { matchEntryId: entry.id },
        orderBy: { createdAt: "asc" },
      });
      assert.deepEqual(
        events.map((event) => [
          event.kind,
          (event.metadata as { rosterVersion?: number } | null)?.rosterVersion,
        ]),
        [
          ["REGISTRATION_APPLY", 1],
          ["REGISTRATION_APPLY", 2],
          ["REGISTRATION_REVERSAL", 2],
          ["REGISTRATION_APPLY", 3],
        ],
      );
      assert.equal(await db.registration.count({ where: { matchId } }), 0);

      await db.matchTeam.create({
        data: {
          id: faultTeamId,
          matchId: faultMatchId,
          captainId: playerIds[5],
          name: "Fault TEAM source",
          inviteCode: `team-reconcile-fault-${suffix}`,
          status: "approved",
          members: {
            create: playerIds.slice(5, 8).map((userId) => ({
              userId,
            })),
          },
        },
      });
      const faultPort: V2EntrySettlementPort = {
        apply: async (tx, input) => {
          await applyRegistrationSettlement(tx, input);
          throw new Error("injected TEAM settlement failure");
        },
        reverse: reverseRegistrationSettlement,
      };
      await assert.rejects(
        () =>
          reconcileV2TeamEntryRegistration(
            db,
            { matchId: faultMatchId, teamId: faultTeamId },
            faultPort,
          ),
        /injected TEAM settlement failure/,
      );
      assert.equal(
        await db.matchEntry.count({ where: { matchId: faultMatchId } }),
        0,
      );
      assert.equal(
        await db.settlementEvent.count({
          where: {
            matchEntry: { matchId: faultMatchId },
          },
        }),
        0,
      );
    } finally {
      await db.$disconnect();
    }
  },
);

test(
  "real PostgreSQL composes TEAM source create/update/join/leave/remove/submit with Entry lifecycle atomically",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const id = (name: string) => `team-source-wire-${name}-${suffix}`;
    const ownerId = id("owner");
    const captainId = id("captain");
    const player2Id = id("player-2");
    const player3Id = id("player-3");
    const player4Id = id("player-4");
    const player5Id = id("player-5");
    const matchId = id("match");
    const teamId = id("team");
    const run = <T>(
      operation: (tx: Prisma.TransactionClient) => Promise<T>,
    ) =>
      db.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });

    try {
      const verifiedAt = new Date("2026-01-01T00:00:00.000Z");
      await db.user.createMany({
        data: [
          ownerId,
          captainId,
          player2Id,
          player3Id,
          player4Id,
          player5Id,
        ].map((userId) => ({
          id: userId,
          email: `${userId}@example.test`,
          nickname: userId,
          emailVerifiedAt: verifiedAt,
        })),
      });
      await db.match.create({
        data: {
          id: matchId,
          title: "TEAM source action wiring",
          dateTime: new Date("2099-02-01T10:00:00.000Z"),
          type: "team",
          status: "registration",
          engineVersion: "V2",
          format: "group_only",
          maxParticipants: 8,
          createdBy: ownerId,
          registrationDeadline: new Date("2099-01-01T00:00:00.000Z"),
          teamRegistrationStart: new Date("2026-01-01T00:00:00.000Z"),
          teamRegistrationDeadline: new Date("2099-01-01T00:00:00.000Z"),
          teamMinMembers: 3,
          teamMaxMembers: 6,
        },
      });

      // create
      const created = await run(async (tx) => {
        const context = await lockV2TeamEntryRegistrationCreationContext(tx, {
          matchId,
          teamId,
          additionalUserIds: [captainId],
        });
        await tx.matchTeam.create({
          data: {
            id: teamId,
            matchId,
            captainId,
            name: "Atomic TEAM",
            inviteCode: id("invite"),
            status: "draft",
            members: { create: { userId: captainId } },
          },
        });
        return reconcileV2TeamEntryRegistrationInTransaction(tx, context);
      });
      assert.equal(created.action, "NOOP_DRAFT_SOURCE");

      // join below the threshold
      const joinedBelowMinimum = await run(async (tx) => {
        const context = await lockV2TeamEntryRegistrationContext(tx, {
          matchId,
          teamId,
          additionalUserIds: [player2Id],
        });
        await tx.matchTeamMember.create({
          data: { matchId, teamId, userId: player2Id },
        });
        return reconcileV2TeamEntryRegistrationInTransaction(tx, context);
      });
      assert.equal(joinedBelowMinimum.action, "NOOP_DRAFT_SOURCE");

      // join to the threshold (the source action also flips its auto status)
      const joinedToMinimum = await run(async (tx) => {
        const context = await lockV2TeamEntryRegistrationContext(tx, {
          matchId,
          teamId,
          additionalUserIds: [player3Id],
        });
        await tx.matchTeamMember.create({
          data: { matchId, teamId, userId: player3Id },
        });
        await tx.matchTeam.update({
          where: { id: teamId },
          data: { status: "approved", submittedAt: new Date() },
        });
        return reconcileV2TeamEntryRegistrationInTransaction(tx, context);
      });
      assert.equal(joinedToMinimum.action, "CREATED_ACTIVE");

      // submit is an exact source/Entry replay once auto-approved
      const submitted = await run(async (tx) => {
        const context = await lockV2TeamEntryRegistrationContext(tx, {
          matchId,
          teamId,
          additionalUserIds: [captainId],
        });
        await tx.matchTeam.update({
          where: { id: teamId },
          data: { status: "approved", submittedAt: new Date() },
        });
        return reconcileV2TeamEntryRegistrationInTransaction(tx, context);
      });
      assert.equal(submitted.action, "NOOP_ALREADY_SYNCHRONIZED");

      // update synchronizes the frozen Entry name, not Legacy registration.
      const updated = await run(async (tx) => {
        const context = await lockV2TeamEntryRegistrationContext(tx, {
          matchId,
          teamId,
          additionalUserIds: [captainId],
        });
        await tx.matchTeam.update({
          where: { id: teamId },
          data: { name: "Renamed Atomic TEAM" },
        });
        return reconcileV2TeamEntryRegistrationInTransaction(tx, context);
      });
      assert.equal(updated.action, "SYNCHRONIZED_NAME");

      // a fourth member creates a successor frozen roster.
      const joinedActive = await run(async (tx) => {
        const context = await lockV2TeamEntryRegistrationContext(tx, {
          matchId,
          teamId,
          additionalUserIds: [player4Id],
        });
        await tx.matchTeamMember.create({
          data: { matchId, teamId, userId: player4Id },
        });
        return reconcileV2TeamEntryRegistrationInTransaction(tx, context);
      });
      assert.equal(joinedActive.action, "REPLACED_ACTIVE_ROSTER");

      // leave while still at the minimum creates another successor roster.
      const leftActive = await run(async (tx) => {
        const context = await lockV2TeamEntryRegistrationContext(tx, {
          matchId,
          teamId,
          additionalUserIds: [player4Id],
        });
        await tx.matchTeamMember.delete({
          where: { teamId_userId: { teamId, userId: player4Id } },
        });
        return reconcileV2TeamEntryRegistrationInTransaction(tx, context);
      });
      assert.equal(leftActive.action, "REPLACED_ACTIVE_ROSTER");

      await run(async (tx) => {
        const context = await lockV2TeamEntryRegistrationContext(tx, {
          matchId,
          teamId,
          additionalUserIds: [player4Id],
        });
        await tx.matchTeamMember.create({
          data: { matchId, teamId, userId: player4Id },
        });
        return reconcileV2TeamEntryRegistrationInTransaction(tx, context);
      });

      // captain removal keeps a valid three-person source and versions it.
      const removed = await run(async (tx) => {
        const context = await lockV2TeamEntryRegistrationContext(tx, {
          matchId,
          teamId,
          additionalUserIds: [captainId, player2Id],
        });
        await tx.matchTeamMember.delete({
          where: { teamId_userId: { teamId, userId: player2Id } },
        });
        return reconcileV2TeamEntryRegistrationInTransaction(tx, context);
      });
      assert.equal(removed.action, "REPLACED_ACTIVE_ROSTER");

      // leave below the threshold deactivates and reverses the current roster.
      const leftBelowMinimum = await run(async (tx) => {
        const context = await lockV2TeamEntryRegistrationContext(tx, {
          matchId,
          teamId,
          additionalUserIds: [player3Id],
        });
        await tx.matchTeamMember.delete({
          where: { teamId_userId: { teamId, userId: player3Id } },
        });
        await tx.matchTeam.update({
          where: { id: teamId },
          data: { status: "draft", submittedAt: null },
        });
        return reconcileV2TeamEntryRegistrationInTransaction(tx, context);
      });
      assert.equal(leftBelowMinimum.action, "DEACTIVATED_TO_DRAFT");

      const beforeFault = await db.matchEntry.findFirstOrThrow({
        where: { matchId, sourceMatchTeamId: teamId },
        select: { id: true, status: true, version: true },
      });
      const eventsBeforeFault = await db.settlementEvent.count({
        where: { matchEntryId: beforeFault.id },
      });
      const pointsBeforeFault = await db.user.findMany({
        where: { id: { in: [captainId, player4Id, player5Id] } },
        orderBy: { id: "asc" },
        select: { id: true, points: true },
      });
      const faultPort: V2EntrySettlementPort = {
        apply: async (tx, input) => {
          await applyRegistrationSettlement(tx, input);
          throw new Error("injected source/reconcile fault");
        },
        reverse: reverseRegistrationSettlement,
      };
      await assert.rejects(
        () =>
          run(async (tx) => {
            const context = await lockV2TeamEntryRegistrationContext(tx, {
              matchId,
              teamId,
              additionalUserIds: [player5Id],
            });
            await tx.matchTeamMember.create({
              data: { matchId, teamId, userId: player5Id },
            });
            await tx.matchTeam.update({
              where: { id: teamId },
              data: { status: "approved", submittedAt: new Date() },
            });
            return reconcileV2TeamEntryRegistrationInTransaction(
              tx,
              context,
              faultPort,
            );
          }),
        /injected source\/reconcile fault/,
      );

      const sourceAfterFault = await db.matchTeam.findUniqueOrThrow({
        where: { id: teamId },
        select: {
          status: true,
          members: { orderBy: { userId: "asc" }, select: { userId: true } },
        },
      });
      assert.equal(sourceAfterFault.status, "draft");
      assert.equal(
        sourceAfterFault.members.some((member) => member.userId === player5Id),
        false,
      );
      assert.deepEqual(
        await db.matchEntry.findFirstOrThrow({
          where: { id: beforeFault.id },
          select: { status: true, version: true },
        }),
        { status: beforeFault.status, version: beforeFault.version },
      );
      assert.equal(
        await db.settlementEvent.count({ where: { matchEntryId: beforeFault.id } }),
        eventsBeforeFault,
      );
      assert.deepEqual(
        await db.user.findMany({
          where: { id: { in: [captainId, player4Id, player5Id] } },
          orderBy: { id: "asc" },
          select: { id: true, points: true },
        }),
        pointsBeforeFault,
      );

      const concurrentJoin = (userId: string) =>
        run(async (tx) => {
          const context = await lockV2TeamEntryRegistrationContext(tx, {
            matchId,
            teamId,
            additionalUserIds: [userId],
          });
          const membership = await tx.matchTeamMember.findUnique({
            where: { matchId_userId: { matchId, userId } },
            select: { id: true },
          });
          if (!membership) {
            await tx.matchTeamMember.create({
              data: { matchId, teamId, userId },
            });
          }
          const memberCount = await tx.matchTeamMember.count({
            where: { matchId, teamId },
          });
          await tx.matchTeam.update({
            where: { id: teamId },
            data: {
              status: memberCount >= 3 ? "approved" : "draft",
              submittedAt: memberCount >= 3 ? new Date() : null,
            },
          });
          return reconcileV2TeamEntryRegistrationInTransaction(tx, context);
        });

      const racingJoins = await Promise.allSettled([
        concurrentJoin(player3Id),
        concurrentJoin(player5Id),
      ]);
      assert.ok(
        racingJoins.some((result) => result.status === "fulfilled"),
        "at least one serialized source writer must commit",
      );
      for (const [index, result] of racingJoins.entries()) {
        if (result.status === "rejected") {
          assert.equal(isRetryableTeamSourceConflict(result.reason), true);
          await concurrentJoin(index === 0 ? player3Id : player5Id);
        }
      }

      const converged = await db.matchTeam.findUniqueOrThrow({
        where: { id: teamId },
        select: {
          status: true,
          members: { orderBy: { userId: "asc" }, select: { userId: true } },
          sourcedMatchEntries: {
            select: {
              id: true,
              status: true,
              members: {
                where: { status: "ACTIVE", effectiveUntil: null },
                orderBy: { slot: "asc" },
                select: { userId: true, rosterVersion: true },
              },
            },
          },
        },
      });
      assert.equal(converged.status, "approved");
      assert.equal(converged.members.length, 4);
      assert.equal(converged.sourcedMatchEntries.length, 1);
      assert.equal(converged.sourcedMatchEntries[0].status, "ACTIVE");
      assert.deepEqual(
        converged.sourcedMatchEntries[0].members
          .map((member) => member.userId)
          .sort(),
        [captainId, player3Id, player4Id, player5Id].sort(),
      );
      assert.equal(
        new Set(
          converged.sourcedMatchEntries[0].members.map(
            (member) => member.rosterVersion,
          ),
        ).size,
        1,
      );
      assert.equal(await db.registration.count({ where: { matchId } }), 0);
    } finally {
      await db.$disconnect();
    }
  },
);
