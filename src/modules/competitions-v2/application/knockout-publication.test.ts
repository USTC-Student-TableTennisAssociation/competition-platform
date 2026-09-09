import assert from "node:assert/strict";
import test from "node:test";

import {
  createV2KnockoutPublicationApplicationService,
  type V2KnockoutPublicationApplicationServiceDependencies,
} from "./knockout-publication";
import { V2CompetitionApplicationError } from "./entries";

const MATCH_ID = "match-knockout";
const SNAPSHOT_ID = "snapshot-1";
const FINGERPRINT = "a".repeat(64);
const PUBLISHED_AT = new Date("2026-09-05T12:00:00.000Z");
const GROUPED_AT = new Date("2026-09-05T10:00:00.000Z");

type MatchType = "single" | "double" | "team";

function rosterShape(type: MatchType, entryIndex: number) {
  const size = type === "single" ? 1 : 2;
  return Array.from({ length: size }, (_, memberIndex) => ({
    id: `member-${entryIndex}-${memberIndex + 1}`,
    matchId: MATCH_ID,
    entryId: `entry-${entryIndex}`,
    userId: `user-${entryIndex}-${memberIndex + 1}`,
    role:
      type === "team" && memberIndex === 0
        ? ("captain" as const)
        : ("player" as const),
    status: "ACTIVE" as const,
    slot: memberIndex + 1,
    rosterVersion: 1,
    effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
    effectiveUntil: null,
  }));
}

