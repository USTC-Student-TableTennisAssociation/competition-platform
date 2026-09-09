import assert from "node:assert/strict";
import test from "node:test";

import type { Prisma } from "@prisma/client";

import {
  RegistrationSettlementError,
  applyRegistrationSettlement,
  createRegistrationSettlementIdempotencyKey,
  reverseRegistrationSettlement,
  type RegistrationSettlementTransaction,
} from "./registration-settlements";

type TestEntryKind = "INDIVIDUAL" | "DOUBLES" | "TEAM";

type StoredEvent = {
  id: string;
  idempotencyKey: string;
  kind:
    | "RESULT_APPLY"
    | "RESULT_REVERSAL"
    | "REGISTRATION_APPLY"
    | "REGISTRATION_REVERSAL";
  status: "PENDING" | "APPLIED" | "REVERSED" | "FAILED";
  resultRevisionId: string | null;
  matchEntryId: string | null;
  reversesEventId: string | null;
  metadata: Prisma.JsonValue | null;
  failureReason: string | null;
  appliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type StoredEffect = {
  id: string;
  eventId: string;
  userId: string;
  eloBefore: number | null;
  eloAfter: number | null;
  eloDelta: number | null;
  pointsBefore: number | null;
  pointsAfter: number | null;
  pointsDelta: number | null;
  winsDelta: number;
  lossesDelta: number;
  matchesPlayedDelta: number;
  createdAt: Date;
};

type StoredPointsTransaction = {
  id: string;
  userId: string;
  amount: number;
  balanceAfter: number;
  type: "earn" | "spend" | "refund" | "adjustment";
  reason: string;
  referenceId: string | null;
  createdAt: Date;
};

type HarnessOptions = Readonly<{
  kind?: TestEntryKind;
  isQuickMatch?: boolean;
  users?: readonly Readonly<{ id: string; points: number }>[];
  ledger?: readonly Readonly<{
    userId: string;
    amount: number;
    referenceId: string;
  }>[];
}>;

function createHarness(options: HarnessOptions = {}) {
  const now = new Date("2026-09-04T00:00:00.000Z");
  const matchId = "match-1";
  const matchEntryId = "entry-1";
  let rosterVersion = 1;
  let serial = 0;
  const nextId = (prefix: string) => `${prefix}-${++serial}`;
  const kind = options.kind ?? "INDIVIDUAL";
  const defaultUsers =
    kind === "INDIVIDUAL"
      ? [{ id: "user-1", points: 0 }]
      : kind === "DOUBLES"
        ? [
            { id: "user-2", points: 10 },
            { id: "user-1", points: 10 },
          ]
        : [
            { id: "user-3", points: 8 },
            { id: "user-1", points: 5 },
            { id: "user-2", points: 2 },
          ];
  const users = new Map(
    (options.users ?? defaultUsers).map((user) => [user.id, { ...user }]),
  );
  const events: StoredEvent[] = [];
  const effects: StoredEffect[] = [];
  const ledger: StoredPointsTransaction[] = (options.ledger ?? []).map(
    (transaction) => ({
      id: nextId("legacy-points"),
      ...transaction,
      balanceAfter: users.get(transaction.userId)?.points ?? 0,
      type: transaction.amount >= 0 ? "earn" : "refund",
      reason: "existing transaction",
      createdAt: now,
    }),
  );

  const tx = {
    matchEntry: {
      findFirst: async () => ({
        id: matchEntryId,
        matchId,
        kind,
        status: "ACTIVE",
        match: {
          id: matchId,
          engineVersion: "V2",
          isQuickMatch: options.isQuickMatch ?? false,
        },
        members: [...users.keys()].map((userId, index) => ({
          id: `member-${userId}-v${rosterVersion}`,
          entryId: matchEntryId,
          matchId,
          userId,
          rosterVersion,
          status: "ACTIVE",
          effectiveUntil: null,
          slot: index + 1,
        })),
      }),
    },
    $queryRaw: async () => [],
    user: {
      findMany: async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in
          .map((id) => users.get(id))
          .filter((user): user is { id: string; points: number } => user !== undefined)
          .sort((left, right) => left.id.localeCompare(right.id)),
      update: async (args: {
        where: { id: string };
        data: { points: number };
      }) => {
        const user = users.get(args.where.id);
        assert.ok(user);
        const updated = { ...user, points: args.data.points };
        users.set(args.where.id, updated);
        return updated;
      },
    },
    pointsTransaction: {
      findMany: async (args: {
        where: {
          userId: { in: string[] };
          referenceId: { startsWith: string };
        };
      }) =>
        ledger.filter(
          (transaction) =>
            args.where.userId.in.includes(transaction.userId) &&
            transaction.referenceId?.startsWith(
              args.where.referenceId.startsWith,
            ),
        ),
      create: async (args: {
        data: Omit<StoredPointsTransaction, "id" | "createdAt">;
      }) => {
        const transaction: StoredPointsTransaction = {
          id: nextId("points"),
          createdAt: now,
          ...args.data,
        };
        ledger.push(transaction);
        return transaction;
      },
    },
    settlementEvent: {
      findUnique: async (args: { where: { idempotencyKey: string } }) => {
        const event = events.find(
          (candidate) =>
            candidate.idempotencyKey === args.where.idempotencyKey,
        );
        return event === undefined
          ? null
          : {
              ...event,
              effects: effects
                .filter((effect) => effect.eventId === event.id)
                .sort((left, right) => left.userId.localeCompare(right.userId)),
            };
      },
      create: async (args: {
        data: Pick<
          StoredEvent,
          | "idempotencyKey"
          | "kind"
          | "status"
          | "resultRevisionId"
          | "matchEntryId"
          | "reversesEventId"
          | "metadata"
        >;
      }) => {
        const event: StoredEvent = {
          id: nextId("event"),
          failureReason: null,
          appliedAt: null,
          createdAt: now,
          updatedAt: now,
          ...args.data,
        };
        events.push(event);
        return event;
      },
      update: async (args: {
        where: { id: string };
        data: Partial<Pick<StoredEvent, "status" | "appliedAt">>;
      }) => {
        const event = events.find((candidate) => candidate.id === args.where.id);
        assert.ok(event);
        Object.assign(event, args.data, { updatedAt: now });
        return event;
      },
    },
    settlementEffect: {
      create: async (args: {
        data: Omit<StoredEffect, "id" | "createdAt">;
      }) => {
        const effect: StoredEffect = {
          id: nextId("effect"),
          createdAt: now,
          ...args.data,
        };
        effects.push(effect);
        return effect;
      },
    },
  } as unknown as RegistrationSettlementTransaction;

  return {
    tx,
    matchId,
    matchEntryId,
    users,
    events,
    effects,
    ledger,
    setRosterVersion(nextRosterVersion: number) {
      rosterVersion = nextRosterVersion;
    },
  };
}

test("registration apply is idempotent and writes one aggregate event", async () => {
  const harness = createHarness();
  const input = {
    matchId: harness.matchId,
    matchEntryId: harness.matchEntryId,
    rosterVersion: 1,
    origin: "STANDARD" as const,
  };

  const first = await applyRegistrationSettlement(harness.tx, input);
  const second = await applyRegistrationSettlement(harness.tx, input);

  assert.equal(first.wasNoop, false);
  assert.equal(second.wasNoop, true);
  assert.equal(harness.users.get("user-1")?.points, 1);
  assert.equal(harness.events.length, 1);
  assert.equal(harness.effects.length, 1);
  assert.equal(harness.ledger.length, 1);
  assert.equal(first.event.kind, "REGISTRATION_APPLY");
  assert.equal(first.event.status, "APPLIED");
  assert.equal(first.event.matchEntryId, harness.matchEntryId);
  assert.equal(first.event.resultRevisionId, null);
  assert.equal(first.event.reversesEventId, null);
  assert.equal(
    first.event.idempotencyKey,
    createRegistrationSettlementIdempotencyKey(
      harness.matchEntryId,
      1,
      "REGISTRATION_APPLY",
    ),
  );
  assert.match(
    harness.ledger[0].referenceId ?? "",
    /^match-points:match-1:register:v2:/,
  );
  assert.deepEqual(
    first.effects.map((effect) => ({
      elo: [effect.eloBefore, effect.eloAfter, effect.eloDelta],
      points: [effect.pointsBefore, effect.pointsAfter, effect.pointsDelta],
      stats: [
        effect.winsDelta,
        effect.lossesDelta,
        effect.matchesPlayedDelta,
      ],
    })),
    [{ elo: [null, null, null], points: [0, 1, 1], stats: [0, 0, 0] }],
  );
});

test("direct registration settlement rejects quick matches", async () => {
  const harness = createHarness({ isQuickMatch: true });

  await assert.rejects(
    () =>
      applyRegistrationSettlement(harness.tx, {
        matchId: harness.matchId,
        matchEntryId: harness.matchEntryId,
        rosterVersion: 1,
        origin: "STANDARD",
      }),
    (error: unknown) =>
      error instanceof RegistrationSettlementError &&
      error.code === "ENGINE_MISMATCH" &&
      error.details.isQuickMatch === true,
  );
});

test("registration reward respects both per-match and registration caps", async () => {
  const harness = createHarness({
    kind: "DOUBLES",
    users: [
      { id: "user-1", points: 10 },
      { id: "user-2", points: 10 },
    ],
    ledger: [
      {
        userId: "user-1",
        amount: 5,
        referenceId: "match-points:match-1:result:old",
      },
      {
        userId: "user-2",
        amount: 1,
        referenceId: "match-points:match-1:register:legacy-earn",
      },
    ],
  });

  const result = await applyRegistrationSettlement(harness.tx, {
    matchId: harness.matchId,
    matchEntryId: harness.matchEntryId,
    rosterVersion: 1,
    origin: "STANDARD",
  });

  assert.deepEqual(
    result.effects.map((effect) => [effect.userId, effect.pointsDelta]),
    [
      ["user-1", 0],
      ["user-2", 0],
    ],
  );
  assert.equal(harness.users.get("user-1")?.points, 10);
  assert.equal(harness.users.get("user-2")?.points, 10);
});

test("zero-balance reversal records unrecovered points and prevents a second-cycle reward", async () => {
  const harness = createHarness();
  await applyRegistrationSettlement(harness.tx, {
    matchId: harness.matchId,
    matchEntryId: harness.matchEntryId,
    rosterVersion: 1,
    origin: "STANDARD",
  });
  const user = harness.users.get("user-1");
  assert.ok(user);
  user.points = 0;

  const reversed = await reverseRegistrationSettlement(harness.tx, {
    matchId: harness.matchId,
    matchEntryId: harness.matchEntryId,
    rosterVersion: 1,
  });

  assert.equal(user.points, 0);
  assert.equal(reversed.event.kind, "REGISTRATION_REVERSAL");
  assert.equal(reversed.event.status, "APPLIED");
  assert.equal(reversed.event.reversesEventId, harness.events[0].id);
  assert.equal(harness.events[0].status, "REVERSED");
  assert.equal(reversed.effects[0].pointsDelta, 0);
  assert.deepEqual(reversed.event.metadata, {
    schemaVersion: 1,
    matchId: harness.matchId,
    entryKind: "INDIVIDUAL",
    rosterVersion: 1,
    origin: "STANDARD",
    unrecoveredPoints: [{ userId: "user-1", amount: 1 }],
    unrecoveredPointsTotal: 1,
  });

  harness.setRosterVersion(2);
  const reapplied = await applyRegistrationSettlement(harness.tx, {
    matchId: harness.matchId,
    matchEntryId: harness.matchEntryId,
    rosterVersion: 2,
    origin: "STANDARD",
  });
  assert.equal(reapplied.effects[0].pointsDelta, 0);
  assert.equal(user.points, 0);
});

test("team registration records zero-point effects for every member", async () => {
  const harness = createHarness({ kind: "TEAM" });

  const result = await applyRegistrationSettlement(harness.tx, {
    matchId: harness.matchId,
    matchEntryId: harness.matchEntryId,
    rosterVersion: 1,
    origin: "STANDARD",
  });

  assert.equal(result.effects.length, 3);
  assert.ok(result.effects.every((effect) => effect.pointsDelta === 0));
  assert.ok(result.effects.every((effect) => effect.eloDelta === null));
  assert.equal(harness.ledger.length, 0);
  assert.deepEqual(
    [...harness.users.values()].map((user) => user.points).sort(),
    [2, 5, 8],
  );
});

test("a team successor roster records a distinct zero-point activation that can be reversed", async () => {
  const harness = createHarness({ kind: "TEAM" });

  await applyRegistrationSettlement(harness.tx, {
    matchId: harness.matchId,
    matchEntryId: harness.matchEntryId,
    rosterVersion: 1,
    origin: "STANDARD",
  });
  harness.setRosterVersion(2);
  await applyRegistrationSettlement(harness.tx, {
    matchId: harness.matchId,
    matchEntryId: harness.matchEntryId,
    rosterVersion: 2,
    origin: "ADMIN_BULK",
  });
  await reverseRegistrationSettlement(harness.tx, {
    matchId: harness.matchId,
    matchEntryId: harness.matchEntryId,
    rosterVersion: 2,
  });

  assert.deepEqual(
    harness.events.map((event) => ({
      kind: event.kind,
      status: event.status,
      rosterVersion: (event.metadata as { rosterVersion: number }).rosterVersion,
      origin: (event.metadata as { origin: string }).origin,
      reversesEventId: event.reversesEventId,
    })),
    [
      {
        kind: "REGISTRATION_APPLY",
        status: "APPLIED",
        rosterVersion: 1,
        origin: "STANDARD",
        reversesEventId: null,
      },
      {
        kind: "REGISTRATION_APPLY",
        status: "REVERSED",
        rosterVersion: 2,
        origin: "ADMIN_BULK",
        reversesEventId: null,
      },
      {
        kind: "REGISTRATION_REVERSAL",
        status: "APPLIED",
        rosterVersion: 2,
        origin: "ADMIN_BULK",
        reversesEventId: harness.events[1].id,
      },
    ],
  );
  assert.equal(harness.effects.length, 9);
  assert.ok(harness.effects.every((effect) => effect.pointsDelta === 0));
  assert.equal(harness.ledger.length, 0);
  assert.deepEqual(
    [...harness.users.values()].map((user) => user.points).sort(),
    [2, 5, 8],
  );
});

test("explicit admin bulk registration records history without a reward", async () => {
  const harness = createHarness({
    users: [{ id: "user-1", points: 7 }],
  });

  const result = await applyRegistrationSettlement(harness.tx, {
    matchId: harness.matchId,
    matchEntryId: harness.matchEntryId,
    rosterVersion: 1,
    origin: "ADMIN_BULK",
  });

  assert.equal(result.effects[0].pointsDelta, 0);
  assert.equal(harness.users.get("user-1")?.points, 7);
  assert.equal(harness.ledger.length, 0);
  assert.equal(
    (result.event.metadata as { origin?: unknown } | null)?.origin,
    "ADMIN_BULK",
  );
});
