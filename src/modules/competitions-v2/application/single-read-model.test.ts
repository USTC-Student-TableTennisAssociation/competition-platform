import assert from "node:assert/strict";
import test from "node:test";

import {
  V2SingleReadModelIntegrityError,
  getSingleCompetitionReadModel,
  type V2SingleReadDatabase,
} from "../read-model/single-match";

const NOW = new Date("2026-09-04T08:00:00.000Z");

function profile(id: string, nickname: string) {
  return {
    id,
    nickname,
    avatarUrl: `https://example.test/${id}.png`,
    eloRating: id === "user-a" ? 1310 : 1260,
    points: id === "user-a" ? 8 : 5,
    isBanned: false,
  };
}

function individualEntry(input: {
  id: string;
  userId: string;
  snapshotName: string;
  currentNickname: string;
  seed: number;
}) {
  const user = profile(input.userId, input.currentNickname);
  return {
    id: input.id,
    kind: "INDIVIDUAL" as const,
    status: "ACTIVE" as const,
    sourceKey: `individual:${input.userId}`,
    sourceUserId: input.userId,
    displayNameSnapshot: input.snapshotName,
    seed: input.seed,
    version: 3,
    withdrawnAt: null,
    disqualifiedAt: null,
    archivedAt: null,
    metadata: null,
    createdAt: NOW,
    updatedAt: NOW,
    sourceUser: user,
    members: [
      {
        id: `member-${input.id}`,
        userId: input.userId,
        displayNameSnapshot: input.snapshotName,
        role: "player" as const,
        status: "ACTIVE" as const,
        slot: 1,
        rosterVersion: 1,
        effectiveFrom: NOW,
        effectiveUntil: null,
        endReason: null,
        user,
      },
    ],
  };
}

function revision(input: {
  id: string;
  revisionNumber: number;
  status:
    | "PENDING"
    | "CONFIRMED"
    | "REJECTED"
    | "VOIDED"
    | "SUPERSEDED";
  winnerEntryId: string;
  loserEntryId: string;
  supersedesRevisionId?: string | null;
}) {
  const resolved = input.status === "PENDING" ? null : NOW;
  return {
    id: input.id,
    revisionNumber: input.revisionNumber,
    status: input.status,
    resolutionKind: "PLAYED" as const,
    winnerEntryId: input.winnerEntryId,
    loserEntryId: input.loserEntryId,
    score: { bestOf: 5, winnerScore: 3, loserScore: 1, text: "3:1" },
    reportedById: "user-a",
    verifiedById: input.status === "CONFIRMED" ? "admin-1" : null,
    supersedesRevisionId: input.supersedesRevisionId ?? null,
    reason: null,
    resolvedAt: resolved,
    createdAt: NOW,
    updatedAt: NOW,
    reportedBy: {
      id: "user-a",
      nickname: "甲现在的昵称",
      avatarUrl: null,
    },
    verifiedBy:
      input.status === "CONFIRMED"
        ? { id: "admin-1", nickname: "管理员", avatarUrl: null }
        : null,
  };
}

function fixture(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    id: "fixture-group-a-1",
    fixtureKey: "group:0001:pair:0001-0002",
    stage: "GROUP" as const,
    status: "COMPLETED" as const,
    groupKey: "group:0001",
    roundNumber: null,
    position: null,
    sideAEntryId: "entry-a",
    sideBEntryId: "entry-b",
    sideARosterVersion: 1,
    sideBRosterVersion: 1,
    scheduledAt: null,
    startedAt: NOW,
    completedAt: NOW,
    version: 7,
    metadata: null,
    createdAt: NOW,
    updatedAt: NOW,
    incomingDependencies: [],
    resultRevisions: [],
    ...overrides,
  };
}

