import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import {
  V2CompetitionApplicationError,
  type V2CompetitionTransaction,
} from "./entries";
import {
  createV2SingleGroupingApplicationService,
  type PublishV2SingleGroupingCommand,
} from "./grouping";

const publishedAt = new Date("2026-09-04T12:00:00.000Z");

function entry(id: string, userId: string, version = 0) {
  return {
    id,
    kind: "INDIVIDUAL",
    status: "ACTIVE",
    version,
    sourceKey: `individual:${userId}`,
    sourceUserId: userId,
    sourceDoublesTeamId: null,
    sourceMatchTeamId: null,
    displayNameSnapshot: userId,
    sourceDoublesTeam: null,
    sourceMatchTeam: null,
    members: [
      {
        id: `${id}-member`,
        userId,
        role: "player",
        slot: 1,
        rosterVersion: 1,
      },
    ],
  };
}

function user(
  id: string,
  nickname: string,
  eloRating: number,
  points: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    role: "user",
    nickname,
    eloRating,
    points,
    isBanned: false,
    emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function command(): PublishV2SingleGroupingCommand {
  return {
    actor: { id: "manager-1", role: "user" },
    matchId: "match-1",
    expectedEntries: [
      { entryId: "entry-a", version: 2 },
      { entryId: "entry-b", version: 4 },
      { entryId: "entry-c", version: 6 },
      { entryId: "entry-d", version: 8 },
    ],
    draft: {
      format: "group_only",
      seedMethod: "snake",
      groups: [
        { entryIds: ["entry-a", "entry-b"] },
        { entryIds: ["entry-c", "entry-d"] },
      ],
    },
  };
}

type FakeState = {
  match: {
    id: string;
    title: string;
    createdBy: string;
    engineVersion: "LEGACY" | "V2";
    isQuickMatch: boolean;
    type: "single" | "double" | "team";
    status: "registration" | "ongoing" | "finished";
    format: "group_only" | "group_then_knockout";
    registrationDeadline: Date;
    teamRegistrationDeadline: Date | null;
    teamMinMembers: number | null;
    teamMaxMembers: number | null;
    groupingGeneratedAt: Date | null;
  };
  entries: ReturnType<typeof entry>[];
  users: ReturnType<typeof user>[];
  grouping: {
    id: string;
    matchId: string;
    payload: unknown;
    v2SchemaVersion: number | null;
    seedMethod: "MIN_DIFF" | "SNAKE" | null;
    standingsPolicyVersion: number | null;
    qualifiersPerGroup: number | null;
    bracketPolicyVersion: number | null;
    createdAt: Date;
  } | null;
  groups: Array<{
    id: string;
    matchId: string;
    groupingId: string;
    groupKey: string;
    displayName: string;
    position: number;
    entries: Array<Record<string, unknown>>;
  }>;
  fixtures: Array<Record<string, unknown>>;
  lineups: Array<Record<string, unknown>>;
  groupingWrites: number;
  fixtureWrites: number;
  lineupWrites: number;
  matchWrites: number;
  auditWrites: number;
  lockQueries: string[];
  isolationLevels: unknown[];
};

function initialState(): FakeState {
  return {
    match: {
      id: "match-1",
      title: "Singles championship",
      createdBy: "manager-1",
      engineVersion: "V2",
      isQuickMatch: false,
      type: "single",
      status: "registration",
      format: "group_only",
      registrationDeadline: new Date("2026-09-01T00:00:00.000Z"),
      teamRegistrationDeadline: null,
      teamMinMembers: null,
      teamMaxMembers: null,
      groupingGeneratedAt: null,
    },
    entries: [
      entry("entry-d", "user-d", 8),
      entry("entry-b", "user-b", 4),
      entry("entry-a", "user-a", 2),
      entry("entry-c", "user-c", 6),
    ],
    users: [
      user("manager-1", "Manager", 1200, 0),
      user("user-a", "Authoritative A", 1410, 11),
      user("user-b", "Authoritative B", 1190, 7),
      user("user-c", "Authoritative C", 1330, 9),
      user("user-d", "Authoritative D", 1270, 5),
    ],
    grouping: null,
    groups: [],
    fixtures: [],
    lineups: [],
    groupingWrites: 0,
    fixtureWrites: 0,
    lineupWrites: 0,
    matchWrites: 0,
    auditWrites: 0,
    lockQueries: [],
    isolationLevels: [],
  };
}

function fakeDatabase(state: FakeState) {
  const tx = {
    $queryRaw: async (query: { strings?: readonly string[] }) => {
      const text = query.strings?.join("?") ?? String(query);
      state.lockQueries.push(text.replaceAll(/\s+/g, " ").trim());
      return [{ id: text.includes('FROM "Match"') ? state.match.id : "locked-row" }];
    },
    match: {
      findUniqueOrThrow: async () => ({ groupBestOf: 5 }),
      findUnique: async () => ({ ...state.match }),
      update: async (args: {
        data: { status: "ongoing"; groupingGeneratedAt: Date };
      }) => {
        state.match.status = args.data.status;
        state.match.groupingGeneratedAt = args.data.groupingGeneratedAt;
        state.matchWrites += 1;
        return { ...state.match };
      },
    },
    matchEntry: {
      findMany: async () => [...state.entries].sort((a, b) => a.id.localeCompare(b.id)),
    },
    user: {
      findUnique: async (args: { where: { id: string } }) =>
        state.users.find((candidate) => candidate.id === args.where.id) ?? null,
      findMany: async (args: { where: { id: { in: string[] } } }) => {
        const ids = new Set(args.where.id.in);
        return state.users.filter((candidate) => ids.has(candidate.id));
      },
    },
    matchGrouping: {
      findUnique: async () => state.grouping,
      create: async (args: {
        data: {
          matchId: string;
          payload: unknown;
          v2SchemaVersion: number;
          seedMethod: "MIN_DIFF" | "SNAKE";
          standingsPolicyVersion: number;
          qualifiersPerGroup: null;
          bracketPolicyVersion: null;
          createdAt: Date;
        };
      }) => {
        state.grouping = {
          id: "grouping-1",
          matchId: args.data.matchId,
          payload: args.data.payload,
          v2SchemaVersion: args.data.v2SchemaVersion,
          seedMethod: args.data.seedMethod,
          standingsPolicyVersion: args.data.standingsPolicyVersion,
          qualifiersPerGroup: args.data.qualifiersPerGroup,
          bracketPolicyVersion: args.data.bracketPolicyVersion,
          createdAt: args.data.createdAt,
        };
        state.groupingWrites += 1;
        return { id: state.grouping.id };
      },
    },
    matchGroup: {
      findMany: async () => state.groups,
      create: async (args: {
        data: Omit<(typeof state.groups)[number], "id" | "entries">;
      }) => {
        const group = {
          id: `group-${state.groups.length + 1}`,
          ...args.data,
          entries: [],
        };
        state.groups.push(group);
        return { id: group.id };
      },
    },
    matchGroupEntry: {
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        for (const membership of args.data) {
          state.groups
            .find((group) => group.id === membership.groupId)!
            .entries.push(membership);
        }
        return { count: args.data.length };
      },
    },
    matchFixture: {
      findMany: async () => state.fixtures,
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        state.fixtures.push(
          ...args.data.map((fixture, index) => ({
            id: `fixture-${state.fixtures.length + index + 1}`,
            ...fixture,
          })),
        );
        state.fixtureWrites += args.data.length;
        return { count: args.data.length };
      },
    },
    matchFixtureLineupMember: {
      findMany: async (args: { where: { fixtureId: { in: string[] } } }) => {
        const ids = new Set(args.where.fixtureId.in);
        return state.lineups.filter((lineup) => ids.has(String(lineup.fixtureId)));
      },
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        state.lineups.push(...args.data);
        state.lineupWrites += args.data.length;
        return { count: args.data.length };
      },
    },
    auditLog: {
      create: async () => {
        state.auditWrites += 1;
        return { id: `audit-${state.auditWrites}` };
      },
    },
  };
  return {
    $transaction: async <T>(
      operation: (transaction: V2CompetitionTransaction) => Promise<T>,
      options: { isolationLevel?: unknown } = {},
    ) => {
      state.isolationLevels.push(options.isolationLevel);
      return operation(tx as unknown as V2CompetitionTransaction);
    },
  } as unknown as Pick<PrismaClient, "$transaction">;
}

