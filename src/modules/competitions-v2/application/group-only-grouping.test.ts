import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import {
  V2CompetitionApplicationError,
  type V2CompetitionTransaction,
} from "./entries";
import {
  createV2GroupOnlyGroupingApplicationService,
  V2_GROUP_THEN_KNOCKOUT_BRACKET_POLICY_VERSION,
  V2_DOUBLE_GROUP_ONLY_GROUPING_PROFILE,
  V2_SINGLE_GROUP_ONLY_GROUPING_PROFILE,
  V2_SINGLE_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE,
  V2_TEAM_GROUP_ONLY_GROUPING_PROFILE,
  type PublishV2GroupOnlyGroupingCommand,
  type V2GroupOnlyGroupingProfile,
} from "./group-only-grouping";

const publishedAt = new Date("2026-09-05T12:00:00.000Z");

type TestUser = ReturnType<typeof makeUser>;
type TestMember = Readonly<{
  id: string;
  userId: string;
  role: "player" | "captain" | "substitute";
  slot: number;
  rosterVersion: number;
}>;
type TestEntry = Readonly<{
  id: string;
  kind: "INDIVIDUAL" | "DOUBLES" | "TEAM";
  status: "ACTIVE";
  version: number;
  sourceKey: string;
  sourceUserId: string | null;
  sourceDoublesTeamId: string | null;
  sourceMatchTeamId: string | null;
  displayNameSnapshot: string;
  sourceDoublesTeam: {
    id: string;
    matchId: string;
    members: Array<{ userId: string; slot: number; matchId: string }>;
  } | null;
  sourceMatchTeam: {
    id: string;
    matchId: string;
    status: "approved" | "submitted";
    captainId: string;
    members: Array<{ userId: string; matchId: string }>;
  } | null;
  members: TestMember[];
}>;

type TestGroup = {
  id: string;
  matchId: string;
  groupingId: string;
  groupKey: string;
  displayName: string;
  position: number;
  entries: Array<Record<string, unknown>>;
};

type TestState = {
  match: {
    id: string;
    title: string;
    createdBy: string;
    engineVersion: "V2";
    isQuickMatch: false;
    type: "single" | "double" | "team";
    status: "registration" | "ongoing";
    format: "group_only" | "group_then_knockout";
    registrationDeadline: Date;
    teamRegistrationDeadline: Date | null;
    teamMinMembers: number | null;
    teamMaxMembers: number | null;
    groupingGeneratedAt: Date | null;
  };
  entries: TestEntry[];
  users: TestUser[];
  grouping: null | {
    id: string;
    matchId: string;
    payload: unknown;
    v2SchemaVersion: number;
    seedMethod: "MIN_DIFF" | "SNAKE";
    standingsPolicyVersion: number;
    qualifiersPerGroup: number | null;
    bracketPolicyVersion: number | null;
    createdAt: Date;
  };
  groups: TestGroup[];
  fixtures: Array<Record<string, unknown>>;
  lineups: Array<Record<string, unknown>>;
  writes: {
    grouping: number;
    groups: number;
    memberships: number;
    fixtures: number;
    lineups: number;
    match: number;
    audit: number;
  };
  auditAction: string | null;
};

