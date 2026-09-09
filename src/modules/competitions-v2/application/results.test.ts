import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";

import { V2ResultApplicationError } from "./results-errors";
import {
  assertCanonicalResultScore,
  assertCorrectionSwapsParticipants,
  assertInitialResultEntriesActive,
  assertResultActorCanSubmit,
  assertResultActorCanConfirm,
  assertV2ResultFixtureStageSupported,
  createV2ResultApplicationService,
  mapV2ResultPersistenceError,
  v2ForfeitAuditAction,
  v2ForfeitCorrectionAuditAction,
} from "./results";
import type { V2ResultDatabase } from "./results";
import type {
  FrozenFixtureRoster,
  ResultSettlementTransaction,
} from "./settlements";
import { V2_MAX_TEAM_SCORE_PER_FIXTURE } from "../domain/group-standings";

function roster(kind: "INDIVIDUAL" | "DOUBLES" | "TEAM"):
  FrozenFixtureRoster {
  return {
    sideA: {
      entryId: "entry-a",
      kind,
      status: "ACTIVE",
      rosterVersion: 1,
      members: [
        { userId: "reporter", role: kind === "TEAM" ? "captain" : "player" },
        { userId: "same-side-partner", role: "player" },
      ],
      userIds: ["reporter", "same-side-partner"],
    },
    sideB: {
      entryId: "entry-b",
      kind,
      status: "ACTIVE",
      rosterVersion: 1,
      members: [
        { userId: "opposing-captain", role: "captain" },
        { userId: "opposing-player", role: "player" },
      ],
      userIds: ["opposing-captain", "opposing-player"],
    },
    allUserIds: [
      "opposing-captain",
      "opposing-player",
      "reporter",
      "same-side-partner",
    ],
  };
}

function resultServiceWithEntryStatuses(input: Readonly<{
  sideAStatus: "ACTIVE" | "WITHDRAWN" | "DISQUALIFIED";
  sideBStatus: "ACTIVE" | "WITHDRAWN" | "DISQUALIFIED";
  fixtureVersion: number;
}>) {
  const transaction = {
    $queryRaw: async () => [{ id: "locked-row" }],
    match: {
      findUnique: async () => ({
        id: "match-1",
        createdBy: "owner",
        engineVersion: "V2",
        isQuickMatch: false,
        type: "single",
      }),
    },
    matchFixture: {
      findUnique: async () => ({
        id: "fixture-1",
        matchId: "match-1",
        stage: "FREE_PLAY",
        bestOf: 5,
        status: "READY",
        version: input.fixtureVersion,
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
        sideARosterVersion: 1,
        sideBRosterVersion: 1,
      }),
    },
    matchEntry: {
      findMany: async () => [
        {
          id: "entry-a",
          kind: "INDIVIDUAL",
          status: input.sideAStatus,
        },
        {
          id: "entry-b",
          kind: "INDIVIDUAL",
          status: input.sideBStatus,
        },
      ],
    },
    matchEntryMember: {
      findMany: async () => [
        {
          entryId: "entry-a",
          rosterVersion: 1,
          userId: "player-a",
          role: "player",
        },
        {
          entryId: "entry-b",
          rosterVersion: 1,
          userId: "player-b",
          role: "player",
        },
      ],
    },
    resultRevision: {
      findUnique: async () => ({
        id: "revision-1",
        matchId: "match-1",
        fixtureId: "fixture-1",
        status: "PENDING",
        winnerEntryId: "entry-a",
        loserEntryId: "entry-b",
        score: { bestOf: 5, winnerScore: 3, loserScore: 1 },
        reportedById: "player-a",
        supersedesRevisionId: null,
      }),
    },
  } as unknown as ResultSettlementTransaction;
  const db = {
    $transaction: async <T>(
      operation: (tx: ResultSettlementTransaction) => Promise<T>,
    ) => operation(transaction),
  } as unknown as V2ResultDatabase;
  return createV2ResultApplicationService({ db });
}

test("non-team confirmation preserves legacy same-side partner behavior", () => {
  assert.doesNotThrow(() =>
    assertResultActorCanConfirm(
      { id: "same-side-partner", role: "user" },
      { id: "match-1", createdBy: "owner" },
      roster("DOUBLES"),
      { reportedById: "reporter" },
    ),
  );
});

test("initial result submission allows frozen singles and doubles participants but keeps TEAM captain-only", () => {
  const match = { id: "match-1", createdBy: "owner" };
  assert.doesNotThrow(() =>
    assertResultActorCanSubmit(
      { id: "reporter", role: "user" },
      match,
      roster("INDIVIDUAL"),
      false,
    ),
  );
  assert.doesNotThrow(() =>
      assertResultActorCanSubmit(
        { id: "reporter", role: "user" },
        match,
        roster("DOUBLES"),
        false,
      ),
  );
  assert.throws(
    () =>
      assertResultActorCanSubmit(
        { id: "opposing-player", role: "user" },
        match,
        roster("TEAM"),
        false,
      ),
    (error) =>
      error instanceof V2ResultApplicationError && error.code === "FORBIDDEN",
  );
  assert.doesNotThrow(() =>
    assertResultActorCanSubmit(
      { id: "opposing-captain", role: "user" },
      match,
      roster("TEAM"),
      false,
    ),
  );
  assert.throws(
    () =>
      assertResultActorCanSubmit(
        { id: "reporter", role: "user" },
        match,
        roster("INDIVIDUAL"),
        true,
      ),
    (error) =>
      error instanceof V2ResultApplicationError && error.code === "FORBIDDEN",
  );
});

test("team confirmation is restricted to a participating captain", () => {
  assert.throws(
    () =>
      assertResultActorCanConfirm(
        { id: "opposing-player", role: "user" },
        { id: "match-1", createdBy: "owner" },
        roster("TEAM"),
        { reportedById: "reporter" },
      ),
    (error) =>
      error instanceof V2ResultApplicationError && error.code === "FORBIDDEN",
  );
  assert.doesNotThrow(() =>
    assertResultActorCanConfirm(
      { id: "opposing-captain", role: "user" },
      { id: "match-1", createdBy: "owner" },
      roster("TEAM"),
      { reportedById: "reporter" },
    ),
  );
});

