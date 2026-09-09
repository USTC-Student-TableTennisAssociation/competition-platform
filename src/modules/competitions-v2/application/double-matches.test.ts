import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import {
  V2CompetitionApplicationError,
  type V2CompetitionDatabase,
  type V2CompetitionTransaction,
} from "./entries";
import {
  V2_DOUBLE_MATCH_UNLIMITED_PARTICIPANTS,
  createV2DoubleMatchApplicationService,
  fingerprintV2DoubleMatchCreation,
  type CreateV2DoubleMatchCommand,
} from "./double-matches";
import { fingerprintV2SingleMatchCreation } from "./matches";

function command(
  overrides: Partial<CreateV2DoubleMatchCommand> = {},
): CreateV2DoubleMatchCommand {
  return {
    actor: { id: "actor-1", role: "user" },
    requestKey: "3d594650-3436-4a7f-bd48-9d700f17db33",
    title: "Autumn doubles",
    description: "Formal doubles registration slice",
    location: "West Campus Gym",
    dateTime: new Date("2026-10-01T11:00:00.000Z"),
    registrationDeadline: new Date("2026-09-30T11:00:00.000Z"),
    type: "double",
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
          id: "double-match-1",
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

test("DOUBLE facade creates one audited V2 match without Entry or Legacy registration", async () => {
  const state: State = {
    matchData: null,
    existing: null,
    auditData: null,
    calls: [],
  };
  const service = createV2DoubleMatchApplicationService({
    db: fakeDatabase(state),
  });
  const input = command();
  const result = await service.create(input);
  const fingerprint = fingerprintV2DoubleMatchCreation(input);

  assert.equal(result.type, "double");
  assert.equal(result.format, "group_only");
  assert.equal(result.engineVersion, "V2");
  assert.equal(result.created, true);
  assert.deepEqual(state.calls, ["find", "create", "audit"]);
  assert.deepEqual(state.matchData, {
    title: input.title,
    description: input.description,
    location: input.location,
    dateTime: input.dateTime,
    registrationDeadline: input.registrationDeadline,
    type: "double",
    format: "group_only",
      groupBestOf: 5, knockoutBestOf: 5,
    maxParticipants: V2_DOUBLE_MATCH_UNLIMITED_PARTICIPANTS,
    status: "registration",
    engineVersion: "V2",
    creationRequestKey: input.requestKey,
    creationRequestFingerprint: fingerprint,
    isQuickMatch: false,
    createdBy: input.actor.id,
    teamRegistrationStart: null,
    teamRegistrationDeadline: null,
    teamMinMembers: null,
    teamMaxMembers: null,
    rule: { note: "双打分组循环赛" },
  });
  assert.equal("registrations" in (state.matchData ?? {}), false);
  assert.equal("registeredAt" in (state.matchData ?? {}), false);
  assert.equal("entries" in (state.matchData ?? {}), false);
  assert.equal(
    (state.auditData?.details as { type?: string } | undefined)?.type,
    "double",
  );
});

test("DOUBLE durable retries reuse one match and a changed command conflicts", async () => {
  const state: State = {
    matchData: null,
    existing: null,
    auditData: null,
    calls: [],
  };
  const service = createV2DoubleMatchApplicationService({
    db: fakeDatabase(state),
  });
  const first = await service.create(command());
  state.calls.length = 0;
  state.auditData = null;
  const retry = await service.create(command());
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(retry.id, first.id);
  assert.deepEqual(state.calls, ["find"]);
  assert.equal(state.auditData, null);

  await assert.rejects(
    service.create(command({ title: "Changed" })),
    (error: unknown) =>
      error instanceof V2CompetitionApplicationError &&
      error.code === "PERSISTENCE_CONFLICT",
  );
});

test("fingerprint namespaces keep SINGLE and DOUBLE commands disjoint", () => {
  const doubleCommand = command();
  const singleCommand = {
    ...doubleCommand,
    type: "single" as const,
  };
  assert.notEqual(
    fingerprintV2DoubleMatchCreation(doubleCommand),
    fingerprintV2SingleMatchCreation(singleCommand),
  );
});

test("DOUBLE facade rejects any other type or format before a transaction", async () => {
  let transactions = 0;
  const db = {
    $transaction: async () => {
      transactions += 1;
      throw new Error("must not run");
    },
  } as unknown as V2CompetitionDatabase;
  const service = createV2DoubleMatchApplicationService({ db });

  for (const invalid of [
    { ...command(), type: "single" },
    { ...command(), format: "group_then_knockout" },
  ]) {
    await assert.rejects(
      service.create(invalid as unknown as CreateV2DoubleMatchCommand),
      (error: unknown) =>
        error instanceof V2CompetitionApplicationError &&
        error.code === "INVALID_INPUT",
    );
  }
  assert.equal(transactions, 0);
});
