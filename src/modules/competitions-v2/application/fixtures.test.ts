import assert from "node:assert/strict";
import test from "node:test";

import { CompetitionDomainError } from "../domain";
import {
  V2CompetitionApplicationError,
  type V2CompetitionDatabase,
  type V2CompetitionTransaction,
} from "./entries";
import {
  createV2Fixture,
  replaceV2FixtureLineup,
  transitionV2FixtureStatus,
  v2UnplayedFixtureVoidAuditAction,
  wouldCreateFixtureDependencyCycle,
} from "./fixtures";

function fakeDatabase(transaction: object): V2CompetitionDatabase {
  const transactionWithDefaults = {
    $queryRaw: async () => [{ id: "locked-row" }],
    ...transaction,
  };
  const run = async <T>(
    operation: (tx: V2CompetitionTransaction) => Promise<T>,
  ) => operation(transactionWithDefaults as unknown as V2CompetitionTransaction);
  return { $transaction: run } as unknown as V2CompetitionDatabase;
}

function activeActor(overrides: Record<string, unknown> = {}) {
  return {
    id: "manager-1",
    role: "user",
    isBanned: false,
    emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function v2Match(overrides: Record<string, unknown> = {}) {
  return {
    id: "match-1",
    engineVersion: "V2",
    isQuickMatch: false,
    type: "single",
    status: "ongoing",
    format: "group_only",
    createdBy: "manager-1",
    createdAt: new Date("2020-01-01T00:00:00.000Z"),
    registrationDeadline: new Date("2021-01-01T00:00:00.000Z"),
    teamRegistrationStart: null,
    teamRegistrationDeadline: null,
    teamMinMembers: null,
    teamMaxMembers: null,
    ...overrides,
  };
}

async function expectApplicationError(
  action: () => Promise<unknown>,
  code: V2CompetitionApplicationError["code"],
) {
  await assert.rejects(
    action,
    (error: unknown) =>
      error instanceof V2CompetitionApplicationError && error.code === code,
  );
}

test("unplayed fixture void audits are classified by the server-owned match type", () => {
  assert.equal(
    v2UnplayedFixtureVoidAuditAction("single"),
    "v2_single_fixture_void_unplayed",
  );
  assert.equal(
    v2UnplayedFixtureVoidAuditAction("double"),
    "v2_double_fixture_void_unplayed",
  );
  assert.equal(
    v2UnplayedFixtureVoidAuditAction("team"),
    "v2_team_fixture_void_unplayed",
  );
});

test("fixture writes reject quick matches through the shared V2 context", async () => {
  const db = fakeDatabase({
    user: { findUnique: async () => activeActor() },
    match: { findUnique: async () => v2Match({ isQuickMatch: true }) },
  });

  await assert.rejects(
    () =>
      createV2Fixture(db, {
        actor: { id: "manager-1", role: "user" },
        matchId: "match-1",
        fixtureKey: "free:quick",
        stage: { stage: "FREE_PLAY" },
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
      }),
    (error: unknown) =>
      error instanceof CompetitionDomainError &&
      error.code === "ENGINE_WRITE_MISMATCH" &&
      error.details.isQuickMatch === true,
  );
});

test("fixture generation waits for registration to close", async () => {
  const db = fakeDatabase({
    user: { findUnique: async () => activeActor() },
    match: {
      findUnique: async () =>
        v2Match({
          status: "registration",
          registrationDeadline: new Date("2100-01-01T00:00:00.000Z"),
        }),
    },
  });

  await expectApplicationError(
    () =>
      createV2Fixture(db, {
        actor: { id: "manager-1", role: "user" },
        matchId: "match-1",
        fixtureKey: "free:1",
        stage: { stage: "FREE_PLAY" },
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
      }),
    "FIXTURE_CREATION_NOT_ALLOWED",
  );
});

test("an administrator can explicitly audit early fixture generation", async () => {
  let auditData: Record<string, unknown> | undefined;
  const db = fakeDatabase({
    user: {
      findUnique: async () => activeActor({ id: "admin-1", role: "admin" }),
    },
    match: {
      findUnique: async () =>
        v2Match({
          status: "registration",
          registrationDeadline: new Date("2100-01-01T00:00:00.000Z"),
        }),
    },
    auditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        auditData = args.data;
        return { id: "audit-1" };
      },
    },
    matchEntry: {
      findMany: async () => [
        {
          id: "entry-a",
          kind: "INDIVIDUAL",
          status: "ACTIVE",
          members: [{ rosterVersion: 1 }],
        },
        {
          id: "entry-b",
          kind: "INDIVIDUAL",
          status: "ACTIVE",
          members: [{ rosterVersion: 1 }],
        },
      ],
    },
    matchFixture: {
      findUnique: async () => null,
      create: async () => ({
        id: "fixture-1",
        matchId: "match-1",
        fixtureKey: "free:1",
        stage: "FREE_PLAY",
        status: "SCHEDULED",
        version: 0,
        sideARosterVersion: 1,
        sideBRosterVersion: 1,
      }),
    },
  });

  const result = await createV2Fixture(db, {
    actor: { id: "admin-1", role: "admin" },
    matchId: "match-1",
    fixtureKey: "free:1",
    stage: { stage: "FREE_PLAY" },
    sideAEntryId: "entry-a",
    sideBEntryId: "entry-b",
    adminOverride: true,
    overrideReason: "Publish an approved preview bracket",
  });

  assert.equal(result.created, true);
  assert.deepEqual(auditData, {
    actorId: "admin-1",
    action: "v2_fixture_create_admin_override",
    entityType: "Match",
    entityId: "match-1",
    details: {
      matchId: "match-1",
      reason: "Publish an approved preview bracket",
    },
  });
});