test("a reporter cannot self-confirm unless they are owner or admin", () => {
  assert.throws(
    () =>
      assertResultActorCanConfirm(
        { id: "reporter", role: "user" },
        { id: "match-1", createdBy: "owner" },
        roster("DOUBLES"),
        { reportedById: "reporter" },
      ),
    (error) =>
      error instanceof V2ResultApplicationError && error.code === "FORBIDDEN",
  );
  assert.doesNotThrow(() =>
    assertResultActorCanConfirm(
      { id: "reporter", role: "admin" },
      { id: "match-1", createdBy: "owner" },
      roster("DOUBLES"),
      { reportedById: "reporter" },
    ),
  );
});

test("canonical singles and doubles scores must agree with the winner", () => {
  assert.doesNotThrow(() =>
    assertCanonicalResultScore("single", {
      bestOf: 5,
      winnerScore: 3,
      loserScore: 2,
      text: "3:2",
    }),
  );
  assert.doesNotThrow(() =>
    assertCanonicalResultScore("double", {
      bestOf: 7,
      winnerScore: 4,
      loserScore: 2,
      text: "4:2（7局4胜）",
    }),
  );
  assert.throws(
    () =>
      assertCanonicalResultScore("double", {
        bestOf: 5,
        winnerScore: 2,
        loserScore: 3,
      }),
    (error) =>
      error instanceof V2ResultApplicationError &&
      error.code === "INVALID_COMMAND",
  );
  assert.throws(
    () =>
      assertCanonicalResultScore("single", {
        bestOf: 5,
        winnerScore: 3,
        loserScore: 2,
        text: "3-2",
      }),
    (error) =>
      error instanceof V2ResultApplicationError &&
      error.code === "INVALID_COMMAND",
  );
});

test("canonical team scores require a non-negative winning total", () => {
  assert.doesNotThrow(() =>
    assertCanonicalResultScore("team", { winnerScore: 5, loserScore: 3 }),
  );
  assert.throws(
    () =>
      assertCanonicalResultScore("team", { winnerScore: 3, loserScore: 3 }),
    (error) =>
      error instanceof V2ResultApplicationError &&
      error.code === "INVALID_COMMAND",
  );
  assert.doesNotThrow(() =>
    assertCanonicalResultScore("team", {
      winnerScore: V2_MAX_TEAM_SCORE_PER_FIXTURE,
      loserScore: V2_MAX_TEAM_SCORE_PER_FIXTURE - 1,
    }),
  );
  assert.throws(
    () =>
      assertCanonicalResultScore("team", {
        winnerScore: V2_MAX_TEAM_SCORE_PER_FIXTURE + 1,
        loserScore: 0,
      }),
    (error) =>
      error instanceof V2ResultApplicationError &&
      error.code === "INVALID_COMMAND",
  );
  assert.throws(
    () =>
      assertCanonicalResultScore("team", {
        winnerScore: 5,
        loserScore: 3,
        bestOf: 7,
      }),
    (error) =>
      error instanceof V2ResultApplicationError &&
      error.code === "INVALID_COMMAND",
  );
});

test("forfeit audit classification is derived from the locked match type", () => {
  assert.equal(v2ForfeitAuditAction("single"), "v2_single_group_forfeit_confirm");
  assert.equal(v2ForfeitAuditAction("double"), "v2_double_group_forfeit_confirm");
  assert.equal(v2ForfeitAuditAction("team"), "v2_team_group_forfeit_confirm");
  assert.equal(
    v2ForfeitAuditAction("single", "KNOCKOUT"),
    "v2_single_knockout_forfeit_confirm",
  );
  assert.equal(
    v2ForfeitAuditAction("double", "KNOCKOUT"),
    "v2_double_knockout_forfeit_confirm",
  );
  assert.equal(
    v2ForfeitAuditAction("team", "KNOCKOUT"),
    "v2_team_knockout_forfeit_confirm",
  );
  assert.equal(
    v2ForfeitCorrectionAuditAction("single", "GROUP"),
    "v2_single_group_forfeit_correct",
  );
  assert.equal(
    v2ForfeitCorrectionAuditAction("double", "KNOCKOUT"),
    "v2_double_knockout_forfeit_correct",
  );
  assert.equal(
    v2ForfeitCorrectionAuditAction("team", "GROUP"),
    "v2_team_group_forfeit_correct",
  );
});

