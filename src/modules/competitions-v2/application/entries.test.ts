import assert from "node:assert/strict";
import test from "node:test";

import { CompetitionDomainError } from "../domain";
import {
  V2CompetitionApplicationError,
  createV2Entry,
  replaceV2EntryRoster,
  transitionV2EntryStatus,
} from "./entries";
import type {
  V2CompetitionDatabase,
  V2CompetitionTransaction,
  V2EntrySettlementPort,
} from "./entries";

function fakeDatabase(transaction: object): V2CompetitionDatabase {
  const transactionWithDefaults = {
    $queryRaw: async () => [{ id: "locked-row" }],
    ...transaction,
  };
  const run = async <T>(
    operation: (tx: V2CompetitionTransaction) => Promise<T>,
  ) => operation(transactionWithDefaults as unknown as V2CompetitionTransaction);
  return { $transaction: run } as unknown as V2CompetitionDatabase;
}

function fakeSettlementPort(
  overrides: Partial<V2EntrySettlementPort> = {},
): V2EntrySettlementPort {
  return {
    apply: async () => undefined,
    reverse: async () => undefined,
    ...overrides,
  };
}

async function expectApplicationError(
  action: () => Promise<unknown>,
  code: V2CompetitionApplicationError["code"],
) {
  await assert.rejects(
    action,
    (error: unknown) =>
      error instanceof V2CompetitionApplicationError && error.code === code,
  );
}

function activeActor(overrides: Record<string, unknown> = {}) {
  return {
    id: "actor-1",
    role: "user",
    isBanned: false,
    emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    nickname: "Actor",
    ...overrides,
  };
}

function v2Match(overrides: Record<string, unknown> = {}) {
  return {
    id: "match-1",
    engineVersion: "V2",
    isQuickMatch: false,
    type: "single",
    status: "registration",
    createdBy: "manager-1",
    createdAt: new Date("2020-01-01T00:00:00.000Z"),
    registrationDeadline: new Date("2100-01-01T00:00:00.000Z"),
    teamRegistrationStart: null,
    teamRegistrationDeadline: null,
    teamMinMembers: null,
    teamMaxMembers: null,
    ...overrides,
  };
}

test("all entry writes reject a LEGACY match inside the transaction", async () => {
  const db = fakeDatabase({
    user: { findUnique: async () => activeActor() },
    match: {
      findUnique: async () => v2Match({ engineVersion: "LEGACY" }),
    },
  });

  await assert.rejects(
    () =>
      createV2Entry(db, {
        actor: { id: "actor-1", role: "user" },
        matchId: "match-1",
        kind: "INDIVIDUAL",
        sourceId: "actor-1",
      }),
    (error: unknown) =>
      error instanceof CompetitionDomainError &&
      error.code === "ENGINE_WRITE_MISMATCH",
  );
});

test("all entry writes reject a quick match even if its engine flag is V2", async () => {
  const db = fakeDatabase({
    user: { findUnique: async () => activeActor() },
    match: {
      findUnique: async () => v2Match({ isQuickMatch: true }),
    },
  });

  await assert.rejects(
    () =>
      createV2Entry(db, {
        actor: { id: "actor-1", role: "user" },
        matchId: "match-1",
        kind: "INDIVIDUAL",
        sourceId: "actor-1",
      }),
    (error: unknown) =>
      error instanceof CompetitionDomainError &&
      error.code === "ENGINE_WRITE_MISMATCH" &&
      error.details.isQuickMatch === true,
  );
});

test("write context locks Match then actor before reading either context row", async () => {
  const calls: string[] = [];
  const db = fakeDatabase({
    $queryRaw: async (query: { strings: readonly string[] }) => {
      const sql = query.strings.join("?");
      calls.push(sql.includes('FROM "Match"') ? "lock-match" : "lock-actor");
      return [{ id: "locked-row" }];
    },
    user: {
      findUnique: async () => {
        calls.push("read-actor");
        return activeActor();
      },
    },
    match: {
      findUnique: async () => {
        calls.push("read-match");
        return v2Match({ engineVersion: "LEGACY" });
      },
    },
  });

  await assert.rejects(
    () =>
      createV2Entry(db, {
        actor: { id: "actor-1", role: "user" },
        matchId: "match-1",
        kind: "INDIVIDUAL",
        sourceId: "actor-1",
      }),
    CompetitionDomainError,
  );
  assert.deepEqual(calls, [
    "lock-match",
    "lock-actor",
    "read-actor",
    "read-match",
  ]);
});

