import assert from "node:assert/strict";
import test from "node:test";

import {
  buildV2GroupOnlyResultFixtureView,
  formatV2GroupOnlyResultScore,
  parseV2GroupOnlyTeamAggregateScore,
  V2_DOUBLE_GROUP_ONLY_RESULT_VIEW_PROFILE,
  V2_SINGLE_GROUP_ONLY_RESULT_VIEW_PROFILE,
  V2_TEAM_GROUP_ONLY_RESULT_VIEW_PROFILE,
  type V2GroupOnlyResultFixtureInput,
} from "../read-model/group-only-result-view";
import type { V2GroupOnlyActiveResult } from "../read-model/group-only-results";

function revision(
  status: "PENDING" | "CONFIRMED",
  resolutionKind: "PLAYED" | "FORFEIT" = "PLAYED",
) {
  return {
    revisionId: `revision-${status.toLowerCase()}`,
    revisionVersion: 1,
    status,
    resolutionKind,
    winnerEntryId: "entry-a",
    loserEntryId: "entry-b",
    winnerDisplayNameSnapshot: "双打 A",
    loserDisplayNameSnapshot: "双打 B",
    score:
      resolutionKind === "FORFEIT"
        ? { winnerScore: 1, loserScore: 0 }
        : { bestOf: 5, winnerScore: 3, loserScore: 1 },
    reporter: { userId: "manager", nickname: "管理员", avatarUrl: null },
    verifier: status === "CONFIRMED"
      ? { userId: "manager", nickname: "管理员", avatarUrl: null }
      : null,
    supersedesRevisionId: null,
    reason: resolutionKind === "FORFEIT" ? "对方弃权" : null,
    resolvedAt: status === "CONFIRMED" ? "2026-09-05T00:00:00.000Z" : null,
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
  } as const;
}

function activeResult(
  state: "NONE" | "PENDING" | "CONFIRMED",
  resolutionKind: "PLAYED" | "FORFEIT" = "PLAYED",
): V2GroupOnlyActiveResult {
  if (state === "NONE") {
    return {
      state,
      currentRevisionId: null,
      revisionVersion: null,
      authoritativeConfirmedRevisionId: null,
      pendingRevision: null,
      confirmedRevision: null,
    };
  }
  const value = revision(state, resolutionKind);
  return state === "PENDING"
    ? {
        state,
        currentRevisionId: value.revisionId,
        revisionVersion: 1,
        authoritativeConfirmedRevisionId: null,
        pendingRevision: value,
        confirmedRevision: null,
      }
    : {
        state,
        currentRevisionId: value.revisionId,
        revisionVersion: 1,
        authoritativeConfirmedRevisionId: value.revisionId,
        pendingRevision: null,
        confirmedRevision: value,
      };
}

function fixture(
  state: "NONE" | "PENDING" | "CONFIRMED" = "NONE",
  resolutionKind: "PLAYED" | "FORFEIT" = "PLAYED",
): V2GroupOnlyResultFixtureInput {
  const side = (entryId: "entry-a" | "entry-b", prefix: "a" | "b") => ({
    entryId,
    entryStatus: "ACTIVE" as const,
    frozenDisplayName: `双打 ${prefix.toUpperCase()}`,
    members: [1, 2].map((slot) => ({
      userId: `${prefix}-${slot}`,
      isCurrentlyBanned: false,
    })),
  });
  return {
    fixtureId: "fixture-1",
    fixtureVersion: 4,
    status: state === "CONFIRMED" ? "COMPLETED" : "READY",
    sideA: side("entry-a", "a"),
    sideB: side("entry-b", "b"),
    activeResult: activeResult(state, resolutionKind),
  };
}

test("DOUBLE frozen participants may submit while any non-reporter partner confirms", () => {
  const participant = buildV2GroupOnlyResultFixtureView(
    fixture(),
    { userId: "a-1" },
    false,
    V2_DOUBLE_GROUP_ONLY_RESULT_VIEW_PROFILE,
  );
  assert.equal(participant.canSubmitResult, true);
  assert.equal(
    buildV2GroupOnlyResultFixtureView(
      fixture(),
      { userId: "manager" },
      true,
      V2_DOUBLE_GROUP_ONLY_RESULT_VIEW_PROFILE,
    ).canSubmitResult,
    true,
  );
  assert.equal(
    buildV2GroupOnlyResultFixtureView(
      fixture("PENDING"),
      { userId: "a-2" },
      false,
      V2_DOUBLE_GROUP_ONLY_RESULT_VIEW_PROFILE,
    ).canConfirmPending,
    true,
  );
});

test("SINGLE participant submit compatibility remains enabled", () => {
  const input = fixture();
  assert.equal(
    buildV2GroupOnlyResultFixtureView(
      input,
      { userId: "a-1" },
      false,
      V2_SINGLE_GROUP_ONLY_RESULT_VIEW_PROFILE,
    ).canSubmitResult,
    true,
  );
});

