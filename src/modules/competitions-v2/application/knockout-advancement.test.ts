import assert from "node:assert/strict";
import test from "node:test";

import type { Prisma } from "@prisma/client";

import { V2ResultApplicationError } from "./results-errors";
import {
  advanceConfirmedV2KnockoutWinner,
  validateV2KnockoutGraph,
  type V2KnockoutGraphSnapshot,
} from "./knockout-advancement";
import type { ResultSettlementTransaction } from "./settlements";

const FINGERPRINT = "a".repeat(64);
const PUBLISHED_AT = "2026-09-05T12:00:00.000Z";

function metadata(roundNumber: number, position: number) {
  return {
    publication: "V2_KNOCKOUT_BRACKET",
    schemaVersion: 1,
    bracketPolicyVersion: 1,
    qualificationSnapshotId: "snapshot-1",
    sourceRevisionFingerprint: FINGERPRINT,
    roundNumber,
    position,
    publishedAt: PUBLISHED_AT,
  } as Prisma.JsonObject;
}

function baseGraph(): V2KnockoutGraphSnapshot {
  const standings = Array.from({ length: 4 }, (_, index) => ({
    id: `standing-${index + 1}`,
    matchId: "match-1",
    snapshotId: "snapshot-1",
    entryId: `entry-${index + 1}`,
    qualified: true,
    qualificationOrder: index + 1,
    groupEntry: { rosterVersion: 1 },
  }));
  const rosterMembers = standings.map((standing, index) => ({
    id: `member-${index + 1}`,
    entryId: standing.entryId,
    rosterVersion: 1,
    slot: 1,
  }));
  const firstFixture = (
    id: string,
    fixtureKey: string,
    position: number,
    sideAEntryId: string,
    sideBEntryId: string,
  ) => ({
    id,
    matchId: "match-1",
    fixtureKey,
    stage: "KNOCKOUT" as const,
    status: "READY" as const,
    groupId: null,
    groupKey: null,
    roundNumber: 1,
    position,
    sideAEntryId,
    sideBEntryId,
    sideARosterVersion: 1,
    sideBRosterVersion: 1,
    startedAt: null,
    completedAt: null,
    version: 0,
    metadata: metadata(1, position),
    lineupMembers: [sideAEntryId, sideBEntryId].map((entryId, index) => ({
      id: `line-${id}-${index + 1}`,
      entryId,
      entryMemberId: `member-${Number(entryId.slice("entry-".length))}`,
      side: index === 0 ? ("SIDE_A" as const) : ("SIDE_B" as const),
      position: 1,
    })),
    resultRevisions: [],
  });
  const fixtures = [
    firstFixture(
      "fixture-r1-1",
      "knockout:r0001:m0001",
      1,
      "entry-1",
      "entry-4",
    ),
    firstFixture(
      "fixture-r1-2",
      "knockout:r0001:m0002",
      2,
      "entry-2",
      "entry-3",
    ),
    {
      id: "fixture-final",
      matchId: "match-1",
      fixtureKey: "knockout:r0002:m0001",
      stage: "KNOCKOUT" as const,
      status: "SCHEDULED" as const,
      groupId: null,
      groupKey: null,
      roundNumber: 2,
      position: 1,
      sideAEntryId: null,
      sideBEntryId: null,
      sideARosterVersion: null,
      sideBRosterVersion: null,
      startedAt: null,
      completedAt: null,
      version: 0,
      metadata: metadata(2, 1),
      lineupMembers: [],
      resultRevisions: [],
    },
  ];
  return {
    match: {
      id: "match-1",
      engineVersion: "V2",
      isQuickMatch: false,
      status: "ongoing",
      format: "group_then_knockout",
    },
    grouping: {
      id: "grouping-1",
      matchId: "match-1",
      v2SchemaVersion: 1,
      standingsPolicyVersion: 1,
      qualifiersPerGroup: 2,
      bracketPolicyVersion: 1,
      groupCount: 2,
    },
    snapshot: {
      id: "snapshot-1",
      matchId: "match-1",
      groupingId: "grouping-1",
      schemaVersion: 1,
      standingsPolicyVersion: 1,
      sourceRevisionFingerprint: FINGERPRINT,
    },
    standings,
    fixtures,
    dependencies: [
      ...[
        ["dep-q1", "standing-1", "fixture-r1-1", "SIDE_A"],
        ["dep-q4", "standing-4", "fixture-r1-1", "SIDE_B"],
        ["dep-q2", "standing-2", "fixture-r1-2", "SIDE_A"],
        ["dep-q3", "standing-3", "fixture-r1-2", "SIDE_B"],
      ].map(([id, standingId, targetFixtureId, targetSide]) => ({
        id,
        matchId: "match-1",
        sourceFixtureId: null,
        sourceOutcome: null,
        sourceQualificationStandingId: standingId,
        targetFixtureId,
        targetSide: targetSide as "SIDE_A" | "SIDE_B",
      })),
      {
        id: "dep-winner-1",
        matchId: "match-1",
        sourceFixtureId: "fixture-r1-1",
        sourceOutcome: "WINNER" as const,
        sourceQualificationStandingId: null,
        targetFixtureId: "fixture-final",
        targetSide: "SIDE_A" as const,
      },
      {
        id: "dep-winner-2",
        matchId: "match-1",
        sourceFixtureId: "fixture-r1-2",
        sourceOutcome: "WINNER" as const,
        sourceQualificationStandingId: null,
        targetFixtureId: "fixture-final",
        targetSide: "SIDE_B" as const,
      },
    ],
    rosterMembers,
  };
}

