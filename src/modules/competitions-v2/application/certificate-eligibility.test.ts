import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateV2CertificateEligibility,
  type V2CertificateCompetitionSnapshot,
  type V2CertificateEntrySnapshot,
  type V2CertificateFixtureSnapshot,
  type V2CertificateRevisionSnapshot,
} from "./certificate-eligibility";

const MATCH_ID = "match-1";
const GROUPING_ID = "grouping-1";
const NOW = new Date("2026-09-05T08:00:00.000Z");

type MatchType = V2CertificateCompetitionSnapshot["match"]["type"];
type EntryStatus = V2CertificateEntrySnapshot["status"];

function entry(
  id: string,
  userIds: readonly string[],
  type: MatchType,
  status: EntryStatus = "ACTIVE",
  options: Readonly<{ currentDraftRoster?: boolean }> = {},
): V2CertificateEntrySnapshot {
  const hasCurrentRoster =
    status === "ACTIVE" || (status === "DRAFT" && options.currentDraftRoster === true);
  return {
    id,
    kind: type === "single" ? "INDIVIDUAL" : type === "double" ? "DOUBLES" : "TEAM",
    status,
    version: 0,
    members: userIds.map((userId, index) => ({
      id: `${id}-member-${index + 1}`,
      matchId: MATCH_ID,
      entryId: id,
      userId,
      role: type === "team" && index === 0 ? "captain" : "player",
      status: hasCurrentRoster ? "ACTIVE" : "DISQUALIFIED",
      slot: index + 1,
      rosterVersion: 1,
      effectiveUntil: hasCurrentRoster ? null : NOW,
    })),
  };
}

function resultEvents(
  revisionId: string,
  userIds: readonly string[],
  state: "APPLIED" | "REVERSED",
) {
  const application = {
    id: `${revisionId}-apply`,
    kind: "RESULT_APPLY" as const,
    status: state,
    resultRevisionId: revisionId,
    matchEntryId: null,
    reversesEventId: null,
    failureReason: null,
    appliedAt: NOW,
    effects: userIds.map((userId) => ({ userId })),
  };
  return state === "APPLIED"
    ? [application]
    : [
        application,
        {
          id: `${revisionId}-reversal`,
          kind: "RESULT_REVERSAL" as const,
          status: "APPLIED" as const,
          resultRevisionId: revisionId,
          matchEntryId: null,
          reversesEventId: application.id,
          failureReason: null,
          appliedAt: NOW,
          effects: userIds.map((userId) => ({ userId })),
        },
      ];
}

function revision(
  fixtureId: string,
  sideA: V2CertificateEntrySnapshot,
  sideB: V2CertificateEntrySnapshot,
  options: Readonly<{
    id?: string;
    number?: number;
    status?: V2CertificateRevisionSnapshot["status"];
    resolutionKind?: V2CertificateRevisionSnapshot["resolutionKind"];
    supersedesRevisionId?: string | null;
    settlement?: "APPLIED" | "REVERSED" | "NONE";
  }> = {},
): V2CertificateRevisionSnapshot {
  const status = options.status ?? "CONFIRMED";
  const resolutionKind = options.resolutionKind ?? "PLAYED";
  const id = options.id ?? `${fixtureId}-revision-${options.number ?? 1}`;
  const userIds = [...sideA.members, ...sideB.members].map((member) => member.userId);
  const defaultSettlement =
    resolutionKind === "FORFEIT"
      ? "NONE"
      : status === "CONFIRMED"
        ? "APPLIED"
        : status === "SUPERSEDED"
          ? "REVERSED"
          : "NONE";
  const settlement = options.settlement ?? defaultSettlement;
  return {
    id,
    matchId: MATCH_ID,
    fixtureId,
    revisionNumber: options.number ?? 1,
    status,
    resolutionKind,
    winnerEntryId: sideA.id,
    loserEntryId: sideB.id,
    score:
      resolutionKind === "FORFEIT"
        ? { winnerScore: 1, loserScore: 0 }
        : sideA.kind === "TEAM"
          ? { winnerScore: 3, loserScore: 1 }
          : { bestOf: 3, winnerScore: 2, loserScore: 0 },
    reason: resolutionKind === "FORFEIT" ? "对手弃权" : null,
    verifiedById: status === "PENDING" ? null : "verifier-1",
    supersedesRevisionId: options.supersedesRevisionId ?? null,
    resolvedAt: status === "PENDING" ? null : NOW,
    settlementEvents:
      settlement === "NONE" ? [] : resultEvents(id, userIds, settlement),
  };
}