test("TEAM exposes aggregate scoring only to frozen captains or managers", () => {
  const base = fixture();
  const teamFixture = {
    ...base,
    sideA: {
      ...base.sideA,
      frozenDisplayName: "甲队",
      members: [
        { userId: "a-captain", role: "captain" as const, isCurrentlyBanned: false },
        { userId: "a-player", role: "player" as const, isCurrentlyBanned: false },
      ],
    },
    sideB: {
      ...base.sideB,
      frozenDisplayName: "乙队",
      members: [
        { userId: "b-captain", role: "captain" as const, isCurrentlyBanned: false },
        { userId: "b-player", role: "player" as const, isCurrentlyBanned: false },
      ],
    },
  };
  assert.equal(
    buildV2GroupOnlyResultFixtureView(
      teamFixture,
      { userId: "a-captain" },
      false,
      V2_TEAM_GROUP_ONLY_RESULT_VIEW_PROFILE,
    ).canSubmitResult,
    true,
  );
  assert.equal(
    buildV2GroupOnlyResultFixtureView(
      teamFixture,
      { userId: "a-player" },
      false,
      V2_TEAM_GROUP_ONLY_RESULT_VIEW_PROFILE,
    ).canSubmitResult,
    false,
  );

  const pendingFixture = {
    ...teamFixture,
    activeResult: activeResult("PENDING"),
  };
  assert.equal(
    buildV2GroupOnlyResultFixtureView(
      pendingFixture,
      { userId: "b-captain" },
      false,
      V2_TEAM_GROUP_ONLY_RESULT_VIEW_PROFILE,
    ).canConfirmPending,
    true,
  );
  assert.equal(
    buildV2GroupOnlyResultFixtureView(
      pendingFixture,
      { userId: "b-player" },
      false,
      V2_TEAM_GROUP_ONLY_RESULT_VIEW_PROFILE,
    ).canConfirmPending,
    false,
  );

  const confirmed = revision("CONFIRMED");
  const aggregateFixture = {
    ...teamFixture,
    status: "COMPLETED" as const,
    activeResult: {
      state: "CONFIRMED" as const,
      currentRevisionId: confirmed.revisionId,
      revisionVersion: confirmed.revisionVersion,
      authoritativeConfirmedRevisionId: confirmed.revisionId,
      pendingRevision: null,
      confirmedRevision: {
        ...confirmed,
        winnerDisplayNameSnapshot: "甲队",
        loserDisplayNameSnapshot: "乙队",
        score: { winnerScore: 5, loserScore: 3 },
      },
    },
  };
  const view = buildV2GroupOnlyResultFixtureView(
    aggregateFixture,
    { userId: "manager" },
    true,
    V2_TEAM_GROUP_ONLY_RESULT_VIEW_PROFILE,
  );
  assert.deepEqual(view.authoritativeResult?.aggregateScore, {
    winnerScore: 5,
    loserScore: 3,
  });
  assert.equal(view.authoritativeResult?.score, null);
  assert.equal(view.authoritativeResult?.scoreLabel, "5:3（团体总比分）");
  assert.deepEqual(parseV2GroupOnlyTeamAggregateScore({ winnerScore: 3, loserScore: 1 }), {
    winnerScore: 3,
    loserScore: 1,
  });
  assert.equal(
    formatV2GroupOnlyResultScore(
      "PLAYED",
      { winnerScore: 2, loserScore: 2 },
      "TEAM_AGGREGATE",
    ),
    "团体总比分数据异常",
  );
});

test("manager forfeit exposes only eligible winners and renders a non-played score", () => {
  const input = fixture();
  const view = buildV2GroupOnlyResultFixtureView(
    {
      ...input,
      sideB: { ...input.sideB, entryStatus: "WITHDRAWN" },
    },
    { userId: "manager" },
    true,
    V2_DOUBLE_GROUP_ONLY_RESULT_VIEW_PROFILE,
  );
  assert.equal(view.canConfirmForfeit, true);
  assert.deepEqual(view.forfeitWinnerEntries, [
    { entryId: "entry-a", frozenDisplayName: "双打 A" },
  ]);
  const forfeited = buildV2GroupOnlyResultFixtureView(
    fixture("CONFIRMED", "FORFEIT"),
    { userId: "manager" },
    true,
    V2_DOUBLE_GROUP_ONLY_RESULT_VIEW_PROFILE,
  );
  assert.equal(forfeited.authoritativeResult?.score, null);
  assert.equal(forfeited.authoritativeResult?.scoreLabel, "弃权判胜（1:0）");
  assert.equal(forfeited.canSubmitCorrection, false);
  assert.equal(forfeited.canCorrectForfeit, true);
  assert.equal(forfeited.canVoidConfirmed, true);
  const unavailableCorrectedWinner = fixture("CONFIRMED", "FORFEIT");
  const unavailableView = buildV2GroupOnlyResultFixtureView(
    {
      ...unavailableCorrectedWinner,
      sideB: {
        ...unavailableCorrectedWinner.sideB,
        members: unavailableCorrectedWinner.sideB.members.map((member) => ({
          ...member,
          isCurrentlyBanned: true,
        })),
      },
    },
    { userId: "manager" },
    true,
    V2_DOUBLE_GROUP_ONLY_RESULT_VIEW_PROFILE,
  );
  assert.equal(unavailableView.canCorrectForfeit, false);
  assert.equal(
    buildV2GroupOnlyResultFixtureView(
      fixture("CONFIRMED", "FORFEIT"),
      { userId: "a-1" },
      false,
      V2_DOUBLE_GROUP_ONLY_RESULT_VIEW_PROFILE,
    ).canCorrectForfeit,
    false,
  );
  assert.equal(
    formatV2GroupOnlyResultScore("PLAYED", {
      bestOf: 7,
      winnerScore: 4,
      loserScore: 2,
    }),
    "4:2（7局4胜）",
  );
});