function replaceFixture(
  graph: V2KnockoutGraphSnapshot,
  fixtureId: string,
  replacement: (
    fixture: V2KnockoutGraphSnapshot["fixtures"][number],
  ) => V2KnockoutGraphSnapshot["fixtures"][number],
) {
  return {
    ...graph,
    fixtures: graph.fixtures.map((fixture) =>
      fixture.id === fixtureId ? replacement(fixture) : fixture,
    ),
  };
}

function completedFirstFixtureGraph() {
  const graph = baseGraph();
  return replaceFixture(graph, "fixture-r1-1", (fixture) => ({
    ...fixture,
    status: "COMPLETED",
    completedAt: new Date("2026-09-05T13:00:00.000Z"),
    version: 1,
    resultRevisions: [
      {
        id: "revision-r1-1",
        status: "CONFIRMED",
        winnerEntryId: "entry-1",
        loserEntryId: "entry-4",
        supersedesRevisionId: null,
      },
    ],
  }));
}

test("validates the exact qualifier and WINNER dependency graph", () => {
  assert.doesNotThrow(() => validateV2KnockoutGraph(baseGraph()));
});

test("validates NO_CONTEST propagation and a final ADMIN_BYE without a fake result", () => {
  let graph = baseGraph();
  graph = replaceFixture(graph, "fixture-r1-1", (fixture) => ({
    ...fixture,
    status: "VOIDED",
    completedAt: new Date("2026-09-05T13:00:00.000Z"),
    administrativeResolution: {
      id: "resolution-no-contest",
      matchId: "match-1",
      fixtureId: fixture.id,
      kind: "NO_CONTEST",
      advancingEntryId: null,
      advancingRosterVersion: null,
      resolvedById: "manager-1",
      reason: "双方均无法继续参赛",
      createdAt: new Date("2026-09-05T13:00:00.000Z"),
    },
  }));
  graph = replaceFixture(graph, "fixture-r1-2", (fixture) => ({
    ...fixture,
    status: "COMPLETED",
    completedAt: new Date("2026-09-05T13:01:00.000Z"),
    resultRevisions: [
      {
        id: "revision-r1-2",
        status: "CONFIRMED",
        winnerEntryId: "entry-2",
        loserEntryId: "entry-3",
        supersedesRevisionId: null,
      },
    ],
  }));
  graph = replaceFixture(graph, "fixture-final", (fixture) => ({
    ...fixture,
    status: "VOIDED",
    sideBEntryId: "entry-2",
    sideBRosterVersion: 1,
    completedAt: new Date("2026-09-05T13:02:00.000Z"),
    lineupMembers: [
      {
        id: "final-line-b",
        entryId: "entry-2",
        entryMemberId: "member-2",
        side: "SIDE_B",
        position: 1,
      },
    ],
    administrativeResolution: {
      id: "resolution-bye",
      matchId: "match-1",
      fixtureId: fixture.id,
      kind: "ADMIN_BYE",
      advancingEntryId: "entry-2",
      advancingRosterVersion: 1,
      resolvedById: "manager-1",
      reason: "另一来源无晋级者",
      createdAt: new Date("2026-09-05T13:02:00.000Z"),
    },
  }));

  assert.doesNotThrow(() => validateV2KnockoutGraph(graph));
  assert.equal(
    graph.fixtures.flatMap((fixture) => fixture.resultRevisions).length,
    1,
  );
});