test("raw PostgreSQL serialization and deadlock errors map to retryable conflicts", async () => {
  for (const databaseCode of ["40001", "40P01"] as const) {
    const db = {
      $transaction: async () => {
        throw { code: "P2010", meta: { code: databaseCode } };
      },
    } as unknown as V2CompetitionDatabase;

    await expectApplicationError(
      () =>
        createV2Entry(db, {
          actor: { id: "actor-1", role: "user" },
          matchId: "match-1",
          kind: "INDIVIDUAL",
          sourceId: "actor-1",
        }),
      "CONCURRENT_WRITE_CONFLICT",
    );
  }
});

test("createV2Entry derives and snapshots an authorized individual source", async () => {
  let createData: unknown;
  let settlementInput: Parameters<V2EntrySettlementPort["apply"]>[1] | null =
    null;
  const operationOrder: string[] = [];
  const db = fakeDatabase({
    user: { findUnique: async () => activeActor() },
    match: {
      findUnique: async () =>
        v2Match({ type: "single", createdBy: "manager-1" }),
    },
    matchEntry: {
      findUnique: async () => null,
      create: async (args: { data: unknown }) => {
        operationOrder.push("entry-created");
        createData = args.data;
        return {
          id: "entry-1",
          matchId: "match-1",
          kind: "INDIVIDUAL",
          status: "ACTIVE",
          version: 0,
        };
      },
    },
    matchEntryMember: { findFirst: async () => null },
  });

  const result = await createV2Entry(
    db,
    {
      actor: { id: "actor-1", role: "user" },
      matchId: "match-1",
      kind: "INDIVIDUAL",
      sourceId: "actor-1",
      status: "ACTIVE",
    },
    fakeSettlementPort({
      apply: async (_tx, input) => {
        operationOrder.push("settlement-applied");
        settlementInput = input;
      },
    }),
  );

  assert.equal(result.created, true);
  assert.equal(result.rosterVersion, 1);
  assert.deepEqual(operationOrder, ["entry-created", "settlement-applied"]);
  assert.deepEqual(settlementInput, {
    matchId: "match-1",
    matchEntryId: "entry-1",
    rosterVersion: 1,
    origin: "STANDARD",
  });
  assert.deepEqual(createData, {
    matchId: "match-1",
    kind: "INDIVIDUAL",
    status: "ACTIVE",
    sourceKey: "individual:actor-1",
    sourceUserId: "actor-1",
    sourceDoublesTeamId: null,
    sourceMatchTeamId: null,
    displayNameSnapshot: "Actor",
    seed: undefined,
    members: {
      create: [
        {
          userId: "actor-1",
          displayNameSnapshot: "Actor",
          role: "player",
          status: "ACTIVE",
          slot: 1,
          rosterVersion: 1,
        },
      ],
    },
  });
});

test("a match creator cannot register another individual", async () => {
  const db = fakeDatabase({
    user: {
      findUnique: async (args: { where: { id: string } }) =>
        args.where.id === "manager-1"
          ? activeActor({ id: "manager-1" })
          : activeActor({ id: "other-user", nickname: "Other" }),
    },
    match: {
      findUnique: async () => v2Match({ createdBy: "manager-1" }),
    },
  });

  await expectApplicationError(
    () =>
      createV2Entry(db, {
        actor: { id: "manager-1", role: "user" },
        matchId: "match-1",
        kind: "INDIVIDUAL",
        sourceId: "other-user",
      }),
    "FORBIDDEN",
  );
});

