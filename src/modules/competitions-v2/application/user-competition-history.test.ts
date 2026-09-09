import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildUserCompetitionHistory,
  combineTermRegistrationCounts,
  countV2TermRegistrationEntries,
  getTermRegistrationCount,
  getUserCompetitionHistory,
  type UserCompetitionHistoryDatabase,
  type UserCompetitionHistoryItem,
} from "../read-model/user-competition-history";

type HistoryInput = Parameters<typeof buildUserCompetitionHistory>[0];
type V2Revision = HistoryInput["v2Revisions"][number];
type ActiveRevision = V2Revision["fixture"]["resultRevisions"][number];

const USER_ID = "user-me";
const OTHER_ID = "user-other";
const VALID_SCORE = { bestOf: 5, winnerScore: 3, loserScore: 1 } as const;

function legacyResult(
  overrides: Partial<HistoryInput["legacyResults"][number]> = {},
): HistoryInput["legacyResults"][number] {
  return {
    id: "legacy-result",
    matchId: "legacy-match",
    confirmed: true,
    winnerTeamIds: [USER_ID],
    loserTeamIds: [OTHER_ID],
    score: { text: "3:2" },
    resultVerifiedAt: new Date("2026-09-04T08:00:00.000Z"),
    createdAt: new Date("2026-09-04T07:00:00.000Z"),
    match: {
      id: "legacy-match",
      title: "旧引擎快速赛",
      dateTime: new Date("2026-09-04T06:00:00.000Z"),
      engineVersion: "LEGACY",
    },
    ...overrides,
  };
}

function v2Revision(input: Readonly<{
  id?: string;
  resolvedAt?: string;
  winnerEntryId?: string;
  loserEntryId?: string;
  fixtureStatus?: V2Revision["fixture"]["status"];
  score?: unknown;
  pendingCorrection?: boolean;
}> = {}): V2Revision {
  const id = input.id ?? "v2-confirmed";
  const confirmed: ActiveRevision = {
    id,
    revisionNumber: 1,
    status: "CONFIRMED",
    resolutionKind: "PLAYED",
    winnerEntryId: input.winnerEntryId ?? "entry-me",
    loserEntryId: input.loserEntryId ?? "entry-other",
    score: input.score ?? VALID_SCORE,
    reportedById: USER_ID,
    supersedesRevisionId: null,
    reason: null,
    resolvedAt: new Date(input.resolvedAt ?? "2026-09-05T08:00:00.000Z"),
    createdAt: new Date("2026-09-05T07:00:00.000Z"),
    settlementEvents: [
      {
        id: `event-${id}`,
        kind: "RESULT_APPLY",
        status: "APPLIED",
        resultRevisionId: id,
        matchEntryId: null,
        reversesEventId: null,
        failureReason: null,
        appliedAt: new Date(input.resolvedAt ?? "2026-09-05T08:00:00.000Z"),
        effects: [
          {
            id: `effect-${id}-me`,
            userId: USER_ID,
            eloBefore: 1200,
            eloAfter: 1210,
            eloDelta: 10,
            pointsBefore: 10,
            pointsAfter: 20,
            pointsDelta: 10,
            winsDelta: 1,
            lossesDelta: 0,
            matchesPlayedDelta: 1,
          },
          {
            id: `effect-${id}-other`,
            userId: OTHER_ID,
            eloBefore: 1200,
            eloAfter: 1190,
            eloDelta: -10,
            pointsBefore: 10,
            pointsAfter: 10,
            pointsDelta: 0,
            winsDelta: 0,
            lossesDelta: 1,
            matchesPlayedDelta: 1,
          },
        ],
      },
    ],
  };
  const correction: ActiveRevision = {
    id: `${id}-correction`,
    revisionNumber: 2,
    status: "PENDING",
    resolutionKind: "PLAYED",
    winnerEntryId: "entry-other",
    loserEntryId: "entry-me",
    score: VALID_SCORE,
    reportedById: "manager",
    supersedesRevisionId: id,
    reason: null,
    resolvedAt: null,
    createdAt: new Date("2026-09-06T07:00:00.000Z"),
    settlementEvents: [],
  };

  return {
    ...confirmed,
    matchId: "v2-match",
    fixture: {
      id: "fixture-1",
      matchId: "v2-match",
      stage: "GROUP",
      status: input.fixtureStatus ?? "COMPLETED",
      groupKey: "group:0001",
      sideAEntryId: "entry-me",
      sideBEntryId: "entry-other",
      sideARosterVersion: 1,
      sideBRosterVersion: 1,
      completedAt: new Date(input.resolvedAt ?? "2026-09-05T08:00:00.000Z"),
      sideAEntry: {
        id: "entry-me",
        kind: "INDIVIDUAL",
        status: "ACTIVE",
        members: [
          {
            id: "member-me",
            userId: USER_ID,
            displayNameSnapshot: "我的冻结名",
            role: "player",
            status: "ACTIVE",
            slot: 1,
            rosterVersion: 1,
            effectiveFrom: new Date("2026-09-01T08:00:00.000Z"),
            effectiveUntil: null,
          },
        ],
      },
      sideBEntry: {
        id: "entry-other",
        kind: "INDIVIDUAL",
        status: "ACTIVE",
        members: [
          {
            id: "member-other",
            userId: OTHER_ID,
            displayNameSnapshot: "对手冻结名",
            role: "player",
            status: "ACTIVE",
            slot: 1,
            rosterVersion: 1,
            effectiveFrom: new Date("2026-09-01T08:00:00.000Z"),
            effectiveUntil: null,
          },
        ],
      },
      lineupMembers: [
        {
          id: "lineup-me",
          side: "SIDE_A",
          position: 1,
          entryId: "entry-me",
          entryMember: {
            id: "member-me",
            userId: USER_ID,
            displayNameSnapshot: "我的冻结名",
            role: "player",
            slot: 1,
            rosterVersion: 1,
          },
        },
        {
          id: "lineup-other",
          side: "SIDE_B",
          position: 1,
          entryId: "entry-other",
          entryMember: {
            id: "member-other",
            userId: OTHER_ID,
            displayNameSnapshot: "对手冻结名",
            role: "player",
            slot: 1,
            rosterVersion: 1,
          },
        },
      ],
      resultRevisions: input.pendingCorrection
        ? [confirmed, correction]
        : [confirmed],
      match: {
        id: "v2-match",
        title: "V2 单打赛",
        dateTime: new Date("2026-09-05T06:00:00.000Z"),
        engineVersion: "V2",
        isQuickMatch: false,
        type: "single",
        format: "group_only",
        teamMinMembers: null,
        teamMaxMembers: null,
      },
    },
  };
}