test("READY rejects a fixture whose bound roster version does not exist", async () => {
  const db = fakeDatabase({
    user: {
      findUnique: async () => activeActor({ id: "admin-1", role: "admin" }),
    },
    match: {
      findUnique: async () =>
        v2Match({ type: "double", createdBy: "someone-else" }),
    },
    matchFixture: {
      findFirst: async () => ({
        id: "fixture-1",
        status: "READY",
        version: 2,
        stage: "GROUP",
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
        sideARosterVersion: 99,
        sideBRosterVersion: 1,
      }),
    },
    matchEntry: {
      findMany: async () => [
        {
          id: "entry-a",
          kind: "DOUBLES",
          status: "ACTIVE",
          members: [{ rosterVersion: 1 }, { rosterVersion: 1 }],
        },
        {
          id: "entry-b",
          kind: "DOUBLES",
          status: "ACTIVE",
          members: [{ rosterVersion: 1 }, { rosterVersion: 1 }],
        },
      ],
    },
    matchEntryMember: {
      findMany: async () => [
        { entryId: "entry-b", rosterVersion: 1, slot: 1 },
        { entryId: "entry-b", rosterVersion: 1, slot: 2 },
      ],
    },
  });

  await expectApplicationError(
    () =>
      transitionV2FixtureStatus(db, {
        actor: { id: "admin-1", role: "admin" },
        matchId: "match-1",
        fixtureId: "fixture-1",
        expectedVersion: 2,
        to: "READY",
      }),
    "FIXTURE_ENTRY_INVALID",
  );
});

