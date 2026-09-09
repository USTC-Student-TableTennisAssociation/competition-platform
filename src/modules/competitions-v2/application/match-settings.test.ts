import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import { V2CompetitionApplicationError } from "./entries";
import { createV2MatchSettingsApplicationService } from "./match-settings";

const ORIGINAL_UPDATED_AT = new Date("2026-09-04T08:00:00.000Z");
const UPDATED_AT = new Date("2026-09-04T08:05:00.000Z");
const CLOCK = new Date("2026-09-05T08:00:00.000Z");
const NEW_DATE_TIME = new Date("2026-10-02T11:00:00.000Z");
const NEW_REGISTRATION_DEADLINE = new Date("2026-10-01T11:00:00.000Z");

type HarnessMatch = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  dateTime: Date;
  updatedAt: Date;
  engineVersion: "LEGACY" | "V2";
  isQuickMatch: boolean;
  type: "single" | "double" | "team";
  format: "group_only" | "group_then_knockout";
  status: "registration" | "ongoing" | "finished";
  createdBy: string;
  createdAt: Date;
  registrationDeadline: Date;
  groupingGeneratedAt: Date | null;
  teamRegistrationStart: Date | null;
  teamRegistrationDeadline: Date | null;
  teamMinMembers: number | null;
  teamMaxMembers: number | null;
  rule: unknown;
};

function makeHarness(options: Readonly<{
  actorId?: string;
  actorRole?: "user" | "admin";
  match?: Readonly<Partial<HarnessMatch>>;
  grouping?: boolean;
  fixtureCount?: number;
  relationalGroupCount?: number;
  qualificationSnapshotCount?: number;
  failAudit?: boolean;
}> = {}) {
  const actorId = options.actorId ?? "creator-1";
  const calls: string[] = [];
  const audits: unknown[] = [];
  let updateCount = 0;
  const state: { match: HarnessMatch } = {
    match: {
      id: "match-1",
      title: "原比赛名",
      description: "原描述",
      location: "西区乒乓球馆",
      dateTime: new Date("2026-10-01T11:00:00.000Z"),
      updatedAt: new Date(ORIGINAL_UPDATED_AT),
      engineVersion: "V2",
      isQuickMatch: false,
      type: "single",
      format: "group_only",
      status: "registration",
      createdBy: "creator-1",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      registrationDeadline: new Date("2026-09-10T08:00:00.000Z"),
      groupingGeneratedAt: null,
      teamRegistrationStart: null,
      teamRegistrationDeadline: null,
      teamMinMembers: null,
      teamMaxMembers: null,
      rule: { note: "immutable policy" },
      ...options.match,
    },
  };

  const tx = {
    $queryRaw: async (query: { strings?: readonly string[] }) => {
      const sql = query.strings?.join("?") ?? "";
      if (sql.includes('FROM "Match"')) {
        calls.push("lock-match");
        return [{ id: state.match.id }];
      }
      if (sql.includes('FROM "User"')) {
        calls.push("lock-actor");
        return [{ id: actorId }];
      }
      throw new Error(`unexpected lock query: ${sql}`);
    },
    user: {
      findUnique: async () => ({
        id: actorId,
        role: options.actorRole ?? "user",
        isBanned: false,
        emailVerifiedAt: new Date("2026-09-01T00:00:00.000Z"),
      }),
    },
    match: {
      findUnique: async () => ({ ...state.match }),
      update: async (args: {
        where: {
          id: string;
          updatedAt: Date;
        };
        data: {
          title: string;
          description: string | null;
          location: string;
          dateTime: Date;
          registrationDeadline: Date;
          teamRegistrationDeadline?: Date;
        };
      }) => {
        calls.push("update-match");
        assert.equal(args.where.id, state.match.id);
        assert.equal(
          args.where.updatedAt.toISOString(),
          ORIGINAL_UPDATED_AT.toISOString(),
        );
        updateCount += 1;
        Object.assign(state.match, args.data, { updatedAt: new Date(UPDATED_AT) });
        return {
          id: state.match.id,
          title: state.match.title,
          description: state.match.description,
          location: state.match.location,
          dateTime: state.match.dateTime,
          registrationDeadline: state.match.registrationDeadline,
          teamRegistrationDeadline: state.match.teamRegistrationDeadline,
          type: state.match.type,
          format: state.match.format,
          updatedAt: state.match.updatedAt,
        };
      },
    },
    matchGrouping: {
      findUnique: async () =>
        options.grouping === true ? { id: "grouping-1" } : null,
    },
    matchFixture: {
      count: async () => options.fixtureCount ?? 0,
    },
    matchGroup: {
      count: async () => options.relationalGroupCount ?? 0,
    },
    matchQualificationSnapshot: {
      count: async () => options.qualificationSnapshotCount ?? 0,
    },
    auditLog: {
      create: async (args: unknown) => {
        calls.push("create-audit");
        if (options.failAudit) throw new Error("audit unavailable");
        audits.push(args);
        return { id: "audit-1" };
      },
    },
  };
  const db = {
    $transaction: async <T>(
      operation: (transaction: typeof tx) => Promise<T>,
      transactionOptions: unknown,
    ) => {
      calls.push(`transaction:${JSON.stringify(transactionOptions)}`);
      const snapshot = { ...state.match };
      try {
        return await operation(tx);
      } catch (error) {
        state.match = snapshot;
        throw error;
      }
    },
  } as unknown as Pick<PrismaClient, "$transaction">;

  return {
    actor: { id: actorId, role: options.actorRole ?? ("user" as const) },
    calls,
    audits,
    db,
    state,
    get updateCount() {
      return updateCount;
    },
  };
}