function genericV2HistoryRevision(input: Readonly<{
  id: string;
  matchId: string;
  type: "single" | "double" | "team";
  format: "group_only" | "group_then_knockout";
  resolutionKind?: "PLAYED" | "FORFEIT";
  userEntryId?: string;
}>): V2Revision {
  const userEntryId = input.userEntryId ?? `entry-${input.id}-me`;
  const opponentEntryId = `entry-${input.id}-other`;
  const userIds =
    input.type === "single" ? [USER_ID] : [USER_ID, `${input.id}-partner`];
  const opponentIds =
    input.type === "single"
      ? [OTHER_ID]
      : [OTHER_ID, `${input.id}-other-partner`];
  const makeMembers = (
    entryId: string,
    ids: readonly string[],
    ownSide: boolean,
  ) =>
    ids.map((userId, index) => ({
      id: `${entryId}-member-${index + 1}`,
      userId,
      displayNameSnapshot: ownSide
        ? index === 0
          ? "我的冻结名"
          : "我的搭档"
        : `冻结对手${index + 1}`,
      role: (input.type === "team" && index === 0 ? "captain" : "player") as
        | "captain"
        | "player",
      status: "ACTIVE" as const,
      slot: index + 1,
      rosterVersion: 1,
      effectiveFrom: new Date("2026-09-01T08:00:00.000Z"),
      effectiveUntil: null,
    }));
  const sideAMembers = makeMembers(userEntryId, userIds, true);
  const sideBMembers = makeMembers(opponentEntryId, opponentIds, false);
  const resolutionKind = input.resolutionKind ?? "PLAYED";
  const score =
    resolutionKind === "FORFEIT"
      ? { winnerScore: 1, loserScore: 0 }
      : input.type === "team"
        ? { winnerScore: 6, loserScore: 4 }
        : VALID_SCORE;
  const resolvedAt = new Date("2026-09-05T08:00:00.000Z");
  const confirmed: ActiveRevision = {
    id: `${input.id}-confirmed`,
    revisionNumber: 1,
    status: "CONFIRMED",
    resolutionKind,
    winnerEntryId: userEntryId,
    loserEntryId: opponentEntryId,
    score,
    reportedById: USER_ID,
    supersedesRevisionId: null,
    reason: resolutionKind === "FORFEIT" ? "对方弃权" : null,
    resolvedAt,
    createdAt: new Date("2026-09-05T07:00:00.000Z"),
    settlementEvents:
      resolutionKind === "FORFEIT"
        ? []
        : [
            {
              id: `${input.id}-apply`,
              kind: "RESULT_APPLY",
              status: "APPLIED",
              resultRevisionId: `${input.id}-confirmed`,
              matchEntryId: null,
              reversesEventId: null,
              failureReason: null,
              appliedAt: resolvedAt,
              effects: [...sideAMembers, ...sideBMembers].map((member) => {
                const isWinner = sideAMembers.some(
                  (winner) => winner.userId === member.userId,
                );
                return {
                  id: `${input.id}-effect-${member.userId}`,
                  userId: member.userId,
                  eloBefore: 1200,
                  eloAfter: 1200 + (isWinner ? 7 : -7),
                  eloDelta: isWinner ? 7 : -7,
                  pointsBefore: 10,
                  pointsAfter: 10 + (isWinner ? 10 : 0),
                  pointsDelta: isWinner ? 10 : 0,
                  winsDelta: isWinner ? 1 : 0,
                  lossesDelta: isWinner ? 0 : 1,
                  matchesPlayedDelta: 1,
                };
              }),
            },
          ],
  };
  const lineup = (
    [
      ["SIDE_A", userEntryId, sideAMembers],
      ["SIDE_B", opponentEntryId, sideBMembers],
    ] as const
  ).flatMap(([side, entryId, members]) =>
    members.map((member, index) => ({
      id: `${input.id}-${side}-lineup-${index + 1}`,
      side,
      position: index + 1,
      entryId,
      entryMember: {
        id: member.id,
        userId: member.userId,
        displayNameSnapshot: member.displayNameSnapshot,
        role: member.role,
        slot: member.slot,
        rosterVersion: member.rosterVersion,
      },
    })),
  );
  return {
    ...confirmed,
    matchId: input.matchId,
    fixture: {
      id: `${input.id}-fixture`,
      matchId: input.matchId,
      stage: input.format === "group_only" ? "GROUP" : "KNOCKOUT",
      status: "COMPLETED",
      groupKey: input.format === "group_only" ? "group:0001" : null,
      sideAEntryId: userEntryId,
      sideBEntryId: opponentEntryId,
      sideARosterVersion: 1,
      sideBRosterVersion: 1,
      completedAt: resolvedAt,
      sideAEntry: {
        id: userEntryId,
        kind:
          input.type === "single"
            ? "INDIVIDUAL"
            : input.type === "double"
              ? "DOUBLES"
              : "TEAM",
        status: "ACTIVE",
        members: sideAMembers,
      },
      sideBEntry: {
        id: opponentEntryId,
        kind:
          input.type === "single"
            ? "INDIVIDUAL"
            : input.type === "double"
              ? "DOUBLES"
              : "TEAM",
        status: "ACTIVE",
        members: sideBMembers,
      },
      lineupMembers: lineup,
      resultRevisions: [confirmed],
      match: {
        id: input.matchId,
        title: `${input.type}-${input.format}`,
        dateTime: new Date("2026-09-05T06:00:00.000Z"),
        engineVersion: "V2",
        isQuickMatch: false,
        type: input.type,
        format: input.format,
        teamMinMembers: input.type === "team" ? 2 : null,
        teamMaxMembers: input.type === "team" ? 4 : null,
      },
    },
  } as unknown as V2Revision;
}

