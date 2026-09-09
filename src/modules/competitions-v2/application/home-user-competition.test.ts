import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  buildHomeUserCompetitionProjection,
  getHomeUserCompetitionProjection,
  parseV2ScoreText,
  type HomeUserCompetitionDatabase,
} from "../read-model/home-user-competition";

type ProjectionInput = Parameters<
  typeof buildHomeUserCompetitionProjection
>[0];
type V2Entry = ProjectionInput["v2Entries"][number];
type V2Fixture = V2Entry["match"]["fixtures"][number];
type V2Revision = V2Fixture["resultRevisions"][number];
type V2RecentRevision = ProjectionInput["v2RecentRevisions"][number];
type V2PendingRevision = ProjectionInput["v2PendingRevisions"][number];

const USER_ID = "user-me";
const OTHER_ID = "user-other";
const SCORE = { bestOf: 5, winnerScore: 3, loserScore: 1 } as const;

function activeRevision(
  input: Readonly<{
    id: string;
    status: V2Revision["status"];
    revisionNumber: number;
    winnerEntryId?: string;
    loserEntryId?: string;
    reportedById?: string;
    supersedesRevisionId?: string | null;
    resolvedAt?: Date | null;
    eloDelta?: number;
  }>,
): V2Revision {
  const winnerEntryId = input.winnerEntryId ?? "entry-me";
  const loserEntryId = input.loserEntryId ?? "entry-other";
  const isConfirmed = input.status === "CONFIRMED";
  const myEloDelta = input.eloDelta ?? (winnerEntryId === "entry-me" ? 10 : -10);
  return {
    id: input.id,
    revisionNumber: input.revisionNumber,
    status: input.status,
    resolutionKind: "PLAYED",
    winnerEntryId,
    loserEntryId,
    score: SCORE,
    reportedById: input.reportedById ?? USER_ID,
    supersedesRevisionId: input.supersedesRevisionId ?? null,
    reason: null,
    resolvedAt: input.resolvedAt ?? null,
    createdAt: new Date(`2026-09-0${input.revisionNumber}T08:00:00.000Z`),
    settlementEvents: isConfirmed
      ? [
          {
            id: `event-${input.id}`,
            kind: "RESULT_APPLY",
            status: "APPLIED",
            resultRevisionId: input.id,
            matchEntryId: null,
            reversesEventId: null,
            failureReason: null,
            appliedAt: input.resolvedAt ?? new Date("2026-09-03T08:00:00.000Z"),
            effects: [
              {
                id: `effect-${input.id}-me`,
                userId: USER_ID,
                eloBefore: 1200,
                eloAfter: 1200 + myEloDelta,
                eloDelta: myEloDelta,
                pointsBefore: 10,
                pointsAfter: winnerEntryId === "entry-me" ? 20 : 10,
                pointsDelta: winnerEntryId === "entry-me" ? 10 : 0,
                winsDelta: winnerEntryId === "entry-me" ? 1 : 0,
                lossesDelta: winnerEntryId === "entry-me" ? 0 : 1,
                matchesPlayedDelta: 1,
              },
              {
                id: `effect-${input.id}-other`,
                userId: OTHER_ID,
                eloBefore: 1200,
                eloAfter: 1200 - myEloDelta,
                eloDelta: -myEloDelta,
                pointsBefore: 10,
                pointsAfter: winnerEntryId === "entry-other" ? 20 : 10,
                pointsDelta: winnerEntryId === "entry-other" ? 10 : 0,
                winsDelta: winnerEntryId === "entry-other" ? 1 : 0,
                lossesDelta: winnerEntryId === "entry-other" ? 0 : 1,
                matchesPlayedDelta: 1,
              },
            ],
          },
        ]
      : [],
  };
}

function fixture(
  resultRevisions: readonly V2Revision[] = [],
  entryStatuses: Readonly<{
    sideA?: Partial<NonNullable<V2Fixture["sideAEntry"]>>;
    sideB?: Partial<NonNullable<V2Fixture["sideBEntry"]>>;
  }> = {},
): V2Fixture {
  return {
    id: "fixture-1",
    matchId: "match-v2",
    stage: "GROUP",
    status: resultRevisions.some((revision) => revision.status === "CONFIRMED")
      ? "COMPLETED"
      : "READY",
    groupKey: "group:0001",
    sideAEntryId: "entry-me",
    sideBEntryId: "entry-other",
    sideARosterVersion: 1,
    sideBRosterVersion: 1,
    completedAt: resultRevisions.some(
      (revision) => revision.status === "CONFIRMED",
    )
      ? new Date("2026-09-03T08:00:00.000Z")
      : null,
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
      ...(entryStatuses.sideA ?? {}),
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
      ...(entryStatuses.sideB ?? {}),
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
    resultRevisions,
    match: {
      engineVersion: "V2",
      isQuickMatch: false,
      type: "single",
      format: "group_only",
      teamMinMembers: null,
      teamMaxMembers: null,
    },
  };
}