function matchSource(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "match-1",
    title: "校内单打赛",
    description: "测试比赛",
    dateTime: NOW,
    location: "西区体育馆",
    isQuickMatch: false,
    type: "single" as const,
    status: "ongoing" as const,
    engineVersion: "V2" as const,
    format: "group_then_knockout" as const,
    maxParticipants: 32,
    createdBy: "admin-1",
    rule: null,
    registrationDeadline: new Date("2026-09-03T08:00:00.000Z"),
    groupingGeneratedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    creator: { id: "admin-1", nickname: "管理员", avatarUrl: null },
    entries: [],
    fixtures: [],
    ...overrides,
  };
}

function databaseReturning(
  source: unknown,
  inspect?: (args: unknown) => void,
  inspectTransaction?: (options: unknown) => void,
) {
  const groupingSource =
    source && typeof source === "object"
      ? {
          ...(source as Record<string, unknown>),
          teamRegistrationDeadline: null,
          teamMinMembers: null,
          teamMaxMembers: null,
          groupingGeneratedAt: null,
          entries: [],
          groupingResult: null,
          matchGroups: [],
          fixtures: [],
        }
      : source;
  // The fake transaction exposes the page aggregate and the shared grouping
  // projection, but no mutation/reconciliation surface.
  const transactionClient = {
    match: {
      findUnique: async (args: unknown) => {
        const selection = (args as {
          select?: Readonly<Record<string, unknown>>;
        }).select;
        if (selection && "groupingResult" in selection) return groupingSource;
        inspect?.(args);
        return source;
      },
    },
    matchFixtureDependency: { findMany: async () => [] },
  };
  return {
    $transaction: async (
      operation: (tx: typeof transactionClient) => Promise<unknown>,
      options: unknown,
    ) => {
      inspectTransaction?.(options);
      return operation(transactionClient);
    },
  } as unknown as V2SingleReadDatabase;
}

test("the reader returns every discriminator from one read-only RepeatableRead snapshot", async () => {
  let readCount = 0;
  let transactionCount = 0;
  let selectedStatuses: unknown;
  let transactionOptions: unknown;
  const legacy = await getSingleCompetitionReadModel(
    databaseReturning(
      matchSource({ engineVersion: "LEGACY" }),
      (rawArgs) => {
        readCount += 1;
        const args = rawArgs as {
          select: {
            fixtures: {
              select: {
                resultRevisions: { where: { status: { in: unknown } } };
              };
            };
          };
        };
        selectedStatuses =
          args.select.fixtures.select.resultRevisions.where.status.in;
      },
      (options) => {
        transactionCount += 1;
        transactionOptions = options;
      },
    ),
    "match-1",
  );
  assert.equal(legacy.kind, "LEGACY_MATCH");
  assert.equal(readCount, 1);
  assert.equal(transactionCount, 1);
  assert.deepEqual(transactionOptions, { isolationLevel: "RepeatableRead" });
  assert.deepEqual(selectedStatuses, ["PENDING", "CONFIRMED"]);

  let missingReads = 0;
  let missingTransactions = 0;
  const missing = await getSingleCompetitionReadModel(
    databaseReturning(
      null,
      () => {
        missingReads += 1;
      },
      (options) => {
        missingTransactions += 1;
        assert.deepEqual(options, { isolationLevel: "RepeatableRead" });
      },
    ),
    "missing-match",
  );
  assert.deepEqual(missing, {
    kind: "MATCH_NOT_FOUND",
    matchId: "missing-match",
  });
  assert.equal(missingReads, 1);
  assert.equal(missingTransactions, 1);

  const quick = await getSingleCompetitionReadModel(
    databaseReturning(matchSource({ isQuickMatch: true })),
    "match-1",
  );
  assert.equal(quick.kind, "UNSUPPORTED_V2_MATCH");
  if (quick.kind === "UNSUPPORTED_V2_MATCH") {
    assert.equal(quick.reason, "QUICK_MATCH");
  }

  const doubles = await getSingleCompetitionReadModel(
    databaseReturning(matchSource({ type: "double" })),
    "match-1",
  );
  assert.equal(doubles.kind, "UNSUPPORTED_V2_MATCH");
  if (doubles.kind === "UNSUPPORTED_V2_MATCH") {
    assert.equal(doubles.reason, "NON_SINGLE_MATCH");
  }
});

