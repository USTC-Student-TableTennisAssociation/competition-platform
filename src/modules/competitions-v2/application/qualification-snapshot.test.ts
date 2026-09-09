import assert from "node:assert/strict";
import test from "node:test";

import type { PrismaClient } from "@prisma/client";

import { V2CompetitionApplicationError } from "./entries";
import {
  createV2QualificationSnapshotApplicationService,
  type FreezeV2QualificationSnapshotCommand,
} from "./qualification-snapshot";

const NOW = new Date("2026-09-05T12:00:00.000Z");
const PUBLISHED_AT = new Date("2026-09-04T12:00:00.000Z");
const VERIFIED_AT = new Date("2026-01-01T00:00:00.000Z");

type MatchType = "single" | "double" | "team";
type EntryKind = "INDIVIDUAL" | "DOUBLES" | "TEAM";
type CapturedFindArgs = Readonly<{
  take?: number;
  where?: unknown;
  select?: Readonly<{
    effects?: Readonly<{ take?: number }>;
  }>;
}>;

type State = ReturnType<typeof initialState>;

function rosterSize(type: MatchType) {
  return type === "single" ? 1 : type === "double" ? 2 : 3;
}

function entryKind(type: MatchType): EntryKind {
  return type === "single" ? "INDIVIDUAL" : type === "double" ? "DOUBLES" : "TEAM";
}

function memberRows(type: MatchType, entryId: string) {
  return Array.from({ length: rosterSize(type) }, (_, index) => ({
    id: `${entryId}-member-${index + 1}`,
    matchId: "match-1",
    entryId,
    userId: `${entryId}-user-${index + 1}`,
    role: (type === "team" && index === 0 ? "captain" : "player") as
      | "captain"
      | "player",
    status: "ACTIVE" as
      | "ACTIVE"
      | "WITHDRAWN"
      | "REMOVED"
      | "DISQUALIFIED"
      | "SUPERSEDED",
    slot: index + 1,
    rosterVersion: 1,
    effectiveFrom: PUBLISHED_AT,
    effectiveUntil: null as Date | null,
    endReason: null as string | null,
  }));
}

function lineupRows(type: MatchType, fixtureId: string, left: string, right: string) {
  return [
    ...memberRows(type, left).map((member) => ({
      id: `${fixtureId}-lineup-a-${member.slot}`,
      matchId: "match-1",
      fixtureId,
      entryId: left,
      entryMemberId: member.id,
      side: "SIDE_A" as const,
      position: member.slot,
      createdAt: PUBLISHED_AT,
    })),
    ...memberRows(type, right).map((member) => ({
      id: `${fixtureId}-lineup-b-${member.slot}`,
      matchId: "match-1",
      fixtureId,
      entryId: right,
      entryMemberId: member.id,
      side: "SIDE_B" as const,
      position: member.slot,
      createdAt: PUBLISHED_AT,
    })),
  ];
}

function resultScore(type: MatchType) {
  return type === "team"
    ? { winnerScore: 3, loserScore: 1 }
    : { bestOf: 3, winnerScore: 2, loserScore: 0 };
}

function resultApplication(type: MatchType, fixtureId: string, revisionId: string) {
  const appliedAt = new Date("2026-09-05T10:00:00.000Z");
  const users = [
    ...memberRows(type, fixtureId === "fixture-ab" ? "entry-a" : "entry-c"),
    ...memberRows(type, fixtureId === "fixture-ab" ? "entry-b" : "entry-d"),
  ];
  const eventId = `${revisionId}-apply`;
  return {
    id: eventId,
    idempotencyKey: `competition-v2:result-revision:${revisionId}:RESULT_APPLY`,
    kind: "RESULT_APPLY" as const,
    status: "APPLIED" as "PENDING" | "APPLIED" | "REVERSED" | "FAILED",
    resultRevisionId: revisionId,
    matchEntryId: null,
    reversesEventId: null,
    metadata: { schemaVersion: 1 },
    failureReason: null,
    appliedAt,
    createdAt: appliedAt,
    updatedAt: appliedAt,
    effects: users.map((member, index) => ({
      id: `${eventId}-effect-${index + 1}`,
      eventId,
      userId: member.userId,
      eloBefore: 1_200,
      eloAfter: index < rosterSize(type) ? 1_210 : 1_190,
      eloDelta: index < rosterSize(type) ? 10 : -10,
      pointsBefore: 10,
      pointsAfter: index < rosterSize(type) ? 13 : 10,
      pointsDelta: index < rosterSize(type) ? 3 : 0,
      winsDelta: index < rosterSize(type) ? 1 : 0,
      lossesDelta: index < rosterSize(type) ? 0 : 1,
      matchesPlayedDelta: 1,
      createdAt: appliedAt,
    })),
  };
}