async function expectApplicationError(
  operation: () => Promise<unknown>,
  code: V2CompetitionApplicationError["code"],
) {
  await assert.rejects(
    operation,
    (error: unknown) =>
      error instanceof V2CompetitionApplicationError && error.code === code,
  );
}

test("publishes an authoritative group-only legacy projection and GROUP fixtures atomically", async () => {
  const state = initialState();
  const service = createV2SingleGroupingApplicationService({
    db: fakeDatabase(state),
    clock: () => publishedAt,
  });

  const result = await service.publish(command());

  assert.deepEqual(result, {
    matchId: "match-1",
    created: true,
    publishedAt,
    groupCount: 2,
    fixtureCount: 2,
  });
  assert.equal(state.isolationLevels[0], "Serializable");
  assert.deepEqual(
    state.lockQueries.map((query) =>
      query.includes('FROM "Match"')
        ? "match"
        : query.includes('FROM "match_entry"')
          ? "entries"
          : query.includes('FROM "match_entry_member"')
            ? "members"
            : query.includes('FROM "User"')
              ? "users"
              : "unknown",
    ),
    ["match", "users", "entries", "members", "users"],
  );
  assert.equal(state.match.status, "ongoing");
  assert.equal(state.match.groupingGeneratedAt?.toISOString(), publishedAt.toISOString());
  assert.equal(state.groupingWrites, 1);
  assert.equal(state.auditWrites, 1);
  assert.equal(state.fixtureWrites, 2);
  assert.equal(state.lineupWrites, 4);
  assert.deepEqual(
    state.fixtures.map((fixture) => ({
      fixtureKey: fixture.fixtureKey,
      stage: fixture.stage,
      status: fixture.status,
      groupKey: fixture.groupKey,
      sideAEntryId: fixture.sideAEntryId,
      sideBEntryId: fixture.sideBEntryId,
    })),
    [
      {
        fixtureKey: "group:0001:pair:0001-0002",
        stage: "GROUP",
        status: "READY",
        groupKey: "group:0001",
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
      },
      {
        fixtureKey: "group:0002:pair:0001-0002",
        stage: "GROUP",
        status: "READY",
        groupKey: "group:0002",
        sideAEntryId: "entry-c",
        sideBEntryId: "entry-d",
      },
    ],
  );
  assert.equal(state.fixtures.some((fixture) => fixture.stage === "KNOCKOUT"), false);
  assert.deepEqual(state.fixtures[0].metadata, {
    publication: "V2_SINGLE_GROUPING",
    publicationVersion: 1,
    groupIndex: 1,
    groupName: "第 1 组",
    format: "group_only",
    qualifiersPerGroup: null,
    seedMethod: "snake",
    sideAPosition: 1,
    sideBPosition: 2,
  });
  assert.deepEqual(
    state.lineups.map(({ side, entryId, entryMemberId, position }) => ({
      side,
      entryId,
      entryMemberId,
      position,
    })),
    [
      {
        side: "SIDE_A",
        entryId: "entry-a",
        entryMemberId: "entry-a-member",
        position: 1,
      },
      {
        side: "SIDE_B",
        entryId: "entry-b",
        entryMemberId: "entry-b-member",
        position: 1,
      },
      {
        side: "SIDE_A",
        entryId: "entry-c",
        entryMemberId: "entry-c-member",
        position: 1,
      },
      {
        side: "SIDE_B",
        entryId: "entry-d",
        entryMemberId: "entry-d-member",
        position: 1,
      },
    ],
  );

  const payload = state.grouping?.payload as {
    generatedAt: string;
    competitorType: string;
    groups: Array<{
      name: string;
      averagePoints: number;
      players: Array<{
        id: string;
        nickname: string;
        points: number;
        eloRating: number;
      }>;
    }>;
    knockout?: { rounds: unknown[] };
    v2Publication: {
      schemaVersion: number;
      groups: Array<{ groupKey: string; entryIds: string[] }>;
    };
  };
  assert.equal(payload.generatedAt, publishedAt.toISOString());
  assert.equal(payload.competitorType, "user");
  assert.deepEqual(payload.groups[0], {
    name: "第 1 组",
    averagePoints: 1300,
    players: [
      {
        id: "user-a",
        nickname: "Authoritative A",
        points: 11,
        eloRating: 1410,
      },
      {
        id: "user-b",
        nickname: "Authoritative B",
        points: 7,
        eloRating: 1190,
      },
    ],
  });
  assert.equal(payload.knockout, undefined);
  assert.deepEqual(payload.v2Publication, {
    schemaVersion: 1,
    groups: [
      { groupKey: "group:0001", entryIds: ["entry-a", "entry-b"] },
      { groupKey: "group:0002", entryIds: ["entry-c", "entry-d"] },
    ],
  });
});