test("READY atomically creates a full deterministic team lineup", async () => {
  let createdLineup: Array<Record<string, unknown>> = [];
  const db = fakeDatabase({
    user: { findUnique: async () => activeActor() },
    match: {
      findUnique: async () =>
        v2Match({ type: "team", teamMinMembers: 2, teamMaxMembers: 4 }),
    },
    matchFixture: {
      findFirst: async () => ({
        id: "fixture-1",
        status: "SCHEDULED",
        version: 2,
        stage: "GROUP",
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
        sideARosterVersion: 3,
        sideBRosterVersion: 4,
      }),
      updateMany: async () => ({ count: 1 }),
    },
    matchEntry: {
      findMany: async () => [
        {
          id: "entry-a",
          kind: "TEAM",
          status: "ACTIVE",
          members: [{ rosterVersion: 3 }, { rosterVersion: 3 }],
        },
        {
          id: "entry-b",
          kind: "TEAM",
          status: "ACTIVE",
          members: [{ rosterVersion: 4 }, { rosterVersion: 4 }],
        },
      ],
    },
    matchEntryMember: {
      findMany: async () => [
        { id: "member-b2", entryId: "entry-b", rosterVersion: 4, slot: 2 },
        { id: "member-a2", entryId: "entry-a", rosterVersion: 3, slot: 2 },
        { id: "member-b1", entryId: "entry-b", rosterVersion: 4, slot: 1 },
        { id: "member-a1", entryId: "entry-a", rosterVersion: 3, slot: 1 },
      ],
    },
    matchFixtureLineupMember: {
      findMany: async () => [],
      createMany: async (args: { data: Array<Record<string, unknown>> }) => {
        createdLineup = args.data;
        return { count: args.data.length };
      },
    },
  });

  const result = await transitionV2FixtureStatus(db, {
    actor: { id: "manager-1", role: "user" },
    matchId: "match-1",
    fixtureId: "fixture-1",
    expectedVersion: 2,
    to: "READY",
  });

  assert.equal(result.version, 3);
  assert.deepEqual(
    createdLineup.map(({ side, entryMemberId, position }) => ({
      side,
      entryMemberId,
      position,
    })),
    [
      { side: "SIDE_A", entryMemberId: "member-a1", position: 1 },
      { side: "SIDE_A", entryMemberId: "member-a2", position: 2 },
      { side: "SIDE_B", entryMemberId: "member-b1", position: 1 },
      { side: "SIDE_B", entryMemberId: "member-b2", position: 2 },
    ],
  );
});

function readyIndividualTransaction(
  existingLineup: readonly Record<string, unknown>[],
  onCreate: () => void,
) {
  return {
    user: { findUnique: async () => activeActor() },
    match: { findUnique: async () => v2Match() },
    matchFixture: {
      findFirst: async () => ({
        id: "fixture-1",
        status: "READY",
        version: 1,
        stage: "FREE_PLAY",
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
        sideARosterVersion: 1,
        sideBRosterVersion: 1,
      }),
      updateMany: async () => ({ count: 1 }),
    },
    matchEntry: {
      findMany: async () => [
        {
          id: "entry-a",
          kind: "INDIVIDUAL",
          status: "ACTIVE",
          members: [{ rosterVersion: 1 }],
        },
        {
          id: "entry-b",
          kind: "INDIVIDUAL",
          status: "ACTIVE",
          members: [{ rosterVersion: 1 }],
        },
      ],
    },
    matchEntryMember: {
      findMany: async () => [
        { id: "member-a", entryId: "entry-a", rosterVersion: 1, slot: 1 },
        { id: "member-b", entryId: "entry-b", rosterVersion: 1, slot: 1 },
      ],
    },
    matchFixtureLineupMember: {
      findMany: async () => existingLineup,
      createMany: async () => {
        onCreate();
        return { count: 2 };
      },
    },
  };
}

test("READY accepts an identical existing auto-lineup without duplicating it", async () => {
  let createCount = 0;
  const db = fakeDatabase(
    readyIndividualTransaction(
      [
        {
          side: "SIDE_B",
          entryId: "entry-b",
          entryMemberId: "member-b",
          position: 1,
        },
        {
          side: "SIDE_A",
          entryId: "entry-a",
          entryMemberId: "member-a",
          position: 1,
        },
      ],
      () => {
        createCount += 1;
      },
    ),
  );

  await transitionV2FixtureStatus(db, {
    actor: { id: "manager-1", role: "user" },
    matchId: "match-1",
    fixtureId: "fixture-1",
    expectedVersion: 1,
    to: "READY",
  });
  assert.equal(createCount, 0);
});