function baseInput(overrides: Partial<HistoryInput> = {}): HistoryInput {
  return {
    userId: USER_ID,
    legacyResults: [],
    legacyOpponentNames: new Map(),
    v2Revisions: [],
    ...overrides,
    legacyOrder: overrides.legacyOrder ?? "verifiedAt",
  };
}

test("profile history merges Legacy and V2 by authoritative resolution time", () => {
  const history = buildUserCompetitionHistory(
    baseInput({
      legacyResults: [legacyResult()],
      legacyOpponentNames: new Map([[OTHER_ID, "对手当前昵称"]]),
      v2Revisions: [v2Revision()],
    }),
  );

  assert.deepEqual(history, [
    {
      id: "v2-confirmed",
      matchId: "v2-match",
      matchTitle: "V2 单打赛",
      matchDateTime: new Date("2026-09-05T06:00:00.000Z"),
      opponentLabel: "对手冻结名",
      scoreText: "3:1",
      isWin: true,
    },
    {
      id: "legacy-result",
      matchId: "legacy-match",
      matchTitle: "旧引擎快速赛",
      matchDateTime: new Date("2026-09-04T06:00:00.000Z"),
      opponentLabel: "对手当前昵称",
      scoreText: "3:2",
      isWin: true,
    },
  ]);
});

