import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import {
  V2CompetitionApplicationError,
  type V2CompetitionDatabase,
  type V2CompetitionTransaction,
} from "./entries";
import {
  V2_SINGLE_MATCH_TEXT_LIMITS,
  V2_SINGLE_MATCH_UNLIMITED_PARTICIPANTS,
  createV2SingleMatchApplicationService,
  fingerprintV2SingleMatchCreation,
  type CreateV2SingleMatchCommand,
} from "./matches";

function command(
  overrides: Partial<CreateV2SingleMatchCommand> = {},
): CreateV2SingleMatchCommand {
  return {
    actor: { id: "actor-1", role: "user" },
    requestKey: "3d594650-3436-4a7f-bd48-9d700f17db33",
    title: "Autumn singles",
    description: "Formal group-stage competition",
    location: "West Campus Gym",
    dateTime: new Date("2026-10-01T11:00:00.000Z"),
    registrationDeadline: new Date("2026-09-30T11:00:00.000Z"),
    type: "single",
    format: "group_only",
      groupBestOf: 5, knockoutBestOf: 5,
    ...overrides,
  };
}

function activeActor(overrides: Record<string, unknown> = {}) {
  return {
    id: "actor-1",
    role: "user",
    isBanned: false,
    emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

type FakeState = {
  actor: ReturnType<typeof activeActor> | null;
  actorLockExists: boolean;
  calls: string[];
  matchData: Record<string, unknown> | null;
  existingMatch: Record<string, unknown> | null;
  requestLookup: unknown;
  auditData: Record<string, unknown> | null;
  isolationLevel: unknown;
  auditError?: Error;
};

function initialState(): FakeState {
  return {
    actor: activeActor(),
    actorLockExists: true,
    calls: [],
    matchData: null,
    existingMatch: null,
    requestLookup: null,
    auditData: null,
    isolationLevel: null,
  };
}

function fakeDatabase(state: FakeState): V2CompetitionDatabase {
  const tx = {
    $queryRaw: async () => {
      state.calls.push("lock-actor");
      return state.actorLockExists ? [{ id: "actor-1" }] : [];
    },
    user: {
      findUnique: async () => {
        state.calls.push("read-actor");
        return state.actor;
      },
    },
    match: {
      findUnique: async (args: { where: unknown }) => {
        state.calls.push("find-request");
        state.requestLookup = args.where;
        return state.existingMatch;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        state.calls.push("create-match");
        state.matchData = args.data;
        const projected = {
          id: "match-v2-1",
          title: args.data.title,
          description: args.data.description,
          location: args.data.location,
          dateTime: args.data.dateTime,
          registrationDeadline: args.data.registrationDeadline,
          type: args.data.type,
          format: args.data.format,
          status: args.data.status,
          engineVersion: args.data.engineVersion,
          isQuickMatch: args.data.isQuickMatch,
          maxParticipants: args.data.maxParticipants,
          createdBy: args.data.createdBy,
        };
        state.existingMatch = {
          ...projected,
          creationRequestFingerprint: args.data.creationRequestFingerprint,
        };
        return projected;
      },
    },
    auditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        state.calls.push("create-audit");
        if (state.auditError) throw state.auditError;
        state.auditData = args.data;
        return { id: "audit-1" };
      },
    },
  };

  return {
    $transaction: async <T>(
      operation: (transaction: V2CompetitionTransaction) => Promise<T>,
      options: { isolationLevel?: unknown } = {},
    ) => {
      state.isolationLevel = options.isolationLevel;
      return operation(tx as unknown as V2CompetitionTransaction);
    },
  } as unknown as Pick<PrismaClient, "$transaction">;
}

async function expectApplicationError(
  operation: () => Promise<unknown>,
  code: V2CompetitionApplicationError["code"],
) {
  await assert.rejects(
    operation,
    (error: unknown) =>
      error instanceof V2CompetitionApplicationError && error.code === code,
  );
}

function unsafeCommand(value: unknown): CreateV2SingleMatchCommand {
  return value as CreateV2SingleMatchCommand;
}

