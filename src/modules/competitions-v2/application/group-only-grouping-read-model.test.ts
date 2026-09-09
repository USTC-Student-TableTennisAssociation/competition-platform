import assert from "node:assert/strict";
import test from "node:test";
import { Prisma, type PrismaClient } from "@prisma/client";

import {
  getV2GroupOnlyGroupingReadModel,
  V2_DOUBLE_GROUPING_READ_PROFILE,
  V2GroupOnlyGroupingReadIntegrityError,
} from "../read-model/group-only-grouping";

const generatedAt = new Date("2026-09-05T09:00:00.000Z");

function entry(suffix: "a" | "b", seedElo: number, version: number) {
  const entryId = `entry-${suffix}`;
  const sourceId = `source-${suffix}`;
  const users = [1, 2].map((slot) => ({
    id: `${suffix}-partner-${slot}`,
    nickname: `${suffix.toUpperCase()} 搭档 ${slot}`,
    avatarUrl: null,
    isBanned: false,
    emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
  }));
  return {
    id: entryId,
    kind: "DOUBLES" as const,
    status: "ACTIVE" as const,
    sourceKey: `doubles:${sourceId}`,
    sourceUserId: null,
    sourceDoublesTeamId: sourceId,
    sourceMatchTeamId: null,
    displayNameSnapshot: `双打 ${suffix.toUpperCase()}`,
    version,
    sourceUser: null,
    sourceDoublesTeam: {
      id: sourceId,
      matchId: "double-match",
      members: users.map((user, index) => ({
        userId: user.id,
        slot: index + 1,
        matchId: "double-match",
      })),
    },
    sourceMatchTeam: null,
    members: users.map((user, index) => ({
      id: `${entryId}-member-${index + 1}`,
      userId: user.id,
      displayNameSnapshot: user.nickname,
      role: "player" as const,
      status: "ACTIVE" as const,
      slot: index + 1,
      rosterVersion: 1,
      effectiveUntil: null,
      user,
    })),
    seedElo,
  };
}

function confirmedForfeitRevision() {
  return {
    id: "revision-forfeit",
    revisionNumber: 1,
    status: "CONFIRMED" as const,
    resolutionKind: "FORFEIT" as const,
    winnerEntryId: "entry-a",
    loserEntryId: "entry-b",
    score: { winnerScore: 1, loserScore: 0 },
    supersedesRevisionId: null,
    reason: "对方弃权",
    resolvedAt: generatedAt,
    createdAt: generatedAt,
    updatedAt: generatedAt,
    reportedBy: { id: "manager-1", nickname: "管理员", avatarUrl: null },
    verifiedBy: { id: "manager-1", nickname: "管理员", avatarUrl: null },
  };
}

function publishedSource(
  format: "group_only" | "group_then_knockout" = "group_only",
) {
  const entries = [entry("a", 1_500, 2), entry("b", 1_300, 4)];
  const groupId = "group-1";
  const fixtureId = "fixture-1";
  return {
    id: "double-match",
    title: "DOUBLE relational read",
    type: "double" as const,
    status: "ongoing" as const,
    engineVersion: "V2" as const,
    isQuickMatch: false,
    format,
    createdBy: "manager-1",
    registrationDeadline: new Date("2026-09-01T00:00:00.000Z"),
    teamRegistrationDeadline: null,
    teamMinMembers: null,
    teamMaxMembers: null,
    groupingGeneratedAt: generatedAt,
    entries,
    groupingResult: {
      id: "grouping-1",
      matchId: "double-match",
      v2SchemaVersion: 1,
      seedMethod: "SNAKE" as const,
      standingsPolicyVersion: 1,
      qualifiersPerGroup: format === "group_then_knockout" ? 2 : null,
      bracketPolicyVersion: format === "group_then_knockout" ? 1 : null,
      createdAt: generatedAt,
      qualificationSnapshot: null,
    },
    matchGroups: [
      {
        id: groupId,
        matchId: "double-match",
        groupingId: "grouping-1",
        groupKey: "group:0001",
        displayName: "第 1 组",
        position: 1,
        entries: entries.map((value, index) => ({
          id: `membership-${index + 1}`,
          matchId: "double-match",
          groupId,
          entryId: value.id,
          position: index + 1,
          globalSeedRank: index + 1,
          seedElo: value.seedElo,
          seedPoints: index === 0 ? 20 : 10,
          entryVersion: value.version,
          rosterVersion: 1,
        })),
      },
    ],
    fixtures: [
      {
        id: fixtureId,
        matchId: "double-match",
        fixtureKey: "group:0001:pair:0001-0002",
        stage: "GROUP" as const,
        status: "READY" as const,
        groupId,
        groupKey: "group:0001",
        roundNumber: null,
        position: null,
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
        sideARosterVersion: 1,
        sideBRosterVersion: 1,
        version: 0,
        startedAt: null,
        completedAt: null,
        metadata: {
          publication:
            format === "group_then_knockout"
              ? "V2_DOUBLE_GROUP_THEN_KNOCKOUT_GROUPING"
              : "V2_DOUBLE_GROUPING",
          publicationVersion: 1,
          groupIndex: 1,
          groupName: "第 1 组",
          format,
          qualifiersPerGroup: format === "group_then_knockout" ? 2 : null,
          seedMethod: "snake",
          sideAPosition: 1,
          sideBPosition: 2,
          v2Display: { schemaVersion: 1, tableLabels: ["1 号台"] },
        },
        lineupMembers: entries.flatMap((value, entryIndex) =>
          value.members.map((member, memberIndex) => ({
            id: `lineup-${entryIndex + 1}-${memberIndex + 1}`,
            matchId: "double-match",
            fixtureId,
            entryId: value.id,
            entryMemberId: member.id,
            side: entryIndex === 0 ? ("SIDE_A" as const) : ("SIDE_B" as const),
            position: memberIndex + 1,
          })),
        ),
        resultRevisions: [] as ReturnType<typeof confirmedForfeitRevision>[],
      },
    ],
  };
}