function makeUser(id: string, eloRating: number, points = 10) {
  return {
    id,
    role: "user" as const,
    nickname: `User ${id}`,
    eloRating,
    points,
    isBanned: false,
    emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function member(
  entryId: string,
  userId: string,
  slot: number,
  role: TestMember["role"] = "player",
): TestMember {
  return {
    id: `${entryId}-member-${slot}`,
    userId,
    role,
    slot,
    rosterVersion: 3,
  };
}

function buildEntries(type: TestState["match"]["type"]) {
  if (type === "single") {
    const users = [makeUser("single-a", 1200), makeUser("single-b", 1200)];
    const entries: TestEntry[] = users.map((user, index) => {
      const id = index === 0 ? "entry-a" : "entry-b";
      return {
        id,
        kind: "INDIVIDUAL",
        status: "ACTIVE",
        version: index === 0 ? 2 : 4,
        sourceKey: `individual:${user.id}`,
        sourceUserId: user.id,
        sourceDoublesTeamId: null,
        sourceMatchTeamId: null,
        displayNameSnapshot: user.nickname,
        sourceDoublesTeam: null,
        sourceMatchTeam: null,
        members: [member(id, user.id, 1)],
      };
    });
    return { entries, users, lineupSize: 2 };
  }
  if (type === "double") {
    const users = [
      makeUser("double-a1", -1201),
      makeUser("double-a2", -1202),
      makeUser("double-b1", -1201),
      makeUser("double-b2", -1202),
    ];
    const entries: TestEntry[] = ["a", "b"].map((suffix, index) => {
      const id = `entry-${suffix}`;
      const pair = users.slice(index * 2, index * 2 + 2);
      const sourceId = `doubles-${suffix}`;
      return {
        id,
        kind: "DOUBLES",
        status: "ACTIVE",
        version: index === 0 ? 2 : 4,
        sourceKey: `doubles:${sourceId}`,
        sourceUserId: null,
        sourceDoublesTeamId: sourceId,
        sourceMatchTeamId: null,
        displayNameSnapshot: `Pair ${suffix.toUpperCase()}`,
        sourceDoublesTeam: {
          id: sourceId,
          matchId: "match-1",
          members: pair.map((user, slot) => ({
            userId: user.id,
            slot: slot + 1,
            matchId: "match-1",
          })),
        },
        sourceMatchTeam: null,
        members: pair.map((user, slot) => member(id, user.id, slot + 1)),
      };
    });
    return { entries, users, lineupSize: 4 };
  }
  const users = [
    makeUser("team-a1", 1300),
    makeUser("team-a2", 1200),
    makeUser("team-a3", 1250),
    makeUser("team-b1", 1300),
    makeUser("team-b2", 1200),
    makeUser("team-b3", 1250),
  ];
  const entries: TestEntry[] = ["a", "b"].map((suffix, index) => {
    const id = `entry-${suffix}`;
    const roster = users.slice(index * 3, index * 3 + 3);
    const sourceId = `team-${suffix}`;
    return {
      id,
      kind: "TEAM",
      status: "ACTIVE",
      version: index === 0 ? 2 : 4,
      sourceKey: `team:${sourceId}`,
      sourceUserId: null,
      sourceDoublesTeamId: null,
      sourceMatchTeamId: sourceId,
      displayNameSnapshot: `Team ${suffix.toUpperCase()}`,
      sourceDoublesTeam: null,
      sourceMatchTeam: {
        id: sourceId,
        matchId: "match-1",
        status: "approved",
        captainId: roster[0].id,
        members: roster.map((user) => ({
          userId: user.id,
          matchId: "match-1",
        })),
      },
      members: roster.map((user, slot) =>
        member(id, user.id, slot + 1, slot === 0 ? "captain" : "player"),
      ),
    };
  });
  return { entries, users, lineupSize: 6 };
}

function initialState(type: TestState["match"]["type"]) {
  const built = buildEntries(type);
  const state: TestState = {
    match: {
      id: "match-1",
      title: `${type} grouping`,
      createdBy: "manager-1",
      engineVersion: "V2",
      isQuickMatch: false,
      type,
      status: "registration",
      format: "group_only",
      registrationDeadline: new Date("2026-09-01T00:00:00.000Z"),
      teamRegistrationDeadline:
        type === "team" ? new Date("2026-09-02T00:00:00.000Z") : null,
      teamMinMembers: type === "team" ? 2 : null,
      teamMaxMembers: type === "team" ? 4 : null,
      groupingGeneratedAt: null,
    },
    entries: built.entries,
    users: [makeUser("manager-1", 1200, 0), ...built.users],
    grouping: null,
    groups: [],
    fixtures: [],
    lineups: [],
    writes: {
      grouping: 0,
      groups: 0,
      memberships: 0,
      fixtures: 0,
      lineups: 0,
      match: 0,
      audit: 0,
    },
    auditAction: null,
  };
  return { state, lineupSize: built.lineupSize };
}

function fakeDatabase(state: TestState) {
  const tx = {
    $queryRaw: async (query: { strings?: readonly string[] }) => {
      const sql = query.strings?.join("?") ?? String(query);
      return [{ id: sql.includes('FROM "Match"') ? state.match.id : "locked" }];
    },
    match: {
      findUniqueOrThrow: async () => ({ groupBestOf: 5 }),
      findUnique: async () => ({ ...state.match }),
      update: async (args: {
        data: { status: "ongoing"; groupingGeneratedAt: Date };
      }) => {
        state.match.status = args.data.status;
        state.match.groupingGeneratedAt = args.data.groupingGeneratedAt;
        state.writes.match += 1;
        return state.match;
      },
    },
    user: {
      findUnique: async (args: { where: { id: string } }) =>
        state.users.find((user) => user.id === args.where.id) ?? null,
      findMany: async (args: { where: { id: { in: string[] } } }) => {
        const ids = new Set(args.where.id.in);
        return state.users.filter((user) => ids.has(user.id));
      },
    },
    matchEntry: {
      findMany: async () => [...state.entries].sort((a, b) => a.id.localeCompare(b.id)),
    },
    matchGrouping: {
      findUnique: async () => state.grouping,
      create: async (args: { data: NonNullable<TestState["grouping"]> }) => {
        state.grouping = { ...args.data, id: "grouping-1" };
        state.writes.grouping += 1;
        return { id: state.grouping.id };
      },
    },
    matchGroup: {
      findMany: async () => state.groups,
      create: async (args: { data: Omit<TestGroup, "id" | "entries"> }) => {
        const group: TestGroup = {
          id: `group-${state.groups.length + 1}`,
          ...args.data,
          entries: [],
        };
        state.groups.push(group);
        state.writes.groups += 1;
        return { id: group.id };
      },
    },
    matchGroupEntry: {
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        for (const row of args.data) {
          state.groups.find((group) => group.id === row.groupId)!.entries.push(row);
        }
        state.writes.memberships += args.data.length;
        return { count: args.data.length };
      },
    },
    matchFixture: {
      findMany: async () => state.fixtures,
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        const offset = state.fixtures.length;
        state.fixtures.push(
          ...args.data.map((fixture, index) => ({
            id: `fixture-${offset + index + 1}`,
            ...fixture,
          })),
        );
        state.writes.fixtures += args.data.length;
        return { count: args.data.length };
      },
    },
    matchFixtureLineupMember: {
      findMany: async (args: { where: { fixtureId: { in: string[] } } }) => {
        const fixtureIds = new Set(args.where.fixtureId.in);
        return state.lineups.filter((lineup) => fixtureIds.has(String(lineup.fixtureId)));
      },
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        state.lineups.push(...args.data);
        state.writes.lineups += args.data.length;
        return { count: args.data.length };
      },
    },
    auditLog: {
      create: async (args: { data: { action: string } }) => {
        state.auditAction = args.data.action;
        state.writes.audit += 1;
        return { id: "audit-1" };
      },
    },
  };
  return {
    $transaction: async <T>(
      operation: (transaction: V2CompetitionTransaction) => Promise<T>,
    ) => operation(tx as unknown as V2CompetitionTransaction),
  } as unknown as Pick<PrismaClient, "$transaction">;
}