function resultReversal(
  application: ReturnType<typeof resultApplication>,
  id = `${application.resultRevisionId}-reversal`,
) {
  const appliedAt = new Date("2026-09-05T10:30:00.000Z");
  return {
    id,
    idempotencyKey: `competition-v2:result-revision:${application.resultRevisionId}:RESULT_REVERSAL`,
    kind: "RESULT_REVERSAL" as const,
    status: "APPLIED" as "PENDING" | "APPLIED" | "REVERSED" | "FAILED",
    resultRevisionId: application.resultRevisionId,
    matchEntryId: null,
    reversesEventId: application.id,
    metadata: { schemaVersion: 1 },
    failureReason: null,
    appliedAt,
    createdAt: appliedAt,
    updatedAt: appliedAt,
    effects: application.effects.map((effect, index) => ({
      id: `${id}-effect-${index + 1}`,
      eventId: id,
      userId: effect.userId,
      eloBefore: effect.eloAfter,
      eloAfter: effect.eloBefore,
      eloDelta: -effect.eloDelta,
      pointsBefore: effect.pointsAfter,
      pointsAfter: effect.pointsBefore,
      pointsDelta: -effect.pointsDelta,
      winsDelta: -effect.winsDelta,
      lossesDelta: -effect.lossesDelta,
      matchesPlayedDelta: -effect.matchesPlayedDelta,
      createdAt: appliedAt,
    })),
  };
}

type TestResultApplication = ReturnType<typeof resultApplication>;
type TestSettlement = TestResultApplication | ReturnType<typeof resultReversal>;