test("rejects an ADMIN_BYE that does not match the only populated side", () => {
  let graph = baseGraph();
  graph = replaceFixture(graph, "fixture-r1-1", (fixture) => ({
    ...fixture,
    status: "VOIDED",
    completedAt: new Date("2026-09-05T13:00:00.000Z"),
    administrativeResolution: {
      id: "bad-bye",
      matchId: "match-1",
      fixtureId: fixture.id,
      kind: "ADMIN_BYE",
      advancingEntryId: "entry-1",
      advancingRosterVersion: 1,
      resolvedById: "manager-1",
      reason: "错误轮空",
      createdAt: new Date("2026-09-05T13:00:00.000Z"),
    },
  }));
  assert.throws(
    () => validateV2KnockoutGraph(graph),
    (error) =>
      error instanceof V2ResultApplicationError &&
      error.message.includes("only populated side"),
  );
});

test("rejects LOSER advancement and qualification source drift", () => {
  const loserGraph = baseGraph();
  const loserDependencies = loserGraph.dependencies.map((dependency) =>
    dependency.id === "dep-winner-1"
      ? { ...dependency, sourceOutcome: "LOSER" as const }
      : dependency,
  );
  assert.throws(
    () =>
      validateV2KnockoutGraph({
        ...loserGraph,
        dependencies: loserDependencies,
      }),
    (error) =>
      error instanceof V2ResultApplicationError &&
      error.code === "AGGREGATE_INVARIANT_VIOLATION",
  );

  const standingGraph = baseGraph();
  const standingDependencies = standingGraph.dependencies.map((dependency) =>
    dependency.id === "dep-q1"
      ? { ...dependency, sourceQualificationStandingId: "standing-2" }
      : dependency,
  );
  assert.throws(() =>
    validateV2KnockoutGraph({
      ...standingGraph,
      dependencies: standingDependencies,
    }),
  );
});

test("rejects a winner projection whose Entry, roster, or lineup drifted", () => {
  let graph = completedFirstFixtureGraph();
  graph = replaceFixture(graph, "fixture-final", (fixture) => ({
    ...fixture,
    sideAEntryId: "entry-4",
    sideARosterVersion: 1,
    lineupMembers: [
      {
        id: "wrong-final-line",
        entryId: "entry-4",
        entryMemberId: "member-4",
        side: "SIDE_A",
        position: 1,
      },
    ],
  }));
  assert.throws(
    () => validateV2KnockoutGraph(graph),
    (error) =>
      error instanceof V2ResultApplicationError &&
      error.code === "AGGREGATE_INVARIANT_VIOLATION",
  );
});