function harness(type: MatchType, publishedAt = PUBLISHED_AT) {
  const entries = Array.from({ length: 4 }, (_, index) => ({
    id: `entry-${index + 1}`,
    matchId: MATCH_ID,
    kind:
      type === "single"
        ? ("INDIVIDUAL" as const)
        : type === "double"
          ? ("DOUBLES" as const)
          : ("TEAM" as const),
    status: "ACTIVE" as const,
    version: 0,
  }));
  const members = entries.flatMap((_, index) => rosterShape(type, index + 1));
  const users = [
    {
      id: "owner-1",
      role: "user" as const,
      isBanned: false,
      emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    ...members.map((member) => ({
      id: member.userId,
      role: "user" as const,
      isBanned: false,
      emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    })),
  ];
  const group = {
    id: "group-1",
    matchId: MATCH_ID,
    groupingId: "grouping-1",
    groupKey: "group:0001",
    position: 1,
  };
  const memberships = entries.map((entry, index) => ({
    id: `membership-${index + 1}`,
    matchId: MATCH_ID,
    groupId: group.id,
    entryId: entry.id,
    position: index + 1,
    globalSeedRank: index + 1,
    entryVersion: 0,
    rosterVersion: 1,
  }));
  const standings = entries.map((entry, index) => ({
    id: `standing-${index + 1}`,
    matchId: MATCH_ID,
    snapshotId: SNAPSHOT_ID,
    groupId: group.id,
    entryId: entry.id,
    rank: index + 1,
    played: 3,
    wins: 3 - index,
    losses: index,
    scoreFor: 12 - index,
    scoreAgainst: index,
    scoreDifferential: 12 - index * 2,
    qualified: true,
    qualificationOrder: index + 1,
    ineligibilityReason: null,
  }));
  const fixtures: Array<Record<string, unknown>> = [];
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      fixtures.push({
        id: `group-fixture-${left + 1}-${right + 1}`,
        matchId: MATCH_ID,
        fixtureKey: `group:0001:${left + 1}:${right + 1}`,
        stage: "GROUP",
        status: "COMPLETED",
        groupId: group.id,
        groupKey: group.groupKey,
        roundNumber: null,
        position: null,
        sideAEntryId: entries[left].id,
        sideBEntryId: entries[right].id,
        sideARosterVersion: 1,
        sideBRosterVersion: 1,
        scheduledAt: null,
        startedAt: null,
        completedAt: new Date("2026-09-05T11:00:00.000Z"),
        version: 2,
        metadata: null,
        createdAt: GROUPED_AT,
        updatedAt: GROUPED_AT,
      });
    }
  }
  const dependencies: Array<Record<string, unknown>> = [];
  const lineups: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const transactionOptions: unknown[] = [];

  const tx = {
    $queryRaw(query: { strings?: readonly string[] }) {
      const sql = query.strings?.join("?") ?? "";
      if (sql.includes('FROM "Match" WHERE "id"')) {
        return Promise.resolve([{ id: MATCH_ID }]);
      }
      if (sql.includes('FROM "User"')) {
        return Promise.resolve(
          users.map((user) => ({ id: user.id })).sort((left, right) =>
            left.id.localeCompare(right.id),
          ),
        );
      }
      return Promise.resolve([]);
    },
    match: {
      findUniqueOrThrow: async () => ({ knockoutBestOf: 5 }),
      findUnique: async () => ({
        id: MATCH_ID,
        title: `${type} knockout`,
        createdBy: "owner-1",
        engineVersion: "V2",
        isQuickMatch: false,
        type,
        status: "ongoing",
        format: "group_then_knockout",
        groupingGeneratedAt: GROUPED_AT,
        teamMinMembers: type === "team" ? 2 : null,
        teamMaxMembers: type === "team" ? 3 : null,
      }),
    },
    matchGrouping: {
      findUnique: async () => ({
        id: "grouping-1",
        matchId: MATCH_ID,
        v2SchemaVersion: 1,
        seedMethod: "MIN_DIFF",
        standingsPolicyVersion: 1,
        qualifiersPerGroup: 4,
        bracketPolicyVersion: 1,
        createdAt: GROUPED_AT,
      }),
    },
    matchGroup: { findMany: async () => [group] },
    matchGroupEntry: { findMany: async () => memberships },
    matchQualificationSnapshot: {
      findMany: async () => [{
        id: SNAPSHOT_ID,
        matchId: MATCH_ID,
        groupingId: "grouping-1",
        schemaVersion: 1,
        standingsPolicyVersion: 1,
        sourceRevisionFingerprint: FINGERPRINT,
        createdAt: new Date("2026-09-05T11:30:00.000Z"),
      }],
    },
    matchQualificationStanding: { findMany: async () => standings },
    matchEntry: { findMany: async () => entries },
    matchEntryMember: { findMany: async () => members },
    user: { findMany: async () => users },
    matchFixture: {
      findMany: async (args: { where?: { fixtureKey?: { in: string[] } } }) => {
        const keys = args.where?.fixtureKey?.in;
        return keys
          ? fixtures
              .filter((fixture) => keys.includes(fixture.fixtureKey as string))
              .map((fixture) => ({ id: fixture.id, fixtureKey: fixture.fixtureKey }))
          : fixtures;
      },
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        for (const row of args.data) {
          fixtures.push({
            id: `materialized-${row.fixtureKey}`,
            ...row,
          });
        }
        return { count: args.data.length };
      },
    },
    matchFixtureDependency: {
      findMany: async () => dependencies,
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        args.data.forEach((row, index) => {
          dependencies.push({ id: `dependency-${dependencies.length + index}`, ...row });
        });
        return { count: args.data.length };
      },
    },
    matchFixtureLineupMember: {
      findMany: async (args: { where: { fixtureId: { in: string[] } } }) =>
        lineups.filter((lineup) =>
          args.where.fixtureId.in.includes(lineup.fixtureId as string),
        ),
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        args.data.forEach((row, index) => {
          lineups.push({ id: `lineup-${lineups.length + index}`, ...row });
        });
        return { count: args.data.length };
      },
    },
    resultRevision: { count: async () => 0 },
    auditLog: {
      findMany: async () => audits,
      create: async (args: { data: Record<string, unknown> }) => {
        const row = { id: `audit-${audits.length + 1}`, ...args.data };
        audits.push(row);
        return row;
      },
    },
  };
  const db = {
    $transaction: async (
      operation: (transaction: typeof tx) => Promise<unknown>,
      options: unknown,
    ) => {
      transactionOptions.push(options);
      return operation(tx);
    },
  } as unknown as V2KnockoutPublicationApplicationServiceDependencies["db"];
  const service = createV2KnockoutPublicationApplicationService({
    db,
    clock: () => publishedAt,
  });
  const command = {
    actor: { id: "owner-1", role: "user" as const },
    matchId: MATCH_ID,
    expectedQualificationSnapshotId: SNAPSHOT_ID,
    expectedSourceRevisionFingerprint: FINGERPRINT,
  };
  return {
    service,
    command,
    fixtures,
    dependencies,
    lineups,
    audits,
    transactionOptions,
  };
}

for (const type of ["single", "double", "team"] as const) {
  test(`publishes and exactly replays an initial ${type} knockout graph`, async () => {
    const state = harness(type);
    const first = await state.service.publish(state.command);
    assert.equal(first.created, true);
    assert.equal(first.qualificationCount, 4);
    assert.equal(first.roundCount, 2);
    assert.equal(first.fixtureCount, 3);

    const knockout = state.fixtures.filter((fixture) => fixture.stage === "KNOCKOUT");
    assert.equal(knockout.length, 3);
    assert.equal(knockout.filter((fixture) => fixture.status === "READY").length, 2);
    assert.equal(
      knockout.filter((fixture) => fixture.status === "SCHEDULED").length,
      1,
    );
    assert.equal(state.dependencies.length, 6);
    assert.equal(
      state.dependencies.filter(
        (dependency) => dependency.sourceQualificationStandingId !== null,
      ).length,
      4,
    );
    assert.equal(
      state.dependencies.filter(
        (dependency) => dependency.sourceOutcome === "WINNER",
      ).length,
      2,
    );
    assert.equal(state.lineups.length, type === "single" ? 4 : 8);
    assert.equal(state.audits.length, 1);

    const replay = await state.service.publish(state.command);
    assert.equal(replay.created, false);
    assert.equal(replay.publishedAt.toISOString(), PUBLISHED_AT.toISOString());
    assert.equal(state.audits.length, 1);
    assert.deepEqual(state.transactionOptions, [
      { isolationLevel: "Serializable", maxWait: 5_000, timeout: 10_000 },
      { isolationLevel: "Serializable", maxWait: 5_000, timeout: 10_000 },
    ]);
  });
}