test("an administrator acting for another entrant needs one audited override", async () => {
  let auditCount = 0;
  let settlementOrigin: string | null = null;
  const db = fakeDatabase({
    user: {
      findUnique: async (args: { where: { id: string } }) =>
        args.where.id === "admin-1"
          ? activeActor({ id: "admin-1", role: "admin" })
          : activeActor({ id: "other-user", nickname: "Other" }),
    },
    match: { findUnique: async () => v2Match() },
    auditLog: {
      create: async () => {
        auditCount += 1;
        return { id: "audit-1" };
      },
    },
    matchEntry: {
      findUnique: async () => null,
      create: async () => ({
        id: "entry-1",
        matchId: "match-1",
        kind: "INDIVIDUAL",
        status: "ACTIVE",
        version: 0,
      }),
    },
    matchEntryMember: { findFirst: async () => null },
  });

  await expectApplicationError(
    () =>
      createV2Entry(db, {
        actor: { id: "admin-1", role: "admin" },
        matchId: "match-1",
        kind: "INDIVIDUAL",
        sourceId: "other-user",
        status: "ACTIVE",
      }),
    "FORBIDDEN",
  );
  assert.equal(auditCount, 0);

  const result = await createV2Entry(
    db,
    {
      actor: { id: "admin-1", role: "admin" },
      matchId: "match-1",
      kind: "INDIVIDUAL",
      sourceId: "other-user",
      status: "ACTIVE",
      adminOverride: true,
      overrideReason: "Entrant requested assisted registration",
    },
    fakeSettlementPort({
      apply: async (_tx, input) => {
        settlementOrigin = input.origin;
      },
    }),
  );
  assert.equal(result.created, true);
  assert.equal(auditCount, 1);
  assert.equal(settlementOrigin, "ADMIN_BULK");
});

test("ordinary entry creation rejects a closed registration window", async () => {
  const db = fakeDatabase({
    user: { findUnique: async () => activeActor() },
    match: {
      findUnique: async () =>
        v2Match({
          status: "ongoing",
          registrationDeadline: new Date("2021-01-01T00:00:00.000Z"),
        }),
    },
  });

  await expectApplicationError(
    () =>
      createV2Entry(db, {
        actor: { id: "actor-1", role: "user" },
        matchId: "match-1",
        kind: "INDIVIDUAL",
        sourceId: "actor-1",
      }),
    "REGISTRATION_CLOSED",
  );
});

test("DRAFT activation rechecks current source account eligibility", async () => {
  const db = fakeDatabase({
    user: {
      findUnique: async (args: { where: { id: string } }) =>
        args.where.id === "actor-1"
          ? activeActor()
          : activeActor({ id: args.where.id, isBanned: true }),
    },
    match: { findUnique: async () => v2Match() },
    matchEntry: {
      findFirst: async () => ({
        id: "entry-1",
        kind: "INDIVIDUAL",
        status: "DRAFT",
        version: 0,
        sourceUserId: "source-user",
        sourceDoublesTeamId: null,
        sourceMatchTeamId: null,
        members: [],
      }),
    },
    matchFixture: { count: async () => 0 },
  });

  await expectApplicationError(
    () =>
      transitionV2EntryStatus(db, {
        actor: { id: "actor-1", role: "user" },
        matchId: "match-1",
        entryId: "entry-1",
        expectedVersion: 0,
        to: "ACTIVE",
      }),
    "ENTRY_SOURCE_NOT_ACTIVE",
  );
});

test("optimistic entry versions fail before a stale status write", async () => {
  const db = fakeDatabase({
    user: {
      findUnique: async () => activeActor({ role: "admin" }),
    },
    match: { findUnique: async () => v2Match() },
    matchEntry: {
      findFirst: async () => ({
        id: "entry-1",
        kind: "INDIVIDUAL",
        status: "ACTIVE",
        version: 4,
        sourceUserId: "actor-1",
        sourceDoublesTeamId: null,
        sourceMatchTeamId: null,
        members: [],
      }),
    },
  });

  await expectApplicationError(
    () =>
      transitionV2EntryStatus(db, {
        actor: { id: "actor-1", role: "admin" },
        matchId: "match-1",
        entryId: "entry-1",
        expectedVersion: 3,
        to: "DISQUALIFIED",
      }),
    "ENTRY_VERSION_CONFLICT",
  );
});