test("creates only a formal V2 SINGLE group-only match and audit in one transaction", async () => {
  const state = initialState();
  const dateTime = new Date("2026-10-01T11:00:00.000Z");
  const registrationDeadline = new Date("2026-09-30T11:00:00.000Z");
  const service = createV2SingleMatchApplicationService({
    db: fakeDatabase(state),
  });

  const result = await service.create(command({ dateTime, registrationDeadline }));
  const requestFingerprint = fingerprintV2SingleMatchCreation(
    command({ dateTime, registrationDeadline }),
  );

  assert.equal(state.isolationLevel, "Serializable");
  assert.deepEqual(state.calls, [
    "lock-actor",
    "read-actor",
    "find-request",
    "create-match",
    "create-audit",
  ]);
  assert.deepEqual(state.requestLookup, {
    createdBy_creationRequestKey: {
      createdBy: "actor-1",
      creationRequestKey: "3d594650-3436-4a7f-bd48-9d700f17db33",
    },
  });
  assert.deepEqual(state.matchData, {
    title: "Autumn singles",
    description: "Formal group-stage competition",
    location: "West Campus Gym",
    dateTime,
    registrationDeadline,
    type: "single",
    format: "group_only",
      groupBestOf: 5, knockoutBestOf: 5,
    maxParticipants: V2_SINGLE_MATCH_UNLIMITED_PARTICIPANTS,
    status: "registration",
    engineVersion: "V2",
    creationRequestKey: "3d594650-3436-4a7f-bd48-9d700f17db33",
    creationRequestFingerprint: requestFingerprint,
    isQuickMatch: false,
    createdBy: "actor-1",
    teamRegistrationStart: null,
    teamRegistrationDeadline: null,
    teamMinMembers: null,
    teamMaxMembers: null,
    rule: { note: "分组循环赛" },
  });
  assert.notEqual(state.matchData?.dateTime, dateTime);
  assert.notEqual(state.matchData?.registrationDeadline, registrationDeadline);
  assert.deepEqual(state.auditData, {
    actorId: "actor-1",
    action: "match.create",
    entityType: "Match",
    entityId: "match-v2-1",
    details: {
      targetLabel: "Autumn singles",
      title: "Autumn singles",
      type: "single",
      format: "group_only",
      engineVersion: "V2",
      creationRequestFingerprint: requestFingerprint,
      isQuickMatch: false,
      dateTime: "2026-10-01T11:00:00.000Z",
      registrationDeadline: "2026-09-30T11:00:00.000Z",
      teamRegistrationStart: null,
      teamRegistrationDeadline: null,
      teamMinMembers: null,
      teamMaxMembers: null,
    },
  });
  assert.deepEqual(result, {
    id: "match-v2-1",
    title: "Autumn singles",
    description: "Formal group-stage competition",
    location: "West Campus Gym",
    dateTime,
    registrationDeadline,
    type: "single",
    format: "group_only",
    status: "registration",
    engineVersion: "V2",
    isQuickMatch: false,
    maxParticipants: V2_SINGLE_MATCH_UNLIMITED_PARTICIPANTS,
    createdBy: "actor-1",
    created: true,
  });
  assert.equal("registrations" in (state.matchData ?? {}), false);
  assert.equal("entries" in (state.matchData ?? {}), false);
});

test("a durable request key returns the original match without another audit", async () => {
  const state = initialState();
  const service = createV2SingleMatchApplicationService({
    db: fakeDatabase(state),
  });

  const first = await service.create(command());
  state.calls.length = 0;
  state.auditData = null;
  const retry = await service.create(command());

  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(retry.id, first.id);
  assert.deepEqual(state.calls, ["lock-actor", "read-actor", "find-request"]);
  assert.equal(state.auditData, null);

  await expectApplicationError(
    () => service.create(command({ title: "A different competition" })),
    "PERSISTENCE_CONFLICT",
  );
  assert.equal(state.calls.filter((call) => call === "create-match").length, 0);
  assert.equal(state.calls.filter((call) => call === "create-audit").length, 0);
});

test("resolveExisting never creates a missing request and validates an existing fingerprint", async () => {
  const missingState = initialState();
  const missingService = createV2SingleMatchApplicationService({
    db: fakeDatabase(missingState),
  });

  assert.equal(await missingService.resolveExisting(command()), null);
  assert.deepEqual(missingState.calls, [
    "lock-actor",
    "read-actor",
    "find-request",
  ]);
  assert.equal(missingState.matchData, null);
  assert.equal(missingState.auditData, null);

  const existingState = initialState();
  const existingService = createV2SingleMatchApplicationService({
    db: fakeDatabase(existingState),
  });
  const created = await existingService.create(command());
  existingState.calls.length = 0;
  existingState.auditData = null;

  const resolved = await existingService.resolveExisting(command());
  assert.equal(resolved?.id, created.id);
  assert.equal(resolved?.created, false);
  assert.deepEqual(existingState.calls, [
    "lock-actor",
    "read-actor",
    "find-request",
  ]);
  assert.equal(existingState.auditData, null);

  await expectApplicationError(
    () =>
      existingService.resolveExisting(
        command({ title: "A different competition" }),
      ),
    "PERSISTENCE_CONFLICT",
  );
  assert.equal(
    existingState.calls.filter((call) => call === "create-match").length,
    0,
  );
});