test("a SINGLE projection uses Entry/Fixture IDs and the frozen side snapshots", async () => {
  const entryA = individualEntry({
    id: "entry-a",
    userId: "user-a",
    snapshotName: "甲报名时昵称",
    currentNickname: "甲现在的昵称",
    seed: 2,
  });
  const entryB = individualEntry({
    id: "entry-b",
    userId: "user-b",
    snapshotName: "乙报名时昵称",
    currentNickname: "乙现在的昵称",
    seed: 1,
  });
  const confirmed = revision({
    id: "revision-confirmed",
    revisionNumber: 1,
    status: "CONFIRMED",
    winnerEntryId: "entry-a",
    loserEntryId: "entry-b",
  });
  const pendingCorrection = revision({
    id: "revision-correction",
    revisionNumber: 2,
    status: "PENDING",
    winnerEntryId: "entry-b",
    loserEntryId: "entry-a",
    supersedesRevisionId: confirmed.id,
  });
  // This deliberately violates the Prisma where clause in the mock. The
  // resolver still must not mistake a numerically newer terminal revision for
  // the current result.
  const historicalRejected = revision({
    id: "revision-rejected-history",
    revisionNumber: 99,
    status: "REJECTED",
    winnerEntryId: "entry-a",
    loserEntryId: "entry-b",
  });
  const groupFixture = fixture({
    metadata: {
      tableLabels: ["untrusted-root-field"],
      v2Display: { schemaVersion: 1, tableLabels: ["1 号台"] },
    },
    resultRevisions: [historicalRejected, pendingCorrection, confirmed],
  });
  const knockoutFixture = fixture({
    id: "fixture-knockout-1",
    fixtureKey: "knockout:1:1",
    stage: "KNOCKOUT",
    status: "SCHEDULED",
    groupKey: null,
    roundNumber: 1,
    position: 1,
    sideAEntryId: null,
    sideBEntryId: null,
    sideARosterVersion: null,
    sideBRosterVersion: null,
    startedAt: null,
    completedAt: null,
    version: 0,
    incomingDependencies: [
      {
        id: "dependency-1",
        sourceFixtureId: "fixture-group-a-1",
        sourceOutcome: "WINNER",
        targetSide: "SIDE_A",
      },
    ],
    resultRevisions: [],
  });
  const model = await getSingleCompetitionReadModel(
    databaseReturning(
      matchSource({
        entries: [entryA, entryB],
        fixtures: [knockoutFixture, groupFixture],
      }),
    ),
    "match-1",
  );

  assert.equal(model.kind, "SINGLE_V2_MATCH");
  if (model.kind !== "SINGLE_V2_MATCH") return;
  assert.deepEqual(
    model.entries.map((entry) => entry.entryId),
    ["entry-b", "entry-a"],
  );
  assert.deepEqual(model.stageFixtureIds, {
    group: ["fixture-group-a-1"],
    knockout: ["fixture-knockout-1"],
    freePlay: [],
  });
  assert.deepEqual(
    model.groups[0].participants.map((participant) => participant.entryId),
    ["entry-b", "entry-a"],
  );

  const projectedFixture = model.fixtures[0];
  assert.equal(projectedFixture.stage, "GROUP");
  if (projectedFixture.stage !== "GROUP") return;
  assert.equal(projectedFixture.fixtureId, "fixture-group-a-1");
  assert.equal(projectedFixture.fixtureVersion, 7);
  assert.deepEqual(projectedFixture.tableLabels, ["1 号台"]);
  assert.deepEqual(model.groups[0].tableLabels, ["1 号台"]);
  assert.equal(projectedFixture.sideA?.entryId, "entry-a");
  assert.equal(
    projectedFixture.sideA?.player.displayNameSnapshot,
    "甲报名时昵称",
  );
  assert.equal(
    projectedFixture.sideA?.player.profile.nickname,
    "甲现在的昵称",
  );
  assert.equal(projectedFixture.currentRevisionId, "revision-correction");
  assert.equal(projectedFixture.revisionVersion, 2);
  assert.equal(projectedFixture.activeResult.state, "CORRECTION_PENDING");
  assert.equal(
    projectedFixture.activeResult.authoritativeConfirmedRevisionId,
    "revision-confirmed",
  );
  assert.equal(
    projectedFixture.activeResult.confirmedRevision?.winnerEntryId,
    "entry-a",
  );
  assert.equal(
    projectedFixture.activeResult.pendingRevision?.winnerEntryId,
    "entry-b",
  );

  const projectedKnockout = model.fixtures[1];
  assert.equal(projectedKnockout.stage, "KNOCKOUT");
  assert.deepEqual(projectedKnockout.feeders.sideA, {
    dependencyId: "dependency-1",
    sourceFixtureId: "fixture-group-a-1",
    sourceOutcome: "WINNER",
  });
  assert.equal(projectedKnockout.activeResult.state, "NONE");
});