test("registration cancellation cannot downgrade an entry after a fixture exists", async () => {
  const db = fakeDatabase({
    user: { findUnique: async () => activeActor() },
    match: { findUnique: async () => v2Match() },
    matchEntry: {
      findFirst: async () => ({
        id: "entry-1",
        kind: "INDIVIDUAL",
        status: "ACTIVE",
        version: 0,
        sourceUserId: "actor-1",
        sourceDoublesTeamId: null,
        sourceMatchTeamId: null,
        members: [
          {
            userId: "actor-1",
            displayNameSnapshot: "Actor",
            role: "player",
            status: "ACTIVE",
            effectiveUntil: null,
            rosterVersion: 1,
          },
        ],
      }),
    },
    matchFixture: { count: async () => 1 },
  });

  await expectApplicationError(
    () =>
      transitionV2EntryStatus(db, {
        actor: { id: "actor-1", role: "user" },
        matchId: "match-1",
        entryId: "entry-1",
        expectedVersion: 0,
        to: "DRAFT",
      }),
    "FORBIDDEN",
  );
});

test("an administrator cancelling another entrant also needs one audited override", async () => {
  let auditCount = 0;
  let reversalInput: Parameters<V2EntrySettlementPort["reverse"]>[1] | null =
    null;
  const db = fakeDatabase({
    user: {
      findUnique: async () => activeActor({ id: "admin-1", role: "admin" }),
    },
    match: { findUnique: async () => v2Match() },
    auditLog: {
      create: async () => {
        auditCount += 1;
        return { id: "audit-1" };
      },
    },
    matchEntry: {
      findFirst: async () => ({
        id: "entry-1",
        kind: "INDIVIDUAL",
        status: "ACTIVE",
        version: 0,
        sourceUserId: "other-user",
        sourceDoublesTeamId: null,
        sourceMatchTeamId: null,
        members: [
          {
            userId: "other-user",
            displayNameSnapshot: "Other",
            role: "player",
            status: "ACTIVE",
            effectiveUntil: null,
            rosterVersion: 1,
          },
        ],
      }),
      updateMany: async () => ({ count: 1 }),
    },
    matchFixture: { count: async () => 0 },
    matchEntryMember: { updateMany: async () => ({ count: 1 }) },
  });

  await expectApplicationError(
    () =>
      transitionV2EntryStatus(db, {
        actor: { id: "admin-1", role: "admin" },
        matchId: "match-1",
        entryId: "entry-1",
        expectedVersion: 0,
        to: "DRAFT",
      }),
    "FORBIDDEN",
  );
  assert.equal(auditCount, 0);

  const result = await transitionV2EntryStatus(
    db,
    {
      actor: { id: "admin-1", role: "admin" },
      matchId: "match-1",
      entryId: "entry-1",
      expectedVersion: 0,
      to: "DRAFT",
      adminOverride: true,
      overrideReason: "Entrant requested assisted cancellation",
    },
    fakeSettlementPort({
      reverse: async (_tx, input) => {
        reversalInput = input;
      },
    }),
  );
  assert.equal(result.status, "DRAFT");
  assert.equal(auditCount, 1);
  assert.deepEqual(reversalInput, {
    matchId: "match-1",
    matchEntryId: "entry-1",
    rosterVersion: 1,
  });
});