function fixture(
  sideA: V2CertificateEntrySnapshot,
  sideB: V2CertificateEntrySnapshot,
  positions: readonly [number, number],
  options: Readonly<{
    id?: string;
    stage?: "GROUP" | "KNOCKOUT";
    status?: V2CertificateFixtureSnapshot["status"];
    revisions?: readonly V2CertificateRevisionSnapshot[];
    resolutionKind?: "PLAYED" | "FORFEIT";
    groupPosition?: number;
    roundNumber?: number;
    position?: number;
  }> = {},
): V2CertificateFixtureSnapshot {
  const stage = options.stage ?? "GROUP";
  const groupPosition = options.groupPosition ?? 1;
  const groupKey = `group:${String(groupPosition).padStart(4, "0")}`;
  const id = options.id ?? `${stage.toLowerCase()}-${sideA.id}-${sideB.id}`;
  const status = options.status ?? "COMPLETED";
  return {
    id,
    matchId: MATCH_ID,
    fixtureKey:
      stage === "GROUP"
        ? `${groupKey}:pair:${String(positions[0]).padStart(4, "0")}-${String(
            positions[1],
          ).padStart(4, "0")}`
        : `knockout:r${String(options.roundNumber ?? 1).padStart(4, "0")}:m${String(
            options.position ?? 1,
          ).padStart(4, "0")}`,
    stage,
    status,
    groupId: stage === "GROUP" ? `group-${groupPosition}` : null,
    groupKey: stage === "GROUP" ? groupKey : null,
    roundNumber: stage === "KNOCKOUT" ? options.roundNumber ?? 1 : null,
    position: stage === "KNOCKOUT" ? options.position ?? 1 : null,
    sideAEntryId: sideA.id,
    sideBEntryId: sideB.id,
    sideARosterVersion: 1,
    sideBRosterVersion: 1,
    completedAt: status === "COMPLETED" ? NOW : null,
    lineupMembers: [
      ...sideA.members.map((member) => ({
        id: `${id}-lineup-a-${member.slot}`,
        matchId: MATCH_ID,
        fixtureId: id,
        entryId: sideA.id,
        entryMemberId: member.id,
        side: "SIDE_A" as const,
        position: member.slot,
      })),
      ...sideB.members.map((member) => ({
        id: `${id}-lineup-b-${member.slot}`,
        matchId: MATCH_ID,
        fixtureId: id,
        entryId: sideB.id,
        entryMemberId: member.id,
        side: "SIDE_B" as const,
        position: member.slot,
      })),
    ],
    resultRevisions:
      options.revisions ??
      (status === "COMPLETED"
        ? [revision(id, sideA, sideB, { resolutionKind: options.resolutionKind })]
        : []),
  };
}

