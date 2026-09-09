import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Prisma, PrismaClient } from "@prisma/client";

import {
  setUserBanState,
  setUsersBanState,
} from "../../../lib/server/user/ban-user";
import { applyRegistrationSettlement } from "./registration-settlements";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;

const extendedCases = [
  { type: "single" as const, format: "group_then_knockout" as const, size: 1 },
  { type: "double" as const, format: "group_only" as const, size: 2 },
  { type: "double" as const, format: "group_then_knockout" as const, size: 2 },
  { type: "team" as const, format: "group_only" as const, size: 3 },
  { type: "team" as const, format: "group_then_knockout" as const, size: 3 },
] as const;

test(
  "one account ban atomically disqualifies its whole Entry in the other five V2 cells",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const adminId = `six-ban-admin-${suffix}`;
    const targetId = `six-ban-target-${suffix}`;
    const verifiedAt = new Date("2026-09-06T00:00:00.000Z");
    const matchIds: string[] = [];
    const entryIds: string[] = [];

    try {
      await db.user.createMany({
        data: [
          {
            id: adminId,
            email: `${adminId}@example.test`,
            nickname: "Six-cell ban admin",
            role: "admin",
            emailVerifiedAt: verifiedAt,
          },
          {
            id: targetId,
            email: `${targetId}@example.test`,
            nickname: "Six-cell ban target",
            emailVerifiedAt: verifiedAt,
          },
          ...Array.from({ length: 10 }, (_, index) => ({
            id: `six-ban-partner-${index + 1}-${suffix}`,
            email: `six-ban-partner-${index + 1}-${suffix}@example.test`,
            nickname: `Six-cell partner ${index + 1}`,
            emailVerifiedAt: verifiedAt,
          })),
        ],
      });

      for (const [caseIndex, cell] of extendedCases.entries()) {
        const key = `${cell.type}-${cell.format}-${caseIndex + 1}`;
        const matchId = `six-ban-match-${key}-${suffix}`;
        const entryId = `six-ban-entry-${key}-${suffix}`;
        const partnerIds = Array.from(
          { length: cell.size - 1 },
          (_, index) => `six-ban-partner-${caseIndex * 2 + index + 1}-${suffix}`,
        );
        const memberIds = [targetId, ...partnerIds];
        matchIds.push(matchId);
        entryIds.push(entryId);
        await db.match.create({
          data: {
            id: matchId,
            title: `Six-cell ban ${key}`,
            dateTime: new Date("2026-10-01T10:00:00.000Z"),
            registrationDeadline: new Date("2099-01-01T00:00:00.000Z"),
            type: cell.type,
            format: cell.format,
            status: "registration",
            engineVersion: "V2",
            maxParticipants: 16,
            createdBy: adminId,
            ...(cell.type === "team"
              ? {
                  teamRegistrationStart: new Date("2026-09-01T00:00:00.000Z"),
                  teamRegistrationDeadline: new Date("2099-01-01T00:00:00.000Z"),
                  teamMinMembers: 3,
                  teamMaxMembers: 6,
                }
              : {}),
          },
        });

        let sourceId = targetId;
        if (cell.type === "double") {
          sourceId = `six-ban-double-source-${key}-${suffix}`;
          await db.matchDoublesTeam.create({
            data: {
              id: sourceId,
              matchId,
              createdById: targetId,
              registeredAt: verifiedAt,
              members: {
                create: memberIds.map((userId, index) => ({
                  userId,
                  slot: index + 1,
                })),
              },
            },
          });
        } else if (cell.type === "team") {
          sourceId = `six-ban-team-source-${key}-${suffix}`;
          await db.matchTeam.create({
            data: {
              id: sourceId,
              matchId,
              captainId: targetId,
              name: `Six-cell TEAM ${caseIndex + 1}`,
              inviteCode: `six-ban-invite-${key}-${suffix}`,
              status: "approved",
              submittedAt: verifiedAt,
              reviewedAt: verifiedAt,
              reviewedById: adminId,
              members: {
                create: memberIds.map((userId) => ({ userId })),
              },
            },
          });
        }

        await db.matchEntry.create({
          data: {
            id: entryId,
            matchId,
            kind:
              cell.type === "single"
                ? "INDIVIDUAL"
                : cell.type === "double"
                  ? "DOUBLES"
                  : "TEAM",
            status: "ACTIVE",
            sourceKey:
              cell.type === "single"
                ? `individual:${targetId}`
                : cell.type === "double"
                  ? `doubles:${sourceId}`
                  : `team:${sourceId}`,
            ...(cell.type === "single"
              ? { sourceUserId: targetId }
              : cell.type === "double"
                ? { sourceDoublesTeamId: sourceId }
                : { sourceMatchTeamId: sourceId }),
            displayNameSnapshot: `Six-cell Entry ${caseIndex + 1}`,
            members: {
              create: memberIds.map((userId, index) => ({
                userId,
                displayNameSnapshot: `Six-cell member ${caseIndex + 1}-${index + 1}`,
                role:
                  cell.type === "team" && index === 0 ? "captain" : "player",
                status: "ACTIVE",
                slot: index + 1,
                rosterVersion: 1,
              })),
            },
          },
        });
        await db.$transaction((tx) =>
          applyRegistrationSettlement(tx, {
            matchId,
            matchEntryId: entryId,
            rosterVersion: 1,
            origin: "STANDARD",
            clock: () => verifiedAt,
          }),
        );
      }

      const result = await db.$transaction(
        (tx) =>
          setUserBanState(tx, {
            userId: targetId,
            banned: true,
            actorId: adminId,
          }),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5_000,
          timeout: 30_000,
        },
      );

      assert.equal(result.v2Disqualifications.length, extendedCases.length);
      assert.deepEqual(
        result.v2Disqualifications.map((effect) => effect.entryId).sort(),
        [...entryIds].sort(),
      );
      assert.deepEqual(
        result.removedMatches.map((match) => match.id).sort(),
        [...matchIds].sort(),
      );
      const [entries, members, target] = await Promise.all([
        db.matchEntry.findMany({
          where: { id: { in: entryIds } },
          orderBy: { id: "asc" },
          select: { id: true, status: true },
        }),
        db.matchEntryMember.findMany({
          where: { entryId: { in: entryIds } },
          select: { status: true, effectiveUntil: true, endReason: true },
        }),
        db.user.findUniqueOrThrow({ where: { id: targetId } }),
      ]);
      assert.ok(entries.every((entry) => entry.status === "DISQUALIFIED"));
      assert.ok(
        members.every(
          (member) =>
            member.status === "DISQUALIFIED" &&
            member.effectiveUntil !== null &&
            member.endReason === "ENTRY_DISQUALIFIED",
        ),
      );
      assert.equal(target.isBanned, true);
      assert.deepEqual(result.v2CorrectionCleanups, []);
    } finally {
      await db.user.updateMany({
        where: { id: adminId },
        data: { role: "user" },
      });
      await db.$disconnect();
    }
  },
);