test("manager forfeit confirmation is atomic, zero-settlement, and exactly idempotent", async () => {
  const fixture = {
    id: "fixture-forfeit",
    matchId: "match-1",
    stage: "GROUP" as const,
    status: "READY" as "READY" | "COMPLETED" | "VOIDED",
    version: 2,
    sideAEntryId: "entry-a",
    sideBEntryId: "entry-b",
    sideARosterVersion: 1,
    sideBRosterVersion: 1,
  };
  let confirmed: Record<string, unknown> | null = null;
  const writes: string[] = [];
  const transaction = {
    $queryRaw: async () => [{ id: "locked-row" }],
    match: {
      findUnique: async () => ({
        id: "match-1",
        createdBy: "owner",
        engineVersion: "V2",
        isQuickMatch: false,
        type: "double",
        status: "ongoing",
        format: "group_only",
      }),
    },
    matchFixture: {
      findUnique: async () => ({ ...fixture }),
      updateMany: async (args: {
        where: { version: number };
        data: {
          status?: "COMPLETED" | "VOIDED";
          completedAt?: Date;
          version: { increment: number };
        };
      }) => {
        assert.equal(args.where.version, fixture.version);
        if (args.data.status !== undefined) fixture.status = args.data.status;
        fixture.version += args.data.version.increment;
        writes.push("fixture");
        return { count: 1 };
      },
      count: async (args: { where: { status?: unknown } }) =>
        args.where.status === undefined ? 2 : 1,
    },
    matchEntry: {
      findMany: async () => [
        { id: "entry-a", kind: "DOUBLES", status: "ACTIVE" },
        { id: "entry-b", kind: "DOUBLES", status: "DISQUALIFIED" },
      ],
    },
    matchEntryMember: {
      findMany: async () => [
        { entryId: "entry-a", rosterVersion: 1, userId: "winner-a", role: "player" },
        { entryId: "entry-a", rosterVersion: 1, userId: "winner-b", role: "player" },
        { entryId: "entry-b", rosterVersion: 1, userId: "loser-a", role: "player" },
        { entryId: "entry-b", rosterVersion: 1, userId: "loser-b", role: "player" },
      ],
    },
    matchFixtureLineupMember: {
      findMany: async () => [
        {
          side: "SIDE_A",
          position: 1,
          entryId: "entry-a",
          entryMember: { userId: "winner-a", rosterVersion: 1 },
        },
        {
          side: "SIDE_A",
          position: 2,
          entryId: "entry-a",
          entryMember: { userId: "winner-b", rosterVersion: 1 },
        },
        {
          side: "SIDE_B",
          position: 1,
          entryId: "entry-b",
          entryMember: { userId: "loser-a", rosterVersion: 1 },
        },
        {
          side: "SIDE_B",
          position: 2,
          entryId: "entry-b",
          entryMember: { userId: "loser-b", rosterVersion: 1 },
        },
      ],
    },
    user: {
      findUnique: async () => ({ id: "owner" }),
      findMany: async ({
        where,
      }: {
        where: { id: { in: string[] } };
      }) =>
        where.id.in.map((id) => ({
          id,
          role: "user",
          isBanned: id.startsWith("loser"),
          emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
          eloRating: 1200,
          points: 0,
          wins: 0,
          losses: 0,
          matchesPlayed: 0,
        })),
    },
    resultRevision: {
      findMany: async () => (confirmed === null ? [] : [confirmed]),
      findUnique: async () => confirmed,
      findFirst: async () => null,
      findUniqueOrThrow: async () => {
        if (confirmed === null) throw new Error("missing forfeit revision");
        return confirmed;
      },
      aggregate: async () => ({ _max: { revisionNumber: null } }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        confirmed = {
          id: "revision-forfeit",
          createdAt: new Date("2026-09-05T00:00:00.000Z"),
          updatedAt: new Date("2026-09-05T00:00:00.000Z"),
          supersedesRevisionId: null,
          ...data,
        };
        writes.push("revision");
        return confirmed;
      },
      updateMany: async ({
        data,
      }: {
        data: Record<string, unknown>;
      }) => {
        if (confirmed === null) return { count: 0 };
        confirmed = { ...confirmed, ...data };
        writes.push("revision-void");
        return { count: 1 };
      },
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        assert.equal(data.action, "v2_double_group_forfeit_confirm");
        writes.push("audit");
        return { id: "audit-forfeit" };
      },
    },
    settlementEvent: {
      findFirst: async () => null,
      findMany: async () => {
        throw new Error("a forfeit replay must not enter settlement");
      },
      create: async () => {
        throw new Error("a forfeit replay must not create settlement");
      },
    },
  } as unknown as ResultSettlementTransaction;
  const db = {
    $transaction: async <T>(
      operation: (tx: ResultSettlementTransaction) => Promise<T>,
    ) => operation(transaction),
  } as unknown as V2ResultDatabase;
  const service = createV2ResultApplicationService({ db });
  const command = {
    actor: { actorId: "owner", role: "user" as const },
    matchId: "match-1",
    fixtureId: fixture.id,
    expectedFixtureVersion: 2,
    requiredFixtureStage: "GROUP" as const,
    winnerEntryId: "entry-a",
    loserEntryId: "entry-b",
    reason: "  opponent disqualified  ",
  };

  const first = await service.confirmForfeit(command);
  const retry = await service.confirmForfeit(command);
  const replay = await service.confirmRevision({
    actor: command.actor,
    matchId: command.matchId,
    fixtureId: command.fixtureId,
    expectedFixtureVersion: 0,
    requiredFixtureStage: "GROUP",
    resultRevisionId: "revision-forfeit",
  });

  assert.equal(first.id, "revision-forfeit");
  assert.equal(retry.id, "revision-forfeit");
  assert.equal(replay.id, "revision-forfeit");
  assert.equal(first.resolutionKind, "FORFEIT");
  assert.deepEqual(first.score, { winnerScore: 1, loserScore: 0 });
  assert.equal(first.reason, "opponent disqualified");
  assert.deepEqual(writes, ["revision", "fixture", "audit"]);

  const voided = await service.voidRevision({
    actor: command.actor,
    matchId: command.matchId,
    fixtureId: command.fixtureId,
    expectedFixtureVersion: 3,
    requiredFixtureStage: "GROUP",
    resultRevisionId: "revision-forfeit",
    reason: "adjudication withdrawn",
  });
  assert.equal(voided.status, "VOIDED");
  assert.deepEqual(writes, [
    "revision",
    "fixture",
    "audit",
    "revision-void",
    "fixture",
  ]);
});

