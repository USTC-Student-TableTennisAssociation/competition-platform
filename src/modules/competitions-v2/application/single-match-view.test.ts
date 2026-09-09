import assert from "node:assert/strict";
import test from "node:test";

import type {
  V2SingleActiveResult,
  V2SingleEntryReadModel,
  V2SingleFixtureReadModel,
  V2SingleRevisionReadModel,
  V2UserDisplay,
} from "../read-model/single-match";
import {
  buildV2SingleMatchViewModel,
  formatV2SingleScore,
  type V2SingleMatchModel,
} from "../read-model/single-match-view";

const NOW = new Date("2026-09-04T08:00:00.000Z");

function profile(
  userId: string,
  nickname: string,
  isCurrentlyBanned = false,
): V2UserDisplay {
  return {
    userId,
    nickname,
    avatarUrl: null,
    currentEloRating: 1200,
    currentPoints: 5,
    isCurrentlyBanned,
  };
}

function entry(
  entryId: string,
  userId: string,
  frozenName: string,
  options: Readonly<{
    status?: V2SingleEntryReadModel["status"];
    banned?: boolean;
  }> = {},
): V2SingleEntryReadModel {
  const status = options.status ?? "ACTIVE";
  const currentProfile = profile(userId, `${frozenName}（当前）`, options.banned);
  return {
    entryId,
    entryVersion: 4,
    kind: "INDIVIDUAL",
    status,
    sourceKey: `individual:${userId}`,
    sourceUserId: userId,
    displayNameSnapshot: frozenName,
    seed: null,
    currentRosterVersion: 1,
    player: {
      userId,
      displayNameSnapshot: frozenName,
      profile: currentProfile,
    },
    members: [
      {
        entryMemberId: `member-${entryId}`,
        userId,
        displayNameSnapshot: frozenName,
        role: "player",
        status: "ACTIVE",
        slot: 1,
        rosterVersion: 1,
        effectiveFrom: NOW.toISOString(),
        effectiveUntil: null,
        endReason: null,
        profile: currentProfile,
      },
    ],
    withdrawnAt: null,
    disqualifiedAt: null,
    archivedAt: null,
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: NOW.toISOString(),
  };
}