function database(
  source: ReturnType<typeof publishedSource>,
  dependencies: readonly Record<string, unknown>[] = [],
) {
  let isolationLevel: unknown;
  const tx = {
    match: { findUnique: async () => source },
    matchFixtureDependency: { findMany: async () => dependencies },
  } as unknown as Prisma.TransactionClient;
  const db = {
    $transaction: async <T>(
      operation: (transaction: Prisma.TransactionClient) => Promise<T>,
      options?: { isolationLevel?: unknown },
    ) => {
      isolationLevel = options?.isolationLevel;
      return operation(tx);
    },
  } as unknown as Pick<PrismaClient, "$transaction">;
  return { db, isolationLevel: () => isolationLevel };
}

function completeGroupFixture(source: ReturnType<typeof publishedSource>) {
  Object.assign(source.fixtures[0], {
    status: "COMPLETED" as const,
    completedAt: generatedAt,
    resultRevisions: [confirmedForfeitRevision()],
  });
}

function attachTwoEntryKnockout(
  source: ReturnType<typeof publishedSource>,
) {
  completeGroupFixture(source);
  const fingerprint = "a".repeat(64);
  Object.assign(source.groupingResult, {
    qualificationSnapshot: {
      id: "snapshot-1",
      matchId: "double-match",
      groupingId: "grouping-1",
      schemaVersion: 1,
      standingsPolicyVersion: 1,
      sourceRevisionFingerprint: fingerprint,
      createdAt: generatedAt,
      standings: source.entries.map((value, index) => ({
        id: `standing-${index + 1}`,
        matchId: "double-match",
        snapshotId: "snapshot-1",
        groupId: "group-1",
        entryId: value.id,
        rank: index + 1,
        played: 1,
        wins: index === 0 ? 1 : 0,
        losses: index === 0 ? 0 : 1,
        scoreFor: index === 0 ? 1 : 0,
        scoreAgainst: index === 0 ? 0 : 1,
        scoreDifferential: index === 0 ? 1 : -1,
        qualified: true,
        qualificationOrder: index + 1,
        ineligibilityReason: null,
        groupEntry: { rosterVersion: 1 },
      })),
    },
  });
  const knockoutFixture = {
    id: "knockout-final",
    matchId: "double-match",
    fixtureKey: "knockout:r0001:m0001",
    stage: "KNOCKOUT" as const,
    status: "READY" as const,
    groupId: null,
    groupKey: null,
    roundNumber: 1,
    position: 1,
    sideAEntryId: "entry-a",
    sideBEntryId: "entry-b",
    sideARosterVersion: 1,
    sideBRosterVersion: 1,
    version: 0,
    startedAt: null,
    completedAt: null,
    metadata: {
      publication: "V2_KNOCKOUT_BRACKET",
      schemaVersion: 1,
      bracketPolicyVersion: 1,
      qualificationSnapshotId: "snapshot-1",
      sourceRevisionFingerprint: fingerprint,
      roundNumber: 1,
      position: 1,
      publishedAt: generatedAt.toISOString(),
    },
    lineupMembers: source.entries.flatMap((entryValue, entryIndex) =>
      entryValue.members.map((member, memberIndex) => ({
        id: `knockout-lineup-${entryIndex + 1}-${memberIndex + 1}`,
        matchId: "double-match",
        fixtureId: "knockout-final",
        entryId: entryValue.id,
        entryMemberId: member.id,
        side: entryIndex === 0 ? ("SIDE_A" as const) : ("SIDE_B" as const),
        position: memberIndex + 1,
      }))),
    resultRevisions: [],
  };
  (source.fixtures as unknown as Array<Record<string, unknown>>).push(
    knockoutFixture,
  );
  return [
    {
      id: "dependency-a",
      matchId: "double-match",
      sourceFixtureId: null,
      sourceOutcome: null,
      sourceQualificationStandingId: "standing-1",
      targetFixtureId: "knockout-final",
      targetSide: "SIDE_A",
    },
    {
      id: "dependency-b",
      matchId: "double-match",
      sourceFixtureId: null,
      sourceOutcome: null,
      sourceQualificationStandingId: "standing-2",
      targetFixtureId: "knockout-final",
      targetSide: "SIDE_B",
    },
  ];
}

