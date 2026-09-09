import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  V2CompetitionApplicationError,
  type V2CompetitionTransaction,
  type V2EntrySettlementPort,
} from "./entries";
import {
  lockV2TeamEntryRegistrationContext,
  lockV2TeamEntryRegistrationCreationContext,
  reconcileV2TeamEntryRegistration,
  reconcileV2TeamEntryRegistrationInTransaction,
  type V2LockedTeamEntryRegistrationContext,
  type V2TeamEntryRegistrationDatabase,
} from "./team-entry-registration";

type FakeUser = {
  id: string;
  nickname: string;
  isBanned: boolean;
  emailVerifiedAt: Date | null;
};

type FakeSourceMember = {
  id: string;
  teamId: string;
  matchId: string;
  userId: string;
  joinedAt: Date;
  user: FakeUser;
};

type FakeEntryMember = {
  id: string;
  matchId: string;
  entryId: string;
  userId: string;
  displayNameSnapshot: string;
  role: "player" | "captain" | "substitute";
  status: "ACTIVE" | "WITHDRAWN" | "REMOVED" | "DISQUALIFIED" | "SUPERSEDED";
  slot: number;
  rosterVersion: number;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
  endReason: string | null;
};

type FakeEntry = {
  id: string;
  matchId: string;
  kind: "TEAM";
  status: "DRAFT" | "ACTIVE" | "WITHDRAWN" | "DISQUALIFIED" | "ARCHIVED";
  sourceKey: string;
  sourceUserId: null;
  sourceDoublesTeamId: null;
  sourceMatchTeamId: string;
  displayNameSnapshot: string;
  version: number;
  members: FakeEntryMember[];
};

type FakeState = {
  match: {
    id: string;
    title: string;
    type: "team";
    status: "registration";
    engineVersion: "V2" | "LEGACY";
    isQuickMatch: boolean;
    createdAt: Date;
    registrationDeadline: Date;
    teamRegistrationStart: Date | null;
    teamRegistrationDeadline: Date | null;
    teamMinMembers: number | null;
    teamMaxMembers: number | null;
  };
  team: {
    id: string;
    matchId: string;
    name: string;
    captainId: string;
    status: "draft" | "approved" | "submitted" | "waitlisted" | "rejected" | "cancelled";
    members: FakeSourceMember[];
  };
  entry: FakeEntry | null;
};