test(
  "bulk ban disqualifies both DOUBLE Entries before resolving their shared fixture",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const adminId = `bulk-six-admin-${suffix}`;
    const targetIds = [
      `bulk-six-target-a-${suffix}`,
      `bulk-six-target-b-${suffix}`,
    ];
    const partnerIds = [
      `bulk-six-partner-a-${suffix}`,
      `bulk-six-partner-b-${suffix}`,
    ];
    const matchId = `bulk-six-match-${suffix}`;
    const groupingId = `bulk-six-grouping-${suffix}`;
    const groupId = `bulk-six-group-${suffix}`;
    const fixtureId = `bulk-six-fixture-${suffix}`;
    const entryIds = [
      `bulk-six-entry-a-${suffix}`,
      `bulk-six-entry-b-${suffix}`,
    ];
    const sourceIds = [
      `bulk-six-source-a-${suffix}`,
      `bulk-six-source-b-${suffix}`,
    ];
    const verifiedAt = new Date("2026-09-06T00:00:00.000Z");

    try {
      await db.user.createMany({
        data: [
          {
            id: adminId,
            email: `${adminId}@example.test`,
            nickname: "Bulk six-cell admin",
            role: "admin",
            emailVerifiedAt: verifiedAt,
          },
          ...[...targetIds, ...partnerIds].map((id) => ({
            id,
            email: `${id}@example.test`,
            nickname: id,
            emailVerifiedAt: verifiedAt,
          })),
        ],
      });
      await db.match.create({
        data: {
          id: matchId,
          title: "Bulk DOUBLE disqualification",
          dateTime: new Date("2026-10-01T10:00:00.000Z"),
          registrationDeadline: new Date("2026-09-01T00:00:00.000Z"),
          groupingGeneratedAt: verifiedAt,
          type: "double",
          format: "group_only",
          status: "ongoing",
          engineVersion: "V2",
          maxParticipants: 2,
          createdBy: adminId,
        },
      });
      for (let index = 0; index < 2; index += 1) {
        const roster = [targetIds[index], partnerIds[index]];
        await db.matchDoublesTeam.create({
          data: {
            id: sourceIds[index],
            matchId,
            createdById: targetIds[index],
            registeredAt: verifiedAt,
            members: {
              create: roster.map((userId, memberIndex) => ({
                userId,
                slot: memberIndex + 1,
              })),
            },
          },
        });
        await db.matchEntry.create({
          data: {
            id: entryIds[index],
            matchId,
            kind: "DOUBLES",
            status: "ACTIVE",
            sourceKey: `doubles:${sourceIds[index]}`,
            sourceDoublesTeamId: sourceIds[index],
            displayNameSnapshot: `Bulk pair ${index + 1}`,
            members: {
              create: roster.map((userId, memberIndex) => ({
                id: `bulk-six-member-${index + 1}-${memberIndex + 1}-${suffix}`,
                userId,
                displayNameSnapshot: `Bulk member ${index + 1}-${memberIndex + 1}`,
                role: "player",
                status: "ACTIVE",
                slot: memberIndex + 1,
                rosterVersion: 1,
              })),
            },
          },
        });
        await db.$transaction((tx) =>
          applyRegistrationSettlement(tx, {
            matchId,
            matchEntryId: entryIds[index],
            rosterVersion: 1,
            origin: "STANDARD",
            clock: () => verifiedAt,
          }),
        );
      }
      await db.matchGrouping.create({
        data: {
          id: groupingId,
          matchId,
          payload: {},
          v2SchemaVersion: 1,
          seedMethod: "SNAKE",
          standingsPolicyVersion: 1,
          createdAt: verifiedAt,
        },
      });
      await db.matchGroup.create({
        data: {
          id: groupId,
          matchId,
          groupingId,
          groupKey: "group:0001",
          displayName: "第 1 组",
          position: 1,
          createdAt: verifiedAt,
        },
      });
      await db.matchGroupEntry.createMany({
        data: entryIds.map((entryId, index) => ({
          matchId,
          groupId,
          entryId,
          position: index + 1,
          globalSeedRank: index + 1,
          seedElo: 1_200,
          seedPoints: 0,
          entryVersion: 0,
          rosterVersion: 1,
          createdAt: verifiedAt,
        })),
      });
      await db.matchFixture.create({
        data: {
          id: fixtureId,
          matchId,
          fixtureKey: "group:0001:pair:0001-0002",
          stage: "GROUP",
          status: "READY",
          groupId,
          groupKey: "group:0001",
          sideAEntryId: entryIds[0],
          sideBEntryId: entryIds[1],
          sideARosterVersion: 1,
          sideBRosterVersion: 1,
          createdAt: verifiedAt,
          updatedAt: verifiedAt,
        },
      });
      const members = await db.matchEntryMember.findMany({
        where: { entryId: { in: entryIds } },
        orderBy: [{ entryId: "asc" }, { slot: "asc" }],
      });
      await db.matchFixtureLineupMember.createMany({
        data: members.map((member) => ({
          matchId,
          fixtureId,
          entryId: member.entryId,
          entryMemberId: member.id,
          side: member.entryId === entryIds[0] ? "SIDE_A" : "SIDE_B",
          position: member.slot,
          createdAt: verifiedAt,
        })),
      });

      const results = await db.$transaction(
        (tx) =>
          setUsersBanState(tx, {
            userIds: targetIds,
            banned: true,
            actorId: adminId,
          }),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 5_000,
          timeout: 30_000,
        },
      );

      assert.equal(results.length, 2);
      assert.ok(
        results.every(
          (result) =>
            result.v2Disqualifications.length === 1 &&
            result.v2Disqualifications[0].voidedFixtureIds[0] === fixtureId &&
            result.v2Disqualifications[0].forfeitedFixtureIds === undefined,
        ),
      );
      const [match, fixture, entries, revisions] = await Promise.all([
        db.match.findUniqueOrThrow({ where: { id: matchId } }),
        db.matchFixture.findUniqueOrThrow({ where: { id: fixtureId } }),
        db.matchEntry.findMany({ where: { id: { in: entryIds } } }),
        db.resultRevision.findMany({ where: { fixtureId } }),
      ]);
      assert.equal(match.status, "finished");
      assert.equal(fixture.status, "VOIDED");
      assert.ok(entries.every((entry) => entry.status === "DISQUALIFIED"));
      assert.deepEqual(revisions, []);
    } finally {
      await db.user.updateMany({
        where: { id: adminId },
        data: { role: "user" },
      });
      await db.$disconnect();
    }
  },
);