test("a confirmed FORFEIT correction remains the authoritative active result", async () => {
  const entryA = individualEntry({
    id: "entry-a",
    userId: "user-a",
    snapshotName: "甲",
    currentNickname: "甲",
    seed: 1,
  });
  const entryB = individualEntry({
    id: "entry-b",
    userId: "user-b",
    snapshotName: "乙",
    currentNickname: "乙",
    seed: 2,
  });
  const correctedForfeit = {
    ...revision({
      id: "forfeit-correction",
      revisionNumber: 2,
      status: "CONFIRMED",
      winnerEntryId: "entry-b",
      loserEntryId: "entry-a",
      supersedesRevisionId: "forfeit-original",
    }),
    resolutionKind: "FORFEIT" as const,
    score: { winnerScore: 1, loserScore: 0 },
    reason: "更正弃权胜方",
  };
  const model = await getSingleCompetitionReadModel(
    databaseReturning(
      matchSource({
        entries: [entryA, entryB],
        fixtures: [fixture({ resultRevisions: [correctedForfeit] })],
      }),
    ),
    "match-1",
  );

  assert.equal(model.kind, "SINGLE_V2_MATCH");
  if (model.kind !== "SINGLE_V2_MATCH") return;
  const projectedFixture = model.fixtures[0];
  assert.equal(projectedFixture.activeResult.state, "CONFIRMED");
  assert.equal(projectedFixture.currentRevisionId, "forfeit-correction");
  assert.equal(
    projectedFixture.activeResult.confirmedRevision?.resolutionKind,
    "FORFEIT",
  );
  assert.equal(
    projectedFixture.activeResult.confirmedRevision?.supersedesRevisionId,
    "forfeit-original",
  );
  assert.equal(
    projectedFixture.activeResult.confirmedRevision?.winnerEntryId,
    "entry-b",
  );
});

test("ambiguous active revisions fail closed instead of selecting by date", async () => {
  const entryA = individualEntry({
    id: "entry-a",
    userId: "user-a",
    snapshotName: "甲",
    currentNickname: "甲",
    seed: 1,
  });
  const entryB = individualEntry({
    id: "entry-b",
    userId: "user-b",
    snapshotName: "乙",
    currentNickname: "乙",
    seed: 2,
  });
  const duplicatePending = fixture({
    status: "READY",
    completedAt: null,
    resultRevisions: [
      revision({
        id: "pending-1",
        revisionNumber: 1,
        status: "PENDING",
        winnerEntryId: "entry-a",
        loserEntryId: "entry-b",
      }),
      revision({
        id: "pending-2",
        revisionNumber: 2,
        status: "PENDING",
        winnerEntryId: "entry-b",
        loserEntryId: "entry-a",
      }),
    ],
  });

  await assert.rejects(
    getSingleCompetitionReadModel(
      databaseReturning(
        matchSource({
          entries: [entryA, entryB],
          fixtures: [duplicatePending],
        }),
      ),
      "match-1",
    ),
    (error: unknown) =>
      error instanceof V2SingleReadModelIntegrityError &&
      error.entityId === "fixture-group-a-1",
  );
});