test("READY rejects a pre-existing lineup that conflicts with the frozen roster", async () => {
  const db = fakeDatabase(
    readyIndividualTransaction(
      [
        {
          side: "SIDE_A",
          entryId: "entry-a",
          entryMemberId: "different-member",
          position: 1,
        },
      ],
      () => assert.fail("a conflicting lineup must not be appended"),
    ),
  );

  await expectApplicationError(
    () =>
      transitionV2FixtureStatus(db, {
        actor: { id: "manager-1", role: "user" },
        matchId: "match-1",
        fixtureId: "fixture-1",
        expectedVersion: 1,
        to: "READY",
      }),
    "FIXTURE_LINEUP_INVALID",
  );
});

test("manual TEAM lineup replacement rejects a subset of the pinned roster", async () => {
  let fixtureWrites = 0;
  const db = fakeDatabase({
    user: { findUnique: async () => activeActor() },
    match: { findUnique: async () => v2Match({ type: "team" }) },
    matchFixture: {
      findFirst: async () => ({
        id: "fixture-1",
        status: "READY",
        version: 4,
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
        sideARosterVersion: 3,
        sideBRosterVersion: 4,
        _count: { resultRevisions: 0 },
      }),
      updateMany: async () => {
        fixtureWrites += 1;
        return { count: 1 };
      },
    },
    matchEntry: {
      findFirst: async (args: { where: { id: string } }) => ({
        kind: args.where.id === "entry-a" ? "TEAM" : "TEAM",
      }),
    },
    matchEntryMember: {
      findMany: async () => [
        {
          id: "member-a1",
          entryId: "entry-a",
          userId: "user-a1",
          status: "ACTIVE",
          rosterVersion: 3,
          slot: 1,
        },
        {
          id: "member-a2",
          entryId: "entry-a",
          userId: "user-a2",
          status: "ACTIVE",
          rosterVersion: 3,
          slot: 2,
        },
        {
          id: "member-b1",
          entryId: "entry-b",
          userId: "user-b1",
          status: "ACTIVE",
          rosterVersion: 4,
          slot: 1,
        },
        {
          id: "member-b2",
          entryId: "entry-b",
          userId: "user-b2",
          status: "ACTIVE",
          rosterVersion: 4,
          slot: 2,
        },
      ],
    },
  });

  await expectApplicationError(
    () =>
      replaceV2FixtureLineup(db, {
        actor: { id: "manager-1", role: "user" },
        matchId: "match-1",
        fixtureId: "fixture-1",
        expectedVersion: 4,
        lineup: [
          {
            side: "SIDE_A",
            entryId: "entry-a",
            entryMemberId: "member-a1",
            position: 1,
          },
          {
            side: "SIDE_B",
            entryId: "entry-b",
            entryMemberId: "member-b1",
            position: 1,
          },
          {
            side: "SIDE_B",
            entryId: "entry-b",
            entryMemberId: "member-b2",
            position: 2,
          },
        ],
      }),
    "FIXTURE_LINEUP_INVALID",
  );
  assert.equal(fixtureWrites, 0);
});

test("fixture status writes enforce manager permission before reading the target", async () => {
  let fixtureReads = 0;
  const db = fakeDatabase({
    user: { findUnique: async () => activeActor() },
    match: {
      findUnique: async () => v2Match({ createdBy: "different-manager" }),
    },
    matchFixture: {
      findFirst: async () => {
        fixtureReads += 1;
        throw new Error("fixture must not be read by a non-manager");
      },
    },
  });

  await expectApplicationError(
    () =>
      transitionV2FixtureStatus(db, {
        actor: { id: "manager-1", role: "user" },
        matchId: "match-1",
        fixtureId: "fixture-1",
        expectedVersion: 1,
        to: "VOIDED",
        requiredFixtureStage: "GROUP",
      }),
    "FORBIDDEN",
  );
  assert.equal(fixtureReads, 0);
});