test("manager forfeit correction atomically swaps the winner and exact replay writes nothing", async () => {
  type RevisionState = {
    id: string;
    matchId: string;
    fixtureId: string;
    revisionNumber: number;
    status: "CONFIRMED" | "SUPERSEDED";
    resolutionKind: "FORFEIT";
    winnerEntryId: string;
    loserEntryId: string;
    score: { winnerScore: number; loserScore: number };
    reportedById: string;
    verifiedById: string;
    supersedesRevisionId: string | null;
    reason: string;
    resolvedAt: Date;
    createdAt: Date;
    updatedAt: Date;
  };
  const decidedAt = new Date("2026-09-05T08:00:00.000Z");
  const correctedAt = new Date("2026-09-05T09:00:00.000Z");
  let fixtureVersion = 5;
  let matchFormat: "group_only" | "group_then_knockout" =
    "group_then_knockout";
  let predecessor: RevisionState = {
    id: "forfeit-original",
    matchId: "match-1",
    fixtureId: "fixture-1",
    revisionNumber: 1,
    status: "CONFIRMED",
    resolutionKind: "FORFEIT",
    winnerEntryId: "entry-a",
    loserEntryId: "entry-b",
    score: { winnerScore: 1, loserScore: 0 },
    reportedById: "owner",
    verifiedById: "owner",
    supersedesRevisionId: null,
    reason: "original adjudication",
    resolvedAt: decidedAt,
    createdAt: decidedAt,
    updatedAt: decidedAt,
  };
  let successor: RevisionState | null = null;
  const audits: Array<{
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    details: Record<string, string>;
    createdAt: Date;
  }> = [];
  const writes: string[] = [];
  let settlementReads = 0;
  const transaction = {
    $queryRaw: async () => [{ id: "locked-row" }],
    match: {
      findUnique: async () => ({
        id: "match-1",
        createdBy: "owner",
        engineVersion: "V2",
        isQuickMatch: false,
        type: "single",
        status: "finished",
        format: matchFormat,
      }),
    },
    matchFixture: {
      findUnique: async () => ({
        id: "fixture-1",
        matchId: "match-1",
        stage: "GROUP",
      bestOf: 5,
        status: "COMPLETED",
        version: fixtureVersion,
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
        sideARosterVersion: 1,
        sideBRosterVersion: 1,
      }),
      updateMany: async () => {
        fixtureVersion += 1;
        writes.push("fixture");
        return { count: 1 };
      },
    },
    matchEntry: {
      findMany: async () => [
        { id: "entry-a", kind: "INDIVIDUAL", status: "ACTIVE" },
        { id: "entry-b", kind: "INDIVIDUAL", status: "ACTIVE" },
      ],
    },
    matchEntryMember: {
      findMany: async () => [
        {
          entryId: "entry-a",
          rosterVersion: 1,
          userId: "player-a",
          role: "player",
        },
        {
          entryId: "entry-b",
          rosterVersion: 1,
          userId: "player-b",
          role: "player",
        },
      ],
    },
    matchFixtureLineupMember: {
      findMany: async () => [
        {
          side: "SIDE_A",
          position: 1,
          entryId: "entry-a",
          entryMember: { userId: "player-a", rosterVersion: 1 },
        },
        {
          side: "SIDE_B",
          position: 1,
          entryId: "entry-b",
          entryMember: { userId: "player-b", rosterVersion: 1 },
        },
      ],
    },
    matchQualificationSnapshot: {
      findFirst: async () =>
        matchFormat === "group_then_knockout" ? { id: "snapshot-1" } : null,
    },
    user: {
      findUnique: async () => ({ id: "owner" }),
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({
          id,
          role: "user",
          isBanned: false,
          emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
          eloRating: 1200,
          points: 0,
          wins: 0,
          losses: 0,
          matchesPlayed: 0,
        })),
    },
    resultRevision: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === predecessor.id ? predecessor : successor,
      findMany: async ({
        where,
      }: {
        where: {
          supersedesRevisionId?: string;
          status?: { in: string[] };
        };
      }) => {
        if (where.supersedesRevisionId !== undefined) {
          return successor === null ? [] : [successor];
        }
        return [predecessor, successor]
          .filter((revision): revision is RevisionState => revision !== null)
          .filter((revision) => where.status?.in.includes(revision.status));
      },
      updateMany: async () => {
        predecessor = { ...predecessor, status: "SUPERSEDED" };
        writes.push("supersede");
        return { count: 1 };
      },
      aggregate: async () => ({
        _max: { revisionNumber: successor?.revisionNumber ?? 1 },
      }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        successor = {
          ...(data as Omit<RevisionState, "id" | "updatedAt">),
          id: "forfeit-correction",
          updatedAt: correctedAt,
        };
        writes.push("successor");
        return successor;
      },
    },
    settlementEvent: {
      findFirst: async () => {
        settlementReads += 1;
        return null;
      },
    },
    auditLog: {
      create: async ({ data }: { data: typeof audits[number] }) => {
        audits.push(data);
        writes.push("audit");
        return { id: "audit-correction", ...data };
      },
      findMany: async () => audits,
    },
  } as unknown as ResultSettlementTransaction;
  const db = {
    $transaction: async <T>(
      operation: (tx: ResultSettlementTransaction) => Promise<T>,
    ) => operation(transaction),
  } as unknown as V2ResultDatabase;
  const service = createV2ResultApplicationService({
    db,
    clock: () => correctedAt,
  });
  const command = {
    actor: { actorId: "owner", role: "user" as const },
    matchId: "match-1",
    fixtureId: "fixture-1",
    expectedFixtureVersion: 5,
    requiredFixtureStage: "GROUP" as const,
    resultRevisionId: predecessor.id,
    reason: "  wrong side was recorded  ",
  };

  await assert.rejects(
    () =>
      service.correctForfeit({
        ...command,
        actor: { actorId: "player-a", role: "user" },
      }),
    (error: unknown) =>
      error instanceof V2ResultApplicationError &&
      error.code === "FORBIDDEN",
  );
  assert.deepEqual(writes, []);
  await assert.rejects(
    () => service.correctForfeit(command),
    (error: unknown) =>
      error instanceof V2ResultApplicationError &&
      error.code === "INVALID_FIXTURE_STATE" &&
      error.details.qualificationSnapshotId === "snapshot-1",
  );
  assert.deepEqual(writes, []);
  matchFormat = "group_only";
  const first = await service.correctForfeit(command);
  const writesAfterFirst = [...writes];
  const replay = await service.correctForfeit(command);

  assert.equal(first.id, "forfeit-correction");
  assert.equal(replay.id, first.id);
  assert.equal(predecessor.status, "SUPERSEDED");
  assert.equal(first.status, "CONFIRMED");
  assert.equal(first.resolutionKind, "FORFEIT");
  assert.equal(first.revisionNumber, 2);
  assert.equal(first.winnerEntryId, "entry-b");
  assert.equal(first.loserEntryId, "entry-a");
  assert.deepEqual(first.score, { winnerScore: 1, loserScore: 0 });
  assert.equal(first.supersedesRevisionId, predecessor.id);
  assert.equal(first.reportedById, "owner");
  assert.equal(first.verifiedById, "owner");
  assert.equal(first.reason, "wrong side was recorded");
  assert.equal(first.createdAt.getTime(), correctedAt.getTime());
  assert.ok(first.resolvedAt);
  assert.equal(first.resolvedAt.getTime(), correctedAt.getTime());
  assert.equal(fixtureVersion, 6);
  assert.deepEqual(writesAfterFirst, [
    "supersede",
    "successor",
    "fixture",
    "audit",
  ]);
  assert.deepEqual(writes, writesAfterFirst);
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.actorId, "owner");
  assert.equal(audits[0]?.action, "v2_single_group_forfeit_correct");
  assert.equal(audits[0]?.entityType, "ResultRevision");
  assert.equal(audits[0]?.entityId, "forfeit-correction");
  assert.deepEqual(audits[0]?.details, {
    matchId: "match-1",
    fixtureId: "fixture-1",
    stage: "GROUP",
    supersedesRevisionId: "forfeit-original",
    previousWinnerEntryId: "entry-a",
    previousLoserEntryId: "entry-b",
    winnerEntryId: "entry-b",
    loserEntryId: "entry-a",
    reason: "wrong side was recorded",
    resolutionKind: "FORFEIT",
  });
  assert.equal(audits[0]?.createdAt.getTime(), correctedAt.getTime());
  assert.equal(settlementReads, 4);
});