test("rejects malformed active revision combinations on completed fixtures", () => {
  let graph = completedFirstFixtureGraph();
  graph = replaceFixture(graph, "fixture-final", (fixture) => ({
    ...fixture,
    sideAEntryId: "entry-1",
    sideARosterVersion: 1,
    lineupMembers: [
      {
        id: "final-line-a",
        entryId: "entry-1",
        entryMemberId: "member-1",
        side: "SIDE_A",
        position: 1,
      },
    ],
  }));
  graph = replaceFixture(graph, "fixture-r1-1", (fixture) => ({
    ...fixture,
    resultRevisions: [
      ...fixture.resultRevisions,
      {
        id: "malformed-initial-pending",
        status: "PENDING",
        winnerEntryId: "entry-1",
        loserEntryId: "entry-4",
        supersedesRevisionId: null,
      },
    ],
  }));
  assert.throws(
    () => validateV2KnockoutGraph(graph),
    (error) =>
      error instanceof V2ResultApplicationError &&
      error.code === "AGGREGATE_INVARIANT_VIOLATION" &&
      error.message.includes("pending correction"),
  );

  graph = replaceFixture(graph, "fixture-r1-1", (fixture) => ({
    ...fixture,
    resultRevisions: fixture.resultRevisions.map((revision) =>
      revision.status === "PENDING"
        ? {
            ...revision,
            winnerEntryId: "entry-4",
            loserEntryId: "entry-1",
            supersedesRevisionId: "different-confirmed-result",
          }
        : revision,
    ),
  }));
  assert.throws(() => validateV2KnockoutGraph(graph));
});

test("accepts a same-winner pending knockout score correction", () => {
  let graph = completedFirstFixtureGraph();
  graph = replaceFixture(graph, "fixture-final", (fixture) => ({
    ...fixture,
    sideAEntryId: "entry-1",
    sideARosterVersion: 1,
    lineupMembers: [
      {
        id: "final-line-a",
        entryId: "entry-1",
        entryMemberId: "member-1",
        side: "SIDE_A",
        position: 1,
      },
    ],
  }));
  graph = replaceFixture(graph, "fixture-r1-1", (fixture) => ({
    ...fixture,
    resultRevisions: [
      ...fixture.resultRevisions,
      {
        id: "same-winner-pending",
        status: "PENDING",
        winnerEntryId: "entry-1",
        loserEntryId: "entry-4",
        supersedesRevisionId: "revision-r1-1",
      },
    ],
  }));

  assert.doesNotThrow(() => validateV2KnockoutGraph(graph));
});

function fakeTransaction(
  graph: V2KnockoutGraphSnapshot,
  writes: {
    updates: unknown[];
    deletes: unknown[];
    creates: unknown[];
    matchUpdates: unknown[];
  },
) {
  return {
    $queryRaw: async () => [],
    matchGrouping: {
      findUnique: async () => ({
        ...graph.grouping,
        _count: { groups: graph.grouping.groupCount },
      }),
    },
    matchQualificationSnapshot: {
      findFirst: async () => ({
        ...graph.snapshot,
        standings: graph.standings,
      }),
    },
    matchEntryMember: { findMany: async () => graph.rosterMembers },
    matchFixtureDependency: { findMany: async () => graph.dependencies },
    matchFixture: {
      findMany: async () => graph.fixtures,
      updateMany: async (args: unknown) => {
        writes.updates.push(args);
        return { count: 1 };
      },
    },
    matchFixtureLineupMember: {
      deleteMany: async (args: unknown) => {
        writes.deletes.push(args);
        return { count: 0 };
      },
      createMany: async (args: unknown) => {
        writes.creates.push(args);
        return { count: 1 };
      },
    },
    match: {
      updateMany: async (args: unknown) => {
        writes.matchUpdates.push(args);
        return { count: 1 };
      },
    },
  } as unknown as ResultSettlementTransaction;
}

test("atomically copies the frozen winning lineup and readies only a full target", async () => {
  const graph = completedFirstFixtureGraph();
  const writes = { updates: [], deletes: [], creates: [], matchUpdates: [] };
  const result = await advanceConfirmedV2KnockoutWinner(
    fakeTransaction(graph, writes),
    {
      match: graph.match,
      fixtureId: "fixture-r1-1",
      winnerEntryId: "entry-1",
    },
  );

  assert.deepEqual(result, {
    advanced: true,
    finished: false,
    targetFixtureId: "fixture-final",
  });
  assert.equal(writes.updates.length, 1);
  assert.deepEqual(writes.updates[0], {
    where: {
      id: "fixture-final",
      matchId: "match-1",
      version: 0,
      status: "SCHEDULED",
    },
    data: {
      sideAEntryId: "entry-1",
      sideARosterVersion: 1,
      status: "SCHEDULED",
      version: { increment: 1 },
    },
  });
  assert.deepEqual(writes.creates[0], {
    data: [
      {
        matchId: "match-1",
        fixtureId: "fixture-final",
        entryId: "entry-1",
        entryMemberId: "member-1",
        side: "SIDE_A",
        position: 1,
      },
    ],
  });
});