function snapshot(
  type: MatchType,
  format: V2CertificateCompetitionSnapshot["match"]["format"],
  groups: readonly (readonly V2CertificateEntrySnapshot[])[],
  fixtures: readonly V2CertificateFixtureSnapshot[],
  extraEntries: readonly V2CertificateEntrySnapshot[] = [],
): V2CertificateCompetitionSnapshot {
  const groupedEntries = groups.flat();
  const entries = [...groupedEntries, ...extraEntries];
  const knockoutFixtures = fixtures.filter((item) => item.stage === "KNOCKOUT");
  const hasKnockout = knockoutFixtures.length > 0;
  return {
    match: {
      id: MATCH_ID,
      engineVersion: "V2",
      isQuickMatch: false,
      type,
      format,
      groupingGeneratedAt: NOW,
      teamMinMembers: type === "team" ? 2 : null,
      teamMaxMembers: type === "team" ? 4 : null,
    },
    grouping: {
      id: GROUPING_ID,
      matchId: MATCH_ID,
      v2SchemaVersion: 1,
      seedMethod: "MIN_DIFF",
      standingsPolicyVersion: 1,
      qualifiersPerGroup: format === "group_then_knockout" ? 1 : null,
      bracketPolicyVersion: format === "group_then_knockout" ? 1 : null,
      createdAt: NOW,
      qualificationSnapshot: hasKnockout
        ? { id: "qualification-1", matchId: MATCH_ID, groupingId: GROUPING_ID }
        : null,
    },
    groups: groups.map((members, groupIndex) => ({
      id: `group-${groupIndex + 1}`,
      matchId: MATCH_ID,
      groupingId: GROUPING_ID,
      groupKey: `group:${String(groupIndex + 1).padStart(4, "0")}`,
      position: groupIndex + 1,
      entries: members.map((member, entryIndex) => ({
        id: `membership-${member.id}`,
        matchId: MATCH_ID,
        groupId: `group-${groupIndex + 1}`,
        entryId: member.id,
        position: entryIndex + 1,
        globalSeedRank:
          groups.slice(0, groupIndex).reduce((total, group) => total + group.length, 0) +
          entryIndex +
          1,
        entryVersion: 0,
        rosterVersion: 1,
      })),
    })),
    entries,
    fixtures,
    fixtureDependencies: hasKnockout
      ? knockoutFixtures.flatMap((item, index) => [
          {
            id: `${item.id}-dependency-a`,
            matchId: MATCH_ID,
            sourceFixtureId: null,
            sourceOutcome: null,
            sourceQualificationStandingId: `standing-${index}-a`,
            targetFixtureId: item.id,
            targetSide: "SIDE_A" as const,
          },
          {
            id: `${item.id}-dependency-b`,
            matchId: MATCH_ID,
            sourceFixtureId: null,
            sourceOutcome: null,
            sourceQualificationStandingId: `standing-${index}-b`,
            targetFixtureId: item.id,
            targetSide: "SIDE_B" as const,
          },
        ])
      : [],
  };
}

for (const type of ["single", "double", "team"] as const) {
  for (const format of ["group_only", "group_then_knockout"] as const) {
    test(`${type} + ${format} qualifies from the current EntryMember roster`, () => {
      const rosterSize = type === "single" ? 1 : 2;
      const a = entry(
        "entry-a",
        Array.from({ length: rosterSize }, (_, index) => `user-a-${index + 1}`),
        type,
      );
      const b = entry(
        "entry-b",
        Array.from({ length: rosterSize }, (_, index) => `user-b-${index + 1}`),
        type,
      );
      const result = evaluateV2CertificateEligibility(
        snapshot(type, format, [[a, b]], [fixture(a, b, [1, 2])]),
        "user-a-1",
      );
      assert.equal(result.state, "ELIGIBLE", JSON.stringify(result));
    });
  }
}