test("a unique-key race is resolved from a fresh transaction snapshot", async () => {
  const state = initialState();
  const stableDatabase = fakeDatabase(state);
  const runStableTransaction = stableDatabase.$transaction as unknown as <T>(
    operation: (transaction: V2CompetitionTransaction) => Promise<T>,
    options?: {
      isolationLevel?: unknown;
      maxWait?: number;
      timeout?: number;
    },
  ) => Promise<T>;
  const createCommand = command();
  const fingerprint = fingerprintV2SingleMatchCreation(createCommand);
  let transactionCount = 0;
  const db = {
    $transaction: async <T>(
      operation: (transaction: V2CompetitionTransaction) => Promise<T>,
      options: {
        isolationLevel?: unknown;
        maxWait?: number;
        timeout?: number;
      } = {},
    ) => {
      transactionCount += 1;
      if (transactionCount === 1) {
        state.existingMatch = {
          id: "concurrent-winner",
          title: createCommand.title,
          description: createCommand.description,
          location: createCommand.location,
          dateTime: createCommand.dateTime,
          registrationDeadline: createCommand.registrationDeadline,
          type: createCommand.type,
          format: createCommand.format,
          status: "registration",
          engineVersion: "V2",
          isQuickMatch: false,
          maxParticipants: V2_SINGLE_MATCH_UNLIMITED_PARTICIPANTS,
          createdBy: createCommand.actor.id,
          creationRequestFingerprint: fingerprint,
        };
        throw { code: "P2002" };
      }
      return runStableTransaction(operation, options);
    },
  } as unknown as V2CompetitionDatabase;
  const service = createV2SingleMatchApplicationService({ db });

  const resolved = await service.create(createCommand);

  assert.equal(transactionCount, 2);
  assert.equal(resolved.id, "concurrent-winner");
  assert.equal(resolved.created, false);
  assert.deepEqual(state.calls, ["lock-actor", "read-actor", "find-request"]);
  assert.equal(state.auditData, null);
});

test("ordinary verified users and administrators both retain legacy creation permission", async () => {
  for (const role of ["user", "admin"] as const) {
    const state = initialState();
    state.actor = activeActor({ role });
    const service = createV2SingleMatchApplicationService({
      db: fakeDatabase(state),
    });

    const created = await service.create(
      command({ actor: { id: "actor-1", role } }),
    );

    assert.equal(created.createdBy, "actor-1");
    assert.equal(state.auditData?.actorId, "actor-1");
  }
});

test("locks and revalidates actor activity and role before either write", async () => {
  const cases: Array<{
    configure(state: FakeState): void;
    code: V2CompetitionApplicationError["code"];
  }> = [
    {
      configure: (state) => {
        state.actorLockExists = false;
      },
      code: "ACTOR_NOT_ACTIVE",
    },
    {
      configure: (state) => {
        state.actor = activeActor({ isBanned: true });
      },
      code: "ACTOR_NOT_ACTIVE",
    },
    {
      configure: (state) => {
        state.actor = activeActor({ emailVerifiedAt: null });
      },
      code: "ACTOR_NOT_ACTIVE",
    },
    {
      configure: (state) => {
        state.actor = activeActor({ role: "admin" });
      },
      code: "ACTOR_ROLE_STALE",
    },
  ];

  for (const scenario of cases) {
    const state = initialState();
    scenario.configure(state);
    const service = createV2SingleMatchApplicationService({
      db: fakeDatabase(state),
    });

    await expectApplicationError(() => service.create(command()), scenario.code);
    assert.equal(state.calls.includes("create-match"), false);
    assert.equal(state.calls.includes("create-audit"), false);
  }
});

test("rejects non-SINGLE/non-group-only creation before opening a transaction", async () => {
  for (const invalid of [
    { ...command(), type: "double" },
    { ...command(), type: "team" },
    { ...command(), format: "group_then_knockout" },
  ]) {
    let transactions = 0;
    const db = {
      $transaction: async () => {
        transactions += 1;
      },
    } as unknown as V2CompetitionDatabase;
    const service = createV2SingleMatchApplicationService({ db });

    await expectApplicationError(
      () => service.create(unsafeCommand(invalid)),
      "INVALID_INPUT",
    );
    assert.equal(transactions, 0);
  }
});