function initialState(type: MatchType = "single") {
  const entryIds = ["entry-a", "entry-b", "entry-c", "entry-d"];
  const entries = entryIds.map((id) => ({
    id,
    matchId: "match-1",
    kind: entryKind(type),
    status: "ACTIVE" as "DRAFT" | "ACTIVE" | "WITHDRAWN" | "DISQUALIFIED" | "ARCHIVED",
    version: 0,
  }));
  const members = entryIds.flatMap((entryId) => memberRows(type, entryId));
  const fixtures = [
    {
      id: "fixture-ab",
      matchId: "match-1",
      fixtureKey: "group:0001:pair:0001-0002",
      stage: "GROUP" as const,
      status: "COMPLETED" as "SCHEDULED" | "READY" | "COMPLETED" | "VOIDED",
      groupId: "group-1",
      groupKey: "group:0001",
      roundNumber: null,
      position: null,
      sideAEntryId: "entry-a",
      sideBEntryId: "entry-b",
      sideARosterVersion: 1,
      sideBRosterVersion: 1,
      completedAt: new Date("2026-09-05T09:00:00.000Z") as Date | null,
    },
    {
      id: "fixture-cd",
      matchId: "match-1",
      fixtureKey: "group:0002:pair:0001-0002",
      stage: "GROUP" as const,
      status: "COMPLETED" as "SCHEDULED" | "READY" | "COMPLETED" | "VOIDED",
      groupId: "group-2",
      groupKey: "group:0002",
      roundNumber: null,
      position: null,
      sideAEntryId: "entry-c",
      sideBEntryId: "entry-d",
      sideARosterVersion: 1,
      sideBRosterVersion: 1,
      completedAt: new Date("2026-09-05T09:30:00.000Z") as Date | null,
    },
  ];
  const revisions = [
    {
      id: "revision-ab",
      matchId: "match-1",
      fixtureId: "fixture-ab",
      revisionNumber: 1,
      status: "CONFIRMED" as "PENDING" | "CONFIRMED" | "REJECTED" | "VOIDED" | "SUPERSEDED",
      resolutionKind: "PLAYED" as "PLAYED" | "FORFEIT",
      winnerEntryId: "entry-a",
      loserEntryId: "entry-b",
      score: resultScore(type) as Record<string, unknown>,
      reportedById: "entry-a-user-1",
      verifiedById: "manager-1",
      supersedesRevisionId: null as string | null,
      reason: null as string | null,
      resolvedAt: new Date("2026-09-05T09:00:00.000Z"),
      createdAt: new Date("2026-09-05T08:55:00.000Z"),
      updatedAt: new Date("2026-09-05T09:00:00.000Z"),
    },
    {
      id: "revision-cd",
      matchId: "match-1",
      fixtureId: "fixture-cd",
      revisionNumber: 1,
      status: "CONFIRMED" as "PENDING" | "CONFIRMED" | "REJECTED" | "VOIDED" | "SUPERSEDED",
      resolutionKind: "PLAYED" as "PLAYED" | "FORFEIT",
      winnerEntryId: "entry-c",
      loserEntryId: "entry-d",
      score: resultScore(type) as Record<string, unknown>,
      reportedById: "entry-c-user-1",
      verifiedById: "manager-1",
      supersedesRevisionId: null as string | null,
      reason: null as string | null,
      resolvedAt: new Date("2026-09-05T09:30:00.000Z"),
      createdAt: new Date("2026-09-05T09:25:00.000Z"),
      updatedAt: new Date("2026-09-05T09:30:00.000Z"),
    },
  ];
  return {
    match: {
      id: "match-1",
      title: `V2 ${type} knockout qualifier`,
      createdBy: "manager-1",
      engineVersion: "V2" as "LEGACY" | "V2",
      isQuickMatch: false,
      type,
      status: "ongoing" as "registration" | "ongoing" | "finished",
      format: "group_then_knockout" as "group_only" | "group_then_knockout",
      groupingGeneratedAt: PUBLISHED_AT,
      teamMinMembers: type === "team" ? 2 : null,
      teamMaxMembers: type === "team" ? 4 : null,
    },
    actor: {
      id: "manager-1",
      role: "user" as "user" | "admin",
      isBanned: false,
      emailVerifiedAt: VERIFIED_AT as Date | null,
    },
    users: members.map((member) => ({
      id: member.userId,
      role: "user" as const,
      isBanned: false,
      emailVerifiedAt: VERIFIED_AT as Date | null,
    })),
    grouping: {
      id: "grouping-1",
      matchId: "match-1",
      v2SchemaVersion: 1,
      seedMethod: "SNAKE" as "MIN_DIFF" | "SNAKE" | null,
      standingsPolicyVersion: 1,
      qualifiersPerGroup: 1,
      bracketPolicyVersion: 1 as number | null,
      createdAt: PUBLISHED_AT,
    },
    groups: [
      {
        id: "group-1",
        matchId: "match-1",
        groupingId: "grouping-1",
        groupKey: "group:0001",
        displayName: "第 1 组",
        position: 1,
        createdAt: PUBLISHED_AT,
      },
      {
        id: "group-2",
        matchId: "match-1",
        groupingId: "grouping-1",
        groupKey: "group:0002",
        displayName: "第 2 组",
        position: 2,
        createdAt: PUBLISHED_AT,
      },
    ],
    memberships: entryIds.map((entryId, index) => ({
      id: `membership-${entryId}`,
      matchId: "match-1",
      groupId: index < 2 ? "group-1" : "group-2",
      entryId,
      position: (index % 2) + 1,
      globalSeedRank: index + 1,
      seedElo: 1_400 - index * 100,
      seedPoints: 100 - index * 10,
      entryVersion: 0,
      rosterVersion: 1,
      createdAt: PUBLISHED_AT,
    })),
    entries,
    members,
    fixtures,
    lineups: [
      ...lineupRows(type, "fixture-ab", "entry-a", "entry-b"),
      ...lineupRows(type, "fixture-cd", "entry-c", "entry-d"),
    ],
    revisions,
    settlements: [
      resultApplication(type, "fixture-ab", "revision-ab"),
      resultApplication(type, "fixture-cd", "revision-cd"),
    ] as TestSettlement[],
    snapshot: null as null | {
      id: string;
      matchId: string;
      groupingId: string;
      schemaVersion: number;
      standingsPolicyVersion: number;
      sourceRevisionFingerprint: string;
      createdAt: Date;
    },
    standings: [] as Array<{
      id: string;
      matchId: string;
      snapshotId: string;
      groupId: string;
      entryId: string;
      rank: number;
      played: number;
      wins: number;
      losses: number;
      scoreFor: number;
      scoreAgainst: number;
      scoreDifferential: number;
      qualified: boolean;
      qualificationOrder: number | null;
      ineligibilityReason: string | null;
      createdAt: Date;
    }>,
    snapshotWrites: 0,
    standingWrites: 0,
    auditWrites: 0,
    auditDetails: null as unknown,
    locks: [] as string[],
    lockedUserIds: [] as string[],
    userReadAfterLock: false,
    capturedFindArgs: {
      members: null as CapturedFindArgs | null,
      lineups: null as CapturedFindArgs | null,
      revisions: null as CapturedFindArgs | null,
      settlements: null as CapturedFindArgs | null,
    },
    isolationLevels: [] as unknown[],
  };
}