test("a pending correction does not replace the current confirmed V2 result", () => {
  const history = buildUserCompetitionHistory(
    baseInput({
      v2Revisions: [
        v2Revision({
          pendingCorrection: true,
          winnerEntryId: "entry-me",
          loserEntryId: "entry-other",
        }),
      ],
    }),
  );

  assert.equal(history.length, 1);
  assert.equal(history[0].id, "v2-confirmed");
  assert.equal(history[0].isWin, true);
  assert.equal(history[0].opponentLabel, "对手冻结名");
});

for (const type of ["single", "double", "team"] as const) {
  for (const format of ["group_only", "group_then_knockout"] as const) {
    test(`profile history projects ${type} ${format} from its frozen lineup`, () => {
      const revision = genericV2HistoryRevision({
        id: `${type}-${format}`,
        matchId: `match-${type}-${format}`,
        type,
        format,
      });
      const history = buildUserCompetitionHistory(
        baseInput({ v2Revisions: [revision] }),
      );
      assert.equal(history.length, 1);
      assert.equal(
        history[0].opponentLabel,
        type === "single" ? "冻结对手1" : "冻结对手1 / 冻结对手2",
      );
      assert.equal(history[0].scoreText, type === "team" ? "6:4" : "3:1");
    });
  }
}

test("profile history renders FORFEIT without settlement and rejects multi-Entry identity", () => {
  const forfeit = genericV2HistoryRevision({
    id: "team-forfeit-history",
    matchId: "team-forfeit-match",
    type: "team",
    format: "group_then_knockout",
    resolutionKind: "FORFEIT",
  });
  const history = buildUserCompetitionHistory(
    baseInput({ v2Revisions: [forfeit] }),
  );
  assert.equal(history[0].scoreText, "弃权/1:0");

  const first = genericV2HistoryRevision({
    id: "multi-entry-first",
    matchId: "multi-entry-match",
    type: "double",
    format: "group_only",
    userEntryId: "entry-first",
  });
  const second = genericV2HistoryRevision({
    id: "multi-entry-second",
    matchId: "multi-entry-match",
    type: "double",
    format: "group_only",
    userEntryId: "entry-second",
  });
  assert.throws(
    () =>
      buildUserCompetitionHistory(
        baseInput({ v2Revisions: [first, second] }),
      ),
    /multiple Entries/,
  );
});

test("term V2 ownership covers all six cells and deduplicates MatchEntry", () => {
  const events = (
    ["single", "double", "team"] as const
  ).flatMap((type, typeIndex) =>
    (["group_only", "group_then_knockout"] as const).map(
      (format, formatIndex) => {
        const entryId = `entry-${type}-${format}`;
        const byEffect = (typeIndex + formatIndex) % 2 === 0;
        return {
          id: `event-${type}-${format}`,
          status: formatIndex === 0 ? ("APPLIED" as const) : ("REVERSED" as const),
          appliedAt: new Date("2026-09-02T08:00:00.000Z"),
          matchEntryId: entryId,
          metadata: { rosterVersion: 3 },
          effects: byEffect ? [{ userId: USER_ID }] : [],
          matchEntry: {
            id: entryId,
            kind:
              type === "single"
                ? ("INDIVIDUAL" as const)
                : type === "double"
                  ? ("DOUBLES" as const)
                  : ("TEAM" as const),
            members: byEffect
              ? []
              : [{ userId: USER_ID, rosterVersion: 3 }],
            match: {
              engineVersion: "V2" as const,
              isQuickMatch: false,
              type,
              format,
            },
          },
        };
      },
    ),
  );
  assert.equal(
    countV2TermRegistrationEntries([...events, events[0]], USER_ID),
    6,
  );
});

test("invalid V2 lifecycle combinations fail closed", () => {
  assert.throws(
    () =>
      buildUserCompetitionHistory(
        baseInput({
          v2Revisions: [
            v2Revision({ id: "confirmed-on-ready", fixtureStatus: "READY" }),
          ],
        }),
      ),
    /lifecycle is inconsistent/,
  );
});

