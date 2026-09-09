import { Prisma,PrismaClient } from "@prisma/client";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { lockMatchForEngine } from "../../../lib/server/match/engine-guard";

import {
hasMaterializedV2TeamEntry,
isRetryableTeamSourceConflict,
lockTeamSourceMatch,
lockTeamSourceRows,
TEAM_SOURCE_ENTRY_EXISTS_MESSAGE,
} from "../../../lib/server/match/team-source";
import { lockAdminRoleChangeMutex } from "../../../lib/server/user/admin-role-mutex";
import {
setUserBanState,
setUsersBanState,
} from "../../../lib/server/user/ban-user";
import {
HardDeleteUsersBlockedError,
hardDeleteUsersWithoutBusinessHistory,
} from "../../../lib/server/user/hard-delete-users";
import { lockUsersForUpdate } from "../../../lib/server/user/lock-users";
import { createV2Entry } from "./entries";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;

test(
  "the admin role advisory mutex serializes mutually conflicting demotions",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const adminAId = `admin-mutex-a-${suffix}`;
    const adminBId = `admin-mutex-b-${suffix}`;
    let releaseHeldMutex = () => {};
    let holder: Promise<unknown> | undefined;
    let waiter: Promise<unknown> | undefined;

    try {
      assert.equal(
        await db.user.count({ where: { role: "admin" } }),
        0,
        "this integration test requires the dedicated fresh database",
      );
      const verifiedAt = new Date("2026-09-04T00:00:00.000Z");
      await db.user.createMany({
        data: [adminAId, adminBId].map((userId) => ({
          id: userId,
          email: `${userId}@example.test`,
          nickname: userId,
          role: "admin" as const,
          emailVerifiedAt: verifiedAt,
        })),
      });

      let announceHeldMutex = () => {};
      const heldMutex = new Promise<void>((resolve) => {
        announceHeldMutex = resolve;
      });
      const releaseMutex = new Promise<void>((resolve) => {
        releaseHeldMutex = resolve;
      });
      holder = db.$transaction(async (tx) => {
        await lockAdminRoleChangeMutex(tx);
        announceHeldMutex();
        await releaseMutex;
      });
      await heldMutex;

      const probe = await db.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(207698976, 20260904) AS locked
      `;
      assert.deepEqual(probe, [{ locked: false }]);

      let announceWaiterStarted = () => {};
      const waiterStarted = new Promise<void>((resolve) => {
        announceWaiterStarted = resolve;
      });
      let waiterAcquired = false;
      waiter = db.$transaction(async (tx) => {
        announceWaiterStarted();
        await lockAdminRoleChangeMutex(tx);
        waiterAcquired = true;
      });
      await waiterStarted;
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(waiterAcquired, false);
      releaseHeldMutex();
      await Promise.all([holder, waiter]);
      assert.equal(waiterAcquired, true);

      const demoteOtherAdmin = (actorId: string, targetId: string) =>
        db.$transaction(
          async (tx) => {
            await lockAdminRoleChangeMutex(tx);
            await lockUsersForUpdate(tx, [actorId, targetId]);
            const [actor, target] = await Promise.all([
              tx.user.findUnique({
                where: { id: actorId },
                select: {
                  role: true,
                  isBanned: true,
                  emailVerifiedAt: true,
                },
              }),
              tx.user.findUnique({
                where: { id: targetId },
                select: { role: true, nickname: true, email: true },
              }),
            ]);
            if (
              !actor ||
              actor.role !== "admin" ||
              actor.isBanned ||
              !actor.emailVerifiedAt
            ) {
              throw new Error("administrator state changed");
            }
            if (!target) throw new Error("target missing");
            if (target.role === "admin") {
              const otherAdminCount = await tx.user.count({
                where: { role: "admin", id: { not: targetId } },
              });
              if (otherAdminCount === 0) {
                throw new Error("at least one administrator is required");
              }
            }
            if (target.role === "user") return false;

            await tx.user.update({
              where: { id: targetId },
              data: { role: "user" },
            });
            await tx.auditLog.create({
              data: {
                actorId,
                action: "user.role.change",
                entityType: "User",
                entityId: targetId,
                details: { from: "admin", to: "user" },
              },
            });
            return true;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 5_000,
            timeout: 30_000,
          },
        );

      const demotions = await Promise.allSettled([
        demoteOtherAdmin(adminAId, adminBId),
        demoteOtherAdmin(adminBId, adminAId),
      ]);
      assert.equal(
        demotions.filter(
          (result) => result.status === "fulfilled" && result.value,
        ).length,
        1,
      );
      assert.equal(
        await db.user.count({
          where: { id: { in: [adminAId, adminBId] }, role: "admin" },
        }),
        1,
      );
      assert.equal(
        await db.auditLog.count({
          where: {
            action: "user.role.change",
            entityId: { in: [adminAId, adminBId] },
          },
        }),
        1,
      );
    } finally {
      releaseHeldMutex();
      await Promise.allSettled(
        [holder, waiter].filter(
          (operation): operation is Promise<unknown> => operation !== undefined,
        ),
      );
      await db.auditLog.deleteMany({
        where: {
          OR: [
            { actorId: { in: [adminAId, adminBId] } },
            { entityId: { in: [adminAId, adminBId] } },
          ],
        },
      });
      await db.user.deleteMany({
        where: { id: { in: [adminAId, adminBId] } },
      });
      await db.$disconnect();
    }
  },
);

test(
  "lifecycle safety helpers preserve engine and user history invariants in PostgreSQL",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const id = (name: string) => `safety-${name}-${suffix}`;
    const verifiedAt = new Date("2026-09-04T00:00:00.000Z");
    const adminId = id("admin");
    const finishPlayerAId = id("finish-a");
    const finishPlayerBId = id("finish-b");

    const createUser = (userId: string, role: "admin" | "user" = "user") => ({
      id: userId,
      email: `${userId}@example.test`,
      nickname: userId,
      role,
      emailVerifiedAt: verifiedAt,
    });
    const createMatch = (input: {
      matchId: string;
      createdBy: string;
      status?: "registration" | "ongoing";
      engineVersion?: "LEGACY" | "V2";
    }) =>
      db.match.create({
        data: {
          id: input.matchId,
          title: input.matchId,
          dateTime: new Date("2026-10-01T10:00:00.000Z"),
          type: "single",
          status: input.status ?? "registration",
          engineVersion: input.engineVersion ?? "LEGACY",
          maxParticipants: 8,
          createdBy: input.createdBy,
          registrationDeadline: new Date("2099-01-01T00:00:00.000Z"),
        },
      });

    try {
      await db.user.createMany({
        data: [
          createUser(adminId, "admin"),
          createUser(finishPlayerAId),
          createUser(finishPlayerBId),
        ],
      });

      const ongoingMatchId = id("fresh-ongoing");
      const registrationMatchId = id("fresh-registration");
      const completedGrouping = {
        competitorType: "user",
        groups: [
          {
            name: "A",
            players: [
              { id: finishPlayerAId },
              { id: finishPlayerBId },
            ],
          },
        ],
      };
      for (const [matchId, status] of [
        [ongoingMatchId, "ongoing"],
        [registrationMatchId, "registration"],
      ] as const) {
        await db.match.create({
          data: {
            id: matchId,
            title: matchId,
            dateTime: new Date("2026-10-01T10:00:00.000Z"),
            type: "single",
            status,
            engineVersion: "LEGACY",
            format: "group_only",
            maxParticipants: 2,
            createdBy: adminId,
            registrationDeadline: new Date("2026-09-01T00:00:00.000Z"),
            groupingGeneratedAt: verifiedAt,
            groupingResult: { create: { payload: completedGrouping } },
            results: {
              create: {
                winnerId: finishPlayerAId,
                loserId: finishPlayerBId,
                winnerTeamIds: [finishPlayerAId],
                loserTeamIds: [finishPlayerBId],
                score: { phase: "group", groupName: "A" },
                reportedBy: adminId,
                confirmed: true,
                resultVerifiedAt: verifiedAt,
                verifierId: adminId,
              },
            },
          },
        });
      }

      const lockedMatch = await db.$transaction((tx) =>
        lockMatchForEngine(tx, {
          matchId: ongoingMatchId,
          expectedEngine: "LEGACY",
          expectedQuickMatch: false,
        }),
      );
      assert.deepEqual(lockedMatch, {
        id: ongoingMatchId,
        engineVersion: "LEGACY",
        isQuickMatch: false,
      });
      assert.equal(typeof lockedMatch.isQuickMatch, "boolean");

      const cleanUserId = id("delete-clean");
      const matchOwnerUserId = id("delete-match-owner");
      const resultUserId = id("delete-result");
      const identityUserId = id("delete-identity");
      const v2HistoryUserId = id("delete-v2-history");
      await db.user.createMany({
        data: [
          createUser(cleanUserId),
          createUser(matchOwnerUserId),
          createUser(resultUserId),
          createUser(identityUserId),
          createUser(v2HistoryUserId),
        ],
      });

      const cleanDelete = await db.$transaction((tx) =>
        hardDeleteUsersWithoutBusinessHistory(tx, {
          actorId: adminId,
          userIds: [cleanUserId],
          mode: "single",
        }),
      );
      assert.deepEqual(cleanDelete, {
        deletedCount: 1,
        deletedUserIds: [cleanUserId],
      });
      assert.equal(
        await db.user.count({ where: { id: cleanUserId } }),
        0,
      );
      assert.equal(
        await db.auditLog.count({
          where: {
            actorId: adminId,
            action: "user.delete",
            entityType: "User",
            entityId: cleanUserId,
          },
        }),
        1,
      );

      const ownedMatchId = id("owned-match");
      await createMatch({
        matchId: ownedMatchId,
        createdBy: matchOwnerUserId,
      });

      const resultHistoryMatchId = id("result-history-match");
      await createMatch({ matchId: resultHistoryMatchId, createdBy: adminId });
      const resultHistory = await db.matchResult.create({
        data: {
          matchId: resultHistoryMatchId,
          winnerId: resultUserId,
          loserId: finishPlayerBId,
          winnerTeamIds: [resultUserId],
          loserTeamIds: [finishPlayerBId],
          score: { phase: "group" },
          reportedBy: adminId,
        },
      });

      const identity = await db.userIdentity.create({
        data: {
          userId: identityUserId,
          nameHash: id("name-hash"),
          studentIdHash: id("student-hash"),
        },
      });

      const v2HistoryMatchId = id("v2-history-match");
      await createMatch({
        matchId: v2HistoryMatchId,
        createdBy: adminId,
        engineVersion: "V2",
      });
      const v2HistoryEntry = await createV2Entry(db, {
        actor: { id: v2HistoryUserId, role: "user" },
        matchId: v2HistoryMatchId,
        kind: "INDIVIDUAL",
        sourceId: v2HistoryUserId,
        status: "DRAFT",
      });

      for (const blockedUserId of [
        matchOwnerUserId,
        resultUserId,
        identityUserId,
        v2HistoryUserId,
      ]) {
        await assert.rejects(
          db.$transaction((tx) =>
            hardDeleteUsersWithoutBusinessHistory(tx, {
              actorId: adminId,
              userIds: [blockedUserId],
              mode: "single",
            }),
          ),
          (error: unknown) => {
            assert.ok(error instanceof HardDeleteUsersBlockedError);
            assert.equal(error.blockedCount, 1);
            assert.equal(error.requestedCount, 1);
            return true;
          },
        );
      }
      assert.equal(
        await db.user.count({
          where: {
            id: {
              in: [
                matchOwnerUserId,
                resultUserId,
                identityUserId,
                v2HistoryUserId,
              ],
            },
          },
        }),
        4,
      );
      assert.equal(await db.match.count({ where: { id: ownedMatchId } }), 1);
      assert.equal(
        await db.matchResult.count({ where: { id: resultHistory.id } }),
        1,
      );
      assert.equal(
        await db.userIdentity.count({ where: { id: identity.id } }),
        1,
      );
      assert.equal(
        await db.matchEntry.count({ where: { id: v2HistoryEntry.id } }),
        1,
      );
      assert.equal(
        await db.matchEntryMember.count({
          where: { entryId: v2HistoryEntry.id, userId: v2HistoryUserId },
        }),
        1,
      );

      const bannedUserId = id("ban-v2-source");
      const bannedUserMatchId = id("ban-v2-match");
      await db.user.create({ data: createUser(bannedUserId) });
      await createMatch({
        matchId: bannedUserMatchId,
        createdBy: adminId,
        engineVersion: "V2",
      });
      const bannedUserEntry = await createV2Entry(db, {
        actor: { id: bannedUserId, role: "user" },
        matchId: bannedUserMatchId,
        kind: "INDIVIDUAL",
        sourceId: bannedUserId,
        status: "ACTIVE",
      });
      await db.registration.create({
        data: { matchId: bannedUserMatchId, userId: bannedUserId },
      });

      const beforeBan = await db.user.findUniqueOrThrow({
        where: { id: bannedUserId },
        select: {
          points: true,
          eloRating: true,
          wins: true,
          losses: true,
          matchesPlayed: true,
          sessionVersion: true,
        },
      });
      const beforeBanHistory = {
        events: await db.settlementEvent.count({
          where: { matchEntryId: bannedUserEntry.id },
        }),
        effects: await db.settlementEffect.count({
          where: { event: { matchEntryId: bannedUserEntry.id } },
        }),
        points: await db.pointsTransaction.count({
          where: { userId: bannedUserId },
        }),
      };

      const banResult = await db.$transaction(
        (tx) =>
          setUserBanState(tx, {
            userId: bannedUserId,
            banned: true,
            actorId: adminId,
          }),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      assert.deepEqual(banResult.removedMatches, [
        { id: bannedUserMatchId, title: bannedUserMatchId },
      ]);
      assert.deepEqual(banResult.v2Disqualifications, [
        {
          matchId: bannedUserMatchId,
          matchTitle: bannedUserMatchId,
          entryId: bannedUserEntry.id,
          voidedFixtureIds: [],
          voidedResultRevisionIds: [],
        },
      ]);
      assert.ok(banResult.notificationOutboxId);

      const afterBan = await db.user.findUniqueOrThrow({
        where: { id: bannedUserId },
        select: {
          isBanned: true,
          points: true,
          eloRating: true,
          wins: true,
          losses: true,
          matchesPlayed: true,
          sessionVersion: true,
        },
      });
      assert.deepEqual(afterBan, {
        isBanned: true,
        points: beforeBan.points - 1,
        eloRating: beforeBan.eloRating,
        wins: beforeBan.wins,
        losses: beforeBan.losses,
        matchesPlayed: beforeBan.matchesPlayed,
        sessionVersion: beforeBan.sessionVersion + 1,
      });
      assert.equal(
        await db.matchEntry.count({
          where: {
            id: bannedUserEntry.id,
            status: "DISQUALIFIED",
            sourceUserId: bannedUserId,
            disqualifiedAt: { not: null },
          },
        }),
        1,
      );
      assert.equal(
        await db.matchEntryMember.count({
          where: {
            entryId: bannedUserEntry.id,
            userId: bannedUserId,
            status: "DISQUALIFIED",
            effectiveUntil: { not: null },
            endReason: "USER_BANNED",
          },
        }),
        1,
      );
      assert.equal(
        await db.registration.count({
          where: { matchId: bannedUserMatchId, userId: bannedUserId },
        }),
        1,
      );
      assert.deepEqual(
        {
          events: await db.settlementEvent.count({
            where: { matchEntryId: bannedUserEntry.id },
          }),
          effects: await db.settlementEffect.count({
            where: { event: { matchEntryId: bannedUserEntry.id } },
          }),
          points: await db.pointsTransaction.count({
            where: { userId: bannedUserId },
          }),
        },
        {
          events: beforeBanHistory.events + 1,
          effects: beforeBanHistory.effects + 1,
          points: beforeBanHistory.points + 1,
        },
      );
      assert.equal(
        await db.settlementEvent.count({
          where: {
            matchEntryId: bannedUserEntry.id,
            kind: "REGISTRATION_APPLY",
            status: "REVERSED",
          },
        }),
        1,
      );
      assert.equal(
        await db.settlementEvent.count({
          where: {
            matchEntryId: bannedUserEntry.id,
            kind: "REGISTRATION_REVERSAL",
            status: "APPLIED",
          },
        }),
        1,
      );
      assert.equal(
        await db.notificationOutbox.count({
          where: {
            id: banResult.notificationOutboxId ?? undefined,
            userId: bannedUserId,
            kind: "account_banned",
          },
        }),
        1,
      );
    } finally {
      await db.$disconnect();
    }
  },
);

test(
  "team source locks preserve create, join, submit, ban, and V2 materialization boundaries",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const id = (name: string) => `team-source-${name}-${suffix}`;
    const verifiedAt = new Date("2026-09-04T00:00:00.000Z");
    const captainId = id("captain");
    const memberBId = id("member-b");
    const memberCId = id("member-c");
    const adminId = id("admin");
    const v2CaptainId = id("v2-captain");
    const v2MemberBId = id("v2-member-b");
    const v2MemberCId = id("v2-member-c");
    const legacyMatchId = id("legacy-match");
    const legacyTeamId = id("legacy-team");
    const legacyInviteCode = `LEGACY${suffix.slice(0, 8).toUpperCase()}`;
    const v2MatchId = id("v2-match");
    const v2TeamId = id("v2-team");
    let releaseBanTransaction = () => {};
    let banOperation: Promise<unknown> | undefined;
    let submitOperation: Promise<unknown> | undefined;

    const runTeamSourceTransaction = <T>(
      operation: (tx: Prisma.TransactionClient) => Promise<T>,
    ) =>
      db.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5_000,
        timeout: 30_000,
      });

    const createSourceTeam = () =>
      runTeamSourceTransaction(async (tx) => {
        const lockedMatch = await lockTeamSourceMatch(tx, legacyMatchId);
        if (!lockedMatch.ok) throw new Error(lockedMatch.error);
        assert.equal(lockedMatch.ok, true);

        const lockedSource = await lockTeamSourceRows(tx, {
          matchId: legacyMatchId,
          userIds: [captainId],
        });
        assert.deepEqual(lockedSource, { teamIds: [], members: [] });
        assert.equal(
          await hasMaterializedV2TeamEntry(tx, {
            match: lockedMatch.match,
            teamIds: lockedSource.teamIds,
          }),
          false,
        );

        await lockUsersForUpdate(tx, [captainId]);
        const actor = await tx.user.findUniqueOrThrow({
          where: { id: captainId },
          select: { isBanned: true, emailVerifiedAt: true },
        });
        assert.equal(actor.isBanned, false);
        assert.ok(actor.emailVerifiedAt);

        const team = await tx.matchTeam.create({
          data: {
            id: legacyTeamId,
            matchId: legacyMatchId,
            captainId,
            name: "PG source team",
            inviteCode: legacyInviteCode,
            contact: "integration contact",
            status: "draft",
            members: { create: { userId: captainId } },
          },
          select: { id: true },
        });
        await tx.auditLog.create({
          data: {
            actorId: captainId,
            action: "match.team.create",
            entityType: "MatchTeam",
            entityId: team.id,
            details: { matchId: legacyMatchId },
          },
        });
        return { lockedMatch: lockedMatch.match, team };
      });

    const joinSourceTeam = (userId: string) =>
      runTeamSourceTransaction(async (tx) => {
        const lockedMatch = await lockTeamSourceMatch(tx, legacyMatchId);
        if (!lockedMatch.ok) return lockedMatch;

        const binding = await tx.matchTeam.findFirst({
          where: { matchId: legacyMatchId, inviteCode: legacyInviteCode },
          select: { id: true },
        });
        if (!binding) return { ok: false as const, error: "invite missing" };

        const lockedSource = await lockTeamSourceRows(tx, {
          matchId: legacyMatchId,
          teamIds: [binding.id],
          userIds: [userId],
        });
        if (
          await hasMaterializedV2TeamEntry(tx, {
            match: lockedMatch.match,
            teamIds: lockedSource.teamIds,
          })
        ) {
          return {
            ok: false as const,
            error: TEAM_SOURCE_ENTRY_EXISTS_MESSAGE,
          };
        }

        const teamSubject = await tx.matchTeam.findUniqueOrThrow({
          where: { id: binding.id },
          select: {
            captainId: true,
            members: { select: { userId: true } },
          },
        });
        await lockUsersForUpdate(tx, [
          userId,
          teamSubject.captainId,
          ...teamSubject.members.map((member) => member.userId),
        ]);
        const [actor, team] = await Promise.all([
          tx.user.findUnique({
            where: { id: userId },
            select: { isBanned: true, emailVerifiedAt: true },
          }),
          tx.matchTeam.findUnique({
            where: { id: binding.id },
            select: {
              status: true,
              submittedAt: true,
              members: {
                select: {
                  userId: true,
                  user: { select: { isBanned: true } },
                },
              },
            },
          }),
        ]);
        if (!actor || actor.isBanned || !actor.emailVerifiedAt || !team) {
          return { ok: false as const, error: "actor unavailable" };
        }
        if (team.members.some((member) => member.user.isBanned)) {
          return { ok: false as const, error: "member banned" };
        }

        await tx.matchTeamMember.create({
          data: { teamId: binding.id, matchId: legacyMatchId, userId },
        });
        const memberCount = team.members.length + 1;
        const reachedMinimum = memberCount >= 3;
        await tx.matchTeam.update({
          where: { id: binding.id },
          data: {
            status: reachedMinimum ? "approved" : "draft",
            submittedAt: reachedMinimum
              ? (team.submittedAt ?? new Date())
              : null,
            reviewNote: null,
          },
        });
        return { ok: true as const, memberCount };
      });

    const submitSourceTeam = () =>
      runTeamSourceTransaction(async (tx) => {
        const lockedMatch = await lockTeamSourceMatch(tx, legacyMatchId);
        if (!lockedMatch.ok) return lockedMatch;
        const lockedSource = await lockTeamSourceRows(tx, {
          matchId: legacyMatchId,
          teamIds: [legacyTeamId],
        });
        if (!lockedSource.teamIds.includes(legacyTeamId)) {
          return { ok: false as const, error: "team missing" };
        }
        if (
          await hasMaterializedV2TeamEntry(tx, {
            match: lockedMatch.match,
            teamIds: [legacyTeamId],
          })
        ) {
          return {
            ok: false as const,
            error: TEAM_SOURCE_ENTRY_EXISTS_MESSAGE,
          };
        }

        const teamSubject = await tx.matchTeam.findUniqueOrThrow({
          where: { id: legacyTeamId },
          select: {
            captainId: true,
            members: { select: { userId: true } },
          },
        });
        await lockUsersForUpdate(tx, [
          teamSubject.captainId,
          ...teamSubject.members.map((member) => member.userId),
        ]);
        const [actor, team] = await Promise.all([
          tx.user.findUnique({
            where: { id: teamSubject.captainId },
            select: { isBanned: true, emailVerifiedAt: true },
          }),
          tx.matchTeam.findUnique({
            where: { id: legacyTeamId },
            select: {
              name: true,
              members: {
                select: {
                  userId: true,
                  user: { select: { isBanned: true } },
                },
              },
            },
          }),
        ]);
        if (!actor || actor.isBanned || !actor.emailVerifiedAt || !team) {
          return { ok: false as const, error: "captain unavailable" };
        }
        if (team.members.some((member) => member.user.isBanned)) {
          return { ok: false as const, error: "member banned" };
        }
        if (team.members.length < 3 || team.members.length > 5) {
          return { ok: false as const, error: "invalid member count" };
        }

        await tx.matchTeam.update({
          where: { id: legacyTeamId },
          data: {
            status: "approved",
            submittedAt: new Date(),
            reviewNote: null,
          },
        });
        await tx.auditLog.create({
          data: {
            actorId: teamSubject.captainId,
            action: "match.team.submit",
            entityType: "MatchTeam",
            entityId: legacyTeamId,
            details: {
              matchId: legacyMatchId,
              memberCount: team.members.length,
            },
          },
        });
        return { ok: true as const };
      });

    try {
      await db.user.createMany({
        data: [
          ...[
            captainId,
            memberBId,
            memberCId,
            v2CaptainId,
            v2MemberBId,
            v2MemberCId,
          ].map((userId) => ({
            id: userId,
            email: `${userId}@example.test`,
            nickname: userId,
            emailVerifiedAt: verifiedAt,
          })),
          {
            id: adminId,
            email: `${adminId}@example.test`,
            nickname: adminId,
            role: "admin" as const,
            emailVerifiedAt: verifiedAt,
          },
        ],
      });
      await db.match.createMany({
        data: [
          { id: legacyMatchId, engineVersion: "V2" as const },
          { id: v2MatchId, engineVersion: "V2" as const },
        ].map((match) => ({
          ...match,
          title: match.id,
          dateTime: new Date("2099-02-01T00:00:00.000Z"),
          type: "team" as const,
          status: "registration" as const,
          isQuickMatch: false,
          maxParticipants: 24,
          createdBy: captainId,
          registrationDeadline: new Date("2099-01-01T00:00:00.000Z"),
          teamRegistrationStart: new Date("2026-01-01T00:00:00.000Z"),
          teamRegistrationDeadline: new Date("2099-01-01T00:00:00.000Z"),
          teamMinMembers: 3,
          teamMaxMembers: 5,
        })),
      });

      const created = await createSourceTeam();
      assert.equal(created.team.id, legacyTeamId);
      assert.deepEqual(
        {
          id: created.lockedMatch.id,
          type: created.lockedMatch.type,
          status: created.lockedMatch.status,
          engineVersion: created.lockedMatch.engineVersion,
          isQuickMatch: created.lockedMatch.isQuickMatch,
        },
        {
          id: legacyMatchId,
          type: "team",
          status: "registration",
          engineVersion: "V2",
          isQuickMatch: false,
        },
      );
      assert.ok(created.lockedMatch.createdAt instanceof Date);
      assert.ok(created.lockedMatch.registrationDeadline instanceof Date);

      assert.deepEqual(await joinSourceTeam(memberBId), {
        ok: true,
        memberCount: 2,
      });
      assert.deepEqual(await joinSourceTeam(memberCId), {
        ok: true,
        memberCount: 3,
      });
      assert.deepEqual(await submitSourceTeam(), { ok: true });
      const normalTeam = await db.matchTeam.findUniqueOrThrow({
        where: { id: legacyTeamId },
        select: {
          status: true,
          submittedAt: true,
          members: { select: { userId: true } },
        },
      });
      assert.equal(normalTeam.status, "approved");
      assert.ok(normalTeam.submittedAt);
      assert.deepEqual(
        normalTeam.members.map((member) => member.userId).sort(),
        [captainId, memberBId, memberCId].sort(),
      );
      assert.equal(
        await db.auditLog.count({
          where: {
            entityId: legacyTeamId,
            action: { in: ["match.team.create", "match.team.submit"] },
          },
        }),
        2,
      );

      await db.matchTeam.create({
        data: {
          id: v2TeamId,
          matchId: v2MatchId,
          captainId: v2CaptainId,
          name: "Frozen V2 source team",
          inviteCode: `V2${suffix.slice(0, 10).toUpperCase()}`,
          status: "approved",
        },
      });
      await db.matchTeamMember.createMany({
        data: [v2CaptainId, v2MemberBId, v2MemberCId].map(
          (userId, index) => ({
            id: id(`v2-source-member-${index}`),
            teamId: v2TeamId,
            matchId: v2MatchId,
            userId,
          }),
        ),
      });
      const v2Entry = await db.matchEntry.create({
        data: {
          id: id("v2-entry"),
          matchId: v2MatchId,
          kind: "TEAM",
          status: "ACTIVE",
          sourceKey: `team:${v2TeamId}`,
          sourceMatchTeamId: v2TeamId,
          displayNameSnapshot: "Frozen V2 source team",
        },
      });
      const v2GateResult = await runTeamSourceTransaction(async (tx) => {
        const lockedMatch = await lockTeamSourceMatch(tx, v2MatchId);
        if (!lockedMatch.ok) return lockedMatch.error;
        const lockedSource = await lockTeamSourceRows(tx, {
          matchId: v2MatchId,
          teamIds: [v2TeamId],
          userIds: [v2CaptainId],
        });
        if (
          await hasMaterializedV2TeamEntry(tx, {
            match: lockedMatch.match,
            teamIds: lockedSource.teamIds,
          })
        ) {
          return TEAM_SOURCE_ENTRY_EXISTS_MESSAGE;
        }
        await tx.matchTeam.update({
          where: { id: v2TeamId },
          data: { name: "must not be written" },
        });
        return null;
      });
      assert.equal(v2GateResult, TEAM_SOURCE_ENTRY_EXISTS_MESSAGE);
      assert.equal(
        (
          await db.matchTeam.findUniqueOrThrow({
            where: { id: v2TeamId },
            select: { name: true },
          })
        ).name,
        "Frozen V2 source team",
      );
      assert.equal(
        await db.matchEntry.count({ where: { id: v2Entry.id } }),
        1,
      );

      let announceBanWrites = () => {};
      const banWritesReady = new Promise<void>((resolve) => {
        announceBanWrites = resolve;
      });
      const holdBanTransaction = new Promise<void>((resolve) => {
        releaseBanTransaction = resolve;
      });
      banOperation = db.$transaction(
        async (tx) => {
          const result = await setUsersBanState(tx, {
            actorId: adminId,
            userIds: [memberCId],
            banned: true,
          });
          announceBanWrites();
          await holdBanTransaction;
          return result;
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5_000,
          timeout: 30_000,
        },
      );
      await banWritesReady;

      let submitSettled = false;
      submitOperation = submitSourceTeam().finally(() => {
        submitSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(submitSettled, false);
      releaseBanTransaction();

      const [banOutcome, submitOutcome] = await Promise.allSettled([
        banOperation,
        submitOperation,
      ]);
      assert.equal(banOutcome.status, "fulfilled");
      if (banOutcome.status === "fulfilled") {
        const results = banOutcome.value as Awaited<
          ReturnType<typeof setUsersBanState>
        >;
        assert.equal(results.length, 1);
        assert.deepEqual(results[0].removedMatches, []);
      }
      if (submitOutcome.status === "fulfilled") {
        assert.deepEqual(submitOutcome.value, {
          ok: false,
          error: "member banned",
        });
      } else {
        assert.equal(isRetryableTeamSourceConflict(submitOutcome.reason), true);
      }

      const afterRaceUser = await db.user.findUniqueOrThrow({
        where: { id: memberCId },
        select: {
          isBanned: true,
          points: true,
          eloRating: true,
          wins: true,
          losses: true,
          matchesPlayed: true,
        },
      });
      assert.deepEqual(afterRaceUser, {
        isBanned: true,
        points: 0,
        eloRating: 1200,
        wins: 0,
        losses: 0,
        matchesPlayed: 0,
      });
      const afterRaceTeam = await db.matchTeam.findUniqueOrThrow({
        where: { id: legacyTeamId },
        select: {
          status: true,
          submittedAt: true,
          members: { select: { userId: true } },
        },
      });
      assert.equal(afterRaceTeam.status, "approved");
      assert.notEqual(afterRaceTeam.submittedAt, null);
      assert.deepEqual(
        afterRaceTeam.members.map((member) => member.userId).sort(),
        [captainId, memberBId, memberCId].sort(),
      );
      assert.equal(
        await db.matchEntry.count({ where: { id: v2Entry.id } }),
        1,
      );
    } finally {
      releaseBanTransaction();
      await Promise.allSettled(
        [banOperation, submitOperation].filter(
          (operation): operation is Promise<unknown> => operation !== undefined,
        ),
      );
      await db.$disconnect();
    }
  },
);