test("the server-owned GROUP capability rejects a different fixture stage", async () => {
  let revisionReads = 0;
  let fixtureUpdates = 0;
  const db = fakeDatabase({
    user: { findUnique: async () => activeActor() },
    match: { findUnique: async () => v2Match() },
    matchFixture: {
      findFirst: async () => ({
        id: "fixture-free-play",
        status: "READY",
        version: 3,
        stage: "FREE_PLAY",
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
        sideARosterVersion: 1,
        sideBRosterVersion: 1,
      }),
      updateMany: async () => {
        fixtureUpdates += 1;
        return { count: 1 };
      },
    },
    resultRevision: {
      count: async () => {
        revisionReads += 1;
        return 0;
      },
    },
  });

  await expectApplicationError(
    () =>
      transitionV2FixtureStatus(db, {
        actor: { id: "manager-1", role: "user" },
        matchId: "match-1",
        fixtureId: "fixture-free-play",
        expectedVersion: 3,
        to: "VOIDED",
        requiredFixtureStage: "GROUP",
      }),
    "FIXTURE_STAGE_NOT_ALLOWED",
  );
  assert.equal(revisionReads, 0);
  assert.equal(fixtureUpdates, 0);
});

test("an unplayed KNOCKOUT fixture cannot be voided into a bracket dead end", async () => {
  let revisionReads = 0;
  let fixtureUpdates = 0;
  const db = fakeDatabase({
    user: { findUnique: async () => activeActor() },
    match: {
      findUnique: async () =>
        v2Match({ format: "group_then_knockout" }),
    },
    matchFixture: {
      findFirst: async () => ({
        id: "fixture-knockout",
        status: "READY",
        version: 3,
        stage: "KNOCKOUT",
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
        sideARosterVersion: 1,
        sideBRosterVersion: 1,
      }),
      updateMany: async () => {
        fixtureUpdates += 1;
        return { count: 1 };
      },
    },
    resultRevision: {
      count: async () => {
        revisionReads += 1;
        return 0;
      },
    },
  });

  await expectApplicationError(
    () =>
      transitionV2FixtureStatus(db, {
        actor: { id: "manager-1", role: "user" },
        matchId: "match-1",
        fixtureId: "fixture-knockout",
        expectedVersion: 3,
        to: "VOIDED",
      }),
    "FIXTURE_RESULT_MANAGED_STATUS",
  );
  assert.equal(revisionReads, 0);
  assert.equal(fixtureUpdates, 0);
});

test("an active group_then pairing cannot be voided before qualification", async () => {
  let revisionReads = 0;
  let fixtureUpdates = 0;
  const db = fakeDatabase({
    user: { findUnique: async () => activeActor() },
    match: {
      findUnique: async () => v2Match({ format: "group_then_knockout" }),
    },
    matchFixture: {
      findFirst: async () => ({
        id: "fixture-group",
        fixtureKey: "group:0001:pair:0001-0002",
        status: "READY",
        version: 3,
        stage: "GROUP",
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
        sideARosterVersion: 1,
        sideBRosterVersion: 1,
      }),
      updateMany: async () => {
        fixtureUpdates += 1;
        return { count: 1 };
      },
    },
    matchEntry: {
      findMany: async () => [
        { id: "entry-a", status: "ACTIVE" },
        { id: "entry-b", status: "ACTIVE" },
      ],
    },
    resultRevision: {
      count: async () => {
        revisionReads += 1;
        return 0;
      },
    },
  });

  await expectApplicationError(
    () =>
      transitionV2FixtureStatus(db, {
        actor: { id: "manager-1", role: "user" },
        matchId: "match-1",
        fixtureId: "fixture-group",
        expectedVersion: 3,
        to: "VOIDED",
        requiredFixtureStage: "GROUP",
      }),
    "FIXTURE_RESULT_MANAGED_STATUS",
  );
  assert.equal(revisionReads, 0);
  assert.equal(fixtureUpdates, 0);
});