test("cancellation reverses roster 1 and reactivation applies roster 2 in order", async () => {
  let entryStatus = "ACTIVE";
  let entryVersion = 0;
  const members = [
    {
      userId: "actor-1",
      displayNameSnapshot: "Actor",
      role: "player",
      status: "ACTIVE",
      effectiveUntil: null as Date | null,
      rosterVersion: 1,
    },
  ];
  const operations: string[] = [];
  const db = fakeDatabase({
    user: { findUnique: async () => activeActor() },
    match: { findUnique: async () => v2Match() },
    matchFixture: { count: async () => 0 },
    matchEntry: {
      findFirst: async () => ({
        id: "entry-1",
        kind: "INDIVIDUAL",
        status: entryStatus,
        version: entryVersion,
        sourceUserId: "actor-1",
        sourceDoublesTeamId: null,
        sourceMatchTeamId: null,
        members: members.map((member) => ({ ...member })),
      }),
      updateMany: async (args: { data: { status: string } }) => {
        operations.push(`entry:${args.data.status}`);
        entryStatus = args.data.status;
        entryVersion += 1;
        return { count: 1 };
      },
    },
    matchEntryMember: {
      findFirst: async () => null,
      updateMany: async (args: {
        data: { status: string; effectiveUntil: Date };
      }) => {
        operations.push(`members:${args.data.status}`);
        for (const member of members) {
          if (member.status === "ACTIVE" && member.effectiveUntil === null) {
            member.status = args.data.status;
            member.effectiveUntil = args.data.effectiveUntil;
          }
        }
        return { count: 1 };
      },
      createMany: async (args: {
        data: Array<{
          userId: string;
          displayNameSnapshot: string;
          role: string;
          status: string;
          rosterVersion: number;
        }>;
      }) => {
        operations.push(`members:create:${args.data[0].rosterVersion}`);
        members.push(
          ...args.data.map((member) => ({
            ...member,
            effectiveUntil: null,
          })),
        );
        return { count: args.data.length };
      },
    },
  });
  const settlementPort = fakeSettlementPort({
    reverse: async (_tx, input) => {
      operations.push(`reverse:${input.rosterVersion}`);
    },
    apply: async (_tx, input) => {
      operations.push(`apply:${input.rosterVersion}:${input.origin}`);
    },
  });

  await transitionV2EntryStatus(
    db,
    {
      actor: { id: "actor-1", role: "user" },
      matchId: "match-1",
      entryId: "entry-1",
      expectedVersion: 0,
      to: "DRAFT",
    },
    settlementPort,
  );
  await transitionV2EntryStatus(
    db,
    {
      actor: { id: "actor-1", role: "user" },
      matchId: "match-1",
      entryId: "entry-1",
      expectedVersion: 1,
      to: "ACTIVE",
    },
    settlementPort,
  );

  assert.deepEqual(operations, [
    "entry:DRAFT",
    "members:REMOVED",
    "reverse:1",
    "entry:ACTIVE",
    "members:create:2",
    "apply:2:STANDARD",
  ]);
});

test("every supported transition out of ACTIVE reverses its current roster", async () => {
  for (const to of ["WITHDRAWN", "DISQUALIFIED"] as const) {
    let reversedRosterVersion: number | null = null;
    const db = fakeDatabase({
      user: {
        findUnique: async () => activeActor({ role: "admin" }),
      },
      match: { findUnique: async () => v2Match() },
      matchEntry: {
        findFirst: async () => ({
          id: "entry-1",
          kind: "INDIVIDUAL",
          status: "ACTIVE",
          version: 4,
          sourceUserId: "actor-1",
          sourceDoublesTeamId: null,
          sourceMatchTeamId: null,
          members: [
            {
              userId: "actor-1",
              displayNameSnapshot: "Actor",
              role: "player",
              status: "ACTIVE",
              effectiveUntil: null,
              rosterVersion: 3,
            },
          ],
        }),
        updateMany: async () => ({ count: 1 }),
      },
      matchEntryMember: { updateMany: async () => ({ count: 1 }) },
    });

    await transitionV2EntryStatus(
      db,
      {
        actor: { id: "actor-1", role: "admin" },
        matchId: "match-1",
        entryId: "entry-1",
        expectedVersion: 4,
        to,
      },
      fakeSettlementPort({
        reverse: async (_tx, input) => {
          reversedRosterVersion = input.rosterVersion;
        },
      }),
    );
    assert.equal(reversedRosterVersion, 3, `${to} must reverse roster 3`);
  }
});