test("DOUBLE grouping read model uses one RepeatableRead relational snapshot", async () => {
  const harness = database(publishedSource());
  const model = await getV2GroupOnlyGroupingReadModel(
    harness.db,
    "double-match",
    V2_DOUBLE_GROUPING_READ_PROFILE,
  );
  assert.equal(harness.isolationLevel(), "RepeatableRead");
  assert.equal(model.kind, "GROUP_ONLY_V2_MATCH");
  if (model.kind !== "GROUP_ONLY_V2_MATCH") assert.fail("unexpected read model");
  assert.equal(model.published, true);
  assert.equal(model.groups.length, 1);
  assert.deepEqual(model.groups[0].tableLabels, ["1 号台"]);
  assert.deepEqual(
    model.groups[0].entries.map((value) => [
      value.entryId,
      value.sourceCompetitorId,
      value.members.length,
    ]),
    [
      ["entry-a", "source-a", 2],
      ["entry-b", "source-b", 2],
    ],
  );
  assert.equal(model.groups[0].fixtures.length, 1);
  assert.equal(model.groups[0].fixtures[0].sideA.members.length, 2);
  assert.equal(model.groups[0].fixtures[0].sideB.members.length, 2);
  assert.equal(model.groups[0].fixtures[0].activeResult.state, "NONE");
});

test("DOUBLE grouping read model resolves one relational confirmed forfeit", async () => {
  const source = publishedSource();
  Object.assign(source.fixtures[0], {
    status: "COMPLETED" as const,
    resultRevisions: [confirmedForfeitRevision()],
  });
  const model = await getV2GroupOnlyGroupingReadModel(
    database(source).db,
    "double-match",
    V2_DOUBLE_GROUPING_READ_PROFILE,
  );
  assert.equal(model.kind, "GROUP_ONLY_V2_MATCH");
  if (model.kind !== "GROUP_ONLY_V2_MATCH") assert.fail("unexpected model");
  const active = model.groups[0].fixtures[0].activeResult;
  assert.equal(active.state, "CONFIRMED");
  assert.equal(active.confirmedRevision?.resolutionKind, "FORFEIT");
  assert.equal(active.confirmedRevision?.reason, "对方弃权");
});

