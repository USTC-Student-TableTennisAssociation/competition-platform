import assert from "node:assert/strict";
import test from "node:test";
import type { V2GroupOnlyGroupingFixture } from "../read-model/group-only-grouping";
import type { V2GroupOnlyRevisionReadModel } from "../read-model/group-only-results";
import {
  buildV2GroupOnlyResultFixtureView,
  V2_DOUBLE_GROUP_ONLY_RESULT_VIEW_PROFILE as DOUBLE,
  V2_TEAM_GROUP_ONLY_RESULT_VIEW_PROFILE as TEAM,
  type V2GroupOnlyResultViewProfile,
} from "../read-model/group-only-result-view";
import { memberFixtureGuidance } from "../read-model/member-fixture-guidance";

function fixture(): V2GroupOnlyGroupingFixture {
  const side = (prefix: string) => ({
    entryId: prefix,
    entryStatus: "ACTIVE" as const,
    frozenDisplayName: `${prefix}队`,
    members: [1, 2].map((slot) => ({
      entryMemberId: `${prefix}-${slot}`,
      userId: `${prefix}-${slot}`,
      frozenDisplayName: `${prefix}${slot}`,
      nickname: "当前昵称可能已修改",
      avatarUrl: null,
      slot,
      role: slot === 1 ? ("captain" as const) : ("player" as const),
      rosterVersion: 1,
      isCurrentlyBanned: false,
    })),
  });
  const pending: V2GroupOnlyRevisionReadModel = {
    revisionId: "pending",
    revisionVersion: 1,
    status: "PENDING",
    resolutionKind: "PLAYED",
    winnerEntryId: "a",
    loserEntryId: "b",
    winnerDisplayNameSnapshot: "a队",
    loserDisplayNameSnapshot: "b队",
    score: { bestOf: 5, winnerScore: 3, loserScore: 1 },
    reporter: { userId: "a-1", nickname: "a1", avatarUrl: null },
    verifier: null,
    supersedesRevisionId: null,
    reason: null,
    resolvedAt: null,
    createdAt: "2026-10-04T00:00:00Z",
    updatedAt: "2026-10-04T00:00:00Z",
  };
  return {
    fixtureId: "fixture",
    fixtureKey: "group:1:pair:1-2",
    fixtureVersion: 2,
    status: "READY",
    sideA: side("a"),
    sideB: side("b"),
    activeResult: {
      state: "PENDING",
      currentRevisionId: pending.revisionId,
      revisionVersion: 1,
      authoritativeConfirmedRevisionId: null,
      pendingRevision: pending,
      confirmedRevision: null,
    },
  };
}

function guidance(
  input: V2GroupOnlyGroupingFixture,
  userId: string | null,
  profile: V2GroupOnlyResultViewProfile,
  manager = false,
) {
  const view = buildV2GroupOnlyResultFixtureView(
    input,
    userId ? { userId } : null,
    manager,
    profile,
  );
  return memberFixtureGuidance(input, view, userId, manager, profile);
}

test("doubles waiting message includes the reporter's partner and both opponents under current policy", () => {
  const result = guidance(fixture(), "a-1", DOUBLE);
  assert.equal(result.pendingHint, "等待 a2、b1、b2 确认，管理员也可处理。");
  assert.equal(result.sideACaption, "我方");
  assert.equal(result.sideBCaption, undefined);
  assert.equal(result.roleHint, null);
});

test("team waiting message names only the other frozen captain", () => {
  const result = guidance(fixture(), "a-1", TEAM);
  assert.equal(result.pendingHint, "等待队长 b1 确认，管理员也可处理。");
  assert.equal(result.roleHint, null);
  assert.equal(result.sideACaption, "本队");
});

test("ordinary team members learn which frozen captain handles their result", () => {
  const result = guidance(fixture(), "b-2", TEAM);
  assert.match(result.roleHint!, /队长 b1录入和确认比分/);
  assert.equal(result.sideBCaption, "本队");
  assert.equal(result.pendingHint, "等待队长 b1 确认，管理员也可处理。");
});

test("eligible confirming members receive their next action rather than a waiting message", () => {
  assert.equal(
    guidance(fixture(), "a-2", DOUBLE).pendingHint,
    "请你核对双方和比分，确认后计入正式成绩。",
  );
  assert.equal(
    guidance(fixture(), "b-1", TEAM).pendingHint,
    "请你核对双方和比分，确认后计入正式成绩。",
  );
});

test("banned or withdrawn sides direct pending results to a manager", () => {
  const input = fixture();
  const banned = {
    ...input,
    sideB: {
      ...input.sideB,
      members: input.sideB.members.map((m) => ({
        ...m,
        isCurrentlyBanned: true,
      })),
    },
  };
  assert.equal(
    guidance(banned, "a-1", DOUBLE).pendingHint,
    "等待管理员核对并处理本场比分。",
  );
  const withdrawn = {
    ...input,
    sideB: { ...input.sideB, entryStatus: "WITHDRAWN" as const },
  };
  assert.equal(
    guidance(withdrawn, "a-1", TEAM).pendingHint,
    "等待管理员核对并处理本场比分。",
  );
});

test("corrections preserve the original result and direct participants to manager review", () => {
  const input = fixture();
  const pending = input.activeResult.pendingRevision!;
  const corrected: V2GroupOnlyGroupingFixture = {
    ...input,
    status: "COMPLETED",
    activeResult: {
      state: "CORRECTION_PENDING",
      currentRevisionId: "pending",
      revisionVersion: 2,
      authoritativeConfirmedRevisionId: "original",
      pendingRevision: { ...pending, supersedesRevisionId: "original" },
      confirmedRevision: {
        ...pending,
        revisionId: "original",
        status: "CONFIRMED",
        verifier: { userId: "b-1", nickname: "b1", avatarUrl: null },
      },
    },
  };
  assert.equal(
    guidance(corrected, "b-1", DOUBLE).pendingHint,
    "等待管理员核对更正；原赛果仍然生效。",
  );
  assert.equal(
    guidance(corrected, "manager", DOUBLE, true).pendingHint,
    "请你核对双方和比分，确认后计入正式成绩。",
  );
});

test("spectators do not receive a personal side or team role", () => {
  const result = guidance(fixture(), null, TEAM);
  assert.equal(result.sideACaption, undefined);
  assert.equal(result.sideBCaption, undefined);
  assert.equal(result.roleHint, null);
});