test("played corrections accept only exact keep-winner or swap-winner shapes", () => {
  assert.doesNotThrow(() =>
    assertCorrectionSwapsParticipants(
      { winnerEntryId: "entry-a", loserEntryId: "entry-b" },
      { winnerEntryId: "entry-b", loserEntryId: "entry-a" },
    ),
  );
  assert.doesNotThrow(() =>
    assertCorrectionSwapsParticipants(
      { winnerEntryId: "entry-a", loserEntryId: "entry-b" },
      { winnerEntryId: "entry-a", loserEntryId: "entry-b" },
    ),
  );
  assert.throws(
    () =>
      assertCorrectionSwapsParticipants(
        { winnerEntryId: "entry-a", loserEntryId: "entry-b" },
        { winnerEntryId: "entry-a", loserEntryId: "entry-c" },
      ),
    (error) =>
      error instanceof V2ResultApplicationError &&
      error.code === "INVALID_CORRECTION",
  );
});

test("correction creation derives the exact swap from the locked confirmed revision", async () => {
  const created: Array<Record<string, unknown>> = [];
  const confirmedRevision = {
    id: "revision-confirmed",
    matchId: "match-1",
    fixtureId: "fixture-1",
    revisionNumber: 1,
    status: "CONFIRMED",
    resolutionKind: "PLAYED" as "PLAYED" | "FORFEIT",
    winnerEntryId: "entry-a",
    loserEntryId: "entry-b",
    score: { bestOf: 5, winnerScore: 3, loserScore: 1 },
    reportedById: "player-a",
    verifiedById: "owner",
    supersedesRevisionId: null,
    reason: null,
    resolvedAt: new Date("2026-09-04T07:00:00.000Z"),
    createdAt: new Date("2026-09-04T06:00:00.000Z"),
    updatedAt: new Date("2026-09-04T07:00:00.000Z"),
  } as const;
  let confirmedResolutionKind: "PLAYED" | "FORFEIT" = "PLAYED";
  const transaction = {
    $queryRaw: async () => [{ id: "locked-row" }],
    match: {
      findUnique: async () => ({
        id: "match-1",
        createdBy: "owner",
        engineVersion: "V2",
        isQuickMatch: false,
        type: "single",
        status: "ongoing",
        format: "group_only",
      }),
    },
    matchFixture: {
      findUnique: async () => ({
        id: "fixture-1",
        matchId: "match-1",
        stage: "GROUP",
      bestOf: 5,
        status: "COMPLETED",
        version: 4,
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
        sideARosterVersion: 1,
        sideBRosterVersion: 1,
      }),
      updateMany: async () => ({ count: 1 }),
    },
    resultRevision: {
      findUnique: async () => ({
        ...confirmedRevision,
        resolutionKind: confirmedResolutionKind,
      }),
      findFirst: async () => null,
      aggregate: async () => ({ _max: { revisionNumber: 1 } }),
      create: async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return { id: "revision-correction", ...data };
      },
    },
    matchEntry: {
      findMany: async () => [
        { id: "entry-a", kind: "INDIVIDUAL", status: "ACTIVE" },
        { id: "entry-b", kind: "INDIVIDUAL", status: "ACTIVE" },
      ],
    },
    matchEntryMember: {
      findMany: async () => [
        {
          entryId: "entry-a",
          rosterVersion: 1,
          userId: "player-a",
          role: "player",
        },
        {
          entryId: "entry-b",
          rosterVersion: 1,
          userId: "player-b",
          role: "player",
        },
      ],
    },
    matchFixtureLineupMember: {
      findMany: async () => [
        {
          side: "SIDE_A",
          position: 1,
          entryId: "entry-a",
          entryMember: { userId: "player-a", rosterVersion: 1 },
        },
        {
          side: "SIDE_B",
          position: 1,
          entryId: "entry-b",
          entryMember: { userId: "player-b", rosterVersion: 1 },
        },
      ],
    },
    user: {
      findUnique: async () => ({ id: "owner" }),
      findMany: async () =>
        ["owner", "player-a", "player-b"].map((id) => ({
          id,
          role: "user",
          isBanned: false,
          emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
          eloRating: 1200,
          points: 0,
          wins: 0,
          losses: 0,
          matchesPlayed: 0,
        })),
    },
  } as unknown as ResultSettlementTransaction;
  const db = {
    $transaction: async <T>(
      operation: (tx: ResultSettlementTransaction) => Promise<T>,
    ) => operation(transaction),
  } as unknown as V2ResultDatabase;
  const service = createV2ResultApplicationService({ db });

  await service.submitCorrection({
    actor: { actorId: "owner", role: "user" },
    matchId: "match-1",
    fixtureId: "fixture-1",
    expectedFixtureVersion: 4,
    requiredFixtureStage: "GROUP",
    resultRevisionId: "revision-confirmed",
    score: { bestOf: 5, winnerScore: 3, loserScore: 2 },
  });

  assert.equal(created.length, 1);
  const { createdAt, ...createdData } = created[0] ?? {};
  assert.equal(createdAt instanceof Date, true);
  assert.deepEqual(createdData, {
    matchId: "match-1",
    fixtureId: "fixture-1",
    revisionNumber: 2,
    status: "PENDING",
    winnerEntryId: "entry-b",
    loserEntryId: "entry-a",
    score: { bestOf: 5, winnerScore: 3, loserScore: 2 },
    reportedById: "owner",
    supersedesRevisionId: "revision-confirmed",
    reason: undefined,
  });

  await service.submitCorrection({
    actor: { actorId: "owner", role: "user" },
    matchId: "match-1",
    fixtureId: "fixture-1",
    expectedFixtureVersion: 4,
    requiredFixtureStage: "GROUP",
    resultRevisionId: "revision-confirmed",
    correctionMode: "KEEP_WINNER",
    score: { bestOf: 5, winnerScore: 3, loserScore: 2 },
  });
  assert.equal(created.length, 2);
  const { createdAt: keptWinnerCreatedAt, ...keptWinnerCreatedData } =
    created[1]!;
  assert.equal(keptWinnerCreatedAt instanceof Date, true);
  assert.deepEqual(
    keptWinnerCreatedData,
    {
      matchId: "match-1",
      fixtureId: "fixture-1",
      revisionNumber: 2,
      status: "PENDING",
      winnerEntryId: "entry-a",
      loserEntryId: "entry-b",
      score: { bestOf: 5, winnerScore: 3, loserScore: 2 },
      reportedById: "owner",
      supersedesRevisionId: "revision-confirmed",
      reason: undefined,
    },
  );

  created.length = 0;
  confirmedResolutionKind = "FORFEIT";
  await assert.rejects(
    () =>
      service.submitCorrection({
        actor: { actorId: "owner", role: "user" },
        matchId: "match-1",
        fixtureId: "fixture-1",
        expectedFixtureVersion: 4,
        requiredFixtureStage: "GROUP",
        resultRevisionId: "revision-confirmed",
        score: { bestOf: 5, winnerScore: 3, loserScore: 2 },
      }),
    (error: unknown) =>
      error instanceof V2ResultApplicationError &&
      error.code === "INVALID_CORRECTION" &&
      error.details.resolutionKind === "FORFEIT",
  );
  assert.equal(created.length, 0);
});

