import assert from "node:assert/strict";
import test from "node:test";

import {
  finishV2GroupOnlyMatchIfTerminal,
  finishV2SingleGroupOnlyMatchIfTerminal,
  type LockedV2MatchCompletionContext,
  type V2MatchCompletionTransaction,
} from "./match-completion";

type FixtureStatus = "SCHEDULED" | "READY" | "COMPLETED" | "VOIDED";

function eligibleMatch(
  overrides: Partial<LockedV2MatchCompletionContext> = {},
): LockedV2MatchCompletionContext {
  return {
    id: "match-1",
    engineVersion: "V2",
    isQuickMatch: false,
    type: "single",
    status: "ongoing",
    format: "group_only",
    ...overrides,
  };
}

function completionTransaction(
  fixtureStatuses: readonly FixtureStatus[],
  initialStatus: "registration" | "ongoing" | "finished" = "ongoing",
  topologyValid = true,
) {
  let persistedStatus = initialStatus;
  const countQueries: unknown[] = [];
  const updateQueries: unknown[] = [];
  const transaction = {
    matchFixture: {
      count: async (args: {
        where: {
          matchId: string;
          status?: { notIn: readonly FixtureStatus[] };
        };
      }) => {
        countQueries.push(args);
        const excluded = args.where.status?.notIn;
        return excluded === undefined
          ? fixtureStatuses.length
          : fixtureStatuses.filter((status) => !excluded.includes(status)).length;
      },
    },
    match: {
      findUnique: async () => ({
        groupingGeneratedAt: new Date("2026-09-05T00:00:00.000Z"),
        groupingResult: {
          createdAt: new Date("2026-09-05T00:00:00.000Z"),
          v2SchemaVersion: 1,
          seedMethod: "MIN_DIFF",
          standingsPolicyVersion: 1,
          qualifiersPerGroup: null,
          bracketPolicyVersion: null,
          groups: fixtureStatuses.map((_, index) => ({
            id: `group-${index + 1}`,
            groupKey: `group:${String(index + 1).padStart(4, "0")}`,
            position: index + 1,
            entries: [
              { entryId: `entry-${index + 1}-a`, position: 1 },
              { entryId: `entry-${index + 1}-b`, position: 2 },
            ],
          })),
        },
        fixtures: fixtureStatuses.map((status, index) => ({
          id: `fixture-${index + 1}`,
          stage: topologyValid ? "GROUP" : "FREE_PLAY",
          status,
          groupId: `group-${index + 1}`,
          groupKey: `group:${String(index + 1).padStart(4, "0")}`,
          sideAEntryId: `entry-${index + 1}-a`,
          sideBEntryId: `entry-${index + 1}-b`,
        })),
      }),
      updateMany: async (args: {
        where: { status: "ongoing" };
        data: { status: "finished" };
      }) => {
        updateQueries.push(args);
        if (persistedStatus !== args.where.status) return { count: 0 };
        persistedStatus = args.data.status;
        return { count: 1 };
      },
    },
  } as unknown as V2MatchCompletionTransaction;

  return {
    transaction,
    countQueries,
    updateQueries,
    persistedStatus: () => persistedStatus,
  };
}

test("the last terminal fixture finishes an eligible match with one CAS", async () => {
  const state = completionTransaction(["COMPLETED", "VOIDED"]);

  assert.equal(
    await finishV2SingleGroupOnlyMatchIfTerminal(
      state.transaction,
      eligibleMatch(),
    ),
    true,
  );
  assert.equal(state.persistedStatus(), "finished");
  assert.equal(state.countQueries.length, 2);
  assert.equal(state.updateQueries.length, 1);
  assert.deepEqual(state.countQueries[1], {
    where: {
      matchId: "match-1",
      status: { notIn: ["COMPLETED", "VOIDED"] },
    },
  });
});

test("a non-terminal fixture keeps the match ongoing", async () => {
  const state = completionTransaction(["COMPLETED", "READY"]);

  assert.equal(
    await finishV2SingleGroupOnlyMatchIfTerminal(
      state.transaction,
      eligibleMatch(),
    ),
    false,
  );
  assert.equal(state.persistedStatus(), "ongoing");
  assert.equal(state.updateQueries.length, 0);
});

test("an all-voided fixture set is terminal", async () => {
  const state = completionTransaction(["VOIDED", "VOIDED"]);

  assert.equal(
    await finishV2SingleGroupOnlyMatchIfTerminal(
      state.transaction,
      eligibleMatch(),
    ),
    true,
  );
  assert.equal(state.persistedStatus(), "finished");
});

test("a match without fixtures never auto-finishes", async () => {
  const state = completionTransaction([]);

  assert.equal(
    await finishV2SingleGroupOnlyMatchIfTerminal(
      state.transaction,
      eligibleMatch(),
    ),
    false,
  );
  assert.equal(state.countQueries.length, 1);
  assert.equal(state.updateQueries.length, 0);
});

test("terminal ad-hoc fixtures cannot finish a match without the relational publication topology", async () => {
  const state = completionTransaction(["COMPLETED"], "ongoing", false);

  assert.equal(
    await finishV2GroupOnlyMatchIfTerminal(state.transaction, eligibleMatch()),
    false,
  );
  assert.equal(state.persistedStatus(), "ongoing");
  assert.equal(state.updateQueries.length, 0);
});

test("all supported entry kinds use the same group-only completion projection", async () => {
  for (const type of ["single", "double", "team"] as const) {
    const state = completionTransaction(["COMPLETED", "VOIDED"]);
    assert.equal(
      await finishV2GroupOnlyMatchIfTerminal(
        state.transaction,
        eligibleMatch({ type }),
      ),
      true,
    );
    assert.equal(state.persistedStatus(), "finished");
    assert.deepEqual(state.updateQueries[0], {
      where: {
        id: "match-1",
        engineVersion: "V2",
        isQuickMatch: false,
        type,
        format: "group_only",
        status: "ongoing",
      },
      data: { status: "finished" },
    });
  }
});

test("ineligible engine, format, quick, and lifecycle states do no reads or writes", async () => {
  const ineligible: LockedV2MatchCompletionContext[] = [
    eligibleMatch({ engineVersion: "LEGACY" }),
    eligibleMatch({ isQuickMatch: true }),
    eligibleMatch({ format: "group_then_knockout" }),
    eligibleMatch({ status: "registration" }),
    eligibleMatch({ status: "finished" }),
  ];

  for (const match of ineligible) {
    const state = completionTransaction(["COMPLETED"]);
    assert.equal(
      await finishV2SingleGroupOnlyMatchIfTerminal(state.transaction, match),
      false,
    );
    assert.equal(state.countQueries.length, 0);
    assert.equal(state.updateQueries.length, 0);
  }
});

test("the status CAS makes concurrent or repeated completion idempotent", async () => {
  const state = completionTransaction(["COMPLETED"]);
  const lockedSnapshot = eligibleMatch();

  assert.equal(
    await finishV2SingleGroupOnlyMatchIfTerminal(
      state.transaction,
      lockedSnapshot,
    ),
    true,
  );
  assert.equal(
    await finishV2SingleGroupOnlyMatchIfTerminal(
      state.transaction,
      lockedSnapshot,
    ),
    false,
  );
  assert.equal(state.persistedStatus(), "finished");
  assert.equal(state.updateQueries.length, 2);
});