test("unplayed fixture voiding rejects a stale optimistic version before result checks", async () => {
  let revisionReads = 0;
  let fixtureUpdates = 0;
  const db = fakeDatabase({
    user: { findUnique: async () => activeActor() },
    match: { findUnique: async () => v2Match() },
    matchFixture: {
      findFirst: async () => ({
        id: "fixture-group",
        status: "READY",
        version: 4,
        stage: "GROUP",
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
        sideARosterVersion: 1,
        sideBRosterVersion: 1,
      }),
      updateMany: async () => {
        fixtureUpdates += 1;
        return { count: 1 };
      },
    },
    resultRevision: {
      count: async () => {
        revisionReads += 1;
        return 0;
      },
    },
  });

  await expectApplicationError(
    () =>
      transitionV2FixtureStatus(db, {
        actor: { id: "manager-1", role: "user" },
        matchId: "match-1",
        fixtureId: "fixture-group",
        expectedVersion: 3,
        to: "VOIDED",
        requiredFixtureStage: "GROUP",
      }),
    "FIXTURE_VERSION_CONFLICT",
  );
  assert.equal(revisionReads, 0);
  assert.equal(fixtureUpdates, 0);
});

test("generic fixture transitions cannot complete or void completed fixtures", async () => {
  const fixture = {
    id: "fixture-1",
    status: "READY",
    version: 1,
    stage: "FREE_PLAY",
    sideAEntryId: "entry-a",
    sideBEntryId: "entry-b",
    sideARosterVersion: 1,
    sideBRosterVersion: 1,
  };
  const db = fakeDatabase({
    user: { findUnique: async () => activeActor() },
    match: { findUnique: async () => v2Match() },
    matchFixture: { findFirst: async () => fixture },
  });

  await expectApplicationError(
    () =>
      transitionV2FixtureStatus(db, {
        actor: { id: "manager-1", role: "user" },
        matchId: "match-1",
        fixtureId: "fixture-1",
        expectedVersion: 1,
        to: "COMPLETED",
      }),
    "FIXTURE_RESULT_MANAGED_STATUS",
  );

  fixture.status = "COMPLETED";
  await expectApplicationError(
    () =>
      transitionV2FixtureStatus(db, {
        actor: { id: "manager-1", role: "user" },
        matchId: "match-1",
        fixtureId: "fixture-1",
        expectedVersion: 1,
        to: "VOIDED",
      }),
    "FIXTURE_RESULT_MANAGED_STATUS",
  );
});

test("a GROUP fixture with an active result must use result-aware voiding", async () => {
  const db = fakeDatabase({
    user: { findUnique: async () => activeActor() },
    match: { findUnique: async () => v2Match() },
    matchFixture: {
      findFirst: async () => ({
        id: "fixture-1",
        status: "READY",
        version: 1,
        stage: "GROUP",
        sideAEntryId: "entry-a",
        sideBEntryId: "entry-b",
        sideARosterVersion: 1,
        sideBRosterVersion: 1,
      }),
    },
    resultRevision: { count: async () => 1 },
  });

  await expectApplicationError(
    () =>
      transitionV2FixtureStatus(db, {
        actor: { id: "manager-1", role: "user" },
        matchId: "match-1",
        fixtureId: "fixture-1",
        expectedVersion: 1,
        to: "VOIDED",
        requiredFixtureStage: "GROUP",
      }),
    "FIXTURE_RESULT_MANAGED_STATUS",
  );
});