function v2Entry(input: Readonly<{
  id?: string;
  status?: V2Entry["status"];
  participatedAt: string;
  fixtures?: readonly V2Fixture[];
}>): V2Entry {
  return {
    id: input.id ?? "entry-me",
    kind: "INDIVIDUAL",
    status: input.status ?? "ACTIVE",
    createdAt: new Date(input.participatedAt),
    members: [
      {
        id: "member-me",
        userId: USER_ID,
        displayNameSnapshot: "我的冻结名",
        role: "player",
        status: "ACTIVE",
        slot: 1,
        rosterVersion: 1,
        effectiveFrom: new Date(input.participatedAt),
        effectiveUntil: null,
      },
    ],
    match: {
      id: `match-${input.id ?? "v2"}`,
      title: "V2 单打赛",
      dateTime: new Date("2026-09-10T08:00:00.000Z"),
      status: "ongoing",
      engineVersion: "V2",
      isQuickMatch: false,
      type: "single",
      format: "group_only",
      groupingGeneratedAt: new Date("2026-09-03T08:00:00.000Z"),
      teamMinMembers: null,
      teamMaxMembers: null,
      qualificationSnapshots: [],
      fixtures: input.fixtures ?? [],
    },
  };
}

function legacyRegistration(
  id: string,
  participatedAt: string,
): ProjectionInput["legacyRegistrations"][number] {
  return {
    createdAt: new Date(participatedAt),
    match: {
      id,
      title: "旧引擎比赛",
      dateTime: new Date("2026-09-09T08:00:00.000Z"),
      format: "group_only",
      status: "registration",
      engineVersion: "LEGACY",
      isQuickMatch: false,
      type: "single",
      groupingGeneratedAt: null,
      groupingResult: null,
      results: [],
    },
  };
}

function baseInput(
  overrides: Partial<ProjectionInput> = {},
): ProjectionInput {
  return {
    userId: USER_ID,
    legacyRegistrations: [],
    v2Entries: [],
    legacyRecentResults: [],
    legacyOpponentNames: new Map(),
    v2RecentRevisions: [],
    legacyPendingResultCount: 0,
    v2PendingRevisions: [],
    ...overrides,
  };
}

type MatchType = V2Entry["match"]["type"];
type MatchFormat = V2Entry["match"]["format"];

function kindFor(type: MatchType): V2Entry["kind"] {
  return type === "single"
    ? "INDIVIDUAL"
    : type === "double"
      ? "DOUBLES"
      : "TEAM";
}

function defaultUsers(type: MatchType, side: "SIDE_A" | "SIDE_B") {
  if (side === "SIDE_A") {
    return type === "single" ? [USER_ID] : [USER_ID, "user-my-partner"];
  }
  return type === "single" ? [OTHER_ID] : [OTHER_ID, "user-other-partner"];
}

function frozenRoster(input: Readonly<{
  type: MatchType;
  side: "SIDE_A" | "SIDE_B";
  entryId: string;
  userIds?: readonly string[];
  names?: readonly string[];
  rosterVersion?: number;
}>) {
  const userIds = input.userIds ?? defaultUsers(input.type, input.side);
  const names =
    input.names ??
    userIds.map((userId, index) =>
      input.side === "SIDE_A"
        ? index === 0
          ? "我的冻结名"
          : "我的搭档"
        : `对手${index + 1}`,
    );
  const rosterVersion = input.rosterVersion ?? 1;
  const members = userIds.map((userId, index) => ({
    id: `${input.entryId}-v${rosterVersion}-member-${index + 1}`,
    userId,
    displayNameSnapshot: names[index] ?? `成员${index + 1}`,
    role: (input.type === "team" && index === 0 ? "captain" : "player") as
      | "captain"
      | "player",
    status: "ACTIVE" as const,
    slot: index + 1,
    rosterVersion,
    effectiveFrom: new Date("2026-09-01T08:00:00.000Z"),
    effectiveUntil: null,
  }));
  return {
    entry: {
      id: input.entryId,
      kind: kindFor(input.type),
      status: "ACTIVE" as const,
      members,
    },
    lineup: members.map((member, index) => ({
      id: `${input.entryId}-lineup-${index + 1}`,
      side: input.side,
      position: index + 1,
      entryId: input.entryId,
      entryMember: {
        id: member.id,
        userId: member.userId,
        displayNameSnapshot: member.displayNameSnapshot,
        role: member.role,
        slot: member.slot,
        rosterVersion: member.rosterVersion,
      },
    })),
  };
}