test("an initial result cannot be submitted after either entry withdraws", async () => {
  const inactiveRoster = roster("INDIVIDUAL");
  const withdrawnRoster: FrozenFixtureRoster = {
    ...inactiveRoster,
    sideA: { ...inactiveRoster.sideA, status: "WITHDRAWN" },
  };
  assert.throws(
    () => assertInitialResultEntriesActive(withdrawnRoster),
    (error: unknown) =>
      error instanceof V2ResultApplicationError &&
      error.code === "INVALID_FIXTURE_PARTICIPANTS",
  );

  const service = resultServiceWithEntryStatuses({
    sideAStatus: "WITHDRAWN",
    sideBStatus: "ACTIVE",
    fixtureVersion: 0,
  });
  await assert.rejects(
    () =>
      service.submitRevision({
        actor: { actorId: "player-a", role: "user" },
        matchId: "match-1",
        fixtureId: "fixture-1",
        expectedFixtureVersion: 0,
        winnerEntryId: "entry-a",
        loserEntryId: "entry-b",
        score: { bestOf: 5, winnerScore: 3, loserScore: 1 },
      }),
    (error: unknown) =>
      error instanceof V2ResultApplicationError &&
      error.code === "INVALID_FIXTURE_PARTICIPANTS" &&
      Array.isArray(error.details.inactiveEntries),
  );
});

test("pending initial confirmation rechecks entry status after submission", async () => {
  const service = resultServiceWithEntryStatuses({
    sideAStatus: "ACTIVE",
    sideBStatus: "DISQUALIFIED",
    fixtureVersion: 1,
  });

  await assert.rejects(
    () =>
      service.confirmRevision({
        actor: { actorId: "player-b", role: "user" },
        matchId: "match-1",
        fixtureId: "fixture-1",
        expectedFixtureVersion: 1,
        resultRevisionId: "revision-1",
      }),
    (error: unknown) =>
      error instanceof V2ResultApplicationError &&
      error.code === "INVALID_FIXTURE_PARTICIPANTS" &&
      Array.isArray(error.details.inactiveEntries),
  );
});

test("knockout result writes require the explicit server-owned capability", () => {
  assert.doesNotThrow(() => assertV2ResultFixtureStageSupported("GROUP"));
  assert.doesNotThrow(() => assertV2ResultFixtureStageSupported("FREE_PLAY"));
  assert.throws(
    () => assertV2ResultFixtureStageSupported("KNOCKOUT"),
    (error) =>
      error instanceof V2ResultApplicationError &&
      error.code === "INVALID_FIXTURE_STATE",
  );
  assert.doesNotThrow(() =>
    assertV2ResultFixtureStageSupported("KNOCKOUT", "KNOCKOUT"),
  );
});

test("the result clock is sampled only after Match and Fixture locks", async () => {
  const sequence: string[] = [];
  const transaction = {
    $queryRaw: async () => {
      sequence.push(sequence.length === 0 ? "match-lock" : "fixture-lock");
      return [{ id: "locked-row" }];
    },
    match: {
      findUnique: async () => ({
        id: "match-1",
        createdBy: "owner",
        engineVersion: "V2",
        isQuickMatch: false,
        type: "single",
        status: "ongoing",
        format: "group_only",
      }),
    },
    matchFixture: {
      findUnique: async () => ({
        id: "fixture-1",
        matchId: "match-1",
        stage: "FREE_PLAY",
        bestOf: 5,
        status: "READY",
        version: 0,
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
        sideARosterVersion: 1,
        sideBRosterVersion: 1,
      }),
    },
  } as unknown as ResultSettlementTransaction;
  const db = {
    $transaction: async <T>(
      operation: (tx: ResultSettlementTransaction) => Promise<T>,
    ) => operation(transaction),
  } as unknown as V2ResultDatabase;
  const service = createV2ResultApplicationService({
    db,
    clock: () => {
      sequence.push("clock");
      return new Date("2026-09-05T12:00:00.000Z");
    },
  });

  await assert.rejects(() =>
    service.submitRevision({
      actor: { actorId: "owner", role: "user" },
      matchId: "match-1",
      fixtureId: "fixture-1",
      expectedFixtureVersion: 0,
      winnerEntryId: "not-a-side",
      loserEntryId: "entry-b",
      score: { bestOf: 5, winnerScore: 3, loserScore: 0 },
    }),
  );
  assert.deepEqual(sequence, ["match-lock", "fixture-lock", "clock"]);
});