test("rejected and voided pending revisions do not prevent fixture voiding", async () => {
  const observedWhere: Array<Record<string, unknown>> = [];
  let completionUpdates = 0;
  let auditWrites = 0;
  for (const terminalStatus of ["REJECTED", "VOIDED"] as const) {
    const fixtureId = `fixture-${terminalStatus.toLowerCase()}`;
    const fixtureKey = `group:terminal-${terminalStatus.toLowerCase()}`;
    const publicationTime = new Date("2026-09-05T00:00:00.000Z");
    const db = fakeDatabase({
      user: { findUnique: async () => activeActor() },
      match: {
        findUnique: async () => ({
          ...v2Match(),
          groupingGeneratedAt: publicationTime,
          groupingResult: {
            createdAt: publicationTime,
            v2SchemaVersion: 1,
            seedMethod: "MIN_DIFF",
            standingsPolicyVersion: 1,
            qualifiersPerGroup: null,
            bracketPolicyVersion: null,
            groups: [
              {
                id: "group-1",
                groupKey: fixtureKey,
                position: 1,
                entries: [
                  { entryId: "entry-a", position: 1 },
                  { entryId: "entry-b", position: 2 },
                ],
              },
            ],
          },
          fixtures: [
            {
              id: fixtureId,
              stage: "GROUP",
              status: "VOIDED",
              groupId: "group-1",
              groupKey: fixtureKey,
              sideAEntryId: "entry-a",
              sideBEntryId: "entry-b",
            },
          ],
        }),
        updateMany: async () => {
          completionUpdates += 1;
          return { count: 1 };
        },
      },
      matchFixture: {
        findFirst: async () => ({
          id: fixtureId,
          fixtureKey,
          status: "READY",
          version: 2,
          stage: "GROUP",
          sideAEntryId: "entry-a",
          sideBEntryId: "entry-b",
          sideARosterVersion: 1,
          sideBRosterVersion: 1,
        }),
        updateMany: async () => ({ count: 1 }),
        count: async (args: {
          where: { status?: { notIn: readonly string[] } };
        }) => (args.where.status === undefined ? 1 : 0),
      },
      resultRevision: {
        count: async (args: { where: Record<string, unknown> }) => {
          observedWhere.push(args.where);
          // A revision that reached either terminal state has no active apply
          // settlement, so it must not match the blocking query.
          return terminalStatus === "REJECTED" || terminalStatus === "VOIDED"
            ? 0
            : 1;
        },
      },
      auditLog: {
        create: async () => {
          auditWrites += 1;
          return { id: `audit-${auditWrites}` };
        },
      },
    });

    const result = await transitionV2FixtureStatus(db, {
      actor: { id: "manager-1", role: "user" },
      matchId: "match-1",
      fixtureId,
      expectedVersion: 2,
      to: "VOIDED",
      requiredFixtureStage: "GROUP",
    });

    assert.deepEqual(result, {
      id: fixtureId,
      status: "VOIDED",
      version: 3,
    });
  }

  assert.equal(completionUpdates, 2);
  assert.equal(auditWrites, 2);

  assert.equal(observedWhere.length, 2);
  for (const where of observedWhere) {
    assert.deepEqual(where.OR, [
      { status: { in: ["PENDING", "CONFIRMED"] } },
      {
        settlementEvents: {
          some: { kind: "RESULT_APPLY", status: "APPLIED" },
        },
      },
    ]);
  }
});