function formalFixture(input: Readonly<{
  id: string;
  matchId: string;
  type: MatchType;
  format: MatchFormat;
  stage: "GROUP" | "KNOCKOUT";
  status: "READY" | "COMPLETED" | "VOIDED";
  resolutionKind?: "PLAYED" | "FORFEIT";
  initialPendingReporter?: string;
  pendingCorrection?: boolean;
  sideAEntryId?: string;
  sideAUsers?: readonly string[];
  sideBUsers?: readonly string[];
  sideBNames?: readonly string[];
}>): V2Fixture {
  const sideAEntryId = input.sideAEntryId ?? "entry-me";
  const sideA = frozenRoster({
    type: input.type,
    side: "SIDE_A",
    entryId: sideAEntryId,
    userIds: input.sideAUsers,
  });
  const sideB = frozenRoster({
    type: input.type,
    side: "SIDE_B",
    entryId: "entry-other",
    userIds: input.sideBUsers,
    names: input.sideBNames,
  });
  const resolutionKind = input.resolutionKind ?? "PLAYED";
  const score =
    resolutionKind === "FORFEIT"
      ? { winnerScore: 1, loserScore: 0 }
      : input.type === "team"
        ? { winnerScore: 5, loserScore: 3 }
        : { bestOf: 5, winnerScore: 3, loserScore: 1 };
  const allMembers = [...sideA.entry.members, ...sideB.entry.members];
  const appliedEffects = allMembers.map((member) => {
    const isWinner = sideA.entry.members.some(
      (winner) => winner.userId === member.userId,
    );
    return {
      id: `${input.id}-effect-${member.id}`,
      userId: member.userId,
      eloBefore: 1200,
      eloAfter: 1200 + (isWinner ? 8 : -8),
      eloDelta: isWinner ? 8 : -8,
      pointsBefore: 20,
      pointsAfter: 20 + (isWinner ? 10 : 0),
      pointsDelta: isWinner ? 10 : 0,
      winsDelta: isWinner ? 1 : 0,
      lossesDelta: isWinner ? 0 : 1,
      matchesPlayedDelta: 1,
    };
  });
  const resolvedAt = new Date("2026-09-05T08:00:00.000Z");
  const confirmed: V2Revision = {
    id: `${input.id}-confirmed`,
    revisionNumber: 1,
    status: "CONFIRMED",
    resolutionKind,
    winnerEntryId: sideAEntryId,
    loserEntryId: sideB.entry.id,
    score,
    reportedById: USER_ID,
    supersedesRevisionId: null,
    reason: resolutionKind === "FORFEIT" ? "对手弃权" : null,
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
              effects: appliedEffects,
            },
          ],
  };
  const pending: V2Revision = {
    id: `${input.id}-pending`,
    revisionNumber: input.pendingCorrection ? 2 : 1,
    status: "PENDING",
    resolutionKind: "PLAYED",
    winnerEntryId: sideAEntryId,
    loserEntryId: sideB.entry.id,
    score: input.type === "team" ? { winnerScore: 4, loserScore: 2 } : SCORE,
    reportedById: input.initialPendingReporter ?? "manager",
    supersedesRevisionId: input.pendingCorrection ? confirmed.id : null,
    reason: null,
    resolvedAt: null,
    createdAt: new Date("2026-09-06T07:00:00.000Z"),
    settlementEvents: [],
  };
  const resultRevisions =
    input.status === "COMPLETED"
      ? input.pendingCorrection
        ? [confirmed, pending]
        : [confirmed]
      : input.status === "READY" && input.initialPendingReporter !== undefined
        ? [pending]
        : [];
  return {
    id: input.id,
    matchId: input.matchId,
    stage: input.stage,
    status: input.status,
    groupKey: input.stage === "GROUP" ? "group:0001" : null,
    sideAEntryId,
    sideBEntryId: sideB.entry.id,
    sideARosterVersion: 1,
    sideBRosterVersion: 1,
    completedAt: input.status === "COMPLETED" ? resolvedAt : null,
    sideAEntry: sideA.entry,
    sideBEntry: sideB.entry,
    lineupMembers: [...sideA.lineup, ...sideB.lineup],
    resultRevisions,
    match: {
      engineVersion: "V2",
      isQuickMatch: false,
      type: input.type,
      format: input.format,
      teamMinMembers: input.type === "team" ? 2 : null,
      teamMaxMembers: input.type === "team" ? 4 : null,
    },
  };
}

