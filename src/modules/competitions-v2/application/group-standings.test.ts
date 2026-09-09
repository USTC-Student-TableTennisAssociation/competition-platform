import assert from "node:assert/strict";
import test from "node:test";

import {
  V2_MAX_TEAM_SCORE_PER_FIXTURE,
  V2GroupStandingsError,
  evaluateV2GroupQualification,
  type V2StandingsEntry,
  type V2StandingsFixture,
  type V2StandingsGroup,
} from "../domain/group-standings";

function entry(
  entryId: string,
  position: number,
  seedElo: number,
  overrides: Partial<V2StandingsEntry> = {},
): V2StandingsEntry {
  return {
    entryId,
    position,
    globalSeedRank: position,
    seedElo,
    eligible: true,
    ...overrides,
  };
}

function playedFixture(
  fixtureId: string,
  sideAEntryId: string,
  sideBEntryId: string,
  winnerEntryId: string,
  winnerScore: number,
  loserScore: number,
  overrides: Partial<V2StandingsFixture> = {},
): V2StandingsFixture {
  const loserEntryId =
    winnerEntryId === sideAEntryId ? sideBEntryId : sideAEntryId;
  return {
    fixtureId,
    status: "COMPLETED",
    sideAEntryId,
    sideBEntryId,
    pendingRevisionIds: [],
    confirmedRevision: {
      revisionId: `${fixtureId}-revision`,
      resolutionKind: "PLAYED",
      winnerEntryId,
      loserEntryId,
      score: { bestOf: 5, winnerScore, loserScore },
    },
    ...overrides,
  };
}

function group(
  groupId: string,
  position: number,
  entries: readonly V2StandingsEntry[],
  fixtures: readonly V2StandingsFixture[],
): V2StandingsGroup {
  return { groupId, position, entries, fixtures };
}

function expectError(
  operation: () => unknown,
  code: V2GroupStandingsError["code"],
) {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof V2GroupStandingsError);
    assert.equal(error.code, code);
    return true;
  });
}

test("ranks each group by wins, score differential, score for, frozen Elo, then Entry ID", () => {
  const evaluation = evaluateV2GroupQualification({
    matchType: "single",
    qualifiersPerGroup: 2,
    groups: [
      group(
        "group-a",
        1,
        [entry("entry-a", 1, 1000), entry("entry-b", 2, 1200), entry("entry-c", 3, 900)],
        [
          playedFixture("fixture-ab", "entry-a", "entry-b", "entry-a", 3, 2),
          playedFixture("fixture-ac", "entry-a", "entry-c", "entry-c", 3, 1),
          playedFixture("fixture-bc", "entry-b", "entry-c", "entry-b", 3, 0),
        ],
      ),
    ],
  });

  assert.deepEqual(
    evaluation.standings.map((row) => ({
      entryId: row.entryId,
      rank: row.rank,
      wins: row.wins,
      diff: row.scoreDifferential,
      qualified: row.qualified,
      order: row.qualificationOrder,
    })),
    [
      { entryId: "entry-b", rank: 1, wins: 1, diff: 2, qualified: true, order: 1 },
      { entryId: "entry-a", rank: 2, wins: 1, diff: -1, qualified: true, order: 2 },
      { entryId: "entry-c", rank: 3, wins: 1, diff: -1, qualified: false, order: null },
    ],
  );
  assert.match(evaluation.sourceFingerprintPayload, /fixture-ab/);
});

test("assigns qualification order by place then published group position", () => {
  const makeTwoEntryGroup = (id: string, position: number, winner: string) => {
    const first = `${id}-a`;
    const second = `${id}-b`;
    return group(
      id,
      position,
      [
        entry(first, 1, 1000, { globalSeedRank: (position - 1) * 2 + 1 }),
        entry(second, 2, 900, { globalSeedRank: (position - 1) * 2 + 2 }),
      ],
      [playedFixture(`${id}-fixture`, first, second, winner, 2, 0, {
        confirmedRevision: {
          revisionId: `${id}-revision`,
          resolutionKind: "PLAYED",
          winnerEntryId: winner,
          loserEntryId: winner === first ? second : first,
          score: { bestOf: 3, winnerScore: 2, loserScore: 0 },
        },
      })],
    );
  };
  const evaluation = evaluateV2GroupQualification({
    matchType: "double",
    qualifiersPerGroup: 2,
    groups: [
      makeTwoEntryGroup("group-b", 2, "group-b-a"),
      makeTwoEntryGroup("group-a", 1, "group-a-b"),
    ],
  });
  const order = new Map(
    evaluation.standings.map((row) => [row.entryId, row.qualificationOrder]),
  );
  assert.deepEqual(
    [order.get("group-a-b"), order.get("group-b-a"), order.get("group-a-a"), order.get("group-b-b")],
    [1, 2, 3, 4],
  );
});

