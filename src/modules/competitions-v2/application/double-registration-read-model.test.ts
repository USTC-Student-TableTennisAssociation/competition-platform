import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import {
  V2DoubleRegistrationIntegrityError,
  getV2DoubleRegistrationReadState,
} from "../read-model/double-registration";

function profile(id: string, nickname: string) {
  return {
    id,
    nickname,
    avatarUrl: null,
    eloRating: 1000,
    points: 10,
    isBanned: false,
    emailVerifiedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function source(overrides: Record<string, unknown> = {}) {
  const users = [profile("user-a", "A"), profile("user-b", "B")];
  return {
    id: "match-1",
    title: "V2 doubles",
    description: null,
    dateTime: new Date("2026-10-01T11:00:00Z"),
    location: "West Campus Gym",
    isQuickMatch: false,
    type: "double",
    status: "registration",
    engineVersion: "V2",
    format: "group_only",
    createdBy: "owner",
    registrationDeadline: new Date("2026-09-30T11:00:00Z"),
    teamRegistrationDeadline: null,
    teamMinMembers: null,
    teamMaxMembers: null,
    groupingGeneratedAt: null,
    groupingResult: null,
    matchGroups: [],
    fixtures: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    creator: { id: "owner", nickname: "Owner", avatarUrl: null },
    doublesTeams: [
      {
        id: "source-team",
        createdById: "user-a",
        createdAt: new Date("2026-01-01T00:00:00Z"),
        members: users.map((user, index) => ({
          id: `source-member-${index + 1}`,
          userId: user.id,
          slot: index + 1,
          user,
        })),
      },
    ],
    entries: [
      {
        id: "entry-1",
        kind: "DOUBLES",
        status: "ACTIVE",
        sourceKey: "doubles:source-team",
        sourceUserId: null,
        sourceDoublesTeamId: "source-team",
        sourceMatchTeamId: null,
        sourceUser: null,
        sourceMatchTeam: null,
        sourceDoublesTeam: {
          id: "source-team",
          matchId: "match-1",
          members: users.map((user, index) => ({
            userId: user.id,
            slot: index + 1,
            matchId: "match-1",
          })),
        },
        displayNameSnapshot: "A / B",
        version: 0,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        members: users.map((user, index) => ({
          id: `entry-member-${index + 1}`,
          userId: user.id,
          displayNameSnapshot: user.nickname,
          role: "player",
          status: "ACTIVE",
          slot: index + 1,
          rosterVersion: 1,
          effectiveFrom: new Date("2026-01-01T00:00:00Z"),
          effectiveUntil: null,
          user,
        })),
      },
    ],
    ...overrides,
  };
}

function database(value: unknown, selection?: unknown[]) {
  return {
    $transaction: async <T>(
      operation: (tx: {
        match: { findUnique(args: unknown): Promise<unknown> };
        matchFixtureDependency: { findMany(args: unknown): Promise<unknown[]> };
      }) => Promise<T>,
      options: unknown,
    ) => {
      selection?.push(options);
      return operation({
        match: {
          findUnique: async (args) => {
            selection?.push(args);
            return value;
          },
        },
        matchFixtureDependency: {
          findMany: async (args) => {
            selection?.push(args);
            return [];
          },
        },
      });
    },
  } as unknown as Pick<PrismaClient, "$transaction">;
}

test("DOUBLE read state derives pair counts and partner action only from ACTIVE Entry", async () => {
  const calls: unknown[] = [];
  const result = await getV2DoubleRegistrationReadState(
    database(source(), calls),
    "match-1",
    "user-a",
    new Date("2026-09-01T00:00:00Z"),
  );
  assert.equal(result.kind, "DOUBLE_V2_REGISTRATION");
  if (result.kind !== "DOUBLE_V2_REGISTRATION") return;
  assert.equal(result.activeEntryCount, 1);
  assert.equal(result.activeMemberCount, 2);
  assert.equal(result.viewer.action, "CANCEL");
  assert.equal(result.viewer.sourceTeam?.entry?.entryId, "entry-1");
  assert.deepEqual(
    result.activeEntries[0].members.map((member) => member.userId),
    ["user-a", "user-b"],
  );
  assert.deepEqual(calls[0], {
    isolationLevel: "RepeatableRead",
    maxWait: 5_000,
    timeout: 10_000,
  });
  const serializedSelection = JSON.stringify(calls[1]);
  assert.equal(serializedSelection.includes("registrations"), false);
  assert.equal(serializedSelection.includes("registeredAt"), false);
});

test("source-only, DRAFT, unauthenticated, and closed states choose safe actions", async () => {
  const base = source();
  const sourceOnly = await getV2DoubleRegistrationReadState(
    database({ ...base, entries: [] }),
    "match-1",
    "user-a",
    new Date("2026-09-01T00:00:00Z"),
  );
  assert.equal(
    sourceOnly.kind === "DOUBLE_V2_REGISTRATION"
      ? sourceOnly.viewer.action
      : null,
    "REGISTER",
  );

  const draft = await getV2DoubleRegistrationReadState(
    database({
      ...base,
      entries: [{ ...base.entries[0], status: "DRAFT" }],
    }),
    "match-1",
    "user-b",
    new Date("2026-09-01T00:00:00Z"),
  );
  assert.equal(
    draft.kind === "DOUBLE_V2_REGISTRATION" ? draft.viewer.action : null,
    "REGISTER",
  );
  assert.equal(
    draft.kind === "DOUBLE_V2_REGISTRATION" ? draft.activeEntryCount : null,
    0,
  );

  const noTeam = await getV2DoubleRegistrationReadState(
    database({ ...base, doublesTeams: [], entries: [] }),
    "match-1",
    "user-a",
    new Date("2026-09-01T00:00:00Z"),
  );
  assert.equal(
    noTeam.kind === "DOUBLE_V2_REGISTRATION" ? noTeam.viewer.action : null,
    "FORM_TEAM",
  );

  const anonymous = await getV2DoubleRegistrationReadState(
    database({ ...base, entries: [] }),
    "match-1",
    null,
    new Date("2026-09-01T00:00:00Z"),
  );
  assert.equal(
    anonymous.kind === "DOUBLE_V2_REGISTRATION"
      ? anonymous.viewer.action
      : null,
    "LOGIN",
  );

  const closed = await getV2DoubleRegistrationReadState(
    database(base),
    "match-1",
    "user-a",
    new Date("2026-10-01T00:00:00Z"),
  );
  assert.equal(
    closed.kind === "DOUBLE_V2_REGISTRATION" ? closed.viewer.action : null,
    "NONE",
  );
});

test("an eligible partner may still exit an ACTIVE pair after the other account is banned", async () => {
  const base = source();
  const sourceMembers = base.doublesTeams[0].members.map((member, index) =>
    index === 1
      ? { ...member, user: { ...member.user, isBanned: true } }
      : member,
  );
  const result = await getV2DoubleRegistrationReadState(
    database({
      ...base,
      doublesTeams: [
        { ...base.doublesTeams[0], members: sourceMembers },
      ],
    }),
    "match-1",
    "user-a",
    new Date("2026-09-01T00:00:00Z"),
  );
  assert.equal(
    result.kind === "DOUBLE_V2_REGISTRATION" ? result.viewer.action : null,
    "CANCEL",
  );
});

test("ACTIVE Entry fails closed unless one roster version has exact slots 1/2", async () => {
  const base = source();
  const baseEntry = base.entries[0];
  for (const members of [
    baseEntry.members.map((member, index) => ({
      ...member,
      rosterVersion: index + 1,
    })),
    baseEntry.members.map((member, index) => ({ ...member, slot: index + 2 })),
  ]) {
    await assert.rejects(
      getV2DoubleRegistrationReadState(
        database({ ...base, entries: [{ ...baseEntry, members }] }),
        "match-1",
        "user-a",
      ),
      V2DoubleRegistrationIntegrityError,
    );
  }
});

test("ACTIVE Entry user set must exactly match its MatchDoublesTeam source", async () => {
  const base = source();
  const mismatched = base.entries[0].members.map((member, index) =>
    index === 0
      ? {
          ...member,
          userId: "different-user",
          user: profile("different-user", "Different"),
        }
      : member,
  );
  await assert.rejects(
    getV2DoubleRegistrationReadState(
      database({
        ...base,
        entries: [{ ...base.entries[0], members: mismatched }],
      }),
      "match-1",
      "user-a",
    ),
    V2DoubleRegistrationIntegrityError,
  );
});

test("missing and unsupported matches remain explicit fail-closed states", async () => {
  assert.deepEqual(
    await getV2DoubleRegistrationReadState(database(null), "missing", null),
    { kind: "MATCH_NOT_FOUND" },
  );
  assert.deepEqual(
    await getV2DoubleRegistrationReadState(
      database(source({ type: "single" })),
      "match-1",
      null,
    ),
    { kind: "UNSUPPORTED_V2_MATCH" },
  );
});
