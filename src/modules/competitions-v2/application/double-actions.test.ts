import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import {
  createV2DoubleActionHandlers,
  type V2DoubleActionAdapterDependencies,
} from "../adapters/double-actions";
import {
  V2CompetitionApplicationError,
  type CreateV2EntryInput,
  type TransitionV2EntryStatusInput,
  type createV2Entry,
  type transitionV2EntryStatus,
} from "./entries";
import type {
  PublishV2DoubleGroupingCommand,
  V2DoubleGroupingApplicationService,
} from "./double-grouping";
import type { V2ResultApplicationService } from "./results";

function form() {
  const value = new FormData();
  value.set("csrfToken", "token");
  return value;
}

function setup(input: Readonly<{
  sources?: readonly { id: string }[];
  entry?: {
    id: string;
    kind: "DOUBLES";
    status: "DRAFT" | "ACTIVE" | "WITHDRAWN";
    version: number;
  } | null;
  createResult?: {
    id: string;
    matchId: string;
    kind: "DOUBLES";
    status: "DRAFT" | "ACTIVE";
    version: number;
    rosterVersion: number;
    created: boolean;
  };
  createError?: unknown;
  transitionError?: unknown;
  matchType?: "single" | "double" | "team";
}> = {}) {
  const createInputs: CreateV2EntryInput[] = [];
  const transitionInputs: TransitionV2EntryStatusInput[] = [];
  const revalidated: string[][] = [];
  const db = {
    match: {
      findUnique: async () => ({
        type: input.matchType ?? "double",
        format: "group_only",
        engineVersion: "V2",
        isQuickMatch: false,
      }),
    },
    matchDoublesTeam: {
      findMany: async () => input.sources ?? [{ id: "source-team" }],
    },
    matchEntry: {
      findUnique: async () =>
        input.entry === undefined
          ? { id: "entry-1", kind: "DOUBLES", status: "ACTIVE", version: 0 }
          : input.entry,
    },
  } as unknown as PrismaClient;
  const createEntry = (async (
    _db: unknown,
    command: CreateV2EntryInput,
  ) => {
    createInputs.push(command);
    if (input.createError !== undefined) throw input.createError;
    return (
      input.createResult ?? {
        id: "entry-1",
        matchId: "match-1",
        kind: "DOUBLES",
        status: "ACTIVE",
        version: 0,
        rosterVersion: 1,
        created: true,
      }
    );
  }) as typeof createV2Entry;
  const transitionEntryStatus = (async (
    _db: unknown,
    command: TransitionV2EntryStatusInput,
  ) => {
    transitionInputs.push(command);
    if (input.transitionError !== undefined) throw input.transitionError;
    return {
      id: command.entryId,
      status: command.to,
      version: command.expectedVersion + 1,
    };
  }) as typeof transitionV2EntryStatus;
  const dependencies: V2DoubleActionAdapterDependencies = {
    db,
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "partner-1", role: "user" }),
    revalidatePaths: async (paths) => {
      revalidated.push([...paths]);
    },
    logError: async () => undefined,
    createEntry,
    transitionEntryStatus,
  };
  return {
    actions: createV2DoubleActionHandlers(dependencies),
    createInputs,
    transitionInputs,
    revalidated,
  };
}

test("DOUBLE registration derives the source from auth and activates one Entry", async () => {
  const harness = setup();
  assert.deepEqual(await harness.actions.register("match-1", form()), {
    success: "双打小队报名成功。",
  });
  assert.deepEqual(harness.createInputs, [
    {
      actor: { id: "partner-1", role: "user" },
      matchId: "match-1",
      kind: "DOUBLES",
      sourceId: "source-team",
      status: "ACTIVE",
    },
  ]);
  assert.equal(harness.transitionInputs.length, 0);
  assert.deepEqual(harness.revalidated, [
    ["/", "/matchs", "/matchs/match-1", "/team-invites"],
  ]);
});

test("a DRAFT doubles Entry is reactivated with its optimistic version", async () => {
  const harness = setup({
    createResult: {
      id: "entry-draft",
      matchId: "match-1",
      kind: "DOUBLES",
      status: "DRAFT",
      version: 4,
      rosterVersion: 1,
      created: false,
    },
  });
  assert.equal((await harness.actions.register("match-1", form())).error, undefined);
  assert.deepEqual(harness.transitionInputs, [
    {
      actor: { id: "partner-1", role: "user" },
      matchId: "match-1",
      entryId: "entry-draft",
      expectedVersion: 4,
      to: "ACTIVE",
    },
  ]);
});