function command(
  harness: ReturnType<typeof makeHarness>,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    actor: harness.actor,
    matchId: "match-1",
    expectedUpdatedAt: new Date(ORIGINAL_UPDATED_AT),
    title: "新比赛名",
    description: null,
    location: "东区乒乓球馆",
    dateTime: new Date(NEW_DATE_TIME),
    registrationDeadline: new Date(NEW_REGISTRATION_DEADLINE),
    ...overrides,
  };
}

test("settings update locks Match before actor and commits metadata and schedule with its audit", async () => {
  const harness = makeHarness();
  const service = createV2MatchSettingsApplicationService({
    db: harness.db,
    clock: () => new Date(CLOCK),
  });

  const result = await service.update(command(harness));
  assert.equal(result.changed, true);
  assert.equal(result.updatedAt.toISOString(), UPDATED_AT.toISOString());
  assert.equal(harness.state.match.title, "新比赛名");
  assert.equal(harness.state.match.description, null);
  assert.equal(harness.state.match.location, "东区乒乓球馆");
  assert.equal(
    harness.state.match.dateTime.toISOString(),
    NEW_DATE_TIME.toISOString(),
  );
  assert.equal(harness.state.match.status, "registration");
  assert.equal(
    harness.state.match.registrationDeadline.toISOString(),
    NEW_REGISTRATION_DEADLINE.toISOString(),
  );
  assert.equal(harness.updateCount, 1);
  assert.equal(harness.audits.length, 1);
  assert.deepEqual(harness.audits[0], {
    data: {
      actorId: "creator-1",
      action: "v2_match_settings_update",
      entityType: "Match",
      entityId: "match-1",
      details: {
        targetLabel: "新比赛名",
        engineVersion: "V2",
        type: "single",
        format: "group_only",
        before: {
          title: "原比赛名",
          description: "原描述",
          location: "西区乒乓球馆",
          dateTime: "2026-10-01T11:00:00.000Z",
          registrationDeadline: "2026-09-10T08:00:00.000Z",
          teamRegistrationDeadline: null,
        },
        after: {
          title: "新比赛名",
          description: null,
          location: "东区乒乓球馆",
          dateTime: NEW_DATE_TIME.toISOString(),
          registrationDeadline: NEW_REGISTRATION_DEADLINE.toISOString(),
          teamRegistrationDeadline: null,
        },
      },
    },
  });
  assert.ok(harness.calls.indexOf("lock-match") < harness.calls.indexOf("lock-actor"));
  assert.ok(harness.calls.indexOf("lock-actor") < harness.calls.indexOf("update-match"));
  assert.ok(harness.calls.indexOf("update-match") < harness.calls.indexOf("create-audit"));
  assert.match(harness.calls[0], /"isolationLevel":"Serializable"/);
});