test("accepts the canonical compact and UI best-of score labels", () => {
  for (const text of ["3:1", "3:1（5局3胜）"]) {
    assert.doesNotThrow(() =>
      evaluateV2GroupQualification({
        matchType: "single",
        qualifiersPerGroup: 1,
        groups: [
          group(
            "group-a",
            1,
            [entry("entry-a", 1, 1000), entry("entry-b", 2, 900)],
            [
              playedFixture(
                "fixture-ab",
                "entry-a",
                "entry-b",
                "entry-a",
                3,
                1,
                {
                  confirmedRevision: {
                    revisionId: "revision-ab",
                    resolutionKind: "PLAYED",
                    winnerEntryId: "entry-a",
                    loserEntryId: "entry-b",
                    score: { bestOf: 5, winnerScore: 3, loserScore: 1, text },
                  },
                },
              ),
            ],
          ),
        ],
      }),
    );
  }
});

test("FORFEIT counts as a deterministic 1:0 competition result", () => {
  const evaluation = evaluateV2GroupQualification({
    matchType: "team",
    qualifiersPerGroup: 1,
    groups: [
      group(
        "group-a",
        1,
        [entry("entry-a", 1, 1000), entry("entry-b", 2, 900)],
        [
          playedFixture("fixture-ab", "entry-a", "entry-b", "entry-a", 1, 0, {
            confirmedRevision: {
              revisionId: "revision-forfeit",
              resolutionKind: "FORFEIT",
              winnerEntryId: "entry-a",
              loserEntryId: "entry-b",
              score: { reason: "opponent unavailable" },
            },
          }),
        ],
      ),
    ],
  });
  assert.deepEqual(
    evaluation.standings.map((row) => [row.entryId, row.wins, row.losses, row.scoreFor]),
    [
      ["entry-a", 1, 0, 1],
      ["entry-b", 0, 1, 0],
    ],
  );
});

test("TEAM score bounds keep every maximum-size group aggregate in PostgreSQL integer range", () => {
  const teamFixture = (winnerScore: number): V2StandingsFixture => ({
    fixtureId: "fixture-ab",
    status: "COMPLETED",
    sideAEntryId: "entry-a",
    sideBEntryId: "entry-b",
    pendingRevisionIds: [],
    confirmedRevision: {
      revisionId: "revision-ab",
      resolutionKind: "PLAYED",
      winnerEntryId: "entry-a",
      loserEntryId: "entry-b",
      score: { winnerScore, loserScore: 0 },
    },
  });
  const input = (winnerScore: number) => ({
    matchType: "team" as const,
    qualifiersPerGroup: 1,
    groups: [
      group(
        "group-a",
        1,
        [entry("entry-a", 1, 1000), entry("entry-b", 2, 900)],
        [teamFixture(winnerScore)],
      ),
    ],
  });

  assert.equal(
    evaluateV2GroupQualification(input(V2_MAX_TEAM_SCORE_PER_FIXTURE))
      .standings[0]?.scoreFor,
    V2_MAX_TEAM_SCORE_PER_FIXTURE,
  );
  expectError(
    () =>
      evaluateV2GroupQualification(
        input(V2_MAX_TEAM_SCORE_PER_FIXTURE + 1),
      ),
    "INTEGRITY_ERROR",
  );
});