test("a regular team member cannot withdraw the entire team entry", async () => {
  const db = fakeDatabase({
    user: { findUnique: async () => activeActor() },
    match: {
      findUnique: async () => v2Match({ type: "team" }),
    },
    matchEntry: {
      findFirst: async () => ({
        id: "entry-1",
        kind: "TEAM",
        status: "ACTIVE",
        version: 0,
        sourceUserId: null,
        sourceDoublesTeamId: null,
        sourceMatchTeamId: "source-team-1",
        members: [
          {
            userId: "actor-1",
            displayNameSnapshot: "Actor",
            role: "player",
            status: "ACTIVE",
            effectiveUntil: null,
            rosterVersion: 1,
          },
        ],
      }),
    },
    matchTeam: {
      findFirst: async () => ({ captainId: "captain-1" }),
    },
  });

  await expectApplicationError(
    () =>
      transitionV2EntryStatus(db, {
        actor: { id: "actor-1", role: "user" },
        matchId: "match-1",
        entryId: "entry-1",
        expectedVersion: 0,
        to: "WITHDRAWN",
      }),
    "FORBIDDEN",
  );
});

test("a non-captain administrator needs exactly one audited pre-fixture roster override", async () => {
  const auditWrites: Array<Record<string, unknown>> = [];
  let settlementOrigin: string | null = null;
  const db = fakeDatabase({
    user: {
      findUnique: async () =>
        activeActor({ id: "admin-1", role: "admin", nickname: "Admin" }),
      findMany: async () => [
        activeActor({ id: "captain-1", nickname: "Captain" }),
        activeActor({ id: "player-2", nickname: "Player Two" }),
      ],
    },
    match: {
      findUnique: async () =>
        v2Match({
          type: "team",
          status: "ongoing",
          registrationDeadline: new Date("2021-01-01T00:00:00.000Z"),
          teamRegistrationDeadline: new Date("2021-01-01T00:00:00.000Z"),
          teamMinMembers: 2,
          teamMaxMembers: 5,
        }),
    },
    matchEntry: {
      findFirst: async () => ({
        id: "entry-1",
        kind: "TEAM",
        status: "ACTIVE",
        version: 2,
        sourceMatchTeamId: "source-team-1",
        members: [
          { userId: "captain-1", role: "captain", rosterVersion: 1 },
          { userId: "old-player", role: "player", rosterVersion: 1 },
        ],
      }),
      updateMany: async () => ({ count: 1 }),
    },
    matchTeam: {
      findFirst: async () => ({
        captainId: "captain-1",
        members: [{ userId: "captain-1" }, { userId: "player-2" }],
      }),
    },
    matchFixture: { count: async () => 0 },
    matchEntryMember: {
      findFirst: async () => null,
      updateMany: async () => ({ count: 1 }),
      createMany: async () => ({ count: 2 }),
    },
    auditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        auditWrites.push(args.data);
        return { id: `audit-${auditWrites.length}` };
      },
    },
  });

  await expectApplicationError(
    () =>
      replaceV2EntryRoster(db, {
        actor: { id: "admin-1", role: "admin" },
        matchId: "match-1",
        entryId: "entry-1",
        expectedVersion: 2,
        memberIds: ["captain-1", "player-2"],
      }),
    "FORBIDDEN",
  );
  assert.equal(auditWrites.length, 0);

  const result = await replaceV2EntryRoster(
    db,
    {
      actor: { id: "admin-1", role: "admin" },
      matchId: "match-1",
      entryId: "entry-1",
      expectedVersion: 2,
      memberIds: ["captain-1", "player-2"],
      adminOverride: true,
      overrideReason: "Captain requested an assisted roster sync",
    },
    fakeSettlementPort({
      apply: async (_tx, input) => {
        settlementOrigin = input.origin;
      },
    }),
  );

  assert.equal(result.version, 3);
  assert.equal(settlementOrigin, "ADMIN_BULK");
  assert.deepEqual(auditWrites, [
    {
      actorId: "admin-1",
      action: "v2_entry_roster_replace_admin_override",
      entityType: "MatchEntry",
      entityId: "entry-1",
      details: {
        matchId: "match-1",
        reason: "Captain requested an assisted roster sync",
      },
    },
  ]);
});