test("profile result limit is applied after the two engines are merged", () => {
  const history = buildUserCompetitionHistory(
    baseInput({
      legacyResults: [legacyResult()],
      v2Revisions: [v2Revision()],
      limit: 1,
    }),
  );

  assert.deepEqual(history.map((item) => item.id), ["v2-confirmed"]);
});

test("the two profile surfaces preserve their distinct Legacy ordering", () => {
  const createdLater = legacyResult({
    id: "created-later",
    createdAt: new Date("2026-09-08T08:00:00.000Z"),
    resultVerifiedAt: new Date("2026-09-05T08:00:00.000Z"),
  });
  const verifiedLater = legacyResult({
    id: "verified-later",
    createdAt: new Date("2026-09-06T08:00:00.000Z"),
    resultVerifiedAt: new Date("2026-09-09T08:00:00.000Z"),
  });

  const recent = buildUserCompetitionHistory(
    baseInput({
      legacyResults: [createdLater, verifiedLater],
      legacyOrder: "createdAt",
    }),
  );
  const fullHistory = buildUserCompetitionHistory(
    baseInput({
      legacyResults: [createdLater, verifiedLater],
      legacyOrder: "verifiedAt",
    }),
  );

  assert.deepEqual(recent.map((item) => item.id), [
    "created-later",
    "verified-later",
  ]);
  assert.deepEqual(fullHistory.map((item) => item.id), [
    "verified-later",
    "created-later",
  ]);
});

test("term count adds Legacy formal registrations and activated V2 entries", () => {
  assert.equal(
    combineTermRegistrationCounts({
      legacyFormalRegistrations: 3,
      v2ActivatedEntries: 2,
    }),
    5,
  );
  assert.throws(
    () =>
      combineTermRegistrationCounts({
        legacyFormalRegistrations: -1,
        v2ActivatedEntries: 2,
      }),
    /non-negative integers/,
  );
});

test("history queries keep Legacy quick results and isolate the supported V2 slice", async () => {
  type QueryArgs = Readonly<{
    where?: unknown;
    orderBy?: unknown;
    select?: unknown;
  }>;
  type HistoryTransaction = Readonly<{
    matchResult: Readonly<{
      findMany: (args: QueryArgs) => Promise<readonly never[]>;
    }>;
    user: Readonly<{
      findMany: (args: QueryArgs) => Promise<readonly never[]>;
    }>;
    resultRevision: Readonly<{
      findMany: (args: QueryArgs) => Promise<readonly never[]>;
    }>;
  }>;
  const legacyQueries: QueryArgs[] = [];
  const v2Queries: QueryArgs[] = [];
  const db = {
    $transaction: async (
      operation: (
        tx: HistoryTransaction,
      ) => Promise<readonly UserCompetitionHistoryItem[]>,
    ) =>
      operation({
        matchResult: {
          findMany: async (args) => {
            legacyQueries.push(args);
            return [];
          },
        },
        user: { findMany: async () => [] },
        resultRevision: {
          findMany: async (args) => {
            v2Queries.push(args);
            return [];
          },
        },
      }),
  } as unknown as UserCompetitionHistoryDatabase;

  assert.deepEqual(
    await getUserCompetitionHistory(db, USER_ID, {
      legacyOrder: "verifiedAt",
    }),
    [],
  );
  assert.deepEqual(legacyQueries[0]?.where, {
    confirmed: true,
    OR: [
      { winnerTeamIds: { has: USER_ID } },
      { loserTeamIds: { has: USER_ID } },
    ],
    match: { engineVersion: "LEGACY" },
  });
  assert.deepEqual(v2Queries[0]?.where, {
    status: "CONFIRMED",
    fixture: {
      match: {
        engineVersion: "V2",
        isQuickMatch: false,
      },
      lineupMembers: { some: { entryMember: { userId: USER_ID } } },
    },
  });
  assert.deepEqual(legacyQueries[0]?.orderBy, [
    { resultVerifiedAt: { sort: "desc", nulls: "last" } },
    { createdAt: "desc" },
    { id: "asc" },
  ]);
  const v2Query = JSON.stringify(v2Queries[0]);
  assert.match(v2Query, /resolutionKind/);
  assert.match(v2Query, /settlementEvents/);
  assert.match(v2Query, /lineupMembers/);
  assert.doesNotMatch(v2Query, /sourceUserId/);
});

