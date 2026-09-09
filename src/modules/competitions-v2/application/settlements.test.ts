import assert from "node:assert/strict";
import test from "node:test";

import {
  applyResultSettlement,
  assertFixtureLineupMatchesFrozenRoster,
  calculateSameWinnerCorrectionReapplyAward,
  calculateResultEloDeltas,
  legacyCompatibleResultPointsPolicy,
  reverseResultSettlement,
} from "./settlements";
import type {
  FrozenFixtureRoster,
  ResultSettlementTransaction,
} from "./settlements";
import { V2ResultApplicationError } from "./results-errors";

const baseInput = {
  userId: "user-1",
  matchId: "match-1",
  resultRevisionId: "revision-1",
  currentBalance: 10,
};

test("legacy-compatible result rewards grant one point up to the per-match cap", () => {
  assert.equal(
    legacyCompatibleResultPointsPolicy.calculateWinnerAward({
      ...baseInput,
      netMatchPoints: 0,
    }),
    1,
  );
  assert.equal(
    legacyCompatibleResultPointsPolicy.calculateWinnerAward({
      ...baseInput,
      netMatchPoints: 4,
    }),
    1,
  );
  assert.equal(
    legacyCompatibleResultPointsPolicy.calculateWinnerAward({
      ...baseInput,
      netMatchPoints: 5,
    }),
    0,
  );
});

test("a result reversal never drives the current points balance below zero", () => {
  assert.equal(
    legacyCompatibleResultPointsPolicy.calculateWinnerReversal({
      ...baseInput,
      netMatchPoints: 1,
      originalAward: 1,
      currentBalance: 3,
    }),
    -1,
  );
  assert.equal(
    legacyCompatibleResultPointsPolicy.calculateWinnerReversal({
      ...baseInput,
      netMatchPoints: 1,
      originalAward: 1,
      currentBalance: 0,
    }),
    0,
  );
});

test("a same-winner correction reapplies only the award actually recovered", () => {
  for (const reversalDelta of [-1, 0] as const) {
    const reapplied = calculateSameWinnerCorrectionReapplyAward(
      1,
      reversalDelta,
    );
    assert.equal(reapplied, reversalDelta === 0 ? 0 : -reversalDelta);
    assert.equal(1 + reversalDelta + reapplied, 1);
  }
  assert.equal(calculateSameWinnerCorrectionReapplyAward(0, 0), 0);
  assert.throws(
    () => calculateSameWinnerCorrectionReapplyAward(1, -2),
    (error: unknown) =>
      error instanceof V2ResultApplicationError &&
      error.code === "SETTLEMENT_STATE_CONFLICT",
  );
});

test("a later correction keeps the original ELO algorithm baseline", () => {
  const originalInputs = new Map([
    [
      "old-winner",
      {
        userId: "old-winner",
        eloRating: 1400,
        matchesPlayed: 0,
      },
    ],
    [
      "old-loser",
      {
        userId: "old-loser",
        eloRating: 1000,
        matchesPlayed: 0,
      },
    ],
  ]);
  const corrected = calculateResultEloDeltas(
    ["old-loser"],
    ["old-winner"],
    originalInputs,
  );
  const correctedByUser = new Map(
    corrected.map((effect) => [effect.userId, effect.delta]),
  );

  // Their live ratings may have changed through another fixture; the correction
  // delta still comes from the persisted original inputs, then applies to live state.
  const liveAfterAnotherFixture = new Map([
    ["old-winner", 1000],
    ["old-loser", 1400],
  ]);
  assert.equal(correctedByUser.get("old-loser"), 36);
  assert.equal(correctedByUser.get("old-winner"), -36);
  assert.equal(
    liveAfterAnotherFixture.get("old-loser")! +
      correctedByUser.get("old-loser")!,
    1436,
  );
});

const frozenTeamRoster: FrozenFixtureRoster = {
  sideA: {
    entryId: "entry-a",
    kind: "TEAM",
    status: "ACTIVE",
    rosterVersion: 3,
    members: [
      { userId: "user-a1", role: "player" },
      { userId: "user-a2", role: "player" },
    ],
    userIds: ["user-a1", "user-a2"],
  },
  sideB: {
    entryId: "entry-b",
    kind: "TEAM",
    status: "ACTIVE",
    rosterVersion: 4,
    members: [
      { userId: "user-b1", role: "player" },
      { userId: "user-b2", role: "player" },
    ],
    userIds: ["user-b1", "user-b2"],
  },
  allUserIds: ["user-a1", "user-a2", "user-b1", "user-b2"],
};

const frozenTeamFixture = {
  id: "fixture-team",
  matchId: "match-team",
  sideAEntryId: "entry-a",
  sideBEntryId: "entry-b",
  sideARosterVersion: 3,
  sideBRosterVersion: 4,
};