test("an administrator creates a successor team roster without rewriting old members", async () => {
  const memberUpdates: Array<{ data: { status: string } }> = [];
  let createdMembers: Array<Record<string, unknown>> = [];
  let settlementInput: Parameters<V2EntrySettlementPort["apply"]>[1] | null =
    null;
  const db = fakeDatabase({
    user: {
      findUnique: async () => activeActor({ role: "admin" }),
      findMany: async () => [
        activeActor({ id: "user-1", role: "user", nickname: "One" }),
        activeActor({ id: "user-3", role: "user", nickname: "Three" }),
      ],
    },
    match: {
      findUnique: async () =>
        v2Match({
          type: "team",
          teamMinMembers: 2,
          teamMaxMembers: 5,
        }),
    },
    matchEntry: {
      findFirst: async () => ({
        id: "entry-1",
        kind: "TEAM",
        status: "ACTIVE",
        version: 2,
        sourceMatchTeamId: "source-team-1",
        members: [
          {
            userId: "user-1",
            role: "captain",
            rosterVersion: 1,
          },
          { userId: "user-2", role: "player", rosterVersion: 1 },
        ],
      }),
      updateMany: async () => ({ count: 1 }),
    },
    matchFixture: { count: async () => 1 },
    matchTeam: {
      findFirst: async () => ({ captainId: "user-1" }),
    },
    matchEntryMember: {
      findFirst: async () => null,
      updateMany: async (args: { data: { status: string } }) => {
        memberUpdates.push(args);
        return { count: 1 };
      },
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        createdMembers = args.data;
        return { count: args.data.length };
      },
    },
    auditLog: { create: async () => ({ id: "audit-1" }) },
  });

  const result = await replaceV2EntryRoster(
    db,
    {
      actor: { id: "actor-1", role: "admin" },
      matchId: "match-1",
      entryId: "entry-1",
      expectedVersion: 2,
      memberIds: ["user-1", "user-3"],
      adminOverride: true,
      overrideReason: "Approved injury substitution",
    },
    fakeSettlementPort({
      apply: async (_tx, input) => {
        settlementInput = input;
      },
    }),
  );

  assert.equal(result.version, 3);
  assert.equal(result.rosterVersion, 2);
  assert.deepEqual(
    memberUpdates.map((update) => update.data.status),
    ["SUPERSEDED", "REMOVED"],
  );
  assert.deepEqual(
    createdMembers.map((member) => ({
      userId: member.userId,
      rosterVersion: member.rosterVersion,
      status: member.status,
    })),
    [
      { userId: "user-1", rosterVersion: 2, status: "ACTIVE" },
      { userId: "user-3", rosterVersion: 2, status: "ACTIVE" },
    ],
  );
  assert.deepEqual(settlementInput, {
    matchId: "match-1",
    matchEntryId: "entry-1",
    rosterVersion: 2,
    origin: "ADMIN_BULK",
  });
});