test("KNOCKOUT revisions reject VOID even with the explicit stage capability", async () => {
  let revisionWrites = 0;
  let fixtureWrites = 0;
  const transaction = {
    $queryRaw: async () => [{ id: "locked-row" }],
    match: {
      findUnique: async () => ({
        id: "match-1",
        createdBy: "owner",
        engineVersion: "V2",
        isQuickMatch: false,
        type: "single",
        status: "ongoing",
        format: "group_then_knockout",
      }),
    },
    matchFixture: {
      findUnique: async () => ({
        id: "fixture-ko",
        matchId: "match-1",
        stage: "KNOCKOUT",
        status: "READY",
        version: 2,
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
        sideARosterVersion: 1,
        sideBRosterVersion: 1,
      }),
      updateMany: async () => {
        fixtureWrites += 1;
        return { count: 1 };
      },
    },
    resultRevision: {
      findUnique: async () => ({
        id: "revision-ko",
        matchId: "match-1",
        fixtureId: "fixture-ko",
        status: "PENDING",
        winnerEntryId: "entry-a",
        loserEntryId: "entry-b",
        supersedesRevisionId: null,
      }),
      updateMany: async () => {
        revisionWrites += 1;
        return { count: 1 };
      },
    },
    user: {
      findUnique: async () => ({ id: "owner" }),
      findMany: async () => [
        {
          id: "owner",
          role: "user",
          isBanned: false,
          emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
          eloRating: 1_200,
          points: 0,
          wins: 0,
          losses: 0,
          matchesPlayed: 0,
        },
      ],
    },
  } as unknown as ResultSettlementTransaction;
  const db = {
    $transaction: async <T>(
      operation: (tx: ResultSettlementTransaction) => Promise<T>,
    ) => operation(transaction),
  } as unknown as V2ResultDatabase;
  const service = createV2ResultApplicationService({ db });

  await assert.rejects(
    () =>
      service.voidRevision({
        actor: { actorId: "owner", role: "user" },
        matchId: "match-1",
        fixtureId: "fixture-ko",
        expectedFixtureVersion: 2,
        requiredFixtureStage: "KNOCKOUT",
        resultRevisionId: "revision-ko",
      }),
    (error: unknown) =>
      error instanceof V2ResultApplicationError &&
      error.code === "INVALID_FIXTURE_STATE",
  );
  assert.equal(revisionWrites, 0);
  assert.equal(fixtureWrites, 0);
});

test("a confirmed active group_then pairing cannot be voided before qualification", async () => {
  let revisionWrites = 0;
  let fixtureWrites = 0;
  const transaction = {
    $queryRaw: async () => [{ id: "locked-row" }],
    match: {
      findUnique: async () => ({
        id: "match-1",
        createdBy: "owner",
        engineVersion: "V2",
        isQuickMatch: false,
        type: "single",
        status: "ongoing",
        format: "group_then_knockout",
      }),
    },
    matchFixture: {
      findUnique: async () => ({
        id: "fixture-group",
        matchId: "match-1",
        stage: "GROUP",
      bestOf: 5,
        status: "COMPLETED",
        version: 2,
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
        sideARosterVersion: 1,
        sideBRosterVersion: 1,
      }),
      updateMany: async () => {
        fixtureWrites += 1;
        return { count: 1 };
      },
    },
    resultRevision: {
      findUnique: async () => ({
        id: "revision-group",
        matchId: "match-1",
        fixtureId: "fixture-group",
        status: "CONFIRMED",
        resolutionKind: "PLAYED",
        winnerEntryId: "entry-a",
        loserEntryId: "entry-b",
        supersedesRevisionId: null,
      }),
      updateMany: async () => {
        revisionWrites += 1;
        return { count: 1 };
      },
    },
    matchQualificationSnapshot: { findFirst: async () => null },
    matchEntry: {
      findMany: async () => [
        { id: "entry-a", status: "ACTIVE" },
        { id: "entry-b", status: "ACTIVE" },
      ],
    },
    user: {
      findUnique: async () => ({ id: "owner" }),
      findMany: async () => [
        {
          id: "owner",
          role: "user",
          isBanned: false,
          emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
          eloRating: 1_200,
          points: 0,
          wins: 0,
          losses: 0,
          matchesPlayed: 0,
        },
      ],
    },
  } as unknown as ResultSettlementTransaction;
  const db = {
    $transaction: async <T>(
      operation: (tx: ResultSettlementTransaction) => Promise<T>,
    ) => operation(transaction),
  } as unknown as V2ResultDatabase;
  const service = createV2ResultApplicationService({ db });

  await assert.rejects(
    () =>
      service.voidRevision({
        actor: { actorId: "owner", role: "user" },
        matchId: "match-1",
        fixtureId: "fixture-group",
        expectedFixtureVersion: 2,
        requiredFixtureStage: "GROUP",
        resultRevisionId: "revision-group",
      }),
    (error: unknown) =>
      error instanceof V2ResultApplicationError &&
      error.code === "INVALID_FIXTURE_STATE",
  );
  assert.equal(revisionWrites, 0);
  assert.equal(fixtureWrites, 0);
});

test("qualification snapshot freezes every GROUP result mutation", async () => {
  let entryReads = 0;
  const transaction = {
    $queryRaw: async () => [{ id: "locked-row" }],
    match: {
      findUnique: async () => ({
        id: "match-1",
        createdBy: "owner",
        engineVersion: "V2",
        isQuickMatch: false,
        type: "single",
        status: "ongoing",
        format: "group_then_knockout",
      }),
    },
    matchFixture: {
      findUnique: async () => ({
        id: "fixture-1",
        matchId: "match-1",
        stage: "GROUP",
      bestOf: 5,
        status: "READY",
        version: 0,
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
        sideARosterVersion: 1,
        sideBRosterVersion: 1,
      }),
    },
    matchQualificationSnapshot: {
      findFirst: async () => ({ id: "snapshot-1" }),
    },
    matchEntry: {
      findMany: async () => {
        entryReads += 1;
        return [];
      },
    },
  } as unknown as ResultSettlementTransaction;
  const db = {
    $transaction: async <T>(
      operation: (tx: ResultSettlementTransaction) => Promise<T>,
    ) => operation(transaction),
  } as unknown as V2ResultDatabase;
  const service = createV2ResultApplicationService({ db });

  await assert.rejects(
    () =>
      service.submitRevision({
        actor: { actorId: "owner", role: "user" },
        matchId: "match-1",
        fixtureId: "fixture-1",
        expectedFixtureVersion: 0,
        requiredFixtureStage: "GROUP",
        winnerEntryId: "entry-a",
        loserEntryId: "entry-b",
        score: { bestOf: 5, winnerScore: 3, loserScore: 1 },
      }),
    (error: unknown) =>
      error instanceof V2ResultApplicationError &&
      error.code === "INVALID_FIXTURE_STATE" &&
      error.details.qualificationSnapshotId === "snapshot-1",
  );
  assert.equal(entryReads, 0);
});