function addConfirmedCorrection(state: State, type: MatchType = "single") {
  const original = state.revisions.find((revision) => revision.id === "revision-ab")!;
  const application = state.settlements.find(
    (event) => event.resultRevisionId === original.id && event.kind === "RESULT_APPLY",
  ) as TestResultApplication;
  original.status = "SUPERSEDED";
  application.status = "REVERSED";
  const reversal = resultReversal(application);
  const correctedAt = new Date("2026-09-05T11:00:00.000Z");
  const correction: State["revisions"][number] = {
    ...original,
    id: "revision-ab-correction",
    revisionNumber: 2,
    status: "CONFIRMED",
    supersedesRevisionId: original.id,
    reportedById: "manager-1",
    verifiedById: "manager-1",
    reason: "corrected result",
    resolvedAt: correctedAt,
    createdAt: correctedAt,
    updatedAt: correctedAt,
  };
  state.revisions.push(correction);
  state.settlements.push(reversal, resultApplication(type, "fixture-ab", correction.id));
  return { original, correction, application, reversal };
}

function fakeDatabase(state: State) {
  const tx = {
    $queryRaw: async (query: {
      strings?: readonly string[];
      values?: readonly unknown[];
    }) => {
      const sql = (query.strings?.join("?") ?? String(query))
        .replaceAll(/\s+/g, " ")
        .trim();
      state.locks.push(sql);
      if (sql.includes('FROM "Match"')) return [{ id: state.match.id }];
      if (sql.includes('FROM "User"')) {
        state.lockedUserIds = (query.values ?? []).filter(
          (value): value is string => typeof value === "string",
        );
        const requested = new Set(state.lockedUserIds);
        return [state.actor, ...state.users]
          .filter((user) => requested.has(user.id))
          .map((user) => ({ id: user.id }))
          .sort((left, right) => left.id.localeCompare(right.id));
      }
      return [];
    },
    match: { findUnique: async () => ({ ...state.match }) },
    user: {
      findUnique: async () => ({ ...state.actor }),
      findMany: async (args: { where: { id: { in: readonly string[] } } }) => {
        state.userReadAfterLock = state.lockedUserIds.length > 0;
        const requested = new Set(args.where.id.in);
        return [state.actor, ...state.users]
          .filter((user) => requested.has(user.id))
          .map((user) => ({ ...user }));
      },
    },
    matchGrouping: { findUnique: async () => ({ ...state.grouping }) },
    matchGroup: { findMany: async () => [...state.groups] },
    matchGroupEntry: { findMany: async () => [...state.memberships] },
    matchEntry: { findMany: async () => [...state.entries] },
    matchEntryMember: {
      findMany: async (args: CapturedFindArgs) => {
        state.capturedFindArgs.members = args;
        return [...state.members];
      },
    },
    matchFixture: { findMany: async () => [...state.fixtures] },
    matchFixtureLineupMember: {
      findMany: async (args: CapturedFindArgs) => {
        state.capturedFindArgs.lineups = args;
        return [...state.lineups];
      },
    },
    resultRevision: {
      findMany: async (args: CapturedFindArgs) => {
        state.capturedFindArgs.revisions = args;
        return [...state.revisions];
      },
    },
    settlementEvent: {
      findMany: async (args: CapturedFindArgs) => {
        state.capturedFindArgs.settlements = args;
        return [...state.settlements];
      },
    },
    matchQualificationSnapshot: {
      findUnique: async () => (state.snapshot ? { ...state.snapshot } : null),
      create: async (args: {
        data: Omit<NonNullable<State["snapshot"]>, "id">;
      }) => {
        state.snapshotWrites += 1;
        state.snapshot = { id: "snapshot-1", ...args.data };
        return { id: state.snapshot.id, createdAt: state.snapshot.createdAt };
      },
    },
    matchQualificationStanding: {
      findMany: async () => state.standings.map((standing) => ({ ...standing })),
      createMany: async (args: {
        data: Array<Omit<State["standings"][number], "id">>;
      }) => {
        state.standingWrites += 1;
        state.standings = args.data.map((standing, index) => ({
          id: `standing-${index + 1}`,
          ...standing,
        }));
        return { count: args.data.length };
      },
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
      operation: (client: typeof tx) => Promise<T>,
      options?: { isolationLevel?: unknown },
    ) => {
      state.isolationLevels.push(options?.isolationLevel);
      return operation(tx);
    },
  } as unknown as Pick<PrismaClient, "$transaction">;
}