test("either authenticated partner can cancel the source Entry to DRAFT", async () => {
  const harness = setup({
    entry: { id: "entry-1", kind: "DOUBLES", status: "ACTIVE", version: 7 },
  });
  assert.deepEqual(await harness.actions.cancelRegistration("match-1", form()), {
    success: "双打小队已退出报名。",
  });
  assert.deepEqual(harness.transitionInputs, [
    {
      actor: { id: "partner-1", role: "user" },
      matchId: "match-1",
      entryId: "entry-1",
      expectedVersion: 7,
      to: "DRAFT",
    },
  ]);
});

test("concurrent register/cancel retries converge only after authoritative state read", async () => {
  const conflict = new V2CompetitionApplicationError(
    "CONCURRENT_WRITE_CONFLICT",
    "conflict",
  );
  const register = setup({ createError: conflict });
  assert.equal((await register.actions.register("match-1", form())).error, undefined);

  const cancel = setup({
    entry: { id: "entry-1", kind: "DOUBLES", status: "DRAFT", version: 8 },
  });
  assert.deepEqual(await cancel.actions.cancelRegistration("match-1", form()), {
    success: "双打小队已退出报名。",
  });
  assert.equal(cancel.transitionInputs.length, 0);
});

test("missing/ambiguous sources, wrong match type, and client source IDs fail closed", async () => {
  for (const harness of [
    setup({ sources: [] }),
    setup({ sources: [{ id: "one" }, { id: "two" }] }),
    setup({ matchType: "single" }),
  ]) {
    const result = await harness.actions.register("match-1", form());
    assert.equal(typeof result.error, "string");
    assert.equal(harness.createInputs.length, 0);
  }

  const protectedForm = form();
  protectedForm.set("sourceId", "attacker-source");
  const harness = setup();
  assert.deepEqual(await harness.actions.register("match-1", protectedForm), {
    error: "提交的数据无效，请检查后重试。",
  });
  assert.equal(harness.createInputs.length, 0);
});

function groupingForm() {
  const value = form();
  value.set("groupCount", "1");
  value.set("seedMethod", "snake");
  return value;
}

function activeDoubleEntry(
  suffix: "a" | "b",
  version: number,
  eloBase: number,
) {
  const entryId = `entry-${suffix}`;
  const sourceId = `source-${suffix}`;
  const users = [1, 2].map((slot) => ({
    id: `${suffix}-partner-${slot}`,
    nickname: `${suffix.toUpperCase()} 搭档 ${slot}`,
    points: version * 10 + slot,
    eloRating: eloBase + slot,
    isBanned: false,
    emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
  }));
  return {
    id: entryId,
    version,
    kind: "DOUBLES" as const,
    sourceKey: `doubles:${sourceId}`,
    sourceUserId: null,
    sourceDoublesTeamId: sourceId,
    sourceMatchTeamId: null,
    displayNameSnapshot: `双打 ${suffix.toUpperCase()}`,
    sourceUser: null,
    sourceDoublesTeam: {
      id: sourceId,
      matchId: "match-1",
      members: users.map((user, index) => ({
        userId: user.id,
        slot: index + 1,
        matchId: "match-1",
      })),
    },
    sourceMatchTeam: null,
    members: users.map((user, index) => ({
      id: `${entryId}-member-${index + 1}`,
      userId: user.id,
      role: "player" as const,
      slot: index + 1,
      rosterVersion: 1,
      user,
    })),
  };
}

function doubleGroupingMatch(
  entries = [
    activeDoubleEntry("a", 2, 1_500),
    activeDoubleEntry("b", 4, 1_300),
  ],
  format: "group_only" | "group_then_knockout" = "group_only",
) {
  return {
    id: "match-1",
    createdBy: "manager-1",
    engineVersion: "V2" as const,
    isQuickMatch: false,
    type: "double" as const,
    status: "registration" as const,
    format,
    registrationDeadline: new Date("2026-09-04T08:00:00.000Z"),
    teamRegistrationDeadline: null,
    teamMinMembers: null,
    teamMaxMembers: null,
    entries,
  };
}

const activeGroupingManager = {
  id: "manager-1",
  role: "user" as const,
  isBanned: false,
  emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
};