function lineupTransaction(rows: readonly Record<string, unknown>[]) {
  return {
    matchFixtureLineupMember: { findMany: async () => rows },
  } as unknown as ResultSettlementTransaction;
}

test("result settlement accepts a complete frozen TEAM lineup", async () => {
  await assert.doesNotReject(() =>
    assertFixtureLineupMatchesFrozenRoster(
      lineupTransaction([
        {
          side: "SIDE_A",
          position: 1,
          entryId: "entry-a",
          entryMember: { userId: "user-a1", rosterVersion: 3 },
        },
        {
          side: "SIDE_A",
          position: 2,
          entryId: "entry-a",
          entryMember: { userId: "user-a2", rosterVersion: 3 },
        },
        {
          side: "SIDE_B",
          position: 1,
          entryId: "entry-b",
          entryMember: { userId: "user-b1", rosterVersion: 4 },
        },
        {
          side: "SIDE_B",
          position: 2,
          entryId: "entry-b",
          entryMember: { userId: "user-b2", rosterVersion: 4 },
        },
      ]),
      frozenTeamFixture,
      frozenTeamRoster,
    ),
  );
});

test("result settlement rejects a partial TEAM lineup", async () => {
  await assert.rejects(
    assertFixtureLineupMatchesFrozenRoster(
      lineupTransaction([
        {
          side: "SIDE_A",
          position: 1,
          entryId: "entry-a",
          entryMember: { userId: "user-a1", rosterVersion: 3 },
        },
        {
          side: "SIDE_B",
          position: 1,
          entryId: "entry-b",
          entryMember: { userId: "user-b1", rosterVersion: 4 },
        },
        {
          side: "SIDE_B",
          position: 2,
          entryId: "entry-b",
          entryMember: { userId: "user-b2", rosterVersion: 4 },
        },
      ]),
      frozenTeamFixture,
      frozenTeamRoster,
    ),
    (error: unknown) =>
      error instanceof V2ResultApplicationError &&
      error.code === "INVALID_FIXTURE_ROSTER",
  );
});

test("direct result settlement rejects quick matches", async () => {
  const tx = {
    $queryRaw: async () => [{ id: "locked-row" }],
    resultRevision: {
      findUnique: async () => ({
        id: "revision-1",
        matchId: "match-1",
        fixtureId: "fixture-1",
        status: "CONFIRMED",
        winnerEntryId: "entry-a",
        loserEntryId: "entry-b",
        supersedesRevisionId: null,
        fixture: {
          id: "fixture-1",
          matchId: "match-1",
          sideAEntryId: "entry-a",
          sideBEntryId: "entry-b",
          sideARosterVersion: 1,
          sideBRosterVersion: 1,
        },
      }),
    },
    match: {
      findUnique: async () => ({
        id: "match-1",
        engineVersion: "V2",
        isQuickMatch: true,
        type: "single",
      }),
    },
  } as unknown as ResultSettlementTransaction;

  await assert.rejects(
    () =>
      applyResultSettlement(tx, {
        resultRevisionId: "revision-1",
      }),
    (error: unknown) =>
      error instanceof V2ResultApplicationError &&
      error.code === "ENGINE_MISMATCH" &&
      error.details.isQuickMatch === true,
  );
});

test("forfeit revisions can never apply or reverse ELO, points, or record effects", async () => {
  let settlementReads = 0;
  let userReads = 0;
  const tx = {
    $queryRaw: async () => [{ id: "revision-forfeit" }],
    resultRevision: {
      findUnique: async () => ({
        id: "revision-forfeit",
        matchId: "match-1",
        fixtureId: "fixture-1",
        status: "CONFIRMED",
        resolutionKind: "FORFEIT",
        winnerEntryId: "entry-a",
        loserEntryId: "entry-b",
        supersedesRevisionId: null,
        fixture: {
          id: "fixture-1",
          matchId: "match-1",
          sideAEntryId: "entry-a",
          sideBEntryId: "entry-b",
          sideARosterVersion: 1,
          sideBRosterVersion: 1,
        },
      }),
    },
    match: {
      findUnique: async () => ({
        id: "match-1",
        engineVersion: "V2",
        isQuickMatch: false,
        type: "single",
      }),
    },
    settlementEvent: {
      findMany: async () => {
        settlementReads += 1;
        return [];
      },
    },
    user: {
      findMany: async () => {
        userReads += 1;
        return [];
      },
    },
  } as unknown as ResultSettlementTransaction;

  for (const settle of [applyResultSettlement, reverseResultSettlement]) {
    await assert.rejects(
      () => settle(tx, { resultRevisionId: "revision-forfeit" }),
      (error: unknown) =>
        error instanceof V2ResultApplicationError &&
        error.code === "SETTLEMENT_STATE_CONFLICT" &&
        error.details.resolutionKind === "FORFEIT",
    );
  }
  assert.equal(settlementReads, 0);
  assert.equal(userReads, 0);
});