test("a forfeit satisfies an active-opponent obligation but is not participation evidence", () => {
  const a = entry("entry-a", ["user-a"], "single");
  const b = entry("entry-b", ["user-b"], "single");
  const c = entry("entry-c", ["user-c"], "single");
  const played = fixture(a, b, [1, 2]);
  const forfeit = fixture(a, c, [1, 3], { resolutionKind: "FORFEIT" });
  const other = fixture(b, c, [2, 3]);
  const eligible = evaluateV2CertificateEligibility(
    snapshot("single", "group_only", [[a, b, c]], [played, forfeit, other]),
    "user-a",
  );
  assert.equal(eligible.state, "ELIGIBLE");

  const onlyForfeit = evaluateV2CertificateEligibility(
    snapshot("single", "group_only", [[a, b]], [
      fixture(a, b, [1, 2], { resolutionKind: "FORFEIT" }),
    ]),
    "user-a",
  );
  assert.equal(onlyForfeit.state, "INELIGIBLE");
  if (onlyForfeit.state === "INELIGIBLE") {
    assert.equal(onlyForfeit.code, "NO_CONFIRMED_FIXTURE");
  }
});

test("FORFEIT with any global settlement is corrupt", () => {
  const a = entry("entry-a", ["user-a", "user-a2"], "double");
  const b = entry("entry-b", ["user-b", "user-b2"], "double");
  const base = fixture(a, b, [1, 2], { resolutionKind: "FORFEIT" });
  const current = base.resultRevisions[0];
  const corrupted = {
    ...base,
    resultRevisions: [{
      ...current,
      settlementEvents: resultEvents(current.id, ["user-a", "user-a2", "user-b", "user-b2"], "APPLIED"),
    }],
  };
  assert.equal(
    evaluateV2CertificateEligibility(
      snapshot("double", "group_only", [[a, b]], [corrupted]),
      "user-a",
    ).state,
    "INTEGRITY_ERROR",
  );
});

test("a pending correction in an applicant's knockout lineup blocks issuance", () => {
  const a = entry("entry-a", ["user-a"], "single");
  const b = entry("entry-b", ["user-b"], "single");
  const group = fixture(a, b, [1, 2]);
  const knockoutId = "knockout-final";
  const pending = revision(knockoutId, a, b, {
    id: "knockout-pending",
    status: "PENDING",
    settlement: "NONE",
  });
  const knockout = fixture(a, b, [1, 2], {
    id: knockoutId,
    stage: "KNOCKOUT",
    status: "READY",
    revisions: [pending],
  });
  const result = evaluateV2CertificateEligibility(
    snapshot("single", "group_then_knockout", [[a, b]], [group, knockout]),
    "user-a",
  );
  assert.equal(result.state, "INELIGIBLE");
  if (result.state === "INELIGIBLE") assert.equal(result.code, "PENDING_RESULT");
});

test("a played knockout result can prove participation while forfeits settle group duties", () => {
  const a = entry("entry-a", ["user-a"], "single");
  const b = entry("entry-b", ["user-b"], "single");
  const groupForfeit = fixture(a, b, [1, 2], { resolutionKind: "FORFEIT" });
  const knockout = fixture(a, b, [1, 2], {
    id: "knockout-final",
    stage: "KNOCKOUT",
  });
  const result = evaluateV2CertificateEligibility(
    snapshot(
      "single",
      "group_then_knockout",
      [[a, b]],
      [groupForfeit, knockout],
    ),
    "user-a",
  );
  assert.equal(result.state, "ELIGIBLE", JSON.stringify(result));
});

test("an inactive opponent's voided pair is no obligation, including retained completedAt", () => {
  const a = entry("entry-a", ["user-a"], "single");
  const b = entry("entry-b", ["user-b"], "single", "DISQUALIFIED");
  const c = entry("entry-c", ["user-c"], "single");
  const voidedBase = fixture(a, b, [1, 2], { status: "VOIDED", revisions: [] });
  const old = revision(voidedBase.id, a, b, {
    status: "VOIDED",
    settlement: "REVERSED",
  });
  const result = evaluateV2CertificateEligibility(
    snapshot(
      "single",
      "group_only",
      [[a, b, c]],
      [
        { ...voidedBase, completedAt: NOW, resultRevisions: [old] },
        fixture(a, c, [1, 3]),
        fixture(b, c, [2, 3], { status: "VOIDED", revisions: [] }),
      ],
    ),
    "user-a",
  );
  assert.equal(result.state, "ELIGIBLE", JSON.stringify(result));
});