test("an orphan pending correction fails closed", async () => {
  const entryA = individualEntry({
    id: "entry-a",
    userId: "user-a",
    snapshotName: "甲",
    currentNickname: "甲",
    seed: 1,
  });
  const entryB = individualEntry({
    id: "entry-b",
    userId: "user-b",
    snapshotName: "乙",
    currentNickname: "乙",
    seed: 2,
  });
  const orphanCorrection = fixture({
    resultRevisions: [
      revision({
        id: "pending-correction",
        revisionNumber: 3,
        status: "PENDING",
        winnerEntryId: "entry-b",
        loserEntryId: "entry-a",
        supersedesRevisionId: "missing-confirmed-revision",
      }),
    ],
  });

  await assert.rejects(
    getSingleCompetitionReadModel(
      databaseReturning(
        matchSource({
          entries: [entryA, entryB],
          fixtures: [orphanCorrection],
        }),
      ),
      "match-1",
    ),
    V2SingleReadModelIntegrityError,
  );
});

test("an ACTIVE individual Entry without one current member fails closed", async () => {
  const entryWithoutCurrentMember = {
    ...individualEntry({
      id: "entry-a",
      userId: "user-a",
      snapshotName: "甲",
      currentNickname: "甲",
      seed: 1,
    }),
    members: [],
  };

  await assert.rejects(
    getSingleCompetitionReadModel(
      databaseReturning(
        matchSource({
          entries: [entryWithoutCurrentMember],
          fixtures: [],
        }),
      ),
      "match-1",
    ),
    (error: unknown) =>
      error instanceof V2SingleReadModelIntegrityError &&
      error.entityId === "entry-a" &&
      /exactly one current member/.test(error.message),
  );
});

test("GROUP display metadata is allowlisted and inconsistent labels fail closed", async () => {
  const entryA = individualEntry({
    id: "entry-a",
    userId: "user-a",
    snapshotName: "甲",
    currentNickname: "甲",
    seed: 1,
  });
  const entryB = individualEntry({
    id: "entry-b",
    userId: "user-b",
    snapshotName: "乙",
    currentNickname: "乙",
    seed: 2,
  });
  const first = fixture({
    status: "READY",
    completedAt: null,
    metadata: { v2Display: { schemaVersion: 1, tableLabels: ["1 号台"] } },
  });
  const different = fixture({
    id: "fixture-group-a-2",
    fixtureKey: "group:0001:pair:0001-0003",
    status: "READY",
    completedAt: null,
    metadata: { v2Display: { schemaVersion: 1, tableLabels: ["2 号台"] } },
  });
  await assert.rejects(
    getSingleCompetitionReadModel(
      databaseReturning(
        matchSource({ entries: [entryA, entryB], fixtures: [first, different] }),
      ),
      "match-1",
    ),
    (error: unknown) =>
      error instanceof V2SingleReadModelIntegrityError &&
      /disagree/.test(error.message),
  );

  const extendedDisplay = fixture({
    status: "READY",
    completedAt: null,
    metadata: {
      v2Display: {
        schemaVersion: 1,
        tableLabels: ["1 号台"],
        attackerField: true,
      },
    },
  });
  await assert.rejects(
    getSingleCompetitionReadModel(
      databaseReturning(
        matchSource({ entries: [entryA, entryB], fixtures: [extendedDisplay] }),
      ),
      "match-1",
    ),
    (error: unknown) =>
      error instanceof V2SingleReadModelIntegrityError &&
      /display metadata/.test(error.message),
  );
});

test("invalid match IDs are rejected before touching Prisma", async () => {
  let read = false;
  let transaction = false;
  const db = databaseReturning(
    null,
    () => {
      read = true;
    },
    () => {
      transaction = true;
    },
  );
  await assert.rejects(
    getSingleCompetitionReadModel(db, " match-1"),
    /non-empty stable identifier/,
  );
  assert.equal(read, false);
  assert.equal(transaction, false);
});