test("group-then-knockout management derives all four states from relational rows", async () => {
  const unpublished = publishedSource("group_then_knockout");
  Object.assign(unpublished, {
    groupingGeneratedAt: null,
    groupingResult: null,
    matchGroups: [],
    fixtures: [],
  });
  const unpublishedModel = await getV2GroupOnlyGroupingReadModel(
    database(unpublished).db,
    "double-match",
    V2_DOUBLE_GROUPING_READ_PROFILE,
  );
  assert.equal(unpublishedModel.kind, "GROUP_THEN_KNOCKOUT_V2_MATCH");
  if (unpublishedModel.kind !== "GROUP_THEN_KNOCKOUT_V2_MATCH") {
    assert.fail("unexpected unpublished model");
  }
  assert.equal(unpublishedModel.managementState, "UNPUBLISHED");

  const inProgress = publishedSource("group_then_knockout");
  const inProgressModel = await getV2GroupOnlyGroupingReadModel(
    database(inProgress).db,
    "double-match",
    V2_DOUBLE_GROUPING_READ_PROFILE,
  );
  assert.equal(inProgressModel.kind, "GROUP_THEN_KNOCKOUT_V2_MATCH");
  if (inProgressModel.kind !== "GROUP_THEN_KNOCKOUT_V2_MATCH") {
    assert.fail("unexpected in-progress model");
  }
  assert.equal(inProgressModel.managementState, "GROUP_IN_PROGRESS");

  const ready = publishedSource("group_then_knockout");
  completeGroupFixture(ready);
  const readyModel = await getV2GroupOnlyGroupingReadModel(
    database(ready).db,
    "double-match",
    V2_DOUBLE_GROUPING_READ_PROFILE,
  );
  assert.equal(readyModel.kind, "GROUP_THEN_KNOCKOUT_V2_MATCH");
  if (readyModel.kind !== "GROUP_THEN_KNOCKOUT_V2_MATCH") {
    assert.fail("unexpected ready model");
  }
  assert.equal(readyModel.managementState, "READY_TO_FINALIZE");

  const finalized = publishedSource("group_then_knockout");
  const dependencies = attachTwoEntryKnockout(finalized);
  const knockoutFixture = (finalized.fixtures as unknown as Array<{
    stage: string;
    version: number;
    metadata: unknown;
  }>).find(
    (fixture) => fixture.stage === "KNOCKOUT",
  )!;
  knockoutFixture.version = 1;
  knockoutFixture.metadata = {
    ...(knockoutFixture.metadata as Record<string, unknown>),
    v2Display: { schemaVersion: 1, tableLabels: ["决赛台"] },
  };
  const finalizedModel = await getV2GroupOnlyGroupingReadModel(
    database(finalized, dependencies).db,
    "double-match",
    V2_DOUBLE_GROUPING_READ_PROFILE,
  );
  assert.equal(finalizedModel.kind, "GROUP_THEN_KNOCKOUT_V2_MATCH");
  if (finalizedModel.kind !== "GROUP_THEN_KNOCKOUT_V2_MATCH") {
    assert.fail("unexpected finalized model");
  }
  assert.equal(finalizedModel.managementState, "KNOCKOUT_PUBLISHED");
  assert.equal(finalizedModel.knockout?.fixtureCount, 1);
  assert.equal(finalizedModel.knockout?.roundCount, 1);
  assert.equal(finalizedModel.knockout?.finalFixtureId, "knockout-final");
  assert.equal(finalizedModel.knockout?.rounds[0]?.fixtures.length, 1);
  assert.deepEqual(
    finalizedModel.knockout?.rounds[0]?.fixtures[0]?.tableLabels,
    ["决赛台"],
  );
});

test("group-then-knockout management never hides a malformed knockout graph", async () => {
  const finalized = publishedSource("group_then_knockout");
  const dependencies = attachTwoEntryKnockout(finalized);
  dependencies[1].sourceQualificationStandingId = "standing-attacker";
  await assert.rejects(
    () =>
      getV2GroupOnlyGroupingReadModel(
        database(finalized, dependencies).db,
        "double-match",
        V2_DOUBLE_GROUPING_READ_PROFILE,
      ),
    V2GroupOnlyGroupingReadIntegrityError,
  );

  const invalidDisplay = publishedSource("group_then_knockout");
  const invalidDisplayDependencies = attachTwoEntryKnockout(invalidDisplay);
  const fixture = (invalidDisplay.fixtures as unknown as Array<{
    stage: string;
    metadata: unknown;
  }>).find(
    (value) => value.stage === "KNOCKOUT",
  )!;
  fixture.metadata = {
    ...(fixture.metadata as Record<string, unknown>),
    v2Display: { schemaVersion: 1, tableLabels: ["重复", "重复"] },
  };
  await assert.rejects(
    () =>
      getV2GroupOnlyGroupingReadModel(
        database(invalidDisplay, invalidDisplayDependencies).db,
        "double-match",
        V2_DOUBLE_GROUPING_READ_PROFILE,
      ),
    V2GroupOnlyGroupingReadIntegrityError,
  );
});

test("DOUBLE grouping read model fails closed on source and lineup drift", async () => {
  const crossMatchSource = publishedSource();
  crossMatchSource.entries[0].sourceDoublesTeam.members[0].matchId =
    "another-match";
  await assert.rejects(
    () =>
      getV2GroupOnlyGroupingReadModel(
        database(crossMatchSource).db,
        "double-match",
        V2_DOUBLE_GROUPING_READ_PROFILE,
      ),
    V2GroupOnlyGroupingReadIntegrityError,
  );

  const incompleteLineup = publishedSource();
  incompleteLineup.fixtures[0].lineupMembers.pop();
  await assert.rejects(
    () =>
      getV2GroupOnlyGroupingReadModel(
        database(incompleteLineup).db,
        "double-match",
        V2_DOUBLE_GROUPING_READ_PROFILE,
      ),
    V2GroupOnlyGroupingReadIntegrityError,
  );
});

test("DOUBLE grouping read model rejects payload-like state without relational rows", async () => {
  const partial = publishedSource();
  partial.matchGroups = [];
  partial.fixtures = [];
  await assert.rejects(
    () =>
      getV2GroupOnlyGroupingReadModel(
        database(partial).db,
        "double-match",
        V2_DOUBLE_GROUPING_READ_PROFILE,
      ),
    V2GroupOnlyGroupingReadIntegrityError,
  );
});
