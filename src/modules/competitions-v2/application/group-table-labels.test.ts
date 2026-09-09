import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import {
  V2CompetitionApplicationError,
  type V2CompetitionTransaction,
} from "./entries";
import {
  createV2SingleGroupTableLabelsApplicationService,
  type UpdateV2SingleGroupTableLabelsCommand,
} from "./group-table-labels";

const GENERATED_AT = new Date("2026-09-04T12:00:00.000Z");

function metadata(
  groupIndex: number,
  sideAPosition: number,
  sideBPosition: number,
  labels?: readonly string[],
) {
  return {
    publication: "V2_SINGLE_GROUPING",
    publicationVersion: 1,
    groupIndex,
    groupName: `第 ${groupIndex} 组`,
    format: "group_only",
    qualifiersPerGroup: null,
    seedMethod: "snake",
    sideAPosition,
    sideBPosition,
    ...(labels === undefined
      ? {}
      : { v2Display: { schemaVersion: 1, tableLabels: [...labels] } }),
  };
}

function fixture(
  id: string,
  groupIndex: number,
  sideAPosition: number,
  sideBPosition: number,
  entryIds: readonly string[],
) {
  const groupKey = `group:${String(groupIndex).padStart(4, "0")}`;
  return {
    id,
    fixtureKey: `${groupKey}:pair:${String(sideAPosition).padStart(4, "0")}-${String(sideBPosition).padStart(4, "0")}`,
    stage: "GROUP" as const,
    groupKey,
    roundNumber: null,
    position: null,
    sideAEntryId: entryIds[sideAPosition - 1],
    sideBEntryId: entryIds[sideBPosition - 1],
    version: 5,
    metadata: metadata(groupIndex, sideAPosition, sideBPosition),
  };
}

type State = {
  match: {
    id: string;
    title: string;
    createdBy: string;
    engineVersion: "LEGACY" | "V2";
    isQuickMatch: boolean;
    type: "single" | "double" | "team";
    status: "registration" | "ongoing" | "finished";
    format: "group_only" | "group_then_knockout";
    groupingGeneratedAt: Date | null;
  };
  actor: {
    id: string;
    role: "user" | "admin";
    isBanned: boolean;
    emailVerifiedAt: Date | null;
  };
  payload: Record<string, unknown>;
  groupingCreatedAt: Date;
  entries: Array<{
    id: string;
    kind: "INDIVIDUAL";
    sourceUserId: string;
  }>;
  fixtures: ReturnType<typeof fixture>[];
  fixtureWrites: number;
  groupingWrites: number;
  auditWrites: number;
  auditDetails: unknown;
  locks: string[];
  isolationLevels: unknown[];
};