function command(): FreezeV2QualificationSnapshotCommand {
  return {
    actor: { id: "manager-1", role: "user" },
    matchId: "match-1",
  };
}

function service(state: State, clock: () => Date = () => NOW) {
  return createV2QualificationSnapshotApplicationService({
    db: fakeDatabase(state),
    clock,
  });
}

async function expectApplicationError(
  operation: () => Promise<unknown>,
  code: V2CompetitionApplicationError["code"],
) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof V2CompetitionApplicationError);
    assert.equal(error.code, code);
    return true;
  });
}

for (const type of ["single", "double", "team"] as const) {
  test(`freezes complete ${type} qualification facts atomically`, async () => {
    const state = initialState(type);
    const result = await service(state).freeze(command());

    assert.equal(result.created, true);
    assert.equal(result.snapshotId, "snapshot-1");
    assert.equal(result.qualificationCount, 2);
    assert.match(result.sourceRevisionFingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      result.standings
        .filter((standing) => standing.qualified)
        .map((standing) => [standing.entryId, standing.qualificationOrder]),
      [
        ["entry-a", 1],
        ["entry-c", 2],
      ],
    );
    assert.equal(state.snapshotWrites, 1);
    assert.equal(state.standingWrites, 1);
    assert.equal(state.standings.length, 4);
    assert.equal(state.auditWrites, 1);
    assert.deepEqual(state.isolationLevels, ["Serializable"]);

    const matchLock = state.locks.findIndex((sql) => sql.includes('FROM "Match"'));
    const groupLock = state.locks.findIndex((sql) => sql.includes('FROM "match_group"'));
    const fixtureLock = state.locks.findIndex((sql) => sql.includes('FROM "match_fixture"'));
    const revisionLock = state.locks.findIndex((sql) => sql.includes('FROM "result_revision"'));
    const settlementLock = state.locks.findIndex((sql) => sql.includes('FROM "settlement_event"'));
    const actorLock = state.locks.findIndex((sql) => sql.includes('FROM "User"'));
    assert.ok(matchLock < groupLock);
    assert.ok(groupLock < fixtureLock);
    assert.ok(fixtureLock < revisionLock);
    assert.ok(revisionLock < settlementLock);
    assert.ok(settlementLock < actorLock);
  });
}

test("an exact retry is a strict no-op", async () => {
  const state = initialState();
  const app = service(state);
  const first = await app.freeze(command());
  const second = await app.freeze(command());

  assert.equal(second.created, false);
  assert.equal(second.snapshotId, first.snapshotId);
  assert.equal(second.sourceRevisionFingerprint, first.sourceRevisionFingerprint);
  assert.equal(state.snapshotWrites, 1);
  assert.equal(state.standingWrites, 1);
  assert.equal(state.auditWrites, 1);
});