test("the same server-owned service accepts all six formal type x format slices", async () => {
  const scopes = [
    ["single", "group_only"],
    ["single", "group_then_knockout"],
    ["double", "group_only"],
    ["double", "group_then_knockout"],
    ["team", "group_only"],
    ["team", "group_then_knockout"],
  ] as const;

  for (const [type, format] of scopes) {
    const originalTeamStart = new Date("2026-09-02T08:00:00.000Z");
    const harness = makeHarness({
      match: {
        type,
        format,
        ...(type === "team"
          ? {
              teamRegistrationStart: originalTeamStart,
              teamRegistrationDeadline: new Date(
                "2026-09-10T08:00:00.000Z",
              ),
              teamMinMembers: 3,
              teamMaxMembers: 6,
            }
          : {}),
      },
    });
    const service = createV2MatchSettingsApplicationService({
      db: harness.db,
      clock: () => new Date(CLOCK),
    });

    const result = await service.update(command(harness));
    assert.equal(result.changed, true, `${type}:${format}`);
    assert.equal(harness.state.match.type, type);
    assert.equal(harness.state.match.format, format);
    assert.equal(harness.state.match.engineVersion, "V2");
    assert.deepEqual(harness.state.match.rule, { note: "immutable policy" });
    assert.equal(harness.audits.length, 1);

    if (type === "team") {
      assert.equal(
        harness.state.match.teamRegistrationDeadline?.toISOString(),
        NEW_REGISTRATION_DEADLINE.toISOString(),
      );
      assert.equal(
        harness.state.match.registrationDeadline.toISOString(),
        harness.state.match.teamRegistrationDeadline?.toISOString(),
      );
      assert.equal(
        harness.state.match.teamRegistrationStart?.toISOString(),
        originalTeamStart.toISOString(),
      );
      assert.equal(harness.state.match.teamMinMembers, 3);
      assert.equal(harness.state.match.teamMaxMembers, 6);
    } else {
      assert.equal(harness.state.match.teamRegistrationDeadline, null);
    }
  }
});

test("the command cannot select or mutate server-owned match policy", async () => {
  for (const protectedField of [
    "type",
    "format",
    "engineVersion",
    "isQuickMatch",
    "status",
    "rule",
    "teamRegistrationStart",
    "teamRegistrationDeadline",
    "teamMinMembers",
    "teamMaxMembers",
    "groupingGeneratedAt",
  ]) {
    const harness = makeHarness();
    const service = createV2MatchSettingsApplicationService({
      db: harness.db,
      clock: () => new Date(CLOCK),
    });
    await assert.rejects(
      service.update(
        command(harness, {
          [protectedField]: "client-owned",
        }),
      ),
      (error: unknown) =>
        error instanceof V2CompetitionApplicationError &&
        error.code === "INVALID_INPUT",
      protectedField,
    );
    assert.deepEqual(harness.calls, [], protectedField);
  }
});

test("an identical retry is a no-op and does not duplicate the audit", async () => {
  const harness = makeHarness();
  const service = createV2MatchSettingsApplicationService({
    db: harness.db,
    clock: () => new Date(CLOCK),
  });

  await service.update(command(harness));
  const retry = await service.update(command(harness));
  assert.equal(retry.changed, false);
  assert.equal(harness.updateCount, 1);
  assert.equal(harness.audits.length, 1);
});

test("a stale different edit is rejected instead of overwriting the newer settings", async () => {
  const harness = makeHarness({
    match: { title: "别人刚保存的名称", updatedAt: UPDATED_AT },
  });
  const service = createV2MatchSettingsApplicationService({
    db: harness.db,
    clock: () => new Date(CLOCK),
  });

  await assert.rejects(
    service.update(command(harness)),
    (error: unknown) =>
      error instanceof V2CompetitionApplicationError &&
      error.code === "CONCURRENT_WRITE_CONFLICT",
  );
  assert.equal(harness.updateCount, 0);
  assert.equal(harness.audits.length, 0);
});

test("creator-only and unpublished registration lifecycle checks fail closed", async () => {
  const cases = [
    makeHarness({ actorId: "admin-2", actorRole: "admin" }),
    makeHarness({ match: { status: "ongoing" } }),
    makeHarness({ match: { groupingGeneratedAt: new Date(CLOCK) } }),
    makeHarness({ grouping: true }),
    makeHarness({ fixtureCount: 1 }),
    makeHarness({
      match: { format: "group_then_knockout" },
      relationalGroupCount: 1,
    }),
    makeHarness({
      match: { format: "group_then_knockout" },
      qualificationSnapshotCount: 1,
    }),
    makeHarness({ match: { registrationDeadline: new Date(CLOCK) } }),
    makeHarness({ match: { createdAt: new Date("2026-09-06T00:00:00.000Z") } }),
  ];

  for (const harness of cases) {
    const service = createV2MatchSettingsApplicationService({
      db: harness.db,
      clock: () => new Date(CLOCK),
    });
    await assert.rejects(
      service.update(command(harness)),
      (error: unknown) =>
        error instanceof V2CompetitionApplicationError && error.code === "FORBIDDEN",
    );
    assert.equal(harness.updateCount, 0);
    assert.equal(harness.audits.length, 0);
  }
});

