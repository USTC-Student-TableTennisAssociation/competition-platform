import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma, PrismaClient } from "@prisma/client";

import type {
  V2CompetitionDatabase,
  V2CompetitionTransaction,
} from "./entries";
import { createV2TeamGroupingApplicationService } from "./team-grouping";
import { reconcileV2TeamEntryRegistration } from "./team-entry-registration";
import {
  V2_TEAM_MATCH_UNLIMITED_PARTICIPANTS,
  createV2TeamMatchApplicationService,
  type CreateV2TeamMatchCommand,
} from "./team-matches";
import { getV2TeamRegistrationReadState } from "../read-model/team-registration";

const integrationDatabaseUrl = process.env.V2_CORE_INTEGRATION_DATABASE_URL;
const publicationTime = new Date("2026-09-05T12:00:00.000Z");

type TransactionOptions = Readonly<{
  isolationLevel?: Prisma.TransactionIsolationLevel;
  maxWait?: number;
  timeout?: number;
}>;

function faultAfterAuditWrite(db: PrismaClient): V2CompetitionDatabase {
  return {
    $transaction: async <T>(
      operation: (tx: V2CompetitionTransaction) => Promise<T>,
      options?: TransactionOptions,
    ) =>
      db.$transaction(async (tx) => {
        const faultingTransaction = new Proxy(tx, {
          get(target, property, receiver) {
            if (property === "auditLog") {
              return {
                create: async (args: Prisma.AuditLogCreateArgs) => {
                  await tx.auditLog.create(args);
                  throw new Error("injected TEAM creation audit failure");
                },
              };
            }
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as unknown as V2CompetitionTransaction;
        return operation(faultingTransaction);
      }, options),
  } as unknown as V2CompetitionDatabase;
}

test(
  "real PostgreSQL creates TEAM once under concurrency and serves its authoritative lifecycle",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const id = (name: string) => `team-create-${name}-${suffix}`;
    const ownerId = id("owner");
    const participantIds = Array.from(
      { length: 6 },
      (_, index) => id(`player-${index + 1}`),
    );
    const requestKey = randomUUID();
    const command: CreateV2TeamMatchCommand = {
      actor: { id: ownerId, role: "user" },
      requestKey,
      title: "V2 TEAM lifecycle integration",
      description: "Concurrent creation through published grouping",
      location: "West Campus Gym",
      dateTime: new Date("2026-10-01T11:00:00.000Z"),
      registrationDeadline: new Date("2026-09-01T00:00:00.000Z"),
      teamRegistrationStart: new Date("2026-08-01T00:00:00.000Z"),
      teamRegistrationDeadline: new Date("2026-09-02T00:00:00.000Z"),
      teamMinMembers: 3,
      teamMaxMembers: 6,
      type: "team",
      format: "group_only",
    };

    try {
      const verifiedAt = new Date("2026-01-01T00:00:00.000Z");
      await db.user.createMany({
        data: [ownerId, ...participantIds].map((userId, index) => ({
          id: userId,
          email: `${userId}@example.test`,
          nickname: index === 0 ? "TEAM owner" : `TEAM player ${index}`,
          emailVerifiedAt: verifiedAt,
          eloRating: 1_100 + index * 10,
          points: 10 + index,
        })),
      });

      const service = createV2TeamMatchApplicationService({ db });
      const concurrentResults = await Promise.all([
        service.create(command),
        service.create(command),
      ]);
      assert.equal(concurrentResults[0].id, concurrentResults[1].id);
      assert.deepEqual(
        concurrentResults.map((result) => result.created).sort(),
        [false, true],
      );

      const matchId = concurrentResults[0].id;
      const match = await db.match.findUniqueOrThrow({
        where: { id: matchId },
        select: {
          engineVersion: true,
          type: true,
          format: true,
          maxParticipants: true,
          registrationDeadline: true,
          teamRegistrationStart: true,
          teamRegistrationDeadline: true,
          teamMinMembers: true,
          teamMaxMembers: true,
        },
      });
      assert.deepEqual(match, {
        engineVersion: "V2",
        type: "team",
        format: "group_only",
        maxParticipants: V2_TEAM_MATCH_UNLIMITED_PARTICIPANTS,
        registrationDeadline: command.teamRegistrationDeadline,
        teamRegistrationStart: command.teamRegistrationStart,
        teamRegistrationDeadline: command.teamRegistrationDeadline,
        teamMinMembers: command.teamMinMembers,
        teamMaxMembers: command.teamMaxMembers,
      });
      assert.equal(
        await db.match.count({ where: { createdBy: ownerId, creationRequestKey: requestKey } }),
        1,
      );
      assert.equal(
        await db.auditLog.count({
          where: { actorId: ownerId, entityId: matchId, action: "match.create" },
        }),
        1,
      );
      assert.equal(await db.registration.count({ where: { matchId } }), 0);
      assert.equal(await db.matchEntry.count({ where: { matchId } }), 0);

      const teamIds = [id("alpha"), id("bravo")];
      for (const [teamIndex, teamId] of teamIds.entries()) {
        const roster = participantIds.slice(teamIndex * 3, teamIndex * 3 + 3);
        await db.matchTeam.create({
          data: {
            id: teamId,
            matchId,
            captainId: roster[0],
            name: teamIndex === 0 ? "Alpha TEAM" : "Bravo TEAM",
            inviteCode: id(`invite-${teamIndex + 1}`),
            status: "approved",
            submittedAt: new Date("2026-08-20T00:00:00.000Z"),
            members: {
              create: roster.map((userId, memberIndex) => ({
                userId,
                joinedAt: new Date(
                  Date.UTC(2026, 7, 10 + teamIndex, memberIndex),
                ),
              })),
            },
          },
        });
        const reconciled = await reconcileV2TeamEntryRegistration(db, {
          matchId,
          teamId,
        });
        assert.equal(reconciled.action, "CREATED_ACTIVE");
      }

      const entries = await db.matchEntry.findMany({
        where: { matchId, status: "ACTIVE" },
        orderBy: { id: "asc" },
        select: { id: true, version: true },
      });
      assert.equal(entries.length, 2);
      const beforePublication = await getV2TeamRegistrationReadState(
        db,
        matchId,
        publicationTime,
      );
      assert.equal(beforePublication.kind, "TEAM_V2_REGISTRATION");
      if (beforePublication.kind !== "TEAM_V2_REGISTRATION") {
        assert.fail("the formal TEAM detail projection was not readable");
      }
      assert.deepEqual(beforePublication.registration, {
        open: false,
        notStarted: false,
        closed: true,
      });
      assert.equal(beforePublication.activeEntryCount, 2);
      assert.equal(beforePublication.activeMemberCount, 6);
      assert.equal(beforePublication.grouping.published, false);

      const grouping = createV2TeamGroupingApplicationService({
        db,
        clock: () => publicationTime,
      });
      const published = await grouping.publish({
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
      assert.equal(published.created, true);

      const afterPublication = await getV2TeamRegistrationReadState(
        db,
        matchId,
        publicationTime,
      );
      assert.equal(afterPublication.kind, "TEAM_V2_REGISTRATION");
      if (afterPublication.kind !== "TEAM_V2_REGISTRATION") {
        assert.fail("the published TEAM detail projection was not readable");
      }
      assert.equal(afterPublication.match.status, "ongoing");
      assert.equal(afterPublication.grouping.published, true);
      assert.equal(afterPublication.grouping.groups.length, 1);
      assert.equal(afterPublication.grouping.groups[0].fixtures.length, 1);
      assert.equal(await db.registration.count({ where: { matchId } }), 0);
    } finally {
      await db.$disconnect();
    }
  },
);

test(
  "real PostgreSQL rolls TEAM creation and its audit back together",
  { skip: integrationDatabaseUrl === undefined },
  async () => {
    process.env.DATABASE_URL = integrationDatabaseUrl;
    process.env.DATABASE_URL_UNPOOLED = integrationDatabaseUrl;
    const db = new PrismaClient();
    const suffix = randomUUID().replaceAll("-", "");
    const actorId = `team-create-rollback-owner-${suffix}`;
    const requestKey = randomUUID();

    try {
      await db.user.create({
        data: {
          id: actorId,
          email: `${actorId}@example.test`,
          nickname: "TEAM rollback owner",
          emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      });
      const service = createV2TeamMatchApplicationService({
        db: faultAfterAuditWrite(db),
      });
      await assert.rejects(
        service.create({
          actor: { id: actorId, role: "user" },
          requestKey,
          title: "Rolled back TEAM",
          description: null,
          location: "West Campus Gym",
          dateTime: new Date("2026-10-01T11:00:00.000Z"),
          registrationDeadline: new Date("2026-09-01T00:00:00.000Z"),
          teamRegistrationStart: new Date("2026-08-01T00:00:00.000Z"),
          teamRegistrationDeadline: new Date("2026-09-02T00:00:00.000Z"),
          teamMinMembers: 3,
          teamMaxMembers: 6,
          type: "team",
          format: "group_only",
        }),
        /injected TEAM creation audit failure/,
      );
      assert.equal(
        await db.match.count({
          where: { createdBy: actorId, creationRequestKey: requestKey },
        }),
        0,
      );
      assert.equal(
        await db.auditLog.count({
          where: { actorId, action: "match.create" },
        }),
        0,
      );
    } finally {
      await db.$disconnect();
    }
  },
);