test("a real unplayed GROUP void writes one atomic audit and an idempotent retry writes none", async () => {
  const fixture = {
    id: "fixture-group",
    fixtureKey: "group:0001:pair:0001-0002",
    status: "READY" as "READY" | "VOIDED",
    version: 2,
    stage: "GROUP" as const,
    sideAEntryId: "entry-a",
    sideBEntryId: "entry-b",
    sideARosterVersion: 1,
    sideBRosterVersion: 1,
  };
  const audits: Array<Record<string, unknown>> = [];
  let revisionChecks = 0;
  const db = fakeDatabase({
    user: { findUnique: async () => activeActor() },
    match: { findUnique: async () => v2Match() },
    matchFixture: {
      findFirst: async () => ({ ...fixture }),
      updateMany: async (args: {
        where: { version: number };
        data: { status: "VOIDED"; version: { increment: number } };
      }) => {
        if (fixture.version !== args.where.version) return { count: 0 };
        fixture.status = args.data.status;
        fixture.version += args.data.version.increment;
        return { count: 1 };
      },
      count: async (args: { where: { status?: unknown } }) =>
        args.where.status === undefined ? 2 : 1,
    },
    resultRevision: {
      count: async () => {
        revisionChecks += 1;
        return 0;
      },
    },
    auditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        audits.push(args.data);
        return { id: "audit-1" };
      },
    },
  });

  const first = await transitionV2FixtureStatus(db, {
    actor: { id: "manager-1", role: "user" },
    matchId: "match-1",
    fixtureId: fixture.id,
    expectedVersion: 2,
    to: "VOIDED",
    requiredFixtureStage: "GROUP",
  });
  const retry = await transitionV2FixtureStatus(db, {
    actor: { id: "manager-1", role: "user" },
    matchId: "match-1",
    fixtureId: fixture.id,
    expectedVersion: 3,
    to: "VOIDED",
    requiredFixtureStage: "GROUP",
  });

  assert.deepEqual(first, { id: fixture.id, status: "VOIDED", version: 3 });
  assert.deepEqual(retry, { id: fixture.id, status: "VOIDED", version: 3 });
  assert.equal(revisionChecks, 1);
  assert.deepEqual(audits, [
    {
      actorId: "manager-1",
      action: "v2_single_fixture_void_unplayed",
      entityType: "MatchFixture",
      entityId: fixture.id,
      details: {
        matchId: "match-1",
        fromStatus: "READY",
        stage: "GROUP",
        targetLabel: fixture.fixtureKey,
      },
    },
  ]);
});

test("an audit failure rolls the unplayed fixture status write back", async () => {
  let persisted = { status: "READY" as "READY" | "VOIDED", version: 5 };
  const db = {
    $transaction: async <T>(
      operation: (tx: V2CompetitionTransaction) => Promise<T>,
    ) => {
      const staged = { ...persisted };
      const tx = {
        $queryRaw: async () => [{ id: "locked-row" }],
        user: { findUnique: async () => activeActor() },
        match: { findUnique: async () => v2Match() },
        matchFixture: {
          findFirst: async () => ({
            id: "fixture-audit-failure",
            fixtureKey: "group:0001:pair:0002-0003",
            status: staged.status,
            version: staged.version,
            stage: "GROUP",
            sideAEntryId: "entry-a",
            sideBEntryId: "entry-b",
            sideARosterVersion: 1,
            sideBRosterVersion: 1,
          }),
          updateMany: async () => {
            staged.status = "VOIDED";
            staged.version += 1;
            return { count: 1 };
          },
          count: async () => assert.fail("completion must follow the audit"),
        },
        resultRevision: { count: async () => 0 },
        auditLog: {
          create: async () => {
            throw new Error("audit storage failed");
          },
        },
      } as unknown as V2CompetitionTransaction;

      const result = await operation(tx);
      persisted = staged;
      return result;
    },
  } as V2CompetitionDatabase;

  await assert.rejects(
    transitionV2FixtureStatus(db, {
      actor: { id: "manager-1", role: "user" },
      matchId: "match-1",
      fixtureId: "fixture-audit-failure",
      expectedVersion: 5,
      to: "VOIDED",
      requiredFixtureStage: "GROUP",
    }),
    /audit storage failed/,
  );
  assert.deepEqual(persisted, { status: "READY", version: 5 });
});

test("dependency cycle detection catches indirect and self cycles", () => {
  const edges = [
    { sourceFixtureId: "fixture-a", targetFixtureId: "fixture-b" },
    { sourceFixtureId: "fixture-b", targetFixtureId: "fixture-c" },
  ];

  assert.equal(
    wouldCreateFixtureDependencyCycle(edges, {
      sourceFixtureId: "fixture-c",
      targetFixtureId: "fixture-a",
    }),
    true,
  );
  assert.equal(
    wouldCreateFixtureDependencyCycle(edges, {
      sourceFixtureId: "fixture-d",
      targetFixtureId: "fixture-d",
    }),
    true,
  );
  assert.equal(
    wouldCreateFixtureDependencyCycle(edges, {
      sourceFixtureId: "fixture-c",
      targetFixtureId: "fixture-d",
    }),
    false,
  );
});