function formalEntry(input: Readonly<{
  matchId: string;
  type: MatchType;
  format: MatchFormat;
  fixtures?: readonly V2Fixture[];
  status?: "registration" | "ongoing" | "finished";
  qualificationSnapshot?: boolean;
  groupingGenerated?: boolean;
  entryId?: string;
}>): V2Entry {
  const entryId = input.entryId ?? "entry-me";
  const roster = frozenRoster({
    type: input.type,
    side: "SIDE_A",
    entryId,
  });
  return {
    id: entryId,
    kind: kindFor(input.type),
    status: "ACTIVE",
    createdAt: new Date("2026-09-01T07:00:00.000Z"),
    members: roster.entry.members,
    match: {
      id: input.matchId,
      title: `${input.type}-${input.format}`,
      dateTime: new Date("2026-09-10T08:00:00.000Z"),
      status: input.status ?? "ongoing",
      engineVersion: "V2",
      isQuickMatch: false,
      type: input.type,
      format: input.format,
      groupingGeneratedAt:
        input.groupingGenerated === false || input.status === "registration"
          ? null
          : new Date("2026-09-03T08:00:00.000Z"),
      teamMinMembers: input.type === "team" ? 2 : null,
      teamMaxMembers: input.type === "team" ? 4 : null,
      qualificationSnapshots: input.qualificationSnapshot
        ? [{ id: `${input.matchId}-qualification` }]
        : [],
      fixtures: input.fixtures ?? [],
    },
  };
}

function topRevision<T extends "CONFIRMED" | "PENDING">(
  fixture: V2Fixture,
  status: T,
): T extends "CONFIRMED" ? V2RecentRevision : V2PendingRevision {
  const revision = fixture.resultRevisions.find((item) => item.status === status);
  assert.ok(revision);
  return {
    ...revision,
    matchId: fixture.matchId,
    fixture,
  } as unknown as T extends "CONFIRMED"
    ? V2RecentRevision
    : V2PendingRevision;
}