test("term count queries do not double count Legacy facts for V2 matches", async () => {
  type CountArgs = Readonly<{
    where?: unknown;
    distinct?: unknown;
    select?: unknown;
    orderBy?: unknown;
  }>;
  type CountTransaction = Readonly<{
    registration: Readonly<{
      count: (args: CountArgs) => Promise<number>;
    }>;
    settlementEvent: Readonly<{
      findMany: (
        args: CountArgs,
      ) => Promise<readonly unknown[]>;
    }>;
  }>;
  const termStart = new Date("2026-09-01T00:00:00.000Z");
  const legacyQueries: CountArgs[] = [];
  const v2Queries: CountArgs[] = [];
  const db = {
    $transaction: async (
      operation: (tx: CountTransaction) => Promise<number>,
    ) =>
      operation({
        registration: {
          count: async (args) => {
            legacyQueries.push(args);
            return 3;
          },
        },
        settlementEvent: {
          findMany: async (args) => {
            v2Queries.push(args);
            const event = (id: string, entryId: string, byEffect: boolean) => ({
              id,
              status: "APPLIED" as const,
              appliedAt: new Date("2026-09-02T08:00:00.000Z"),
              matchEntryId: entryId,
              metadata: { rosterVersion: 2 },
              effects: byEffect ? [{ userId: USER_ID }] : [],
              matchEntry: {
                id: entryId,
                kind: "DOUBLES" as const,
                members: byEffect
                  ? []
                  : [{ userId: USER_ID, rosterVersion: 2 }],
                match: {
                  engineVersion: "V2" as const,
                  isQuickMatch: false,
                  type: "double" as const,
                  format: "group_then_knockout" as const,
                },
              },
            });
            return [
              event("event-1", "entry-1", true),
              event("event-2", "entry-2", false),
              event("event-3", "entry-2", true),
            ];
          },
        },
      }),
  } as unknown as UserCompetitionHistoryDatabase;

  assert.equal(await getTermRegistrationCount(db, USER_ID, termStart), 5);
  assert.deepEqual(legacyQueries[0]?.where, {
    userId: USER_ID,
    createdAt: { gte: termStart },
    match: { engineVersion: "LEGACY", isQuickMatch: false },
  });
  assert.deepEqual(v2Queries[0]?.where, {
    kind: "REGISTRATION_APPLY",
    status: { in: ["APPLIED", "REVERSED"] },
    appliedAt: { gte: termStart },
    matchEntry: {
      is: {
        match: { engineVersion: "V2", isQuickMatch: false },
      },
    },
    OR: [
      { effects: { some: { userId: USER_ID } } },
      {
        matchEntry: {
          is: { members: { some: { userId: USER_ID } } },
        },
      },
    ],
  });
  assert.equal(v2Queries[0]?.distinct, undefined);
  assert.doesNotMatch(JSON.stringify(v2Queries[0]), /sourceUserId|INDIVIDUAL/);
});

test("term count rejects an invalid date before opening a transaction", async () => {
  let transactionOpened = false;
  const db = {
    $transaction: async () => {
      transactionOpened = true;
      return 0;
    },
  } as unknown as UserCompetitionHistoryDatabase;

  await assert.rejects(
    () => getTermRegistrationCount(db, USER_ID, new Date(Number.NaN)),
    /termStart must be a valid date/,
  );
  assert.equal(transactionOpened, false);
});

test("profile routes use the mixed-engine adapter instead of direct legacy facts", () => {
  const ownProfile = readFileSync(
    resolve(process.cwd(), "src/app/profile/page.tsx"),
    "utf8",
  );
  const history = readFileSync(
    resolve(process.cwd(), "src/app/profile/history/page.tsx"),
    "utf8",
  );
  const publicProfile = readFileSync(
    resolve(process.cwd(), "src/app/profile/[id]/page.tsx"),
    "utf8",
  );

  assert.match(ownProfile, /getUserCompetitionHistory\(prisma, currentUser\.id/);
  assert.match(ownProfile, /getTermRegistrationCount\(prisma, currentUser\.id/);
  assert.match(history, /getUserCompetitionHistory\(prisma, currentUser\.id/);
  assert.match(publicProfile, /getTermRegistrationCount\(prisma, user\.id/);
  assert.match(ownProfile, /legacyOrder:\s*"createdAt"/);
  assert.match(history, /legacyOrder:\s*"verifiedAt"/);
  for (const source of [ownProfile, history, publicProfile]) {
    assert.doesNotMatch(source, /prisma\.matchResult\.findMany/);
    assert.doesNotMatch(source, /prisma\.registration\.count/);
  }
});