function verifiedUser(id: string): FakeUser {
  return {
    id,
    nickname: id.toUpperCase(),
    isBanned: false,
    emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function initialState(): FakeState {
  const matchId = "team-match";
  const teamId = "source-team";
  const memberIds = ["captain", "player-2"];
  return {
    match: {
      id: matchId,
      title: "TEAM V2",
      type: "team",
      status: "registration",
      engineVersion: "V2",
      isQuickMatch: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      registrationDeadline: new Date("2099-01-01T00:00:00.000Z"),
      teamRegistrationStart: new Date("2026-01-01T00:00:00.000Z"),
      teamRegistrationDeadline: new Date("2099-01-01T00:00:00.000Z"),
      teamMinMembers: 3,
      teamMaxMembers: 5,
    },
    team: {
      id: teamId,
      matchId,
      name: "Initial Team",
      captainId: "captain",
      status: "draft",
      members: memberIds.map((userId, index) => ({
        id: `source-member-${userId}`,
        teamId,
        matchId,
        userId,
        joinedAt: new Date(`2026-01-0${index + 1}T00:00:00.000Z`),
        user: verifiedUser(userId),
      })),
    },
    entry: null,
  };
}

function queryText(query: unknown) {
  if (
    typeof query === "object" &&
    query !== null &&
    "strings" in query &&
    Array.isArray(query.strings)
  ) {
    return query.strings.join(" ");
  }
  return "";
}

function createHarness(seed: FakeState = initialState()) {
  let state = structuredClone(seed);
  const lockCalls: string[] = [];
  const applied: number[] = [];
  const reversed: number[] = [];
  let entrySequence = 0;
  let entryMemberSequence = 0;
  let transactionCount = 0;

  const tx = {
    $queryRaw: async (query: unknown) => {
      const sql = queryText(query);
      if (sql.includes('FROM "Match"')) {
        lockCalls.push("match");
        return [state.match];
      }
      if (sql.includes("FROM match_team t")) {
        lockCalls.push("team");
        return [{ id: state.team.id }];
      }
      if (sql.includes("FROM match_team_member tm")) {
        lockCalls.push("team-members");
        return state.team.members.map((member) => ({
          id: member.id,
          teamId: member.teamId,
          userId: member.userId,
        }));
      }
      if (sql.includes("FROM match_entry_member")) {
        lockCalls.push("entry-members");
        return (state.entry?.members ?? []).map((member) => ({
          id: member.id,
          userId: member.userId,
        }));
      }
      if (sql.includes("FROM match_entry")) {
        lockCalls.push("entries");
        return state.entry ? [{ id: state.entry.id }] : [];
      }
      if (sql.includes('FROM "User"')) {
        lockCalls.push("users");
        return [];
      }
      throw new Error(`Unexpected raw query: ${sql}`);
    },
    matchTeam: {
      findMany: async () => [{ captainId: state.team.captainId }],
      findFirst: async () => structuredClone(state.team),
    },
    matchEntry: {
      findUnique: async () =>
        state.entry === null ? null : structuredClone(state.entry),
      create: async (args: {
        data: {
          matchId: string;
          kind: "TEAM";
          status: "DRAFT" | "ACTIVE";
          sourceKey: string;
          sourceMatchTeamId: string;
          displayNameSnapshot: string;
          members: {
            create: Array<{
              userId: string;
              displayNameSnapshot: string;
              role: "player" | "captain" | "substitute";
              status: "ACTIVE";
              slot: number;
              rosterVersion: number;
            }>;
          };
        };
      }) => {
        entrySequence += 1;
        const entryId = `entry-${entrySequence}`;
        state.entry = {
          id: entryId,
          matchId: args.data.matchId,
          kind: "TEAM",
          status: args.data.status,
          sourceKey: args.data.sourceKey,
          sourceUserId: null,
          sourceDoublesTeamId: null,
          sourceMatchTeamId: args.data.sourceMatchTeamId,
          displayNameSnapshot: args.data.displayNameSnapshot,
          version: 0,
          members: args.data.members.create.map((member) => {
            entryMemberSequence += 1;
            return {
              ...member,
              id: `entry-member-${entryMemberSequence}`,
              matchId: args.data.matchId,
              entryId,
              effectiveFrom: new Date(),
              effectiveUntil: null,
              endReason: null,
            };
          }),
        };
        return structuredClone(state.entry);
      },
      updateMany: async (args: {
        where: { id: string; matchId: string; version: number };
        data: {
          status?: FakeEntry["status"];
          displayNameSnapshot?: string;
          version: { increment: number };
        };
      }) => {
        if (
          !state.entry ||
          state.entry.id !== args.where.id ||
          state.entry.matchId !== args.where.matchId ||
          state.entry.version !== args.where.version
        ) {
          return { count: 0 };
        }
        if (args.data.status !== undefined) {
          state.entry.status = args.data.status;
        }
        if (args.data.displayNameSnapshot !== undefined) {
          state.entry.displayNameSnapshot = args.data.displayNameSnapshot;
        }
        state.entry.version += args.data.version.increment;
        return { count: 1 };
      },
    },
    matchEntryMember: {
      findFirst: async () => null,
      updateMany: async (args: {
        where: {
          entryId: string;
          matchId: string;
          userId?: { in: string[] };
          status: "ACTIVE";
          effectiveUntil: null;
        };
        data: {
          status: FakeEntryMember["status"];
          effectiveUntil: Date;
          endReason: string;
        };
      }) => {
        if (!state.entry) return { count: 0 };
        let count = 0;
        for (const member of state.entry.members) {
          if (
            member.entryId === args.where.entryId &&
            member.matchId === args.where.matchId &&
            member.status === "ACTIVE" &&
            member.effectiveUntil === null &&
            (args.where.userId === undefined ||
              args.where.userId.in.includes(member.userId))
          ) {
            member.status = args.data.status;
            member.effectiveUntil = args.data.effectiveUntil;
            member.endReason = args.data.endReason;
            count += 1;
          }
        }
        return { count };
      },
      createMany: async (args: {
        data: Array<{
          matchId: string;
          entryId: string;
          userId: string;
          displayNameSnapshot: string;
          role: "player" | "captain" | "substitute";
          status: "ACTIVE";
          slot: number;
          rosterVersion: number;
          effectiveFrom: Date;
        }>;
      }) => {
        if (!state.entry) throw new Error("missing fake Entry");
        for (const member of args.data) {
          entryMemberSequence += 1;
          state.entry.members.push({
            ...member,
            id: `entry-member-${entryMemberSequence}`,
            effectiveUntil: null,
            endReason: null,
          });
        }
        return { count: args.data.length };
      },
    },
  } as unknown as V2CompetitionTransaction;

  const db = {
    $transaction: async <T>(
      operation: (transaction: V2CompetitionTransaction) => Promise<T>,
    ) => {
      transactionCount += 1;
      const snapshot = structuredClone(state);
      try {
        return await operation(tx);
      } catch (error) {
        state = snapshot;
        throw error;
      }
    },
  } as V2TeamEntryRegistrationDatabase;

  const settlementPort: V2EntrySettlementPort = {
    apply: async (_transaction, input) => {
      applied.push(input.rosterVersion);
    },
    reverse: async (_transaction, input) => {
      reversed.push(input.rosterVersion);
    },
  };

  const setTeamMembers = (userIds: readonly string[]) => {
    state.team.members = userIds.map((userId, index) => ({
      id: `source-member-${userId}`,
      teamId: state.team.id,
      matchId: state.match.id,
      userId,
      joinedAt: new Date(`2026-02-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`),
      user: verifiedUser(userId),
    }));
  };

  return {
    db,
    tx,
    settlementPort,
    applied,
    reversed,
    lockCalls,
    get transactionCount() {
      return transactionCount;
    },
    get state() {
      return state;
    },
    setTeamMembers,
  };
}

async function reconcile(harness: ReturnType<typeof createHarness>) {
  return reconcileV2TeamEntryRegistration(
    harness.db,
    { matchId: harness.state.match.id, teamId: harness.state.team.id },
    harness.settlementPort,
  );
}

function currentEntry(harness: ReturnType<typeof createHarness>) {
  return harness.state.entry as FakeEntry | null;
}

function serverActionSource(name: string, nextName: string) {
  const source = readFileSync(
    resolve(process.cwd(), "src/app/matchs/actions.ts"),
    "utf8",
  );
  const start = source.indexOf(`export async function ${name}`);
  const end = source.indexOf(`export async function ${nextName}`, start + 1);
  assert.notEqual(start, -1, `missing ${name}`);
  assert.notEqual(end, -1, `missing boundary after ${name}`);
  return source.slice(start, end);
}

test("all six TEAM source actions compose V2 reconciliation in their Serializable transaction", () => {
  const actions = [
    ["createMatchTeamAction", "updateMatchTeamAction"],
    ["updateMatchTeamAction", "joinMatchTeamByInviteAction"],
    ["joinMatchTeamByInviteAction", "leaveMatchTeamAction"],
    ["leaveMatchTeamAction", "removeMatchTeamMemberAction"],
    ["removeMatchTeamMemberAction", "submitMatchTeamAction"],
    ["submitMatchTeamAction", "cancelMatchTeamAction"],
  ] as const;

  for (const [name, nextName] of actions) {
    const source = serverActionSource(name, nextName);
    assert.match(
      source,
      /lockedMatch\.match\.engineVersion === MatchEngineVersion\.V2/,
      name,
    );
    assert.match(
      source,
      /reconcileV2TeamEntryRegistrationInTransaction\(tx, v2Context\)/,
      name,
    );
    assert.match(
      source,
      /isolationLevel: Prisma\.TransactionIsolationLevel\.Serializable/,
      name,
    );
    assert.doesNotMatch(source, /hasMaterializedV2TeamEntry/, name);
    assert.doesNotMatch(source, /(?:tx|prisma)\.registration\./, name);
    assert.doesNotMatch(source, /registeredAt/, name);
  }

  assert.match(
    serverActionSource("createMatchTeamAction", "updateMatchTeamAction"),
    /lockV2TeamEntryRegistrationCreationContext\(tx/,
  );
  const cancellation = serverActionSource(
    "cancelMatchTeamAction",
    "adminUpdateMatchTeamStatusAction",
  );
  assert.match(cancellation, /binding\.match\.engineVersion === MatchEngineVersion\.V2/);
  assert.match(cancellation, /lockV2TeamEntryRegistrationContext\(tx/);
  assert.match(cancellation, /transitionV2EntryStatusInTransaction\(tx/);
  assert.match(cancellation, /to: 'WITHDRAWN'/);
  assert.match(cancellation, /v2_team_dissolve_before_grouping/);
  assert.doesNotMatch(cancellation, /expectedEngine: 'LEGACY'|matchResult\.delete/);
  assert.match(cancellation, /历史比赛已归档/);
});

test("new TEAM source locks absent ranges before sorted Users", async () => {
  const lockCalls: string[] = [];
  const tx = {
    $queryRaw: async (query: unknown) => {
      const sql = queryText(query);
      if (sql.includes('FROM "Match"')) {
        lockCalls.push("match");
        return [initialState().match];
      }
      if (sql.includes("FROM match_team t")) {
        lockCalls.push("team");
        return [];
      }
      if (sql.includes("FROM match_entry_member")) {
        lockCalls.push("entry-members");
        return [];
      }
      if (sql.includes("FROM match_entry")) {
        lockCalls.push("entries");
        return [];
      }
      if (sql.includes('FROM "User"')) {
        lockCalls.push("users");
        assert.deepEqual((query as { values: unknown[] }).values, [
          "captain",
          "player-2",
        ]);
        return [];
      }
      throw new Error(`Unexpected raw query: ${sql}`);
    },
    matchTeam: {
      findMany: async () => [],
    },
    matchEntry: {
      findFirst: async () => null,
    },
  } as unknown as V2CompetitionTransaction;

  const context = await lockV2TeamEntryRegistrationCreationContext(tx, {
    matchId: "team-match",
    teamId: "planned-team",
    additionalUserIds: ["player-2", "captain", "captain"],
  });

  assert.equal(context.teamId, "planned-team");
  assert.deepEqual(context.lockedTeamIds, []);
  assert.deepEqual(context.lockedUserIds, ["captain", "player-2"]);
  assert.deepEqual(lockCalls, [
    "match",
    "team",
    "entries",
    "entry-members",
    "users",
  ]);
});

test("new source fails closed when it would replace a related materialized TEAM source", async () => {
  const lockCalls: string[] = [];
  const tx = {
    $queryRaw: async (query: unknown) => {
      const sql = queryText(query);
      if (sql.includes('FROM "Match"')) {
        lockCalls.push("match");
        return [initialState().match];
      }
      if (sql.includes("FROM match_team t")) {
        lockCalls.push("team");
        return [{ id: "old-team" }];
      }
      if (sql.includes("FROM match_team_member tm")) {
        lockCalls.push("team-members");
        return [{ id: "old-member", teamId: "old-team", userId: "captain" }];
      }
      if (sql.includes("FROM match_entry_member")) {
        lockCalls.push("entry-members");
        return [{ id: "old-entry-member", userId: "captain" }];
      }
      if (sql.includes("FROM match_entry")) {
        lockCalls.push("entries");
        return [{ id: "old-entry" }];
      }
      if (sql.includes('FROM "User"')) {
        lockCalls.push("users");
        return [];
      }
      throw new Error(`Unexpected raw query: ${sql}`);
    },
    matchTeam: {
      findMany: async () => [{ captainId: "captain" }],
    },
    matchEntry: {
      findFirst: async () => ({
        id: "old-entry",
        sourceMatchTeamId: "old-team",
      }),
    },
  } as unknown as V2CompetitionTransaction;

  await assert.rejects(
    () =>
      lockV2TeamEntryRegistrationCreationContext(tx, {
        matchId: "team-match",
        teamId: "planned-team",
        additionalUserIds: ["captain"],
      }),
    (error: unknown) =>
      error instanceof V2CompetitionApplicationError &&
      error.code === "ENTRY_SOURCE_NOT_ACTIVE",
  );
  assert.deepEqual(lockCalls, [
    "match",
    "team",
    "team-members",
    "entries",
    "entry-members",
  ]);
});

test("TEAM source lifecycle creates, versions, deactivates, and reactivates one Entry", async () => {
  const harness = createHarness();

  const belowMinimum = await reconcile(harness);
  assert.equal(belowMinimum.action, "NOOP_DRAFT_SOURCE");
  assert.equal(harness.state.entry, null);
  assert.deepEqual(harness.lockCalls.slice(0, 6), [
    "match",
    "team",
    "team-members",
    "entries",
    "entry-members",
    "users",
  ]);

  harness.setTeamMembers(["captain", "player-2", "player-3"]);
  harness.state.team.status = "approved";
  const created = await reconcile(harness);
  assert.equal(created.action, "CREATED_ACTIVE");
  assert.equal(created.rosterVersion, 1);
  assert.equal(currentEntry(harness)?.status, "ACTIVE");
  assert.deepEqual(harness.applied, [1]);

  const unchanged = await reconcile(harness);
  assert.equal(unchanged.action, "NOOP_ALREADY_SYNCHRONIZED");
  assert.equal(currentEntry(harness)?.version, 0);

  harness.state.team.name = "Renamed Team";
  const renamed = await reconcile(harness);
  assert.equal(renamed.action, "SYNCHRONIZED_NAME");
  assert.equal(currentEntry(harness)?.displayNameSnapshot, "Renamed Team");
  assert.equal(currentEntry(harness)?.version, 1);

  harness.setTeamMembers(["captain", "player-3", "player-4"]);
  const replaced = await reconcile(harness);
  assert.equal(replaced.action, "REPLACED_ACTIVE_ROSTER");
  assert.equal(replaced.rosterVersion, 2);
  assert.equal(currentEntry(harness)?.version, 2);
  assert.deepEqual(harness.applied, [1, 2]);
  assert.deepEqual(
    currentEntry(harness)?.members
      .filter((member) => member.rosterVersion === 2)
      .map((member) => [member.userId, member.status]),
    [
      ["captain", "ACTIVE"],
      ["player-3", "ACTIVE"],
      ["player-4", "ACTIVE"],
    ],
  );

  harness.setTeamMembers(["captain", "player-4"]);
  harness.state.team.status = "draft";
  const deactivated = await reconcile(harness);
  assert.equal(deactivated.action, "DEACTIVATED_TO_DRAFT");
  assert.equal(currentEntry(harness)?.status, "DRAFT");
  assert.deepEqual(harness.reversed, [2]);
  assert.equal(
    currentEntry(harness)?.members.some((member) => member.status === "ACTIVE"),
    false,
  );

  harness.setTeamMembers(["captain", "player-4", "player-5"]);
  harness.state.team.status = "approved";
  const reactivated = await reconcile(harness);
  assert.equal(reactivated.action, "REACTIVATED");
  assert.equal(reactivated.rosterVersion, 3);
  assert.equal(currentEntry(harness)?.status, "ACTIVE");
  assert.deepEqual(harness.applied, [1, 2, 3]);
  assert.equal(harness.transactionCount, 7);
});

test("unsupported source states and terminal Entries fail closed", async () => {
  for (const status of ["submitted", "waitlisted", "rejected"] as const) {
    const harness = createHarness();
    harness.state.team.status = status;
    await assert.rejects(
      () => reconcile(harness),
      (error: unknown) =>
        error instanceof V2CompetitionApplicationError &&
        error.code === "ENTRY_SOURCE_NOT_ACTIVE",
    );
    assert.equal(harness.state.entry, null);
  }

  const cancelled = createHarness();
  cancelled.state.team.status = "cancelled";
  assert.equal(
    (await reconcile(cancelled)).action,
    "NOOP_CANCELLED_SOURCE_WITHOUT_ENTRY",
  );

  const terminal = createHarness();
  terminal.setTeamMembers(["captain", "player-2", "player-3"]);
  terminal.state.team.status = "approved";
  await reconcile(terminal);
  if (!terminal.state.entry) assert.fail("expected fake Entry");
  terminal.state.entry.status = "WITHDRAWN";
  await assert.rejects(
    () => reconcile(terminal),
    (error: unknown) =>
      error instanceof V2CompetitionApplicationError &&
      error.code === "ENTRY_SOURCE_NOT_ACTIVE",
  );
  assert.equal(terminal.state.entry.status, "WITHDRAWN");
});

test("threshold/status mismatches and inactive source users fail closed", async () => {
  const draftAtMinimum = createHarness();
  draftAtMinimum.setTeamMembers(["captain", "player-2", "player-3"]);
  await assert.rejects(() => reconcile(draftAtMinimum));
  assert.equal(draftAtMinimum.state.entry, null);

  const approvedBelowMinimum = createHarness();
  approvedBelowMinimum.state.team.status = "approved";
  await assert.rejects(() => reconcile(approvedBelowMinimum));
  assert.equal(approvedBelowMinimum.state.entry, null);

  const banned = createHarness();
  banned.setTeamMembers(["captain", "player-2", "player-3"]);
  banned.state.team.status = "approved";
  banned.state.team.members[2].user.isBanned = true;
  await assert.rejects(() => reconcile(banned));
  assert.equal(banned.state.entry, null);
});

test("reconciler rejects a forged or cross-transaction lock context", async () => {
  const first = createHarness();
  const context = await lockV2TeamEntryRegistrationContext(first.tx, {
    matchId: first.state.match.id,
    teamId: first.state.team.id,
  });
  const second = createHarness();

  await assert.rejects(
    () =>
      reconcileV2TeamEntryRegistrationInTransaction(
        second.tx,
        context,
        second.settlementPort,
      ),
    (error: unknown) =>
      error instanceof V2CompetitionApplicationError &&
      error.code === "INVALID_INPUT",
  );
  await assert.rejects(
    () =>
      reconcileV2TeamEntryRegistrationInTransaction(
        first.tx,
        {} as V2LockedTeamEntryRegistrationContext,
        first.settlementPort,
      ),
    (error: unknown) =>
      error instanceof V2CompetitionApplicationError &&
      error.code === "INVALID_INPUT",
  );
});

test("a settlement failure aborts the aggregate transaction", async () => {
  const harness = createHarness();
  harness.setTeamMembers(["captain", "player-2", "player-3"]);
  harness.state.team.status = "approved";
  const failingPort: V2EntrySettlementPort = {
    apply: async () => {
      throw new Error("fault after Entry persistence");
    },
    reverse: async () => undefined,
  };

  await assert.rejects(
    () =>
      reconcileV2TeamEntryRegistration(
        harness.db,
        { matchId: harness.state.match.id, teamId: harness.state.team.id },
        failingPort,
      ),
    /fault after Entry persistence/,
  );
  assert.equal(harness.state.entry, null);
});

test("a source mutation and failed reconciliation roll back together", async () => {
  const harness = createHarness();
  const failingPort: V2EntrySettlementPort = {
    apply: async () => {
      throw new Error("injected atomic source failure");
    },
    reverse: async () => {
      throw new Error("unexpected reverse");
    },
  };

  await assert.rejects(
    () =>
      harness.db.$transaction(async (tx) => {
        const context = await lockV2TeamEntryRegistrationContext(tx, {
          matchId: harness.state.match.id,
          teamId: harness.state.team.id,
          additionalUserIds: ["player-3"],
        });
        harness.setTeamMembers(["captain", "player-2", "player-3"]);
        harness.state.team.status = "approved";
        await reconcileV2TeamEntryRegistrationInTransaction(
          tx,
          context,
          failingPort,
        );
      }),
    /injected atomic source failure/,
  );

  assert.equal(harness.state.team.status, "draft");
  assert.deepEqual(
    harness.state.team.members.map((member) => member.userId),
    ["captain", "player-2"],
  );
  assert.equal(harness.state.entry, null);
});