function revision(
  revisionId: string,
  status: "PENDING" | "CONFIRMED",
  reporterId = "user-a",
  supersedesRevisionId: string | null = null,
): V2SingleRevisionReadModel {
  return {
    revisionId,
    revisionVersion: supersedesRevisionId ? 2 : 1,
    status,
    resolutionKind: "PLAYED",
    winnerEntryId: supersedesRevisionId ? "entry-b" : "entry-a",
    loserEntryId: supersedesRevisionId ? "entry-a" : "entry-b",
    winnerDisplayNameSnapshot: supersedesRevisionId ? "乙冻结名" : "甲冻结名",
    loserDisplayNameSnapshot: supersedesRevisionId ? "甲冻结名" : "乙冻结名",
    score: { bestOf: 5, winnerScore: 3, loserScore: 1 },
    reporter: { userId: reporterId, nickname: "登记人", avatarUrl: null },
    verifier: null,
    supersedesRevisionId,
    reason: null,
    resolvedAt: status === "CONFIRMED" ? NOW.toISOString() : null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function fixtureSide(source: V2SingleEntryReadModel) {
  const player = source.player;
  if (!player) throw new Error("test entry needs a current player");
  return {
    entryId: source.entryId,
    entryVersion: source.entryVersion,
    entryStatus: source.status,
    entryDisplayNameSnapshot: source.displayNameSnapshot,
    rosterVersion: 1,
    player: {
      entryMemberId: `member-${source.entryId}`,
      userId: player.userId,
      displayNameSnapshot: source.displayNameSnapshot,
      profile: player.profile,
    },
  };
}

function activeResult(
  state: "NONE" | "PENDING" | "CONFIRMED" | "CORRECTION_PENDING",
): V2SingleActiveResult {
  const pending = revision("revision-pending", "PENDING");
  const confirmed = revision("revision-confirmed", "CONFIRMED");
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
  if (state === "PENDING") {
    return {
      state,
      currentRevisionId: pending.revisionId,
      revisionVersion: pending.revisionVersion,
      authoritativeConfirmedRevisionId: null,
      pendingRevision: pending,
      confirmedRevision: null,
    };
  }
  if (state === "CONFIRMED") {
    return {
      state,
      currentRevisionId: confirmed.revisionId,
      revisionVersion: confirmed.revisionVersion,
      authoritativeConfirmedRevisionId: confirmed.revisionId,
      pendingRevision: null,
      confirmedRevision: confirmed,
    };
  }
  const correction = revision(
    "revision-correction",
    "PENDING",
    "manager",
    confirmed.revisionId,
  );
  return {
    state,
    currentRevisionId: correction.revisionId,
    revisionVersion: correction.revisionVersion,
    authoritativeConfirmedRevisionId: confirmed.revisionId,
    pendingRevision: correction,
    confirmedRevision: confirmed,
  };
}

function fixture(
  entryA: V2SingleEntryReadModel,
  entryB: V2SingleEntryReadModel,
  state: "NONE" | "PENDING" | "CONFIRMED" | "CORRECTION_PENDING" = "NONE",
  statusOverride?: V2SingleFixtureReadModel["status"],
): V2SingleFixtureReadModel {
  return {
    fixtureId: "fixture-1",
    fixtureKey: "group:0001:pair:0001-0002",
    fixtureVersion: 9,
    stage: "GROUP",
    status:
      statusOverride ??
      (state === "CONFIRMED" || state === "CORRECTION_PENDING"
        ? "COMPLETED"
        : "READY"),
    groupKey: "group:0001",
    tableLabels: [],
    roundNumber: null,
    position: null,
    sideA: fixtureSide(entryA),
    sideB: fixtureSide(entryB),
    feeders: { sideA: null, sideB: null },
    activeResult: activeResult(state),
    currentRevisionId:
      state === "NONE"
        ? null
        : state === "CORRECTION_PENDING"
          ? "revision-correction"
          : state === "CONFIRMED"
            ? "revision-confirmed"
            : "revision-pending",
    revisionVersion: state === "NONE" ? null : state === "CORRECTION_PENDING" ? 2 : 1,
    scheduledAt: null,
    startedAt: NOW.toISOString(),
    completedAt:
      state === "CONFIRMED" || state === "CORRECTION_PENDING"
        ? NOW.toISOString()
        : null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function model(input: Readonly<{
  state?: "NONE" | "PENDING" | "CONFIRMED" | "CORRECTION_PENDING";
  entryA?: V2SingleEntryReadModel;
  entryB?: V2SingleEntryReadModel;
  format?: "group_only" | "group_then_knockout";
  extraStage?: "KNOCKOUT" | "FREE_PLAY";
  fixtureStatus?: V2SingleFixtureReadModel["status"];
}> = {}): V2SingleMatchModel {
  const entryA = input.entryA ?? entry("entry-a", "user-a", "甲冻结名");
  const entryB = input.entryB ?? entry("entry-b", "user-b", "乙冻结名");
  const groupFixture = fixture(
    entryA,
    entryB,
    input.state,
    input.fixtureStatus,
  );
  const groupingMember = (item: V2SingleEntryReadModel) => ({
    entryMemberId: `member-${item.entryId}`,
    userId: item.player!.userId,
    frozenDisplayName: item.displayNameSnapshot,
    nickname: item.player!.profile.nickname,
    avatarUrl: item.player!.profile.avatarUrl,
    slot: 1,
    role: "player" as const,
    rosterVersion: 1,
    isCurrentlyBanned: item.player!.profile.isCurrentlyBanned,
  });
  const groupingGroup = {
    groupId: "group-id-1",
    groupKey: "group:0001",
    displayName: "第 1 组",
    position: 1,
    tableLabels: [] as readonly string[],
    entries: [entryA, entryB].map((item, index) => ({
      entryId: item.entryId,
      frozenDisplayName: item.displayNameSnapshot,
      sourceCompetitorId: item.player!.userId,
      entryVersionAtPublication: item.entryVersion,
      rosterVersion: 1,
      seedElo: 1200 - index,
      seedPoints: 5,
      globalSeedRank: index + 1,
      members: [groupingMember(item)],
    })),
    fixtures: [
      {
        fixtureId: groupFixture.fixtureId,
        fixtureKey: groupFixture.fixtureKey,
        fixtureVersion: groupFixture.fixtureVersion,
        status: groupFixture.status,
        sideA: {
          entryId: entryA.entryId,
          entryStatus: entryA.status,
          frozenDisplayName: entryA.displayNameSnapshot,
          members: [groupingMember(entryA)],
        },
        sideB: {
          entryId: entryB.entryId,
          entryStatus: entryB.status,
          frozenDisplayName: entryB.displayNameSnapshot,
          members: [groupingMember(entryB)],
        },
        activeResult: groupFixture.activeResult,
      },
    ],
  };
  const format = input.format ?? "group_only";
  return {
    kind: "SINGLE_V2_MATCH",
    engineVersion: "V2",
    match: {
      id: "match-1",
      title: "单打赛",
      description: null,
      dateTime: "2026-09-06T08:00:00.000Z",
      location: null,
      isQuickMatch: false,
      type: "single",
      status: "registration",
      engineVersion: "V2",
      format,
      maxParticipants: 32,
      createdBy: "manager",
      creator: { userId: "manager", nickname: "管理员", avatarUrl: null },
      registrationDeadline: "2026-09-05T08:00:00.000Z",
      groupingGeneratedAt: NOW.toISOString(),
      createdAt: "2026-09-01T08:00:00.000Z",
      updatedAt: NOW.toISOString(),
    },
    entries: [entryA, entryB],
    fixtures: [groupFixture],
    groups: [
      {
        groupKey: "group:0001",
        tableLabels: [],
        fixtureIds: [groupFixture.fixtureId],
        participants: [entryA, entryB].map((item) => ({
          entryId: item.entryId,
          entryVersion: item.entryVersion,
          entryStatus: item.status,
          userId: item.player?.userId ?? null,
          displayNameSnapshot: item.displayNameSnapshot,
          currentProfile: item.player?.profile ?? null,
        })),
      },
    ],
    stageFixtureIds: {
      group: [groupFixture.fixtureId],
      knockout: input.extraStage === "KNOCKOUT" ? ["unexpected-ko"] : [],
      freePlay: input.extraStage === "FREE_PLAY" ? ["unexpected-free"] : [],
    },
    grouping:
      format === "group_only"
        ? {
            kind: "GROUP_ONLY_V2_MATCH",
            match: {
              id: "match-1",
              title: "单打赛",
              type: "single",
              status: "ongoing",
              format,
              createdBy: "manager",
              registrationDeadline: "2026-09-05T08:00:00.000Z",
              groupingGeneratedAt: NOW.toISOString(),
            },
            activeEntries: [],
            groups: [groupingGroup],
            published: true,
          }
        : {
            kind: "GROUP_THEN_KNOCKOUT_V2_MATCH",
            match: {
              id: "match-1",
              title: "单打赛",
              type: "single",
              status: "ongoing",
              format,
              createdBy: "manager",
              registrationDeadline: "2026-09-05T08:00:00.000Z",
              groupingGeneratedAt: NOW.toISOString(),
            },
            activeEntries: [],
            groups: [groupingGroup],
            published: true,
            qualifiersPerGroup: 1,
            managementState: "GROUP_IN_PROGRESS",
            qualification: null,
            knockout: null,
          },
  };
}

function firstFixture(view: ReturnType<typeof buildV2SingleMatchViewModel>) {
  const result = view.groups[0]?.fixtures[0];
  if (!result) throw new Error("test model needs one visible fixture");
  return result;
}

function editableModel(
  matchOverrides: Partial<V2SingleMatchModel["match"]> = {},
): V2SingleMatchModel {
  const base = model();
  return {
    ...base,
    match: {
      ...base.match,
      status: "registration",
      registrationDeadline: "2026-09-05T08:00:00.000Z",
      groupingGeneratedAt: null,
      ...matchOverrides,
    },
    fixtures: [],
    groups: [],
    stageFixtureIds: { group: [], knockout: [], freePlay: [] },
  };
}

test("the view model preserves V2 command IDs, versions, and frozen names", () => {
  const view = buildV2SingleMatchViewModel(
    model(),
    { userId: "user-a", role: "user" },
    NOW,
  );
  const projected = firstFixture(view);

  assert.equal(projected.fixtureId, "fixture-1");
  assert.equal(projected.fixtureVersion, 9);
  assert.equal(projected.sideA.entryId, "entry-a");
  assert.equal(projected.sideA.entryVersion, 4);
  assert.equal(projected.sideA.frozenDisplayName, "甲冻结名");
  assert.equal(projected.sideA.currentProfile?.nickname, "甲冻结名（当前）");
  assert.equal(projected.canSubmitResult, true);
  assert.deepEqual(
    view.activeEntries.map((item) => item.entryId),
    ["entry-a", "entry-b"],
  );
});

test("result submission is shown only to a fixture participant or manager", () => {
  assert.equal(
    firstFixture(
      buildV2SingleMatchViewModel(
        model(),
        { userId: "outsider", role: "user" },
        NOW,
      ),
    ).canSubmitResult,
    false,
  );
  assert.equal(
    firstFixture(
      buildV2SingleMatchViewModel(
        model(),
        { userId: "manager", role: "user" },
        NOW,
      ),
    ).canSubmitResult,
    true,
  );
  const bannedOpponent = model({
    entryB: entry("entry-b", "user-b", "乙冻结名", { banned: true }),
  });
  assert.equal(
    firstFixture(
      buildV2SingleMatchViewModel(
        bannedOpponent,
        { userId: "user-a", role: "user" },
        NOW,
      ),
    ).canSubmitResult,
    false,
  );
});

test("only managers can void an unplayed fixture without an active result", () => {
  const participant = firstFixture(
    buildV2SingleMatchViewModel(
      model(),
      { userId: "user-a", role: "user" },
      NOW,
    ),
  );
  assert.equal(participant.canVoidUnplayed, false);

  const manager = firstFixture(
    buildV2SingleMatchViewModel(
      model(),
      { userId: "manager", role: "user" },
      NOW,
    ),
  );
  assert.equal(manager.canVoidUnplayed, true);
  assert.equal(
    firstFixture(
      buildV2SingleMatchViewModel(
        model({ fixtureStatus: "SCHEDULED" }),
        { userId: "manager", role: "admin" },
        NOW,
      ),
    ).canVoidUnplayed,
    true,
  );
  assert.equal(
    firstFixture(
      buildV2SingleMatchViewModel(
        model({ state: "PENDING" }),
        { userId: "manager", role: "admin" },
        NOW,
      ),
    ).canVoidUnplayed,
    false,
  );
  assert.equal(
    firstFixture(
      buildV2SingleMatchViewModel(
        model({ state: "CONFIRMED" }),
        { userId: "manager", role: "admin" },
        NOW,
      ),
    ).canVoidUnplayed,
    false,
  );
  assert.equal(
    firstFixture(
      buildV2SingleMatchViewModel(
        model({ fixtureStatus: "VOIDED" }),
        { userId: "manager", role: "admin" },
        NOW,
      ),
    ).canVoidUnplayed,
    false,
  );
});

test("an initial pending result separates confirm and manager-only reject", () => {
  const pendingModel = model({ state: "PENDING" });
  const reporter = firstFixture(
    buildV2SingleMatchViewModel(
      pendingModel,
      { userId: "user-a", role: "user" },
      NOW,
    ),
  );
  assert.equal(reporter.canConfirmPending, false);
  assert.equal(reporter.canRejectPending, false);

  const opponent = firstFixture(
    buildV2SingleMatchViewModel(
      pendingModel,
      { userId: "user-b", role: "user" },
      NOW,
    ),
  );
  assert.equal(opponent.canConfirmPending, true);
  assert.equal(opponent.canRejectPending, false);

  const manager = firstFixture(
    buildV2SingleMatchViewModel(
      pendingModel,
      { userId: "manager", role: "user" },
      NOW,
    ),
  );
  assert.equal(manager.canConfirmPending, true);
  assert.equal(manager.canRejectPending, true);
  assert.equal(manager.pendingResult?.revisionId, "revision-pending");

  const bannedRoster = firstFixture(
    buildV2SingleMatchViewModel(
      model({
        state: "PENDING",
        entryB: entry("entry-b", "user-b", "乙冻结名", { banned: true }),
      }),
      { userId: "manager", role: "admin" },
      NOW,
    ),
  );
  assert.equal(bannedRoster.canConfirmPending, false);
  assert.equal(bannedRoster.canRejectPending, true);
});

test("a correction keeps the confirmed revision authoritative and manager-only", () => {
  const correctionModel = model({
    state: "CORRECTION_PENDING",
    entryA: entry("entry-a", "user-a", "甲冻结名", {
      status: "WITHDRAWN",
    }),
  });
  const participant = firstFixture(
    buildV2SingleMatchViewModel(
      correctionModel,
      { userId: "user-a", role: "user" },
      NOW,
    ),
  );
  assert.equal(participant.canConfirmPending, false);
  assert.equal(participant.canRejectPending, false);
  assert.equal(participant.canSubmitCorrection, false);
  assert.equal(participant.canVoidConfirmed, false);
  assert.equal(participant.authoritativeResult?.revisionId, "revision-confirmed");
  assert.equal(participant.pendingResult?.revisionId, "revision-correction");

  const manager = firstFixture(
    buildV2SingleMatchViewModel(
      correctionModel,
      { userId: "manager", role: "admin" },
      NOW,
    ),
  );
  assert.equal(manager.canConfirmPending, true);
  assert.equal(manager.canRejectPending, true);
  assert.equal(manager.canSubmitCorrection, false);
  assert.equal(manager.canVoidConfirmed, false);

  const bannedRoster = firstFixture(
    buildV2SingleMatchViewModel(
      model({
        state: "CORRECTION_PENDING",
        entryB: entry("entry-b", "user-b", "乙冻结名", { banned: true }),
      }),
      { userId: "manager", role: "admin" },
      NOW,
    ),
  );
  assert.equal(bannedRoster.canConfirmPending, false);
  assert.equal(bannedRoster.canRejectPending, true);
});

test("only a manager can correct or void a confirmed result", () => {
  const confirmedModel = model({ state: "CONFIRMED" });
  const participant = firstFixture(
    buildV2SingleMatchViewModel(
      confirmedModel,
      { userId: "user-a", role: "user" },
      NOW,
    ),
  );
  assert.equal(participant.canSubmitCorrection, false);
  assert.equal(participant.canVoidConfirmed, false);

  const manager = firstFixture(
    buildV2SingleMatchViewModel(
      confirmedModel,
      { userId: "manager", role: "user" },
      NOW,
    ),
  );
  assert.equal(manager.canSubmitCorrection, true);
  assert.equal(manager.canVoidConfirmed, true);
  assert.deepEqual(manager.authoritativeResult?.score, {
    bestOf: 5,
    winnerScore: 3,
    loserScore: 1,
  });

  const bannedParticipant = firstFixture(
    buildV2SingleMatchViewModel(
      model({
        state: "CONFIRMED",
        entryB: entry("entry-b", "user-b", "乙冻结名", { banned: true }),
      }),
      { userId: "manager", role: "admin" },
      NOW,
    ),
  );
  assert.equal(bannedParticipant.canSubmitCorrection, false);
  assert.equal(bannedParticipant.canVoidConfirmed, true);
});

test("registration actions follow the V2 Entry state and registration window", () => {
  assert.equal(
    buildV2SingleMatchViewModel(model(), null, NOW).registration.action,
    "LOGIN",
  );
  assert.equal(
    buildV2SingleMatchViewModel(
      model(),
      { userId: "user-a", role: "user" },
      NOW,
    ).registration.action,
    "CANCEL",
  );
  assert.equal(
    buildV2SingleMatchViewModel(
      model(),
      { userId: "new-user", role: "user" },
      NOW,
    ).registration.action,
    "REGISTER",
  );
  assert.equal(
    buildV2SingleMatchViewModel(
      model(),
      { userId: "new-user", role: "user" },
      new Date("2026-09-05T08:00:00.000Z"),
    ).registration.action,
    "CLOSED",
  );
});

test("settings edit affordance is creator-only during registration before publication", () => {
  assert.equal(
    buildV2SingleMatchViewModel(
      editableModel(),
      { userId: "manager", role: "user" },
      NOW,
    ).canEditSettings,
    true,
  );
  assert.equal(
    buildV2SingleMatchViewModel(
      editableModel(),
      { userId: "admin-outsider", role: "admin" },
      NOW,
    ).canEditSettings,
    false,
  );
  for (const closed of [
    editableModel({ status: "ongoing" }),
    editableModel({ createdAt: "2026-09-04T08:00:00.001Z" }),
    editableModel({ registrationDeadline: NOW.toISOString() }),
    editableModel({ groupingGeneratedAt: NOW.toISOString() }),
    {
      ...editableModel(),
      fixtures: model().fixtures,
    },
  ]) {
    assert.equal(
      buildV2SingleMatchViewModel(
        closed,
        { userId: "manager", role: "admin" },
        NOW,
      ).canEditSettings,
      false,
    );
  }
});

test("group-then-knockout is supported while impossible formal stages fail closed", () => {
  const groupThen = buildV2SingleMatchViewModel(
    model({ format: "group_then_knockout" }),
    { userId: "manager", role: "admin" },
    NOW,
  );
  assert.equal(groupThen.supported, true);
  assert.notEqual(groupThen.registration.action, "UNAVAILABLE");

  for (const unsupported of [
    model({ extraStage: "KNOCKOUT" }),
    model({ extraStage: "FREE_PLAY" }),
  ]) {
    const view = buildV2SingleMatchViewModel(
      unsupported,
      { userId: "manager", role: "admin" },
      NOW,
    );
    assert.equal(view.supported, false);
    assert.equal(view.registration.action, "UNAVAILABLE");
    assert.deepEqual(view.groups, []);
  }
});

test("score labels accept only the canonical 3/5/7-game shape", () => {
  assert.equal(
    formatV2SingleScore({ bestOf: 7, winnerScore: 4, loserScore: 2 }),
    "4:2（7局4胜）",
  );
  assert.equal(
    formatV2SingleScore({ bestOf: 4, winnerScore: 3, loserScore: 1 }),
    "比分数据异常",
  );
  assert.equal(
    formatV2SingleScore({ bestOf: 5, winnerScore: 2, loserScore: 3 }),
    "比分数据异常",
  );
});
