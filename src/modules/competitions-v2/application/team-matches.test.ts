import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import {
  V2CompetitionApplicationError,
  type V2CompetitionDatabase,
  type V2CompetitionTransaction,
} from "./entries";
import {
  V2_TEAM_MATCH_UNLIMITED_PARTICIPANTS,
  createV2TeamMatchApplicationService,
  fingerprintV2TeamMatchCreation,
  type CreateV2TeamMatchCommand,
} from "./team-matches";

function command(
  overrides: Partial<CreateV2TeamMatchCommand> = {},
): CreateV2TeamMatchCommand {
  return {
    actor: { id: "actor-1", role: "user" },
    requestKey: "3d594650-3436-4a7f-bd48-9d700f17db33",
    title: "Autumn team event",
    description: "Formal TEAM registration slice",
    location: "West Campus Gym",
    dateTime: new Date("2026-10-01T11:00:00.000Z"),
    registrationDeadline: new Date("2026-09-29T11:00:00.000Z"),
    teamRegistrationStart: new Date("2026-09-01T01:00:00.000Z"),
    teamRegistrationDeadline: new Date("2026-09-30T09:00:00.000Z"),
    teamMinMembers: 3,
    teamMaxMembers: 6,
    type: "team",
    format: "group_only",
      groupBestOf: 5, knockoutBestOf: 5,
    ...overrides,
  };
}

type State = {
  matchData: Record<string, unknown> | null;
  existing: Record<string, unknown> | null;
  auditData: Record<string, unknown> | null;
  calls: string[];
};

function fakeDatabase(state: State): V2CompetitionDatabase {
  const tx = {
    $queryRaw: async () => [{ id: "actor-1" }],
    user: {
      findUnique: async () => ({
        id: "actor-1",
        role: "user",
        isBanned: false,
        emailVerifiedAt: new Date("2026-01-01T00:00:00Z"),
      }),
    },
    match: {
      findUnique: async () => {
        state.calls.push("find");
        return state.existing;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.calls.push("create");
        state.matchData = data;
        const created = {
          id: "team-match-1",
          title: data.title,
          description: data.description,
          location: data.location,
          dateTime: data.dateTime,
          registrationDeadline: data.registrationDeadline,
          type: data.type,
          format: data.format,
          status: data.status,
          engineVersion: data.engineVersion,
          isQuickMatch: data.isQuickMatch,
          maxParticipants: data.maxParticipants,
          createdBy: data.createdBy,
        };
        state.existing = {
          ...created,
          creationRequestFingerprint: data.creationRequestFingerprint,
        };
        return created;
      },
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.calls.push("audit");
        state.auditData = data;
        return { id: "audit-1" };
      },
    },
  };
  return {
    $transaction: async <T>(
      operation: (transaction: V2CompetitionTransaction) => Promise<T>,
    ) => operation(tx as unknown as V2CompetitionTransaction),
  } as unknown as Pick<PrismaClient, "$transaction">;
}

test("TEAM facade persists its authoritative window and limits without Legacy registration", async () => {
  const state: State = {
    matchData: null,
    existing: null,
    auditData: null,
    calls: [],
  };
  const service = createV2TeamMatchApplicationService({ db: fakeDatabase(state) });
  const input = command();
  const result = await service.create(input);
  const fingerprint = fingerprintV2TeamMatchCreation({
    ...input,
    registrationDeadline: input.teamRegistrationDeadline,
  });

  assert.equal(result.type, "team");
  assert.equal(result.engineVersion, "V2");
  assert.equal(result.created, true);
  assert.deepEqual(state.calls, ["find", "create", "audit"]);
  assert.deepEqual(state.matchData, {
    title: input.title,
    description: input.description,
    location: input.location,
    dateTime: input.dateTime,
    registrationDeadline: input.teamRegistrationDeadline,
    type: "team",
    format: "group_only",
      groupBestOf: 5, knockoutBestOf: 5,
    maxParticipants: V2_TEAM_MATCH_UNLIMITED_PARTICIPANTS,
    status: "registration",
    engineVersion: "V2",
    creationRequestKey: input.requestKey,
    creationRequestFingerprint: fingerprint,
    isQuickMatch: false,
    createdBy: input.actor.id,
    teamRegistrationStart: input.teamRegistrationStart,
    teamRegistrationDeadline: input.teamRegistrationDeadline,
    teamMinMembers: input.teamMinMembers,
    teamMaxMembers: input.teamMaxMembers,
    rule: { note: "团体分组循环赛" },
  });
  assert.equal("registrations" in (state.matchData ?? {}), false);
  assert.equal("registeredAt" in (state.matchData ?? {}), false);
  assert.equal("entries" in (state.matchData ?? {}), false);
});

test("TEAM durable retry is idempotent and binds every team setting", async () => {
  const state: State = {
    matchData: null,
    existing: null,
    auditData: null,
    calls: [],
  };
  const service = createV2TeamMatchApplicationService({ db: fakeDatabase(state) });
  const first = await service.create(command());
  state.calls.length = 0;
  const retry = await service.create(command());
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(retry.id, first.id);
  assert.deepEqual(state.calls, ["find"]);

  for (const changed of [
    command({ teamMinMembers: 2 }),
    command({ teamMaxMembers: 7 }),
    command({
      teamRegistrationStart: new Date("2026-09-02T01:00:00.000Z"),
    }),
  ]) {
    await assert.rejects(
      service.create(changed),
      (error: unknown) =>
        error instanceof V2CompetitionApplicationError &&
        error.code === "PERSISTENCE_CONFLICT",
    );
  }
});

test("TEAM facade rejects invalid windows and limits before persistence", async () => {
  for (const invalid of [
    command({ teamMinMembers: 0 }),
    command({ teamMinMembers: 7, teamMaxMembers: 6 }),
    command({ teamMaxMembers: 51 }),
    command({
      teamRegistrationStart: new Date("2026-09-30T09:00:00.000Z"),
    }),
    command({
      teamRegistrationDeadline: new Date("2026-10-01T11:00:00.000Z"),
    }),
  ]) {
    let transactions = 0;
    const db = {
      $transaction: async () => {
        transactions += 1;
        throw new Error("must not run");
      },
    } as unknown as Pick<PrismaClient, "$transaction">;
    await assert.rejects(
      createV2TeamMatchApplicationService({ db }).create(invalid),
      (error: unknown) =>
        error instanceof V2CompetitionApplicationError &&
        error.code === "INVALID_INPUT",
    );
    assert.equal(transactions, 0);
  }
});