test("ineligible Entries remain auditable while their pairings do not affect rankings", () => {
  const evaluation = evaluateV2GroupQualification({
    matchType: "single",
    qualifiersPerGroup: 1,
    groups: [
      group(
        "group-a",
        1,
        [
          entry("entry-a", 1, 1000),
          entry("entry-b", 2, 900),
          entry("entry-c", 3, 2000, {
            eligible: false,
            ineligibilityReason: "DISQUALIFIED",
          }),
        ],
        [
          playedFixture("fixture-ab", "entry-a", "entry-b", "entry-a", 2, 1, {
            confirmedRevision: {
              revisionId: "revision-ab",
              resolutionKind: "PLAYED",
              winnerEntryId: "entry-a",
              loserEntryId: "entry-b",
              score: { bestOf: 3, winnerScore: 2, loserScore: 1 },
            },
          }),
          {
            fixtureId: "fixture-ac",
            status: "VOIDED",
            sideAEntryId: "entry-a",
            sideBEntryId: "entry-c",
            pendingRevisionIds: [],
            confirmedRevision: null,
          },
          {
            fixtureId: "fixture-bc",
            status: "VOIDED",
            sideAEntryId: "entry-b",
            sideBEntryId: "entry-c",
            pendingRevisionIds: [],
            confirmedRevision: null,
          },
        ],
      ),
    ],
  });
  assert.deepEqual(
    evaluation.standings.map((row) => ({
      id: row.entryId,
      rank: row.rank,
      played: row.played,
      qualified: row.qualified,
      reason: row.ineligibilityReason,
    })),
    [
      { id: "entry-a", rank: 1, played: 1, qualified: true, reason: null },
      { id: "entry-b", rank: 2, played: 1, qualified: false, reason: null },
      { id: "entry-c", rank: 3, played: 0, qualified: false, reason: "DISQUALIFIED" },
    ],
  );
});

test("pending revisions and unplayed eligible pairings block qualification", () => {
  const base = group(
    "group-a",
    1,
    [entry("entry-a", 1, 1000), entry("entry-b", 2, 900)],
    [playedFixture("fixture-ab", "entry-a", "entry-b", "entry-a", 2, 0)],
  );
  expectError(
    () =>
      evaluateV2GroupQualification({
        matchType: "single",
        qualifiersPerGroup: 1,
        groups: [
          { ...base, fixtures: [{ ...base.fixtures[0], pendingRevisionIds: ["pending-1"] }] },
        ],
      }),
    "QUALIFICATION_NOT_READY",
  );
  expectError(
    () =>
      evaluateV2GroupQualification({
        matchType: "single",
        qualifiersPerGroup: 1,
        groups: [
          {
            ...base,
            fixtures: [
              {
                ...base.fixtures[0],
                status: "READY",
                confirmedRevision: null,
              },
            ],
          },
        ],
      }),
    "QUALIFICATION_NOT_READY",
  );
});

test("duplicate or incomplete round-robin topology fails closed", () => {
  const entries = [entry("entry-a", 1, 1000), entry("entry-b", 2, 900), entry("entry-c", 3, 800)];
  const duplicatePair = [
    playedFixture("fixture-ab-1", "entry-a", "entry-b", "entry-a", 2, 0),
    playedFixture("fixture-ab-2", "entry-a", "entry-b", "entry-b", 2, 0),
    playedFixture("fixture-ac", "entry-a", "entry-c", "entry-a", 2, 0),
  ];
  expectError(
    () =>
      evaluateV2GroupQualification({
        matchType: "single",
        qualifiersPerGroup: 1,
        groups: [group("group-a", 1, entries, duplicatePair)],
      }),
    "INTEGRITY_ERROR",
  );
});

test("an unknown terminal state fails closed even when one side is ineligible", () => {
  const inactive = entry("entry-b", 2, 900, {
    eligible: false,
    ineligibilityReason: "DISQUALIFIED",
  });
  expectError(
    () =>
      evaluateV2GroupQualification({
        matchType: "single",
        qualifiersPerGroup: 1,
        groups: [
          group(
            "group-a",
            1,
            [entry("entry-a", 1, 1000), inactive],
            [
              {
                fixtureId: "fixture-ab",
                status: "CORRUPT" as V2StandingsFixture["status"],
                sideAEntryId: "entry-a",
                sideBEntryId: "entry-b",
                pendingRevisionIds: [],
                confirmedRevision: null,
              },
            ],
          ),
        ],
      }),
    "INTEGRITY_ERROR",
  );
});

test("fingerprint payload is deterministic across input ordering", () => {
  const entries = [entry("entry-a", 1, 1000), entry("entry-b", 2, 900)];
  const fixture = playedFixture("fixture-ab", "entry-a", "entry-b", "entry-a", 3, 0);
  const first = evaluateV2GroupQualification({
    matchType: "single",
    qualifiersPerGroup: 1,
    groups: [group("group-a", 1, entries, [fixture])],
  });
  const second = evaluateV2GroupQualification({
    matchType: "single",
    qualifiersPerGroup: 1,
    groups: [group("group-a", 1, [...entries].reverse(), [fixture])],
  });
  assert.equal(first.sourceFingerprintPayload, second.sourceFingerprintPayload);
});