test("VOIDED, READY, and SCHEDULED pairs against active opponents remain incomplete", () => {
  for (const status of ["VOIDED", "READY", "SCHEDULED"] as const) {
    const a = entry("entry-a", ["user-a"], "single");
    const b = entry("entry-b", ["user-b"], "single");
    const c = entry("entry-c", ["user-c"], "single");
    const result = evaluateV2CertificateEligibility(
      snapshot(
        "single",
        "group_only",
        [[a, b, c]],
        [
          fixture(a, b, [1, 2], { status, revisions: [] }),
          fixture(a, c, [1, 3]),
          fixture(b, c, [2, 3]),
        ],
      ),
      "user-a",
    );
    assert.equal(result.state, "INELIGIBLE", `${status}: ${JSON.stringify(result)}`);
    if (result.state === "INELIGIBLE") {
      assert.equal(result.code, "INCOMPLETE_ACTIVE_OPPONENT_FIXTURES");
    }
  }
});

test("legal DRAFT rosters do not corrupt history and cannot own a certificate", () => {
  const a = entry("entry-a", ["user-a"], "single");
  const b = entry("entry-b", ["user-b"], "single");
  const draft = entry(
    "entry-draft",
    ["user-draft"],
    "single",
    "DRAFT",
    { currentDraftRoster: true },
  );
  const state = snapshot("single", "group_only", [[a, b]], [fixture(a, b, [1, 2])], [draft]);
  assert.equal(evaluateV2CertificateEligibility(state, "user-a").state, "ELIGIBLE");
  const draftResult = evaluateV2CertificateEligibility(state, "user-draft");
  assert.equal(draftResult.state, "INELIGIBLE");
  if (draftResult.state === "INELIGIBLE") {
    assert.equal(draftResult.code, "NOT_ACTIVE_ENTRY");
  }
});

test("DOUBLE and TEAM roster cardinality/captain drift fails closed", () => {
  const incompleteDouble = entry("entry-a", ["user-a"], "double");
  const normalDouble = entry("entry-b", ["user-b", "user-b2"], "double");
  assert.equal(
    evaluateV2CertificateEligibility(
      snapshot("double", "group_only", [[incompleteDouble, normalDouble]], [
        fixture(incompleteDouble, normalDouble, [1, 2]),
      ]),
      "user-a",
    ).state,
    "INTEGRITY_ERROR",
  );

  const teamA = entry("entry-ta", ["captain-a", "player-a"], "team");
  const teamB = entry("entry-tb", ["captain-b", "player-b"], "team");
  const noCaptain = {
    ...teamA,
    members: teamA.members.map((member) => ({ ...member, role: "player" as const })),
  };
  assert.equal(
    evaluateV2CertificateEligibility(
      snapshot("team", "group_only", [[noCaptain, teamB]], [
        fixture(noCaptain, teamB, [1, 2]),
      ]),
      "captain-a",
    ).state,
    "INTEGRITY_ERROR",
  );
});

test("settlement effects must cover every member of both frozen rosters exactly once", () => {
  const a = entry("entry-a", ["user-a", "user-a2"], "double");
  const b = entry("entry-b", ["user-b", "user-b2"], "double");
  const valid = fixture(a, b, [1, 2]);
  const current = valid.resultRevisions[0];
  const bad = {
    ...valid,
    resultRevisions: [{
      ...current,
      settlementEvents: [{
        ...current.settlementEvents[0],
        effects: [{ userId: "user-a" }, { userId: "user-b" }],
      }],
    }],
  };
  assert.equal(
    evaluateV2CertificateEligibility(
      snapshot("double", "group_only", [[a, b]], [bad]),
      "user-a",
    ).state,
    "INTEGRITY_ERROR",
  );
});