test("a changed full revision history or polluted standing fails closed on retry", async () => {
  const changedHistory = initialState();
  const changedApp = service(changedHistory);
  await changedApp.freeze(command());
  changedHistory.revisions[0].reason = "history was edited";
  await expectApplicationError(
    () => changedApp.freeze(command()),
    "PERSISTENCE_CONFLICT",
  );

  const pollutedStanding = initialState();
  const pollutedApp = service(pollutedStanding);
  await pollutedApp.freeze(command());
  pollutedStanding.standings[0].wins += 1;
  await expectApplicationError(
    () => pollutedApp.freeze(command()),
    "PERSISTENCE_CONFLICT",
  );
});

test("FORFEIT is ranked as 1:0 and must have no global settlement", async () => {
  const state = initialState("single");
  state.revisions[0].resolutionKind = "FORFEIT";
  state.revisions[0].score = { reason: "opponent unavailable" };
  state.settlements = state.settlements.filter(
    (event) => event.resultRevisionId !== "revision-ab",
  );
  const result = await service(state).freeze(command());
  const winner = result.standings.find((standing) => standing.entryId === "entry-a")!;
  assert.equal(winner.scoreFor, 1);
  assert.equal(winner.scoreAgainst, 0);

  const polluted = initialState("single");
  polluted.revisions[0].resolutionKind = "FORFEIT";
  polluted.revisions[0].score = { reason: "opponent unavailable" };
  await expectApplicationError(
    () => service(polluted).freeze(command()),
    "PERSISTENCE_CONFLICT",
  );
});

test("inactive Entries stay in the snapshot and their terminal pairings do not count", async () => {
  const state = initialState();
  state.entries.find((entry) => entry.id === "entry-b")!.status = "DISQUALIFIED";
  state.entries.find((entry) => entry.id === "entry-b")!.version = 1;
  state.members
    .filter((member) => member.entryId === "entry-b")
    .forEach((member) => {
      member.status = "DISQUALIFIED";
      member.effectiveUntil = NOW;
      member.endReason = "DISQUALIFIED";
    });
  state.fixtures[0].status = "VOIDED";
  state.fixtures[0].completedAt = null;
  state.revisions = state.revisions.filter(
    (revision) => revision.fixtureId !== "fixture-ab",
  );
  state.settlements = state.settlements.filter(
    (event) => event.resultRevisionId !== "revision-ab",
  );

  const result = await service(state).freeze(command());
  const inactive = result.standings.find((standing) => standing.entryId === "entry-b")!;
  const eligible = result.standings.find((standing) => standing.entryId === "entry-a")!;
  assert.deepEqual(
    {
      rank: inactive.rank,
      played: inactive.played,
      qualified: inactive.qualified,
      reason: inactive.ineligibilityReason,
    },
    { rank: 2, played: 0, qualified: false, reason: "DISQUALIFIED" },
  );
  assert.equal(eligible.played, 0);
  assert.equal(eligible.qualified, true);
});

test("pending results, incomplete round robin, and incomplete lineups block freezing", async () => {
  const pending = initialState();
  pending.revisions[0].status = "PENDING";
  pending.fixtures[0].status = "READY";
  pending.settlements = pending.settlements.filter(
    (event) => event.resultRevisionId !== "revision-ab",
  );
  await expectApplicationError(
    () => service(pending).freeze(command()),
    "FIXTURE_RESULT_REQUIRED",
  );

  const incompleteRoundRobin = initialState();
  incompleteRoundRobin.fixtures = incompleteRoundRobin.fixtures.filter(
    (fixture) => fixture.id !== "fixture-ab",
  );
  incompleteRoundRobin.lineups = incompleteRoundRobin.lineups.filter(
    (lineup) => lineup.fixtureId !== "fixture-ab",
  );
  incompleteRoundRobin.revisions = incompleteRoundRobin.revisions.filter(
    (revision) => revision.fixtureId !== "fixture-ab",
  );
  incompleteRoundRobin.settlements = incompleteRoundRobin.settlements.filter(
    (event) => event.resultRevisionId !== "revision-ab",
  );
  await expectApplicationError(
    () => service(incompleteRoundRobin).freeze(command()),
    "PERSISTENCE_CONFLICT",
  );

  const incompleteLineup = initialState("double");
  incompleteLineup.lineups.splice(0, 1);
  await expectApplicationError(
    () => service(incompleteLineup).freeze(command()),
    "FIXTURE_LINEUP_INVALID",
  );
});