test("final confirmation finishes only a completely confirmed bracket", async () => {
  let graph = completedFirstFixtureGraph();
  graph = replaceFixture(graph, "fixture-r1-2", (fixture) => ({
    ...fixture,
    status: "COMPLETED",
    completedAt: new Date("2026-09-05T13:05:00.000Z"),
    resultRevisions: [
      {
        id: "revision-r1-2",
        status: "CONFIRMED",
        winnerEntryId: "entry-2",
        loserEntryId: "entry-3",
        supersedesRevisionId: null,
      },
    ],
  }));
  graph = replaceFixture(graph, "fixture-final", (fixture) => ({
    ...fixture,
    status: "COMPLETED",
    sideAEntryId: "entry-1",
    sideBEntryId: "entry-2",
    sideARosterVersion: 1,
    sideBRosterVersion: 1,
    completedAt: new Date("2026-09-05T14:00:00.000Z"),
    lineupMembers: [
      {
        id: "final-line-a",
        entryId: "entry-1",
        entryMemberId: "member-1",
        side: "SIDE_A",
        position: 1,
      },
      {
        id: "final-line-b",
        entryId: "entry-2",
        entryMemberId: "member-2",
        side: "SIDE_B",
        position: 1,
      },
    ],
    resultRevisions: [
      {
        id: "revision-final",
        status: "CONFIRMED",
        winnerEntryId: "entry-1",
        loserEntryId: "entry-2",
        supersedesRevisionId: null,
      },
    ],
  }));
  const writes = { updates: [], deletes: [], creates: [], matchUpdates: [] };
  const result = await advanceConfirmedV2KnockoutWinner(
    fakeTransaction(graph, writes),
    {
      match: graph.match,
      fixtureId: "fixture-final",
      winnerEntryId: "entry-1",
    },
  );

  assert.equal(result.finished, true);
  assert.equal(writes.matchUpdates.length, 1);
  assert.deepEqual(writes.matchUpdates[0], {
    where: {
      id: "match-1",
      engineVersion: "V2",
      isQuickMatch: false,
      format: "group_then_knockout",
      status: "ongoing",
    },
    data: { status: "finished" },
  });
});

test("a final cannot finish while any earlier knockout fixture is not completed", async () => {
  let graph = baseGraph();
  graph = replaceFixture(graph, "fixture-final", (fixture) => ({
    ...fixture,
    status: "COMPLETED",
    sideAEntryId: "entry-1",
    sideBEntryId: "entry-2",
    sideARosterVersion: 1,
    sideBRosterVersion: 1,
    completedAt: new Date("2026-09-05T14:00:00.000Z"),
    lineupMembers: [
      {
        id: "final-line-a",
        entryId: "entry-1",
        entryMemberId: "member-1",
        side: "SIDE_A",
        position: 1,
      },
      {
        id: "final-line-b",
        entryId: "entry-2",
        entryMemberId: "member-2",
        side: "SIDE_B",
        position: 1,
      },
    ],
    resultRevisions: [
      {
        id: "revision-final",
        status: "CONFIRMED",
        winnerEntryId: "entry-1",
        loserEntryId: "entry-2",
        supersedesRevisionId: null,
      },
    ],
  }));
  const writes = { updates: [], deletes: [], creates: [], matchUpdates: [] };
  await assert.rejects(
    () =>
      advanceConfirmedV2KnockoutWinner(fakeTransaction(graph, writes), {
        match: graph.match,
        fixtureId: "fixture-final",
        winnerEntryId: "entry-1",
      }),
    (error: unknown) =>
      error instanceof V2ResultApplicationError &&
      error.code === "AGGREGATE_INVARIANT_VIOLATION",
  );
  assert.equal(writes.matchUpdates.length, 0);
});