test("an authenticated exact retry is a no-op even if display aggregates changed", async () => {
  const state = initialState();
  let clockCalls = 0;
  const service = createV2SingleGroupingApplicationService({
    db: fakeDatabase(state),
    clock: () => {
      clockCalls += 1;
      return new Date(publishedAt.getTime() + clockCalls * 60_000);
    },
  });

  const first = await service.publish(command());
  state.users.find((candidate) => candidate.id === "user-a")!.eloRating += 16;
  state.users.find((candidate) => candidate.id === "user-a")!.points += 1;
  state.fixtures = state.fixtures.map((fixture) => ({
    ...fixture,
    metadata: {
      ...(fixture.metadata as Record<string, unknown>),
      v2Display: { schemaVersion: 1, tableLabels: ["1 号台"] },
    },
  }));
  (state.grouping!.payload as Record<string, unknown>).tableAssignments = {
    group: { "第 1 组": ["1 号台"], "第 2 组": ["1 号台"] },
    knockout: {},
  };
  const second = await service.publish(command());

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.publishedAt.toISOString(), first.publishedAt.toISOString());
  assert.equal(state.groupingWrites, 1);
  assert.equal(state.fixtureWrites, 2);
  assert.equal(state.lineupWrites, 4);
  assert.equal(state.matchWrites, 1);
  assert.equal(state.auditWrites, 1);
  assert.equal(state.lockQueries.length, 10, "the retry must repeat every lock/auth check");
});

