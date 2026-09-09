import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import {
  V2TeamRegistrationIntegrityError,
  getV2TeamRegistrationReadState,
} from "../read-model/team-registration";

function profile(id: string, nickname: string) {
  return {
    id,
    nickname,
    avatarUrl: null,
    points: 10,
    eloRating: 1_000,
    isBanned: false,
    emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function detailSource(overrides: Record<string, unknown> = {}) {
  const users = [
    profile("captain", "Captain"),
    profile("member-b", "Member B"),
    profile("member-c", "Member C"),
  ];
  const sourceMembers = users.map((user, index) => ({
    id: `source-member-${index + 1}`,
    teamId: "team-1",
    matchId: "match-1",
    userId: user.id,
    joinedAt: new Date(`2026-09-0${index + 1}T00:00:00.000Z`),
    user,
  }));
  const entryMembers = users.map((user, index) => ({
    id: `entry-member-${index + 1}`,
    matchId: "match-1",
    entryId: "entry-1",
    userId: user.id,
    displayNameSnapshot: user.nickname,
    role: index === 0 ? ("captain" as const) : ("player" as const),
    status: "ACTIVE" as const,
    slot: index + 1,
    rosterVersion: 1,
    effectiveUntil: null,
    user,
  }));
  return {
    id: "match-1",
    title: "V2 TEAM",
    description: null,
    dateTime: new Date("2026-10-01T11:00:00.000Z"),
    location: "West Campus Gym",
    isQuickMatch: false,
    type: "team",
    status: "registration",
    engineVersion: "V2",
    format: "group_only",
    createdBy: "owner",
    registrationDeadline: new Date("2026-09-30T09:00:00.000Z"),
    teamRegistrationStart: new Date("2026-09-01T01:00:00.000Z"),
    teamRegistrationDeadline: new Date("2026-09-30T09:00:00.000Z"),
    teamMinMembers: 3,
    teamMaxMembers: 6,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    creator: { id: "owner", nickname: "Owner", avatarUrl: null },
    teamRegistrations: [
      {
        id: "team-1",
        matchId: "match-1",
        captainId: "captain",
        name: "Alpha Team",
        inviteCode: "ALPHA123",
        contact: "contact",
        remark: null,
        reviewNote: null,
        status: "approved",
        submittedAt: new Date("2026-09-03T00:00:00.000Z"),
        reviewedAt: null,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
        captain: users[0],
        members: sourceMembers,
      },
    ],
    entries: [
      {
        id: "entry-1",
        matchId: "match-1",
        kind: "TEAM",
        status: "ACTIVE",
        sourceKey: "team:team-1",
        sourceUserId: null,
        sourceDoublesTeamId: null,
        sourceMatchTeamId: "team-1",
        displayNameSnapshot: "Alpha Team",
        version: 0,
        members: entryMembers,
      },
    ],
    ...overrides,
  };
}

function groupingSource(source: ReturnType<typeof detailSource>) {
  const teams = new Map(
    source.teamRegistrations.map((team) => [team.id, team] as const),
  );
  return {
    id: source.id,
    title: source.title,
    type: source.type,
    status: source.status,
    engineVersion: source.engineVersion,
    isQuickMatch: source.isQuickMatch,
    format: source.format,
    createdBy: source.createdBy,
    registrationDeadline: source.registrationDeadline,
    teamRegistrationDeadline: source.teamRegistrationDeadline,
    teamMinMembers: source.teamMinMembers,
    teamMaxMembers: source.teamMaxMembers,
    groupingGeneratedAt: null,
    groupingResult: null,
    matchGroups: [],
    fixtures: [],
    entries: source.entries.map((entry) => {
      const team = entry.sourceMatchTeamId
        ? teams.get(entry.sourceMatchTeamId)
        : undefined;
      return {
        ...entry,
        sourceUser: null,
        sourceDoublesTeam: null,
        sourceMatchTeam: team
          ? {
              id: team.id,
              matchId: team.matchId,
              captainId: team.captainId,
              status: team.status,
              members: [...team.members]
                .sort((left, right) => left.userId.localeCompare(right.userId))
                .map((member) => ({
                  userId: member.userId,
                  matchId: member.matchId,
                })),
            }
          : null,
      };
    }),
  };
}

function database(
  detail: ReturnType<typeof detailSource> | null,
  grouping = detail ? groupingSource(detail) : null,
  calls: unknown[] = [],
) {
  return {
    db: {
      $transaction: async <T>(
        operation: (tx: {
          match: {
            findUnique(args: {
              select?: Record<string, unknown>;
            }): Promise<unknown>;
          };
          matchFixtureDependency: {
            findMany(args: unknown): Promise<unknown[]>;
          };
        }) => Promise<T>,
        options: unknown,
      ) => {
        calls.push(options);
        return operation({
          match: {
            findUnique: async (args) => {
              calls.push(args);
              return args.select && "teamRegistrations" in args.select
                ? detail
                : grouping;
            },
          },
          matchFixtureDependency: {
            findMany: async (args) => {
              calls.push(args);
              return [];
            },
          },
        });
      },
    } as unknown as Pick<PrismaClient, "$transaction">,
    calls,
  };
}

test("TEAM read model derives source, Entry, window, and counts in one snapshot", async () => {
  const fixture = database(detailSource());
  const result = await getV2TeamRegistrationReadState(
    fixture.db,
    "match-1",
    new Date("2026-09-15T00:00:00.000Z"),
  );
  assert.equal(result.kind, "TEAM_V2_REGISTRATION");
  if (result.kind !== "TEAM_V2_REGISTRATION") return;
  assert.deepEqual(result.registration, {
    open: true,
    notStarted: false,
    closed: false,
  });
  assert.equal(result.activeEntryCount, 1);
  assert.equal(result.activeMemberCount, 3);
  assert.equal(result.teams[0].entry?.status, "ACTIVE");
  assert.equal(result.teams[0].entry?.currentRosterVersion, 1);
  assert.equal(result.grouping.published, false);
  assert.deepEqual(fixture.calls[0], {
    isolationLevel: "RepeatableRead",
    maxWait: 5_000,
    timeout: 10_000,
  });
  const serializedSelections = JSON.stringify(fixture.calls.slice(1));
  assert.equal(/"registrations":/.test(serializedSelections), false);
  assert.equal(serializedSelections.includes("registeredAt"), false);
});

test("TEAM draft source without Entry remains visible but is not an active registration", async () => {
  const base = detailSource();
  const team = {
    ...base.teamRegistrations[0],
    status: "draft",
    submittedAt: null,
    members: base.teamRegistrations[0].members.slice(0, 2),
  };
  const detail = detailSource({ teamRegistrations: [team], entries: [] });
  const result = await getV2TeamRegistrationReadState(
    database(detail).db,
    "match-1",
    new Date("2026-08-15T00:00:00.000Z"),
  );
  assert.equal(result.kind, "TEAM_V2_REGISTRATION");
  if (result.kind !== "TEAM_V2_REGISTRATION") return;
  assert.equal(result.teams[0].entry, null);
  assert.equal(result.activeEntryCount, 0);
  assert.deepEqual(result.registration, {
    open: false,
    notStarted: true,
    closed: false,
  });
});

test("a dissolved TEAM source preserves its withdrawn Entry history", async () => {
  const base = detailSource();
  const endedAt = new Date("2026-09-10T00:00:00.000Z");
  const cancelledTeam = {
    ...base.teamRegistrations[0],
    status: "cancelled",
    submittedAt: null,
  };
  const withdrawnEntry = {
    ...base.entries[0],
    status: "WITHDRAWN",
    version: 1,
    members: base.entries[0].members.map((member) => ({
      ...member,
      status: "WITHDRAWN",
      effectiveUntil: endedAt,
    })),
  };
  const detail = detailSource({
    teamRegistrations: [cancelledTeam],
    entries: [withdrawnEntry],
  });
  const result = await getV2TeamRegistrationReadState(
    database(detail).db,
    "match-1",
    new Date("2026-09-15T00:00:00.000Z"),
  );
  assert.equal(result.kind, "TEAM_V2_REGISTRATION");
  if (result.kind !== "TEAM_V2_REGISTRATION") return;
  assert.equal(result.teams[0].status, "cancelled");
  assert.equal(result.teams[0].entry?.status, "WITHDRAWN");
  assert.equal(result.teams[0].entry?.currentRosterVersion, null);
  assert.equal(result.activeEntryCount, 0);
  assert.equal(result.activeMemberCount, 0);
});

test("TEAM read model fails closed on source/Entry status or roster divergence", async () => {
  const base = detailSource();
  const corruptions = [
    detailSource({
      entries: [{ ...base.entries[0], displayNameSnapshot: "Stale name" }],
    }),
    detailSource({
      entries: [
        {
          ...base.entries[0],
          members: base.entries[0].members.slice(0, 2),
        },
      ],
    }),
    detailSource({
      teamRegistrations: [
        { ...base.teamRegistrations[0], status: "draft" },
      ],
    }),
  ];
  for (const corrupt of corruptions) {
    await assert.rejects(
      getV2TeamRegistrationReadState(database(corrupt).db, "match-1"),
      V2TeamRegistrationIntegrityError,
    );
  }
});

test("TEAM read model exposes explicit missing and unsupported states", async () => {
  assert.deepEqual(
    await getV2TeamRegistrationReadState(database(null).db, "missing"),
    { kind: "MATCH_NOT_FOUND" },
  );
  const unsupported = detailSource({ type: "double" });
  assert.deepEqual(
    await getV2TeamRegistrationReadState(
      database(unsupported, groupingSource(unsupported)).db,
      "match-1",
    ),
    { kind: "UNSUPPORTED_V2_MATCH" },
  );
});