test("DOUBLE grouping snapshots Entry identity and publishes no client display data", async () => {
  const commands: PublishV2DoubleGroupingCommand[] = [];
  const service: V2DoubleGroupingApplicationService = {
    publish: async (command) => {
      commands.push(command);
      return {
        matchId: command.matchId,
        created: true,
        publishedAt: new Date("2026-09-05T09:00:00.000Z"),
        groupCount: command.draft.groups.length,
        fixtureCount: 1,
      };
    },
  };
  const handlers = createV2DoubleActionHandlers({
    db: {
      match: { findUnique: async () => doubleGroupingMatch() },
      user: { findUnique: async () => activeGroupingManager },
    } as unknown as PrismaClient,
    groupingService: service,
    clock: () => new Date("2026-09-05T09:00:00.000Z"),
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "manager-1", role: "user" }),
  });

  const previewState = await handlers.previewGrouping("match-1", groupingForm());
  assert.equal(previewState.error, undefined);
  if (!previewState.previewJson) assert.fail("DOUBLE preview JSON was not returned");
  const preview = JSON.parse(previewState.previewJson) as {
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
    v2Preview: {
      expectedEntries: Array<{ entryId: string; version: number }>;
    };
  };
  assert.equal(preview.competitorType, "team");
  assert.deepEqual(preview.v2Preview.expectedEntries, [
    { entryId: "entry-a", version: 2 },
    { entryId: "entry-b", version: 4 },
  ]);
  assert.deepEqual(
    preview.groups.flatMap((group) => group.players.map((player) => player.id)),
    ["entry-a", "entry-b"],
  );

  const expectedGroups = preview.groups.map((group) => ({
    entryIds: group.players.map((player) => player.id),
  }));
  for (const group of preview.groups) {
    group.name = "客户端伪造组名";
    group.averagePoints = 999_999;
    for (const player of group.players) {
      player.nickname = "客户端伪造小队名";
      player.points = -1;
      player.eloRating = 999_999;
    }
  }
  const publishForm = form();
  publishForm.set("previewJson", JSON.stringify(preview));
  assert.deepEqual(await handlers.publishGrouping("match-1", publishForm), {
    success: "双打分组结果已确认并发布。",
  });
  assert.deepEqual(commands, [
    {
      actor: { id: "manager-1", role: "user" },
      matchId: "match-1",
      expectedEntries: [
        { entryId: "entry-a", version: 2 },
        { entryId: "entry-b", version: 4 },
      ],
      draft: {
        format: "group_only",
        groups: expectedGroups,
        seedMethod: "snake",
      },
    },
  ]);
  assert.equal(JSON.stringify(commands[0]).includes("客户端伪造"), false);
});

test("DOUBLE grouping actions accept a server-revalidated group-then-knockout preview", async () => {
  const commands: PublishV2DoubleGroupingCommand[] = [];
  const handlers = createV2DoubleActionHandlers({
    db: {
      match: {
        findUnique: async () =>
          doubleGroupingMatch(undefined, "group_then_knockout"),
      },
      user: { findUnique: async () => activeGroupingManager },
    } as unknown as PrismaClient,
    groupingService: {
      publish: async (command) => {
        commands.push(command);
        return {
          matchId: command.matchId,
          created: true,
          publishedAt: new Date("2026-09-05T09:00:00.000Z"),
          groupCount: 1,
          fixtureCount: 1,
        };
      },
    },
    clock: () => new Date("2026-09-05T09:00:00.000Z"),
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "manager-1", role: "user" }),
  });
  const previewForm = groupingForm();
  previewForm.set("qualifiersPerGroup", "2");
  const previewState = await handlers.previewGrouping("match-1", previewForm);
  if (!previewState.previewJson) {
    assert.fail(`DOUBLE knockout preview failed: ${previewState.error}`);
  }
  const preview = JSON.parse(previewState.previewJson) as {
    format: string;
    config: { qualifiersPerGroup?: number };
  };
  assert.equal(preview.format, "group_then_knockout");
  assert.equal(preview.config.qualifiersPerGroup, 2);
  const publishForm = form();
  publishForm.set("previewJson", previewState.previewJson);
  assert.equal(
    (await handlers.publishGrouping("match-1", publishForm)).error,
    undefined,
  );
  assert.equal(commands[0].draft.format, "group_then_knockout");
  assert.equal(commands[0].draft.qualifiersPerGroup, 2);
});

test("DOUBLE grouping preview fails closed on cross-match source members", async () => {
  const entries = [
    activeDoubleEntry("a", 2, 1_500),
    activeDoubleEntry("b", 4, 1_300),
  ];
  entries[0].sourceDoublesTeam.members[0].matchId = "another-match";
  let publishCalls = 0;
  const handlers = createV2DoubleActionHandlers({
    db: {
      match: { findUnique: async () => doubleGroupingMatch(entries) },
      user: { findUnique: async () => activeGroupingManager },
    } as unknown as PrismaClient,
    groupingService: {
      publish: async () => {
        publishCalls += 1;
        throw new Error("publication must not run");
      },
    },
    clock: () => new Date("2026-09-05T09:00:00.000Z"),
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "manager-1", role: "user" }),
    logError: async () => undefined,
  });

  const result = await handlers.previewGrouping("match-1", groupingForm());
  assert.equal(typeof result.error, "string");
  assert.equal(result.previewJson, undefined);
  assert.equal(publishCalls, 0);
});