test("PLAYED requires one applied unreversed settlement with complete effects", async () => {
  const missing = initialState();
  missing.settlements = missing.settlements.filter(
    (event) => event.resultRevisionId !== "revision-ab",
  );
  await expectApplicationError(
    () => service(missing).freeze(command()),
    "PERSISTENCE_CONFLICT",
  );

  const reversed = initialState();
  reversed.settlements[0].status = "REVERSED";
  await expectApplicationError(
    () => service(reversed).freeze(command()),
    "PERSISTENCE_CONFLICT",
  );

  const incompleteEffects = initialState("team");
  incompleteEffects.settlements[0].effects.pop();
  await expectApplicationError(
    () => service(incompleteEffects).freeze(command()),
    "PERSISTENCE_CONFLICT",
  );
});

test("a complete correction chain preserves every revision and reversal", async () => {
  const state = initialState();
  const chain = addConfirmedCorrection(state);
  const app = service(state);

  const result = await app.freeze(command());
  assert.equal(result.created, true);
  assert.equal(
    result.standings.find((standing) => standing.entryId === "entry-a")?.wins,
    1,
  );
  chain.original.reason = "tampered superseded history";
  await expectApplicationError(
    () => app.freeze(command()),
    "PERSISTENCE_CONFLICT",
  );

  const orphaned = initialState();
  const orphanedChain = addConfirmedCorrection(orphaned);
  orphanedChain.correction.supersedesRevisionId = null;
  await expectApplicationError(
    () => service(orphaned).freeze(command()),
    "PERSISTENCE_CONFLICT",
  );

  const invalidPredecessor = initialState();
  const invalidChain = addConfirmedCorrection(invalidPredecessor);
  invalidChain.original.status = "VOIDED";
  await expectApplicationError(
    () => service(invalidPredecessor).freeze(command()),
    "PERSISTENCE_CONFLICT",
  );
});

test("settlement effects and reversal subjects must match the recorded result", async () => {
  const wrongWinnerSemantics = initialState();
  wrongWinnerSemantics.settlements[0].effects[0].winsDelta = 0;
  await expectApplicationError(
    () => service(wrongWinnerSemantics).freeze(command()),
    "PERSISTENCE_CONFLICT",
  );

  const wrongReversalSemantics = initialState();
  const correction = addConfirmedCorrection(wrongReversalSemantics);
  correction.reversal.effects[0].lossesDelta = -1;
  await expectApplicationError(
    () => service(wrongReversalSemantics).freeze(command()),
    "PERSISTENCE_CONFLICT",
  );

  const crossRevision = initialState();
  const crossRevisionChain = addConfirmedCorrection(crossRevision);
  crossRevisionChain.reversal.resultRevisionId = crossRevisionChain.correction.id;
  await expectApplicationError(
    () => service(crossRevision).freeze(command()),
    "PERSISTENCE_CONFLICT",
  );

  const inboundCrossMatch = initialState();
  const external = resultReversal(
    inboundCrossMatch.settlements[0] as TestResultApplication,
    "outside-revision-reversal",
  );
  external.resultRevisionId = "outside-revision";
  inboundCrossMatch.settlements.push(external);
  await expectApplicationError(
    () => service(inboundCrossMatch).freeze(command()),
    "PERSISTENCE_CONFLICT",
  );
  assert.match(
    JSON.stringify(inboundCrossMatch.capturedFindArgs.settlements?.where),
    /reverses/,
  );
});