test("strict root and actor keys reject client-controlled lifecycle and policy fields", async () => {
  const protectedFields = [
    "engineVersion",
    "status",
    "isQuickMatch",
    "maxParticipants",
    "rule",
    "teamRegistrationStart",
    "teamRegistrationDeadline",
    "teamMinMembers",
    "teamMaxMembers",
    "adminOverride",
    "creationRequestFingerprint",
  ];

  for (const field of protectedFields) {
    let transactions = 0;
    const db = {
      $transaction: async () => {
        transactions += 1;
      },
    } as unknown as V2CompetitionDatabase;
    const service = createV2SingleMatchApplicationService({ db });

    await expectApplicationError(
      () => service.create(unsafeCommand({ ...command(), [field]: true })),
      "INVALID_INPUT",
    );
    assert.equal(transactions, 0, field);
  }

  const state = initialState();
  const service = createV2SingleMatchApplicationService({
    db: fakeDatabase(state),
  });
  await expectApplicationError(
    () =>
      service.create(
        unsafeCommand({
          ...command(),
          actor: { id: "actor-1", role: "user", adminOverride: true },
        }),
      ),
    "INVALID_INPUT",
  );
  assert.deepEqual(state.calls, []);
});

test("validates normalized text, limits and optional description semantics", async () => {
  const invalidCommands = [
    command({ requestKey: "not-a-v4-uuid" }),
    command({ title: "" }),
    command({ title: " padded" }),
    command({ title: "x".repeat(V2_SINGLE_MATCH_TEXT_LIMITS.title + 1) }),
    command({ location: "Gym " }),
    command({
      location: "x".repeat(V2_SINGLE_MATCH_TEXT_LIMITS.location + 1),
    }),
    command({ description: "" }),
    command({ description: " padded" }),
    command({
      description: "x".repeat(V2_SINGLE_MATCH_TEXT_LIMITS.description + 1),
    }),
    unsafeCommand({ ...command(), description: undefined }),
  ];

  for (const invalid of invalidCommands) {
    const state = initialState();
    const service = createV2SingleMatchApplicationService({
      db: fakeDatabase(state),
    });
    await expectApplicationError(() => service.create(invalid), "INVALID_INPUT");
    assert.deepEqual(state.calls, []);
  }

  const state = initialState();
  const service = createV2SingleMatchApplicationService({
    db: fakeDatabase(state),
  });
  await service.create(command({ description: null }));
  assert.equal(state.matchData?.description, null);
});

test("validates Date identity, finiteness and deadline ordering", async () => {
  const invalidCommands = [
    unsafeCommand({ ...command(), dateTime: "2026-10-01T11:00:00.000Z" }),
    command({ dateTime: new Date(Number.NaN) }),
    unsafeCommand({ ...command(), registrationDeadline: 0 }),
    command({ registrationDeadline: new Date("2026-10-01T11:00:00.000Z") }),
    command({ registrationDeadline: new Date("2026-10-02T11:00:00.000Z") }),
  ];

  for (const invalid of invalidCommands) {
    const state = initialState();
    const service = createV2SingleMatchApplicationService({
      db: fakeDatabase(state),
    });
    await expectApplicationError(() => service.create(invalid), "INVALID_INPUT");
    assert.deepEqual(state.calls, []);
  }
});

test("maps serialization, deadlock and relation conflicts to stable application errors", async () => {
  const conflicts = [
    { error: { code: "P2034" }, expected: "CONCURRENT_WRITE_CONFLICT" },
    {
      error: { code: "P2010", meta: { code: "40001" } },
      expected: "CONCURRENT_WRITE_CONFLICT",
    },
    {
      error: { code: "P2010", meta: { code: "40P01" } },
      expected: "CONCURRENT_WRITE_CONFLICT",
    },
    { error: { code: "P2002" }, expected: "PERSISTENCE_CONFLICT" },
    { error: { code: "P2003" }, expected: "PERSISTENCE_CONFLICT" },
  ] as const;

  for (const { error, expected } of conflicts) {
    const db = {
      $transaction: async () => {
        throw error;
      },
    } as unknown as V2CompetitionDatabase;
    const service = createV2SingleMatchApplicationService({ db });
    await expectApplicationError(() => service.create(command()), expected);
  }
});

test("does not report success if the in-transaction audit write fails", async () => {
  const state = initialState();
  state.auditError = new Error("audit storage failed");
  const service = createV2SingleMatchApplicationService({
    db: fakeDatabase(state),
  });

  await assert.rejects(
    () => service.create(command()),
    /audit storage failed/,
  );
  assert.deepEqual(state.calls, [
    "lock-actor",
    "read-actor",
    "find-request",
    "create-match",
    "create-audit",
  ]);
});