function command(
  state: TestState,
  format: "group_only" | "group_then_knockout" = "group_only",
): PublishV2GroupOnlyGroupingCommand {
  return {
    actor: { id: "manager-1", role: "user" },
    matchId: state.match.id,
    expectedEntries: state.entries.map((entry) => ({
      entryId: entry.id,
      version: entry.version,
    })),
    draft: {
      format,
      seedMethod: "snake",
      groups: [{ entryIds: ["entry-a", "entry-b"] }],
      ...(format === "group_then_knockout" ? { qualifiersPerGroup: 2 } : {}),
    },
  };
}

async function expectError(
  operation: () => Promise<unknown>,
  code: V2CompetitionApplicationError["code"],
) {
  await assert.rejects(
    operation,
    (error: unknown) =>
      error instanceof V2CompetitionApplicationError && error.code === code,
  );
}

const cases: ReadonlyArray<{
  type: TestState["match"]["type"];
  profile: V2GroupOnlyGroupingProfile;
  expectedPublication: string;
  expectedAudit: string;
  expectedSeedElo: number;
}> = [
  {
    type: "single",
    profile: V2_SINGLE_GROUP_ONLY_GROUPING_PROFILE,
    expectedPublication: "V2_SINGLE_GROUPING",
    expectedAudit: "v2_single_grouping_publish",
    expectedSeedElo: 1200,
  },
  {
    type: "double",
    profile: V2_DOUBLE_GROUP_ONLY_GROUPING_PROFILE,
    expectedPublication: "V2_DOUBLE_GROUPING",
    expectedAudit: "v2_double_grouping_publish",
    expectedSeedElo: -1201,
  },
  {
    type: "team",
    profile: V2_TEAM_GROUP_ONLY_GROUPING_PROFILE,
    expectedPublication: "V2_TEAM_GROUPING",
    expectedAudit: "v2_team_grouping_publish",
    expectedSeedElo: 1250,
  },
];