test("rejects a stale Entry version before creating any fixture", async () => {
  const state = initialState();
  state.entries.find((candidate) => candidate.id === "entry-b")!.version = 5;
  const service = createV2SingleGroupingApplicationService({
    db: fakeDatabase(state),
    clock: () => publishedAt,
  });

  await expectApplicationError(() => service.publish(command()), "ENTRY_VERSION_CONFLICT");
  assert.equal(state.groupingWrites, 0);
  assert.equal(state.fixtureWrites, 0);
  assert.equal(state.lineupWrites, 0);
  assert.equal(state.matchWrites, 0);
});

test("rechecks manager permission before exposing or locking Entry state", async () => {
  const state = initialState();
  state.match.createdBy = "another-manager";
  const service = createV2SingleGroupingApplicationService({
    db: fakeDatabase(state),
    clock: () => publishedAt,
  });

  await expectApplicationError(() => service.publish(command()), "FORBIDDEN");
  assert.deepEqual(
    state.lockQueries.map((query) =>
      query.includes('FROM "Match"') ? "match" : "actor",
    ),
    ["match", "actor"],
  );
  assert.equal(state.groupingWrites, 0);
  assert.equal(state.fixtureWrites, 0);
});

test("rechecks participant ban state under User locks", async () => {
  const state = initialState();
  state.users.find((candidate) => candidate.id === "user-b")!.isBanned = true;
  const service = createV2SingleGroupingApplicationService({
    db: fakeDatabase(state),
    clock: () => publishedAt,
  });

  await expectApplicationError(() => service.publish(command()), "FIXTURE_ENTRY_INVALID");
  assert.equal(state.groupingWrites, 0);
  assert.equal(state.fixtureWrites, 0);
  assert.equal(state.lineupWrites, 0);
});

test("rejects a preview that omits a newly active Entry", async () => {
  const state = initialState();
  state.entries.push(entry("entry-e", "user-e", 1));
  state.users.push(user("user-e", "New participant", 1200, 0));
  const service = createV2SingleGroupingApplicationService({
    db: fakeDatabase(state),
    clock: () => publishedAt,
  });

  await expectApplicationError(() => service.publish(command()), "FIXTURE_ENTRY_INVALID");
  assert.equal(state.groupingWrites, 0);
});

test("rejects a changed existing publication instead of replacing it", async () => {
  const state = initialState();
  const service = createV2SingleGroupingApplicationService({
    db: fakeDatabase(state),
    clock: () => publishedAt,
  });
  await service.publish(command());
  state.fixtures[0].sideBEntryId = "entry-c";

  await expectApplicationError(() => service.publish(command()), "FIXTURE_KEY_CONFLICT");
  assert.equal(state.groupingWrites, 1);
  assert.equal(state.fixtureWrites, 2);
  assert.equal(state.lineupWrites, 4);
  assert.equal(state.matchWrites, 1);
  assert.equal(state.auditWrites, 1);
});