test("TEAM policy must already be authoritative and remains immutable", async () => {
  const validTeamPolicy = {
    type: "team",
    format: "group_then_knockout",
    teamRegistrationStart: new Date("2026-09-02T08:00:00.000Z"),
    teamRegistrationDeadline: new Date("2026-09-10T08:00:00.000Z"),
    teamMinMembers: 3,
    teamMaxMembers: 6,
  } as const;
  const invalidPolicies = [
    { ...validTeamPolicy, teamRegistrationDeadline: null },
    {
      ...validTeamPolicy,
      teamRegistrationDeadline: new Date("2026-09-09T08:00:00.000Z"),
    },
    { ...validTeamPolicy, teamMinMembers: null },
    { ...validTeamPolicy, teamMaxMembers: 2 },
  ];

  for (const policy of invalidPolicies) {
    const harness = makeHarness({ match: policy });
    const service = createV2MatchSettingsApplicationService({
      db: harness.db,
      clock: () => new Date(CLOCK),
    });
    await assert.rejects(
      service.update(command(harness)),
      (error: unknown) =>
        error instanceof V2CompetitionApplicationError &&
        error.code === "PERSISTENCE_CONFLICT",
    );
    assert.equal(harness.updateCount, 0);
    assert.equal(harness.audits.length, 0);
  }

  const deadlineBeforeImmutableStart = makeHarness({
    match: {
      ...validTeamPolicy,
      teamRegistrationStart: new Date("2026-09-08T08:00:00.000Z"),
    },
  });
  const service = createV2MatchSettingsApplicationService({
    db: deadlineBeforeImmutableStart.db,
    clock: () => new Date(CLOCK),
  });
  await assert.rejects(
    service.update(
      command(deadlineBeforeImmutableStart, {
        registrationDeadline: new Date("2026-09-08T08:00:00.000Z"),
      }),
    ),
    (error: unknown) =>
      error instanceof V2CompetitionApplicationError &&
      error.code === "INVALID_INPUT",
  );
});

test("a new deadline must remain in the future and before the new start time", async () => {
  const serviceFor = (harness: ReturnType<typeof makeHarness>) =>
    createV2MatchSettingsApplicationService({
      db: harness.db,
      clock: () => new Date(CLOCK),
    });

  for (const overrides of [
    { registrationDeadline: new Date(CLOCK) },
    {
      dateTime: new Date("2026-09-08T08:00:00.000Z"),
      registrationDeadline: new Date("2026-09-08T08:00:00.000Z"),
    },
  ]) {
    const harness = makeHarness();
    await assert.rejects(
      serviceFor(harness).update(command(harness, overrides)),
      (error: unknown) =>
        error instanceof V2CompetitionApplicationError &&
        error.code === "INVALID_INPUT",
    );
    assert.equal(harness.updateCount, 0);
    assert.equal(harness.audits.length, 0);
  }
});

test("an audit failure rolls the metadata update back", async () => {
  const harness = makeHarness({ failAudit: true });
  const service = createV2MatchSettingsApplicationService({
    db: harness.db,
    clock: () => new Date(CLOCK),
  });

  await assert.rejects(service.update(command(harness)), /audit unavailable/);
  assert.equal(harness.state.match.title, "原比赛名");
  assert.equal(harness.state.match.description, "原描述");
  assert.equal(harness.state.match.location, "西区乒乓球馆");
  assert.equal(
    harness.state.match.dateTime.toISOString(),
    "2026-10-01T11:00:00.000Z",
  );
  assert.equal(
    harness.state.match.registrationDeadline.toISOString(),
    "2026-09-10T08:00:00.000Z",
  );
});

test("a TEAM audit failure rolls back both authoritative deadline columns", async () => {
  const originalDeadline = new Date("2026-09-10T08:00:00.000Z");
  const harness = makeHarness({
    failAudit: true,
    match: {
      type: "team",
      format: "group_then_knockout",
      teamRegistrationStart: new Date("2026-09-02T08:00:00.000Z"),
      teamRegistrationDeadline: originalDeadline,
      teamMinMembers: 3,
      teamMaxMembers: 6,
    },
  });
  const service = createV2MatchSettingsApplicationService({
    db: harness.db,
    clock: () => new Date(CLOCK),
  });

  await assert.rejects(service.update(command(harness)), /audit unavailable/);
  assert.equal(
    harness.state.match.registrationDeadline.toISOString(),
    originalDeadline.toISOString(),
  );
  assert.equal(
    harness.state.match.teamRegistrationDeadline?.toISOString(),
    originalDeadline.toISOString(),
  );
  assert.equal(harness.state.match.teamMinMembers, 3);
  assert.equal(harness.state.match.teamMaxMembers, 6);
});