for (const fixtureCase of cases) {
  test(`${fixtureCase.type} freezes relational groups, seed inputs, and complete lineups`, async () => {
    const { state, lineupSize } = initialState(fixtureCase.type);
    const service = createV2GroupOnlyGroupingApplicationService(
      { db: fakeDatabase(state), clock: () => publishedAt },
      fixtureCase.profile,
    );

    const first = await service.publish(command(state));
    assert.equal(first.created, true);
    assert.equal(first.fixtureCount, 1);
    assert.deepEqual(
      {
        v2SchemaVersion: state.grouping?.v2SchemaVersion,
        seedMethod: state.grouping?.seedMethod,
        standingsPolicyVersion: state.grouping?.standingsPolicyVersion,
        qualifiersPerGroup: state.grouping?.qualifiersPerGroup,
        bracketPolicyVersion: state.grouping?.bracketPolicyVersion,
      },
      {
        v2SchemaVersion: 1,
        seedMethod: "SNAKE",
        standingsPolicyVersion: 1,
        qualifiersPerGroup: null,
        bracketPolicyVersion: null,
      },
    );
    assert.equal(state.groups.length, 1);
    assert.equal(state.groups[0].entries.length, 2);
    assert.deepEqual(
      state.groups[0].entries.map((row) => ({
        entryId: row.entryId,
        position: row.position,
        globalSeedRank: row.globalSeedRank,
        seedElo: row.seedElo,
        seedPoints: row.seedPoints,
        entryVersion: row.entryVersion,
        rosterVersion: row.rosterVersion,
      })),
      [
        {
          entryId: "entry-a",
          position: 1,
          globalSeedRank: 1,
          seedElo: fixtureCase.expectedSeedElo,
          seedPoints: 10,
          entryVersion: 2,
          rosterVersion: 3,
        },
        {
          entryId: "entry-b",
          position: 2,
          globalSeedRank: 2,
          seedElo: fixtureCase.expectedSeedElo,
          seedPoints: 10,
          entryVersion: 4,
          rosterVersion: 3,
        },
      ],
    );
    assert.equal(state.fixtures[0].groupId, state.groups[0].id);
    assert.equal(state.fixtures[0].groupKey, state.groups[0].groupKey);
    assert.equal(
      (state.fixtures[0].metadata as Record<string, unknown>).publication,
      fixtureCase.expectedPublication,
    );
    assert.equal(state.lineups.length, lineupSize);
    assert.equal(state.auditAction, fixtureCase.expectedAudit);

    state.users
      .filter((user) => user.id !== "manager-1")
      .forEach((user) => {
        user.eloRating += 37;
        user.points += 1;
      });
    state.fixtures[0].metadata = {
      ...(state.fixtures[0].metadata as Record<string, unknown>),
      v2Display: { schemaVersion: 1, tableLabels: ["1 号台"] },
    };
    (state.grouping!.payload as Record<string, unknown>).tableAssignments = {
      group: { "第 1 组": ["1 号台"] },
      knockout: {},
    };

    const retry = await service.publish(command(state));
    assert.equal(retry.created, false);
    assert.equal(retry.publishedAt.toISOString(), publishedAt.toISOString());
    assert.deepEqual(state.writes, {
      grouping: 1,
      groups: 1,
      memberships: 2,
      fixtures: 1,
      lineups: lineupSize,
      match: 1,
      audit: 1,
    });

    const payloadGroups = (state.grouping!.payload as {
      groups: Array<{ players: Array<{ points: number }> }>;
    }).groups;
    const frozenPoints = payloadGroups[0].players[0].points;
    payloadGroups[0].players[0].points = frozenPoints + 1;
    await expectError(() => service.publish(command(state)), "FIXTURE_KEY_CONFLICT");
    payloadGroups[0].players[0].points = frozenPoints;

    state.groups[0].entries[0].entryVersion = 999;
    await expectError(() => service.publish(command(state)), "FIXTURE_KEY_CONFLICT");
  });
}