test("rejects an incomplete frozen lineup instead of treating it as an idempotent retry", async () => {
  const state = initialState();
  const service = createV2SingleGroupingApplicationService({
    db: fakeDatabase(state),
    clock: () => publishedAt,
  });
  await service.publish(command());
  state.lineups.pop();

  await expectApplicationError(() => service.publish(command()), "FIXTURE_KEY_CONFLICT");
  assert.equal(state.groupingWrites, 1);
  assert.equal(state.fixtureWrites, 2);
  assert.equal(state.lineupWrites, 4);
  assert.equal(state.matchWrites, 1);
  assert.equal(state.auditWrites, 1);
});

test("strictly rejects client-owned projection fields before opening a transaction", async () => {
  const state = initialState();
  const service = createV2SingleGroupingApplicationService({
    db: fakeDatabase(state),
    clock: () => publishedAt,
  });
  const invalid = command() as PublishV2SingleGroupingCommand & {
    draft: PublishV2SingleGroupingCommand["draft"] & {
      tableAssignments: unknown;
    };
  };
  invalid.draft.tableAssignments = { group: { "第 1 组": ["1号台"] } };

  await expectApplicationError(() => service.publish(invalid), "INVALID_INPUT");
  assert.equal(state.isolationLevels.length, 0);
});

test("rejects a singleton group because Fixture would no longer be its fact source", async () => {
  const state = initialState();
  const service = createV2SingleGroupingApplicationService({
    db: fakeDatabase(state),
    clock: () => publishedAt,
  });
  const base = command();
  const invalid: PublishV2SingleGroupingCommand = {
    ...base,
    draft: {
      ...base.draft,
      groups: [
        { entryIds: ["entry-a"] },
        { entryIds: ["entry-b", "entry-c", "entry-d"] },
      ],
    },
  };

  await expectApplicationError(() => service.publish(invalid), "INVALID_INPUT");
  assert.equal(state.isolationLevels.length, 0);
});

test("rejects a knockout projection with fewer than two qualifiers", async () => {
  const state = initialState();
  const service = createV2SingleGroupingApplicationService({
    db: fakeDatabase(state),
    clock: () => publishedAt,
  });
  const base = command();
  const invalid: PublishV2SingleGroupingCommand = {
    ...base,
    draft: {
      ...base.draft,
      format: "group_then_knockout",
      qualifiersPerGroup: 1,
      groups: [
        {
          entryIds: ["entry-a", "entry-b", "entry-c", "entry-d"],
        },
      ],
    },
  };

  await expectApplicationError(() => service.publish(invalid), "INVALID_INPUT");
  assert.equal(state.isolationLevels.length, 0);
});

test("the SINGLE facade publishes a valid group-then-knockout group phase", async () => {
  const state = initialState();
  state.match.format = "group_then_knockout";
  const service = createV2SingleGroupingApplicationService({
    db: fakeDatabase(state),
    clock: () => publishedAt,
  });
  const base = command();
  const knockout: PublishV2SingleGroupingCommand = {
    ...base,
    draft: {
      ...base.draft,
      format: "group_then_knockout",
      qualifiersPerGroup: 1,
    },
  };

  const published = await service.publish(knockout);
  assert.equal(published.created, true);
  assert.equal(state.isolationLevels.length, 1);
  assert.equal(state.grouping?.qualifiersPerGroup, 1);
  assert.equal(state.grouping?.bracketPolicyVersion, 1);
  assert.equal(state.fixtures.some((fixture) => fixture.stage === "KNOCKOUT"), false);
  assert.equal(
    (state.fixtures[0].metadata as Record<string, unknown>).publication,
    "V2_SINGLE_GROUP_THEN_KNOCKOUT_GROUPING",
  );
});

test("rechecks the stored match format and rejects group-then-knockout without writes", async () => {
  const state = initialState();
  state.match.format = "group_then_knockout";
  const service = createV2SingleGroupingApplicationService({
    db: fakeDatabase(state),
    clock: () => publishedAt,
  });

  await expectApplicationError(
    () => service.publish(command()),
    "FIXTURE_CREATION_NOT_ALLOWED",
  );
  assert.equal(state.isolationLevels.length, 1);
  assert.equal(state.groupingWrites, 0);
  assert.equal(state.fixtureWrites, 0);
  assert.equal(state.lineupWrites, 0);
  assert.equal(state.matchWrites, 0);
  assert.equal(state.auditWrites, 0);
});