function initialState(): State {
  const groupOneEntries = ["entry-a", "entry-b", "entry-c"];
  const groupTwoEntries = ["entry-d", "entry-e"];
  return {
    match: {
      id: "match-1",
      title: "V2 单打赛",
      createdBy: "manager-1",
      engineVersion: "V2",
      isQuickMatch: false,
      type: "single",
      status: "ongoing",
      format: "group_only",
      groupingGeneratedAt: GENERATED_AT,
    },
    actor: {
      id: "manager-1",
      role: "user",
      isBanned: false,
      emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    payload: {
      generatedAt: GENERATED_AT.toISOString(),
      competitorType: "user",
      format: "group_only",
      config: { groupCount: 2, seedMethod: "snake" },
      groups: [
        {
          name: "第 1 组",
          averagePoints: 1_300,
          players: groupOneEntries.map((_, index) => ({
            id: `user-${String.fromCharCode(97 + index)}`,
            nickname: `选手 ${index + 1}`,
            points: index,
            eloRating: 1_400 - index * 100,
          })),
        },
        {
          name: "第 2 组",
          averagePoints: 1_150,
          players: groupTwoEntries.map((_, index) => ({
            id: `user-${String.fromCharCode(100 + index)}`,
            nickname: `选手 ${index + 4}`,
            points: index + 3,
            eloRating: 1_200 - index * 100,
          })),
        },
      ],
      v2Publication: {
        schemaVersion: 1,
        groups: [
          { groupKey: "group:0001", entryIds: groupOneEntries },
          { groupKey: "group:0002", entryIds: groupTwoEntries },
        ],
      },
    },
    groupingCreatedAt: GENERATED_AT,
    entries: [...groupOneEntries, ...groupTwoEntries].map((id, index) => ({
      id,
      kind: "INDIVIDUAL",
      sourceUserId: `user-${String.fromCharCode(97 + index)}`,
    })),
    fixtures: [
      fixture("fixture-1-12", 1, 1, 2, groupOneEntries),
      fixture("fixture-1-13", 1, 1, 3, groupOneEntries),
      fixture("fixture-1-23", 1, 2, 3, groupOneEntries),
      fixture("fixture-2-12", 2, 1, 2, groupTwoEntries),
    ],
    fixtureWrites: 0,
    groupingWrites: 0,
    auditWrites: 0,
    auditDetails: null,
    locks: [],
    isolationLevels: [],
  };
}

function command(
  state: State,
  labels: readonly string[] = ["1 号台", "西区馆 A"],
): UpdateV2SingleGroupTableLabelsCommand {
  return {
    actor: { id: "manager-1", role: "user" },
    matchId: "match-1",
    groupKey: "group:0001",
    expectedFixtures: state.fixtures
      .filter((item) => item.groupKey === "group:0001")
      .map((item) => ({ fixtureId: item.id, version: item.version })),
    labels,
  };
}

function fakeDatabase(state: State) {
  const tx = {
    $queryRaw: async (query: { strings?: readonly string[] }) => {
      const sql = (query.strings?.join("?") ?? String(query))
        .replaceAll(/\s+/g, " ")
        .trim();
      state.locks.push(sql);
      if (sql.includes('FROM "Match"')) return [{ id: state.match.id }];
      if (sql.includes('FROM "User"')) return [{ id: state.actor.id }];
      return state.fixtures.map((item) => ({ id: item.id }));
    },
    user: {
      findUnique: async () => ({ ...state.actor }),
    },
    match: {
      findUnique: async () => ({ ...state.match }),
    },
    matchGrouping: {
      findUnique: async () => ({
        payload: state.payload,
        createdAt: state.groupingCreatedAt,
      }),
      update: async (args: { data: { payload: Record<string, unknown> } }) => {
        state.payload = args.data.payload;
        state.groupingWrites += 1;
        return { id: "grouping-1" };
      },
    },
    matchFixture: {
      findMany: async () => [...state.fixtures].sort((a, b) => a.id.localeCompare(b.id)),
      updateMany: async (args: {
        where: { id: string; matchId: string; version: number };
        data: { metadata: ReturnType<typeof metadata>; version: { increment: number } };
      }) => {
        const target = state.fixtures.find(
          (item) => item.id === args.where.id && item.version === args.where.version,
        );
        if (!target) return { count: 0 };
        target.metadata = args.data.metadata;
        target.version += args.data.version.increment;
        state.fixtureWrites += 1;
        return { count: 1 };
      },
    },
    matchEntry: {
      findMany: async () => [...state.entries].sort((a, b) => a.id.localeCompare(b.id)),
    },
    auditLog: {
      create: async (args: { data: { details: unknown } }) => {
        state.auditWrites += 1;
        state.auditDetails = args.data.details;
        return { id: "audit-1" };
      },
    },
  };
  return {
    $transaction: async <T>(
      operation: (client: V2CompetitionTransaction) => Promise<T>,
      options: { isolationLevel?: unknown } = {},
    ) => {
      state.isolationLevels.push(options.isolationLevel);
      return operation(tx as unknown as V2CompetitionTransaction);
    },
  } as unknown as Pick<PrismaClient, "$transaction">;
}

async function expectError(
  operation: () => Promise<unknown>,
  code: V2CompetitionApplicationError["code"],
) {
  await assert.rejects(
    operation,
    (error: unknown) =>
      error instanceof V2CompetitionApplicationError && error.code === code,
  );
}

test("updates every fixture in one complete group plus the compatibility projection and audit", async () => {
  const state = initialState();
  const service = createV2SingleGroupTableLabelsApplicationService({
    db: fakeDatabase(state),
  });

  const result = await service.update(command(state));

  assert.equal(state.isolationLevels[0], "Serializable");
  assert.deepEqual(
    state.locks.map((sql) =>
      sql.includes('FROM "Match"')
        ? "match"
        : sql.includes('FROM "User"')
          ? "actor"
          : "fixtures",
    ),
    ["match", "actor", "fixtures"],
  );
  assert.equal(result.changed, true);
  assert.equal(state.fixtureWrites, 3);
  assert.equal(state.groupingWrites, 1);
  assert.equal(state.auditWrites, 1);
  assert.deepEqual(
    state.fixtures
      .filter((item) => item.groupKey === "group:0001")
      .map((item) => ({ version: item.version, display: item.metadata.v2Display })),
    Array.from({ length: 3 }, () => ({
      version: 6,
      display: { schemaVersion: 1, tableLabels: ["1 号台", "西区馆 A"] },
    })),
  );
  assert.equal(state.fixtures[3].version, 5);
  assert.deepEqual(state.payload.tableAssignments, {
    group: { "第 1 组": ["1 号台", "西区馆 A"] },
    knockout: {},
  });
  assert.deepEqual(state.auditDetails, {
    targetLabel: "V2 单打赛",
    groupKey: "group:0001",
    groupName: "第 1 组",
    fixtureCount: 3,
    beforeLabels: [],
    afterLabels: ["1 号台", "西区馆 A"],
  });
});

test("an exact retry is a no-op even with the pre-update fixture versions", async () => {
  const state = initialState();
  const original = command(state);
  const service = createV2SingleGroupTableLabelsApplicationService({
    db: fakeDatabase(state),
  });
  await service.update(original);

  const retry = await service.update(original);

  assert.equal(retry.changed, false);
  assert.deepEqual(
    retry.fixtures.map((fixture) => fixture.version),
    [6, 6, 6],
  );
  assert.equal(state.fixtureWrites, 3);
  assert.equal(state.groupingWrites, 1);
  assert.equal(state.auditWrites, 1);
});

test("a stale different edit and an incomplete fixture snapshot both fail closed", async () => {
  const state = initialState();
  const stale = command(state, ["2 号台"]);
  state.fixtures[0].version += 1;
  const service = createV2SingleGroupTableLabelsApplicationService({
    db: fakeDatabase(state),
  });
  await expectError(() => service.update(stale), "FIXTURE_VERSION_CONFLICT");

  const complete = command(state, ["3 号台"]);
  const incomplete = {
    ...complete,
    expectedFixtures: complete.expectedFixtures.slice(1),
  };
  await expectError(() => service.update(incomplete), "FIXTURE_VERSION_CONFLICT");
  assert.equal(state.fixtureWrites, 0);
  assert.equal(state.auditWrites, 0);
});

test("inconsistent group display metadata and incomplete round-robin topology are rejected", async () => {
  for (const mutate of [
    (state: State) => {
      state.fixtures[0].metadata = metadata(1, 1, 2, ["1 号台"]);
    },
    (state: State) => {
      state.fixtures.pop();
    },
  ]) {
    const state = initialState();
    mutate(state);
    const service = createV2SingleGroupTableLabelsApplicationService({
      db: fakeDatabase(state),
    });
    await expectError(
      () => service.update(command(state, ["2 号台"])),
      "FIXTURE_KEY_CONFLICT",
    );
    assert.equal(state.fixtureWrites, 0);
    assert.equal(state.groupingWrites, 0);
    assert.equal(state.auditWrites, 0);
  }
});

test("a malformed or identity-reordered MatchGrouping display projection is rejected", async () => {
  for (const mutate of [
    (state: State) => {
      const groups = state.payload.groups as Array<{
        players: Array<Record<string, unknown>>;
      }>;
      groups[0].players.reverse();
    },
    (state: State) => {
      const groups = state.payload.groups as Array<{ averagePoints: number }>;
      groups[0].averagePoints = Number.POSITIVE_INFINITY;
    },
  ]) {
    const state = initialState();
    mutate(state);
    const service = createV2SingleGroupTableLabelsApplicationService({
      db: fakeDatabase(state),
    });
    await expectError(
      () => service.update(command(state, ["2 号台"])),
      "FIXTURE_KEY_CONFLICT",
    );
    assert.equal(state.fixtureWrites, 0);
    assert.equal(state.groupingWrites, 0);
    assert.equal(state.auditWrites, 0);
  }
});

test("permission and supported lifecycle are rechecked after Match then actor locks", async () => {
  const forbidden = initialState();
  forbidden.match.createdBy = "another-manager";
  const forbiddenService = createV2SingleGroupTableLabelsApplicationService({
    db: fakeDatabase(forbidden),
  });
  await expectError(() => forbiddenService.update(command(forbidden)), "FORBIDDEN");
  assert.equal(forbidden.locks.length, 2);

  const finished = initialState();
  finished.match.status = "finished";
  const finishedService = createV2SingleGroupTableLabelsApplicationService({
    db: fakeDatabase(finished),
  });
  await expectError(
    () => finishedService.update(command(finished)),
    "FIXTURE_CREATION_NOT_ALLOWED",
  );
  assert.equal(finished.locks.length, 2);
});

test("the command contract rejects untrimmed, duplicate, control, or oversized labels before a transaction", async () => {
  for (const labels of [
    [" 1 号台"],
    ["1 号台", "1 号台"],
    ["1\t号台"],
    ["x".repeat(65)],
  ]) {
    const state = initialState();
    const service = createV2SingleGroupTableLabelsApplicationService({
      db: fakeDatabase(state),
    });
    await expectError(() => service.update(command(state, labels)), "INVALID_INPUT");
    assert.equal(state.isolationLevels.length, 0);
  }
});