test("an active team successor roster can later withdraw by reversing its current activation", async () => {
  let entryStatus = "ACTIVE";
  let entryVersion = 2;
  let auditCount = 0;
  const members = [
    {
      userId: "user-1",
      displayNameSnapshot: "One",
      role: "captain",
      status: "ACTIVE",
      effectiveUntil: null as Date | null,
      rosterVersion: 1,
    },
    {
      userId: "user-2",
      displayNameSnapshot: "Two",
      role: "player",
      status: "ACTIVE",
      effectiveUntil: null as Date | null,
      rosterVersion: 1,
    },
  ];
  const settlementOperations: string[] = [];
  const appliedRosterVersions = new Set([1]);
  const reversedRosterVersions = new Set<number>();
  const db = fakeDatabase({
    user: {
      findUnique: async () =>
        activeActor({ id: "admin-1", role: "admin", nickname: "Admin" }),
      findMany: async () => [
        activeActor({ id: "user-1", role: "user", nickname: "One" }),
        activeActor({ id: "user-3", role: "user", nickname: "Three" }),
      ],
    },
    match: {
      findUnique: async () =>
        v2Match({
          type: "team",
          teamMinMembers: 2,
          teamMaxMembers: 5,
        }),
    },
    matchEntry: {
      findFirst: async (args: {
        select: { members: { where?: Record<string, unknown> } };
      }) => ({
        id: "entry-1",
        kind: "TEAM",
        status: entryStatus,
        version: entryVersion,
        sourceUserId: null,
        sourceDoublesTeamId: null,
        sourceMatchTeamId: "source-team-1",
        members: members
          .filter(
            (member) =>
              args.select.members.where === undefined ||
              (member.status === "ACTIVE" && member.effectiveUntil === null),
          )
          .map((member) => ({ ...member })),
      }),
      updateMany: async (args: { data: { status?: string } }) => {
        if (args.data.status !== undefined) entryStatus = args.data.status;
        entryVersion += 1;
        return { count: 1 };
      },
    },
    matchFixture: { count: async () => 1 },
    matchTeam: { findFirst: async () => ({ captainId: "user-1" }) },
    matchEntryMember: {
      findFirst: async () => null,
      updateMany: async (args: {
        where: { userId?: { in: string[] } };
        data: { status: string; effectiveUntil: Date };
      }) => {
        const selectedUserIds = args.where.userId?.in;
        for (const member of members) {
          if (
            member.status === "ACTIVE" &&
            member.effectiveUntil === null &&
            (selectedUserIds === undefined ||
              selectedUserIds.includes(member.userId))
          ) {
            member.status = args.data.status;
            member.effectiveUntil = args.data.effectiveUntil;
          }
        }
        return { count: 1 };
      },
      createMany: async (args: {
        data: Array<{
          userId: string;
          displayNameSnapshot: string;
          role: string;
          status: string;
          rosterVersion: number;
        }>;
      }) => {
        members.push(
          ...args.data.map((member) => ({
            ...member,
            effectiveUntil: null,
          })),
        );
        return { count: args.data.length };
      },
    },
    auditLog: {
      create: async () => {
        auditCount += 1;
        return { id: `audit-${auditCount}` };
      },
    },
  });
  const settlementPort = fakeSettlementPort({
    apply: async (_tx, input) => {
      settlementOperations.push(
        `apply:${input.rosterVersion}:${input.origin}`,
      );
      appliedRosterVersions.add(input.rosterVersion);
    },
    reverse: async (_tx, input) => {
      assert.ok(
        appliedRosterVersions.has(input.rosterVersion),
        "a reversal must have a matching activation event",
      );
      settlementOperations.push(`reverse:${input.rosterVersion}`);
      reversedRosterVersions.add(input.rosterVersion);
    },
  });

  const replacement = await replaceV2EntryRoster(
    db,
    {
      actor: { id: "admin-1", role: "admin" },
      matchId: "match-1",
      entryId: "entry-1",
      expectedVersion: 2,
      memberIds: ["user-1", "user-3"],
      adminOverride: true,
      overrideReason: "Approved injury substitution",
    },
    settlementPort,
  );
  await transitionV2EntryStatus(
    db,
    {
      actor: { id: "admin-1", role: "admin" },
      matchId: "match-1",
      entryId: "entry-1",
      expectedVersion: replacement.version,
      to: "WITHDRAWN",
      adminOverride: true,
      overrideReason: "Team withdrew after its approved substitution",
    },
    settlementPort,
  );

  assert.deepEqual(settlementOperations, [
    "apply:2:ADMIN_BULK",
    "reverse:2",
  ]);
  assert.equal(entryStatus, "WITHDRAWN");
  assert.equal(auditCount, 2);
  assert.equal(reversedRosterVersions.has(1), false);
  assert.equal(reversedRosterVersions.has(2), true);
});