test("eligible rosters remain active and contain available users in canonical roles", async () => {
  const inactiveMember = initialState();
  inactiveMember.members[0].status = "DISQUALIFIED";
  inactiveMember.members[0].effectiveUntil = NOW;
  inactiveMember.members[0].endReason = "DISQUALIFIED";
  await expectApplicationError(
    () => service(inactiveMember).freeze(command()),
    "PERSISTENCE_CONFLICT",
  );

  const banned = initialState();
  banned.users.find((user) => user.id === "entry-a-user-1")!.isBanned = true;
  await expectApplicationError(
    () => service(banned).freeze(command()),
    "PERSISTENCE_CONFLICT",
  );

  const unverified = initialState();
  unverified.users.find(
    (user) => user.id === "entry-a-user-1",
  )!.emailVerifiedAt = null;
  await expectApplicationError(
    () => service(unverified).freeze(command()),
    "PERSISTENCE_CONFLICT",
  );

  const wrongSinglesRole = initialState();
  wrongSinglesRole.members[0].role = "captain";
  await expectApplicationError(
    () => service(wrongSinglesRole).freeze(command()),
    "PERSISTENCE_CONFLICT",
  );

  const wrongDoublesRole = initialState("double");
  wrongDoublesRole.members[0].role = "captain";
  await expectApplicationError(
    () => service(wrongDoublesRole).freeze(command()),
    "PERSISTENCE_CONFLICT",
  );
});

test("locks all source rows and sorted roster Users before sampling the clock", async () => {
  const state = initialState("team");
  let locksAtClock: readonly string[] = [];
  let userReadAtClock = false;
  await service(state, () => {
    locksAtClock = [...state.locks];
    userReadAtClock = state.userReadAfterLock;
    return NOW;
  }).freeze(command());

  const expectedUserIds = [state.actor.id, ...state.users.map((user) => user.id)].sort();
  assert.deepEqual(state.lockedUserIds, expectedUserIds);
  assert.equal(state.userReadAfterLock, true);
  assert.equal(userReadAtClock, true);
  assert.equal(
    locksAtClock.some((sql) => sql.includes('FROM "settlement_event"')),
    true,
  );
  assert.equal(
    locksAtClock.some(
      (sql) => sql.includes('AS reversed_event') && sql.includes('AS reversed_fixture'),
    ),
    true,
  );
  assert.equal(locksAtClock.some((sql) => sql.includes('FROM "User"')), true);
});

test("bounds every potentially large qualification source query", async () => {
  const state = initialState();
  await service(state).freeze(command());

  assert.equal(state.capturedFindArgs.members?.take, 51_201);
  assert.equal(state.capturedFindArgs.lineups?.take, 1_000_001);
  assert.equal(state.capturedFindArgs.revisions?.take, 100_001);
  assert.equal(state.capturedFindArgs.settlements?.take, 200_001);
  assert.equal(state.capturedFindArgs.settlements?.select?.effects?.take, 101);
});

test("only an active current manager can freeze a supported complete grouping", async () => {
  const forbidden = initialState();
  forbidden.actor.id = "other-user";
  await expectApplicationError(
    () =>
      service(forbidden).freeze({
        actor: { id: "other-user", role: "user" },
        matchId: "match-1",
      }),
    "FORBIDDEN",
  );

  const staleActorRole = initialState();
  await expectApplicationError(
    () =>
      service(staleActorRole).freeze({
        actor: { id: "manager-1", role: "admin" },
        matchId: "match-1",
      }),
    "ACTOR_ROLE_STALE",
  );

  const wrongFormat = initialState();
  wrongFormat.match.format = "group_only";
  await expectApplicationError(
    () => service(wrongFormat).freeze(command()),
    "FIXTURE_CREATION_NOT_ALLOWED",
  );

  const partialGrouping = initialState();
  partialGrouping.grouping.bracketPolicyVersion = null;
  await expectApplicationError(
    () => service(partialGrouping).freeze(command()),
    "PERSISTENCE_CONFLICT",
  );

  const invalidPower = initialState();
  invalidPower.grouping.qualifiersPerGroup = 2;
  invalidPower.groups.push({
    ...invalidPower.groups[1],
    id: "group-3",
    groupKey: "group:0003",
    displayName: "第 3 组",
    position: 3,
  });
  await expectApplicationError(
    () => service(invalidPower).freeze(command()),
    "PERSISTENCE_CONFLICT",
  );
});

test("rejects command over-posting before opening a transaction", async () => {
  const state = initialState();
  const app = service(state);
  await expectApplicationError(
    () =>
      app.freeze({
        ...command(),
        unexpected: true,
      } as FreezeV2QualificationSnapshotCommand),
    "INVALID_INPUT",
  );
  assert.equal(state.isolationLevels.length, 0);
});