function recentRevision(input: Readonly<{
  id: string;
  winnerEntryId?: string;
  loserEntryId?: string;
  resolvedAt: string;
  pendingCorrection?: boolean;
  eloDelta: number;
}>): V2RecentRevision {
  const confirmed = activeRevision({
    id: input.id,
    status: "CONFIRMED",
    revisionNumber: 1,
    winnerEntryId: input.winnerEntryId,
    loserEntryId: input.loserEntryId,
    resolvedAt: new Date(input.resolvedAt),
    eloDelta: input.eloDelta,
  });
  const correction = activeRevision({
    id: `${input.id}-correction`,
    status: "PENDING",
    revisionNumber: 2,
    winnerEntryId: "entry-other",
    loserEntryId: "entry-me",
    reportedById: "manager",
    supersedesRevisionId: input.id,
  });
  const baseFixture = fixture(
    input.pendingCorrection ? [confirmed, correction] : [confirmed],
  );
  return {
    ...confirmed,
    status: "CONFIRMED",
    matchId: `match-${input.id}`,
    fixture: {
      ...baseFixture,
      matchId: `match-${input.id}`,
      match: {
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

function pendingRevision(input: Readonly<{
  id: string;
  reporterId: string;
  supersedesRevisionId?: string | null;
  withConfirmed?: boolean;
}>): V2PendingRevision {
  const pending = activeRevision({
    id: input.id,
    status: "PENDING",
    revisionNumber: input.supersedesRevisionId ? 2 : 1,
    reportedById: input.reporterId,
    supersedesRevisionId: input.supersedesRevisionId,
  });
  const confirmed = activeRevision({
    id: input.supersedesRevisionId ?? "confirmed-existing",
    status: "CONFIRMED",
    revisionNumber: 1,
    resolvedAt: new Date("2026-09-01T08:00:00.000Z"),
  });
  const baseFixture = fixture(
    input.withConfirmed ? [confirmed, pending] : [pending],
  );
  return {
    ...pending,
    status: "PENDING",
    fixture: {
      ...baseFixture,
      match: {
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

test("home cards use only current ACTIVE V2 membership", () => {
  const confirmed = activeRevision({
    id: "confirmed",
    status: "CONFIRMED",
    revisionNumber: 1,
    resolvedAt: new Date("2026-09-03T08:00:00.000Z"),
  });
  const correction = activeRevision({
    id: "correction",
    status: "PENDING",
    revisionNumber: 2,
    winnerEntryId: "entry-other",
    loserEntryId: "entry-me",
    reportedById: "manager",
    supersedesRevisionId: confirmed.id,
  });
  const historicalV2 = v2Entry({
    status: "WITHDRAWN",
    participatedAt: "2026-09-03T08:00:00.000Z",
    fixtures: [fixture([confirmed, correction], { sideA: { status: "WITHDRAWN" } })],
  });
  const draftV2 = v2Entry({
    id: "entry-draft",
    status: "DRAFT",
    participatedAt: "2026-09-04T08:00:00.000Z",
  });

  const projection = buildHomeUserCompetitionProjection(
    baseInput({
      legacyRegistrations: [
        legacyRegistration("legacy-match", "2026-09-01T08:00:00.000Z"),
      ],
      v2Entries: [historicalV2, draftV2],
    }),
  );

  assert.deepEqual(
    projection.myMatches.map((match) => match.id),
    ["legacy-match"],
  );
});

test("a pending correction keeps the confirmed V2 revision authoritative", () => {
  const projection = buildHomeUserCompetitionProjection(
    baseInput({
      v2RecentRevisions: [
        recentRevision({
          id: "confirmed-original",
          resolvedAt: "2026-09-03T08:00:00.000Z",
          pendingCorrection: true,
          eloDelta: 13,
        }),
      ],
      v2PendingRevisions: [
        pendingRevision({
          id: "pending-correction",
          reporterId: "manager",
          supersedesRevisionId: "confirmed-original",
          withConfirmed: true,
        }),
      ],
    }),
  );

  assert.equal(projection.recentResults.length, 1);
  assert.deepEqual(projection.recentResults[0], {
    id: "confirmed-original",
    matchId: "match-confirmed-original",
    opponentLabel: "对手冻结名 · 3:1",
    isWin: true,
    eloDelta: 13,
  });
  assert.equal(projection.pendingResultCount, 0);
});

test("pending count includes only an opponent-reported initial V2 result", () => {
  const projection = buildHomeUserCompetitionProjection(
    baseInput({
      legacyPendingResultCount: 2,
      v2PendingRevisions: [
        pendingRevision({ id: "actionable", reporterId: OTHER_ID }),
        pendingRevision({ id: "reported-by-me", reporterId: USER_ID }),
        pendingRevision({
          id: "correction",
          reporterId: "manager",
          supersedesRevisionId: "confirmed-existing",
          withConfirmed: true,
        }),
      ],
    }),
  );

  assert.equal(projection.pendingResultCount, 3);
});

test("recent result ELO deltas come from the exact result settlement relation", () => {
  const projection = buildHomeUserCompetitionProjection(
    baseInput({
      legacyRecentResults: [
        {
          id: "legacy-result",
          matchId: "legacy-match",
          winnerTeamIds: [USER_ID],
          loserTeamIds: [OTHER_ID],
          score: { text: "3:2" },
          resultVerifiedAt: new Date("2026-09-04T08:00:00.000Z"),
          createdAt: new Date("2026-09-04T07:00:00.000Z"),
          eloHistory: [{ eloBefore: 1180, eloAfter: 1187, delta: 7 }],
        },
      ],
      legacyOpponentNames: new Map([[OTHER_ID, "当前对手名"]]),
      v2RecentRevisions: [
        recentRevision({
          id: "v2-result",
          winnerEntryId: "entry-other",
          loserEntryId: "entry-me",
          resolvedAt: "2026-09-05T08:00:00.000Z",
          eloDelta: -11,
        }),
      ],
    }),
  );

  assert.deepEqual(
    projection.recentResults.map((result) => [result.id, result.eloDelta]),
    [
      ["v2-result", -11],
      ["legacy-result", 7],
    ],
  );
  assert.equal(projection.recentResults[1].opponentLabel, "当前对手名 · 3:2");
});

test("impossible V2 fixture and active-revision lifecycle combinations fail closed", () => {
  const confirmedOnReady = recentRevision({
    id: "confirmed-on-ready",
    resolvedAt: "2026-09-05T08:00:00.000Z",
    eloDelta: 9,
  });
  const pendingOnVoided = pendingRevision({
    id: "pending-on-voided",
    reporterId: OTHER_ID,
  });

  assert.throws(
    () =>
      buildHomeUserCompetitionProjection(
        baseInput({
          v2RecentRevisions: [
            {
              ...confirmedOnReady,
              fixture: { ...confirmedOnReady.fixture, status: "READY" },
            },
          ],
          v2PendingRevisions: [
            {
              ...pendingOnVoided,
              fixture: { ...pendingOnVoided.fixture, status: "VOIDED" },
            },
          ],
        }),
      ),
    /lifecycle is inconsistent/,
  );
});

for (const type of ["single", "double", "team"] as const) {
  for (const format of ["group_only", "group_then_knockout"] as const) {
    test(`home cards project ${type} ${format} from current frozen membership`, () => {
      const matchId = `match-${type}-${format}`;
      const group = formalFixture({
        id: `${matchId}-group`,
        matchId,
        type,
        format,
        stage: "GROUP",
        status: format === "group_only" ? "READY" : "COMPLETED",
      });
      const fixtures =
        format === "group_only"
          ? [group]
          : [
              group,
              formalFixture({
                id: `${matchId}-knockout`,
                matchId,
                type,
                format,
                stage: "KNOCKOUT",
                status: "READY",
              }),
            ];
      const projection = buildHomeUserCompetitionProjection(
        baseInput({
          v2Entries: [
            formalEntry({
              matchId,
              type,
              format,
              fixtures,
              qualificationSnapshot: format === "group_then_knockout",
            }),
          ],
        }),
      );

      assert.equal(projection.myMatches.length, 1);
      assert.equal(
        projection.myMatches[0].phase,
        format === "group_only" ? "小组赛 0/1" : "淘汰赛 0/1",
      );
      assert.equal(
        projection.myMatches[0].confirmedCount,
        format === "group_only" ? 0 : 1,
      );
    });
  }
}

test("group-then phase waits for an atomic knockout publication and never finishes at GROUP", () => {
  const matchId = "match-waiting-knockout";
  const group = formalFixture({
    id: "group-complete",
    matchId,
    type: "double",
    format: "group_then_knockout",
    stage: "GROUP",
    status: "COMPLETED",
  });
  const waiting = formalEntry({
    matchId,
    type: "double",
    format: "group_then_knockout",
    fixtures: [group],
  });
  const projection = buildHomeUserCompetitionProjection(
    baseInput({ v2Entries: [waiting] }),
  );
  assert.equal(projection.myMatches[0].phase, "等待淘汰签表");

  assert.throws(
    () =>
      buildHomeUserCompetitionProjection(
        baseInput({
          v2Entries: [
            {
              ...waiting,
              match: {
                ...waiting.match,
                qualificationSnapshots: [{ id: "half-snapshot" }],
              },
            },
          ],
        }),
      ),
    /illegal GROUP\/KNOCKOUT stage combination/,
  );
});

test("same Entry roster history is deduplicated while multiple current Entries fail closed", () => {
  const matchId = "match-roster-history";
  const group = formalFixture({
    id: "roster-group",
    matchId,
    type: "double",
    format: "group_only",
    stage: "GROUP",
    status: "READY",
  });
  const current = formalEntry({
    matchId,
    type: "double",
    format: "group_only",
    fixtures: [group],
  });
  const oldMembers = current.members.map((member) => ({
    ...member,
    id: `${member.id}-old`,
    status: "SUPERSEDED" as const,
    rosterVersion: 1,
    effectiveUntil: new Date("2026-09-02T08:00:00.000Z"),
  }));
  const newMembers = current.members.map((member) => ({
    ...member,
    id: `${member.id}-new`,
    rosterVersion: 2,
    effectiveFrom: new Date("2026-09-02T08:00:00.000Z"),
  }));
  const versioned = { ...current, members: [...oldMembers, ...newMembers] };
  const deduped = buildHomeUserCompetitionProjection(
    baseInput({ v2Entries: [versioned, versioned] }),
  );
  assert.equal(deduped.myMatches.length, 1);

  const second = formalEntry({
    matchId,
    type: "double",
    format: "group_only",
    fixtures: [
      formalFixture({
        id: "second-entry-group",
        matchId,
        type: "double",
        format: "group_only",
        stage: "GROUP",
        status: "READY",
        sideAEntryId: "entry-me-second",
      }),
    ],
    entryId: "entry-me-second",
  });
  assert.throws(
    () =>
      buildHomeUserCompetitionProjection(
        baseInput({ v2Entries: [current, second] }),
      ),
    /multiple current Entries/,
  );
});

test("DOUBLE PLAYED and TEAM FORFEIT recent results use complete frozen rosters", () => {
  const doubleFixture = formalFixture({
    id: "double-ko",
    matchId: "match-double-ko",
    type: "double",
    format: "group_then_knockout",
    stage: "KNOCKOUT",
    status: "COMPLETED",
    sideBNames: ["同名对手", "同名对手"],
    pendingCorrection: true,
  });
  const teamFixture = formalFixture({
    id: "team-forfeit",
    matchId: "match-team-group",
    type: "team",
    format: "group_only",
    stage: "GROUP",
    status: "COMPLETED",
    resolutionKind: "FORFEIT",
  });
  const projection = buildHomeUserCompetitionProjection(
    baseInput({
      v2RecentRevisions: [
        topRevision(doubleFixture, "CONFIRMED"),
        topRevision(teamFixture, "CONFIRMED"),
      ],
    }),
  );

  const byId = new Map(projection.recentResults.map((item) => [item.id, item]));
  assert.deepEqual(byId.get("double-ko-confirmed"), {
    id: "double-ko-confirmed",
    matchId: "match-double-ko",
    opponentLabel: "同名对手 · 3:1",
    isWin: true,
    eloDelta: 8,
  });
  assert.deepEqual(byId.get("team-forfeit-confirmed"), {
    id: "team-forfeit-confirmed",
    matchId: "match-team-group",
    opponentLabel: "对手1 / 对手2 · 弃权/1:0",
    isWin: true,
    eloDelta: null,
  });
});

test("PLAYED requires the exact complete settlement roster and FORFEIT requires zero settlement", () => {
  const played = formalFixture({
    id: "played-integrity",
    matchId: "match-played-integrity",
    type: "double",
    format: "group_only",
    stage: "GROUP",
    status: "COMPLETED",
  });
  const confirmed = played.resultRevisions[0];
  const event = confirmed.settlementEvents[0];
  const incompletePlayed = {
    ...played,
    resultRevisions: [
      {
        ...confirmed,
        settlementEvents: [{ ...event, effects: event.effects.slice(0, -1) }],
      },
    ],
  };
  assert.throws(
    () =>
      buildHomeUserCompetitionProjection(
        baseInput({
          v2RecentRevisions: [
            topRevision(incompletePlayed, "CONFIRMED"),
          ],
        }),
      ),
    /exact effect per frozen member/,
  );

  const forfeit = formalFixture({
    id: "forfeit-integrity",
    matchId: "match-forfeit-integrity",
    type: "team",
    format: "group_only",
    stage: "GROUP",
    status: "COMPLETED",
    resolutionKind: "FORFEIT",
  });
  const forfeitRevision = forfeit.resultRevisions[0];
  const contaminated = {
    ...forfeit,
    resultRevisions: [
      { ...forfeitRevision, settlementEvents: confirmed.settlementEvents },
    ],
  };
  assert.throws(
    () =>
      buildHomeUserCompetitionProjection(
        baseInput({
          v2RecentRevisions: [topRevision(contaminated, "CONFIRMED")],
        }),
      ),
    /FORFEIT result has settlement residue/,
  );
});

test("initial pending counts frozen DOUBLE members but excludes reporter and correction", () => {
  const actionable = formalFixture({
    id: "pending-actionable",
    matchId: "match-pending-actionable",
    type: "double",
    format: "group_then_knockout",
    stage: "KNOCKOUT",
    status: "READY",
    initialPendingReporter: OTHER_ID,
  });
  const mine = formalFixture({
    id: "pending-mine",
    matchId: "match-pending-mine",
    type: "double",
    format: "group_only",
    stage: "GROUP",
    status: "READY",
    initialPendingReporter: USER_ID,
  });
  const correction = formalFixture({
    id: "pending-correction-generic",
    matchId: "match-pending-correction",
    type: "double",
    format: "group_only",
    stage: "GROUP",
    status: "COMPLETED",
    pendingCorrection: true,
  });
  const projection = buildHomeUserCompetitionProjection(
    baseInput({
      v2PendingRevisions: [
        topRevision(actionable, "PENDING"),
        topRevision(mine, "PENDING"),
        topRevision(correction, "PENDING"),
      ],
    }),
  );
  assert.equal(projection.pendingResultCount, 1);
});

test("score parsing is type-strict and enforces the shared TEAM ceiling", () => {
  assert.equal(parseV2ScoreText("double", "PLAYED", SCORE), "3:1");
  assert.equal(
    parseV2ScoreText("double", "PLAYED", {
      bestOf: 5,
      winnerScore: 4,
      loserScore: 1,
    }),
    null,
  );
  assert.equal(
    parseV2ScoreText("team", "PLAYED", {
      winnerScore: 2_147_483_647,
      loserScore: 0,
    }),
    null,
  );
  assert.equal(
    parseV2ScoreText("team", "FORFEIT", { winnerScore: 1, loserScore: 0 }, "退赛"),
    "弃权/1:0",
  );
});

test("home queries use current EntryMember and frozen lineup authority for all V2 cells", async () => {
  type Query = Readonly<{ where?: unknown; select?: unknown }>;
  const entryQueries: Query[] = [];
  const revisionQueries: Query[] = [];
  const tx = {
    registration: { findMany: async () => [] },
    matchEntry: {
      findMany: async (query: Query) => {
        entryQueries.push(query);
        return [];
      },
    },
    matchResult: {
      findMany: async () => [],
      count: async () => 0,
    },
    user: { findMany: async () => [] },
    resultRevision: {
      findMany: async (query: Query) => {
        revisionQueries.push(query);
        return [];
      },
    },
  };
  const db = {
    $transaction: async (operation: (value: typeof tx) => Promise<unknown>) =>
      operation(tx),
  } as unknown as HomeUserCompetitionDatabase;

  await getHomeUserCompetitionProjection(db, USER_ID);
  assert.deepEqual(entryQueries[0]?.where, {
    status: "ACTIVE",
    members: {
      some: { userId: USER_ID, status: "ACTIVE", effectiveUntil: null },
    },
    match: { engineVersion: "V2", isQuickMatch: false },
  });
  const serializedEntryQuery = JSON.stringify(entryQueries[0]);
  assert.match(serializedEntryQuery, /qualificationSnapshots/);
  assert.doesNotMatch(serializedEntryQuery, /sourceUserId/);
  assert.equal(revisionQueries.length, 2);
  for (const query of revisionQueries) {
    const serialized = JSON.stringify(query);
    assert.match(serialized, /lineupMembers/);
    assert.match(serialized, /resolutionKind/);
    assert.match(serialized, /settlementEvents/);
    assert.doesNotMatch(serialized, /sourceUserId/);
    assert.doesNotMatch(serialized, /"type":"single"|"format":"group_only"/);
  }
});

test("the home page uses the engine-aware projection and has no positional ELO join", () => {
  const source = readFileSync(
    resolve(process.cwd(), "src/app/page.tsx"),
    "utf8",
  );
  assert.match(source, /getHomeUserCompetitionProjection\(prisma, currentUser\.id\)/);
  assert.doesNotMatch(source, /eloHistories\.map\(\(item, index\)/);
  assert.doesNotMatch(source, /recentResultsRaw/);
});


test("older ongoing matches stay on home when newer finished matches fill the limit", () => {
  const active = v2Entry({ participatedAt: "2026-08-01T08:00:00.000Z" });
  const finished = Array.from({ length: 10 }, (_, index) => {
    const entry = legacyRegistration(`finished-${index}`, "2026-09-03T08:00:00.000Z");
    return { ...entry, match: { ...entry.match, status: "finished" as const } };
  });
  const projection = buildHomeUserCompetitionProjection(baseInput({
    legacyRegistrations: finished,
    v2Entries: [{ ...active, match: { ...active.match, groupingGeneratedAt: null } }],
  }));
  assert.equal(projection.myMatches.length, 10);
  assert.equal(projection.myMatches[0].id, active.match.id);
  assert.equal(projection.myMatches[0].status, "ongoing");
});