function resultTarget(version = 5) {
  const value = form();
  value.set("fixtureId", "fixture-1");
  value.set("expectedFixtureVersion", String(version));
  return value;
}

test("DOUBLE result actions share strict GROUP commands and derive the forfeit loser", async () => {
  const commands: Array<{ operation: string; command: Record<string, unknown> }> = [];
  const record = (operation: string) => async (command: unknown) => {
    commands.push({ operation, command: command as Record<string, unknown> });
    return {} as never;
  };
  const resultService = {
    submitRevision: record("submit"),
    submitCorrection: record("correction"),
    confirmRevision: record("confirm"),
    rejectRevision: record("reject"),
    voidRevision: record("void"),
    confirmForfeit: record("forfeit"),
    correctForfeit: record("forfeit-correction"),
  } as V2ResultApplicationService;
  const handlers = createV2DoubleActionHandlers({
    db: {
      match: {
        findUnique: async () => ({
          type: "double",
          format: "group_only",
          engineVersion: "V2",
          isQuickMatch: false,
        }),
      },
      matchFixture: {
        findFirst: async () => ({
          sideAEntryId: "entry-a",
          sideBEntryId: "entry-b",
        }),
      },
    } as unknown as PrismaClient,
    resultService,
    fixtureStatusTransition: async (_db, command) => {
      commands.push({
        operation: "unplayed-void",
        command: command as unknown as Record<string, unknown>,
      });
      return {} as never;
    },
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "manager-1", role: "admin" }),
    logError: async () => undefined,
  });

  const submission = resultTarget();
  submission.set("winnerEntryId", "entry-a");
  submission.set("bestOf", "7");
  submission.set("winnerScore", "4");
  submission.set("loserScore", "2");
  assert.equal((await handlers.submitResult("match-1", submission)).error, undefined);

  const correction = resultTarget(6);
  correction.set("resultRevisionId", "revision-confirmed");
  correction.set("correctionMode", "KEEP_WINNER");
  correction.set("bestOf", "3");
  correction.set("winnerScore", "2");
  correction.set("loserScore", "1");
  assert.equal((await handlers.submitCorrection("match-1", correction)).error, undefined);

  for (const [operation, handler] of [
    ["confirm", handlers.confirmResult],
    ["reject", handlers.rejectResult],
    ["void", handlers.voidResult],
  ] as const) {
    const target = resultTarget(7);
    target.set("resultRevisionId", `revision-${operation}`);
    assert.equal((await handler("match-1", target)).error, undefined);
  }
  assert.equal(
    (await handlers.voidUnplayedFixture("match-1", resultTarget(8))).error,
    undefined,
  );
  const forfeit = resultTarget(9);
  forfeit.set("winnerEntryId", "entry-a");
  forfeit.set("reason", "对方弃权");
  assert.equal((await handlers.confirmForfeit("match-1", forfeit)).error, undefined);
  const forfeitCorrection = resultTarget(10);
  forfeitCorrection.set("resultRevisionId", "revision-forfeit");
  forfeitCorrection.set("reason", "胜方登记错误");
  assert.equal(
    (await handlers.correctForfeit("match-1", forfeitCorrection)).error,
    undefined,
  );

  assert.equal(commands.length, 8);
  assert.equal(
    commands.every(({ command }) => command.requiredFixtureStage === "GROUP"),
    true,
  );
  assert.equal(commands[1]?.command.correctionMode, "KEEP_WINNER");
  assert.deepEqual(commands.at(-1), {
    operation: "forfeit-correction",
    command: {
      actor: { actorId: "manager-1", role: "admin" },
      matchId: "match-1",
      fixtureId: "fixture-1",
      expectedFixtureVersion: 10,
      requiredFixtureStage: "GROUP",
      resultRevisionId: "revision-forfeit",
      reason: "胜方登记错误",
    },
  });

  const forged = resultTarget(9);
  forged.set("winnerEntryId", "entry-a");
  forged.set("loserEntryId", "attacker-selected-loser");
  forged.set("reason", "伪造负方");
  assert.deepEqual(await handlers.confirmForfeit("match-1", forged), {
    error: "提交的数据无效，请检查后重试。",
  });
  assert.equal(commands.length, 8);
});