test("rejects replay after any knockout progress", async () => {
  const state = harness("single");
  await state.service.publish(state.command);
  const firstKnockout = state.fixtures.find(
    (fixture) => fixture.stage === "KNOCKOUT",
  )!;
  firstKnockout.version = 1;
  await assert.rejects(
    state.service.publish(state.command),
    (error: unknown) =>
      error instanceof V2CompetitionApplicationError &&
      error.code === "FIXTURE_KEY_CONFLICT",
  );
  assert.equal(state.audits.length, 1);
});

test("replays the same initial bracket after an audited display-only edit", async () => {
  const state = harness("single");
  const first = await state.service.publish(state.command);
  const fixture = state.fixtures.find(
    (value) => value.stage === "KNOCKOUT",
  )!;
  fixture.version = 1;
  fixture.updatedAt = new Date(PUBLISHED_AT.getTime() + 1_000);
  fixture.metadata = {
    ...(fixture.metadata as Record<string, unknown>),
    v2Display: { schemaVersion: 1, tableLabels: ["决赛台"] },
  };

  const retry = await state.service.publish(state.command);

  assert.equal(retry.created, false);
  assert.equal(retry.publishedAt.toISOString(), first.publishedAt.toISOString());
  assert.equal(state.audits.length, 1);
});

test("rejects replay when its unique publication audit is missing or polluted", async () => {
  for (const corruption of ["missing", "polluted"] as const) {
    const state = harness("single");
    await state.service.publish(state.command);
    if (corruption === "missing") {
      state.audits.splice(0);
    } else {
      state.audits[0]!.details = {
        ...(state.audits[0]!.details as Record<string, unknown>),
        qualificationSnapshotId: "other-snapshot",
      };
    }
    await assert.rejects(
      state.service.publish(state.command),
      (error: unknown) =>
        error instanceof V2CompetitionApplicationError &&
        error.code === "FIXTURE_KEY_CONFLICT",
    );
  }
});

test("rejects an orphan knockout publication audit before materializing", async () => {
  const state = harness("single");
  state.audits.push({
    id: "orphan-audit",
    actorId: "owner-1",
    action: "v2_single_knockout_publish",
    entityType: "Match",
    entityId: MATCH_ID,
    createdAt: PUBLISHED_AT,
    details: {},
  });
  await assert.rejects(
    state.service.publish(state.command),
    (error: unknown) =>
      error instanceof V2CompetitionApplicationError &&
      error.code === "FIXTURE_KEY_CONFLICT",
  );
  assert.equal(
    state.fixtures.filter((fixture) => fixture.stage === "KNOCKOUT").length,
    0,
  );
});

test("rejects a stale qualification identity before writing the graph", async () => {
  const state = harness("single");
  await assert.rejects(
    state.service.publish({
      ...state.command,
      expectedSourceRevisionFingerprint: "b".repeat(64),
    }),
    (error: unknown) =>
      error instanceof V2CompetitionApplicationError &&
      error.code === "FIXTURE_VERSION_CONFLICT",
  );
  assert.equal(state.fixtures.filter((fixture) => fixture.stage === "KNOCKOUT").length, 0);
  assert.equal(state.dependencies.length, 0);
  assert.equal(state.lineups.length, 0);
  assert.equal(state.audits.length, 0);
});

test("rejects command and actor over-posting before opening a transaction", async () => {
  const state = harness("single");
  for (const command of [
    { ...state.command, adminOverride: true },
    { ...state.command, actor: { ...state.command.actor, isManager: true } },
  ]) {
    await assert.rejects(
      state.service.publish(command as never),
      (error: unknown) =>
        error instanceof V2CompetitionApplicationError &&
        error.code === "INVALID_INPUT",
    );
  }
  assert.equal(state.transactionOptions.length, 0);
});

test("rejects a publication clock earlier than its frozen snapshot", async () => {
  const state = harness("single", new Date("2026-09-05T11:00:00.000Z"));
  await assert.rejects(
    state.service.publish(state.command),
    (error: unknown) =>
      error instanceof V2CompetitionApplicationError &&
      error.code === "INVALID_INPUT",
  );
  assert.equal(state.fixtures.filter((fixture) => fixture.stage === "KNOCKOUT").length, 0);
  assert.equal(state.audits.length, 0);
});