test("the accepted correction chain may coexist with rejected side branches", () => {
  const a = entry("entry-a", ["user-a"], "single");
  const b = entry("entry-b", ["user-b"], "single");
  const base = fixture(a, b, [1, 2]);
  const old = revision(base.id, a, b, {
    id: "revision-old",
    number: 1,
    status: "SUPERSEDED",
    settlement: "REVERSED",
  });
  const rejected = revision(base.id, a, b, {
    id: "revision-rejected",
    number: 2,
    status: "REJECTED",
    supersedesRevisionId: old.id,
    settlement: "NONE",
  });
  const current = revision(base.id, a, b, {
    id: "revision-current",
    number: 3,
    supersedesRevisionId: old.id,
  });
  const state = snapshot("single", "group_only", [[a, b]], [{
    ...base,
    resultRevisions: [old, rejected, current],
  }]);
  assert.equal(evaluateV2CertificateEligibility(state, "user-a").state, "ELIGIBLE");

  const broken = snapshot("single", "group_only", [[a, b]], [{
    ...base,
    resultRevisions: [
      { ...old, settlementEvents: old.settlementEvents.slice(0, 1) },
      rejected,
      current,
    ],
  }]);
  assert.equal(
    evaluateV2CertificateEligibility(broken, "user-a").state,
    "INTEGRITY_ERROR",
  );
});

test("a forfeit correction chain remains valid but still provides no played evidence", () => {
  const a = entry("entry-a", ["user-a"], "single");
  const b = entry("entry-b", ["user-b"], "single");
  const base = fixture(a, b, [1, 2], { resolutionKind: "FORFEIT" });
  const old = revision(base.id, a, b, {
    id: "forfeit-old",
    status: "SUPERSEDED",
    resolutionKind: "FORFEIT",
  });
  const current = revision(base.id, a, b, {
    id: "forfeit-current",
    number: 2,
    resolutionKind: "FORFEIT",
    supersedesRevisionId: old.id,
  });
  const result = evaluateV2CertificateEligibility(
    snapshot("single", "group_only", [[a, b]], [{
      ...base,
      resultRevisions: [
        old,
        {
          ...current,
          winnerEntryId: b.id,
          loserEntryId: a.id,
        },
      ],
    }]),
    "user-a",
  );
  assert.equal(result.state, "INELIGIBLE", JSON.stringify(result));
  if (result.state === "INELIGIBLE") {
    assert.equal(result.code, "NO_CONFIRMED_FIXTURE");
  }
});

test("missing pairs, corrupt lineups, and partial knockout publication fail closed", () => {
  const a = entry("entry-a", ["user-a"], "single");
  const b = entry("entry-b", ["user-b"], "single");
  const c = entry("entry-c", ["user-c"], "single");
  assert.equal(
    evaluateV2CertificateEligibility(
      snapshot("single", "group_only", [[a, b, c]], [
        fixture(a, b, [1, 2]),
        fixture(a, c, [1, 3]),
      ]),
      "user-a",
    ).state,
    "INTEGRITY_ERROR",
  );

  const valid = fixture(a, b, [1, 2]);
  assert.equal(
    evaluateV2CertificateEligibility(
      snapshot("single", "group_only", [[a, b]], [{
        ...valid,
        lineupMembers: valid.lineupMembers.slice(1),
      }]),
      "user-a",
    ).state,
    "INTEGRITY_ERROR",
  );

  const knockout = fixture(a, b, [1, 2], {
    id: "knockout-final",
    stage: "KNOCKOUT",
  });
  const partial = snapshot(
    "single",
    "group_then_knockout",
    [[a, b]],
    [valid, knockout],
  );
  assert.equal(
    evaluateV2CertificateEligibility(
      { ...partial, fixtureDependencies: [] },
      "user-a",
    ).state,
    "INTEGRITY_ERROR",
  );
});