test("group-then-knockout publishes only the complete relational group phase", async () => {
  const { state, lineupSize } = initialState("single");
  state.match.format = "group_then_knockout";
  const service = createV2GroupOnlyGroupingApplicationService(
    { db: fakeDatabase(state), clock: () => publishedAt },
    V2_SINGLE_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE,
  );

  const first = await service.publish(command(state, "group_then_knockout"));
  assert.equal(first.created, true);
  assert.equal(first.fixtureCount, 1);
  assert.equal(state.grouping?.qualifiersPerGroup, 2);
  assert.equal(
    state.grouping?.bracketPolicyVersion,
    V2_GROUP_THEN_KNOCKOUT_BRACKET_POLICY_VERSION,
  );
  assert.deepEqual(
    {
      format: (state.grouping?.payload as Record<string, unknown>).format,
      config: (state.grouping?.payload as Record<string, unknown>).config,
    },
    {
      format: "group_then_knockout",
      config: {
        groupCount: 1,
        seedMethod: "snake",
        qualifiersPerGroup: 2,
      },
    },
  );
  assert.equal(state.fixtures.length, 1);
  assert.equal(state.fixtures[0].stage, "GROUP");
  assert.deepEqual(
    {
      format: (state.fixtures[0].metadata as Record<string, unknown>).format,
      qualifiersPerGroup: (state.fixtures[0].metadata as Record<string, unknown>)
        .qualifiersPerGroup,
    },
    { format: "group_then_knockout", qualifiersPerGroup: 2 },
  );
  assert.equal(state.lineups.length, lineupSize);

  const retry = await service.publish(command(state, "group_then_knockout"));
  assert.equal(retry.created, false);
  assert.deepEqual(state.writes, {
    grouping: 1,
    groups: 1,
    memberships: 2,
    fixtures: 1,
    lineups: lineupSize,
    match: 1,
    audit: 1,
  });
});

test("a group-only profile keeps group-then-knockout fail-closed", async () => {
  const { state } = initialState("single");
  state.match.format = "group_then_knockout";
  const service = createV2GroupOnlyGroupingApplicationService(
    { db: fakeDatabase(state), clock: () => publishedAt },
    V2_SINGLE_GROUP_ONLY_GROUPING_PROFILE,
  );

  await expectError(
    () => service.publish(command(state, "group_then_knockout")),
    "FIXTURE_CREATION_NOT_ALLOWED",
  );
  assert.equal(state.writes.grouping, 0);
});

test("team publication uses teamRegistrationDeadline and requires an approved source", async () => {
  const { state } = initialState("team");
  state.match.teamRegistrationDeadline = new Date("2026-09-06T00:00:00.000Z");
  const service = createV2GroupOnlyGroupingApplicationService(
    { db: fakeDatabase(state), clock: () => publishedAt },
    V2_TEAM_GROUP_ONLY_GROUPING_PROFILE,
  );
  await expectError(() => service.publish(command(state)), "FIXTURE_CREATION_NOT_ALLOWED");
  assert.equal(state.writes.grouping, 0);

  state.match.teamRegistrationDeadline = new Date("2026-09-02T00:00:00.000Z");
  state.entries[0].sourceMatchTeam!.status = "submitted";
  await expectError(() => service.publish(command(state)), "FIXTURE_ENTRY_INVALID");
  assert.equal(state.writes.grouping, 0);
});

test("team publication rejects a roster without exactly one matching captain", async () => {
  const { state } = initialState("team");
  state.entries[0].members[0] = {
    ...state.entries[0].members[0],
    role: "player",
  };
  const service = createV2GroupOnlyGroupingApplicationService(
    { db: fakeDatabase(state), clock: () => publishedAt },
    V2_TEAM_GROUP_ONLY_GROUPING_PROFILE,
  );
  await expectError(() => service.publish(command(state)), "FIXTURE_ENTRY_INVALID");
});