test("a server capability can restrict an otherwise supported result command to GROUP", async () => {
  const service = resultServiceWithEntryStatuses({
    sideAStatus: "ACTIVE",
    sideBStatus: "ACTIVE",
    fixtureVersion: 0,
  });

  await assert.rejects(
    () =>
      service.submitRevision({
        actor: { actorId: "player-a", role: "user" },
        matchId: "match-1",
        fixtureId: "fixture-1",
        expectedFixtureVersion: 0,
        requiredFixtureStage: "GROUP",
        winnerEntryId: "entry-a",
        loserEntryId: "entry-b",
        score: { bestOf: 5, winnerScore: 3, loserScore: 1 },
      }),
    (error: unknown) =>
      error instanceof V2ResultApplicationError &&
      error.code === "INVALID_FIXTURE_STATE" &&
      error.details.stage === "FREE_PLAY",
  );
});

test("result commands reject a quick match even if its engine flag is V2", async () => {
  const transaction = {
    $queryRaw: async () => [{ id: "locked-row" }],
    match: {
      findUnique: async () => ({
        id: "match-1",
        createdBy: "owner",
        engineVersion: "V2",
        isQuickMatch: true,
        type: "single",
      }),
    },
    matchFixture: {
      findUnique: async () => ({
        id: "fixture-1",
        matchId: "match-1",
        stage: "FREE_PLAY",
        bestOf: 5,
        status: "READY",
        version: 0,
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
        sideARosterVersion: 1,
        sideBRosterVersion: 1,
      }),
    },
  } as unknown as ResultSettlementTransaction;
  const db = {
    $transaction: async <T>(
      operation: (tx: ResultSettlementTransaction) => Promise<T>,
    ) => operation(transaction),
  } as unknown as V2ResultDatabase;
  const service = createV2ResultApplicationService({ db });

  await assert.rejects(
    () =>
      service.submitRevision({
        actor: { actorId: "player-a", role: "user" },
        matchId: "match-1",
        fixtureId: "fixture-1",
        expectedFixtureVersion: 0,
        winnerEntryId: "entry-a",
        loserEntryId: "entry-b",
        score: { bestOf: 5, winnerScore: 3, loserScore: 1 },
      }),
    (error: unknown) =>
      error instanceof V2ResultApplicationError &&
      error.code === "ENGINE_MISMATCH" &&
      error.details.isQuickMatch === true,
  );
});

test("result commands recheck actor email verification inside the transaction", async () => {
  const transaction = {
    $queryRaw: async () => [{ id: "locked-row" }],
    match: {
      findUnique: async () => ({
        id: "match-1",
        createdBy: "owner",
        engineVersion: "V2",
        isQuickMatch: false,
        type: "single",
      }),
    },
    matchFixture: {
      findUnique: async () => ({
        id: "fixture-1",
        matchId: "match-1",
        stage: "FREE_PLAY",
        bestOf: 5,
        status: "READY",
        version: 0,
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
        sideARosterVersion: 1,
        sideBRosterVersion: 1,
      }),
    },
    matchEntry: {
      findMany: async () => [
        { id: "entry-a", kind: "INDIVIDUAL", status: "ACTIVE" },
        { id: "entry-b", kind: "INDIVIDUAL", status: "ACTIVE" },
      ],
    },
    matchEntryMember: {
      findMany: async () => [
        {
          entryId: "entry-a",
          rosterVersion: 1,
          userId: "player-a",
          role: "player",
        },
        {
          entryId: "entry-b",
          rosterVersion: 1,
          userId: "player-b",
          role: "player",
        },
      ],
    },
    matchFixtureLineupMember: {
      findMany: async () => [
        {
          side: "SIDE_A",
          position: 1,
          entryId: "entry-a",
          entryMember: { userId: "player-a", rosterVersion: 1 },
        },
        {
          side: "SIDE_B",
          position: 1,
          entryId: "entry-b",
          entryMember: { userId: "player-b", rosterVersion: 1 },
        },
      ],
    },
    user: {
      findUnique: async () => ({ id: "player-a" }),
      findMany: async () => [
        {
          id: "player-a",
          role: "user",
          isBanned: false,
          emailVerifiedAt: null,
          eloRating: 1200,
          points: 0,
          wins: 0,
          losses: 0,
          matchesPlayed: 0,
        },
        {
          id: "player-b",
          role: "user",
          isBanned: false,
          emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
          eloRating: 1200,
          points: 0,
          wins: 0,
          losses: 0,
          matchesPlayed: 0,
        },
      ],
    },
  } as unknown as ResultSettlementTransaction;
  const db = {
    $transaction: async <T>(
      operation: (tx: ResultSettlementTransaction) => Promise<T>,
    ) => operation(transaction),
  } as unknown as V2ResultDatabase;
  const service = createV2ResultApplicationService({ db });

  await assert.rejects(
    () =>
      service.submitRevision({
        actor: { actorId: "player-a", role: "user" },
        matchId: "match-1",
        fixtureId: "fixture-1",
        expectedFixtureVersion: 0,
        winnerEntryId: "entry-a",
        loserEntryId: "entry-b",
        score: { bestOf: 5, winnerScore: 3, loserScore: 1 },
      }),
    (error: unknown) =>
      error instanceof V2ResultApplicationError &&
      error.code === "ACTOR_NOT_ACTIVE",
  );
});

test("Prisma write races and constraint failures map to stable application errors", () => {
  const concurrent = mapV2ResultPersistenceError(
    new Prisma.PrismaClientKnownRequestError("write conflict", {
      code: "P2034",
      clientVersion: "test",
    }),
  );
  const unique = mapV2ResultPersistenceError(
    new Prisma.PrismaClientKnownRequestError("unique conflict", {
      code: "P2002",
      clientVersion: "test",
    }),
  );
  const rawSerializableConflict = mapV2ResultPersistenceError(
    new Prisma.PrismaClientKnownRequestError("raw query conflict", {
      code: "P2010",
      clientVersion: "test",
      meta: { code: "40001" },
    }),
  );
  assert.equal(
    concurrent instanceof V2ResultApplicationError && concurrent.code,
    "CONCURRENT_WRITE_CONFLICT",
  );
  assert.equal(
    unique instanceof V2ResultApplicationError && unique.code,
    "PERSISTENCE_CONFLICT",
  );
  assert.equal(
    rawSerializableConflict instanceof V2ResultApplicationError &&
      rawSerializableConflict.code,
    "CONCURRENT_WRITE_CONFLICT",
  );
});
