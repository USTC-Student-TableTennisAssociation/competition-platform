import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import { createV2SingleActionHandlers } from "../adapters/single-actions";
import type { V2ResultApplicationService } from "./results";
import type {
  PublishV2SingleGroupingCommand,
  V2SingleGroupingApplicationService,
} from "./grouping";
import type {
  UpdateV2SingleGroupTableLabelsCommand,
  V2SingleGroupTableLabelsApplicationService,
} from "./group-table-labels";

function csrfForm() {
  const formData = new FormData();
  formData.set("csrfToken", "valid-token");
  return formData;
}

function groupingPreviewForm() {
  const formData = csrfForm();
  formData.set("groupCount", "2");
  formData.set("seedMethod", "snake");
  return formData;
}

function activeSingleEntry(
  entryId: string,
  userId: string,
  version: number,
  eloRating: number,
) {
  return {
    id: entryId,
    version,
    kind: "INDIVIDUAL" as const,
    sourceKey: `individual:${userId}`,
    sourceUserId: userId,
    sourceDoublesTeamId: null,
    sourceMatchTeamId: null,
    sourceDoublesTeam: null,
    sourceMatchTeam: null,
    displayNameSnapshot: `权威昵称 ${userId}`,
    sourceUser: {
      id: userId,
      nickname: `权威昵称 ${userId}`,
      points: version * 10,
      eloRating,
      isBanned: false,
      emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
    },
    members: [
      {
        userId,
        role: "player" as const,
        slot: 1,
        rosterVersion: 1,
        user: {
          id: userId,
          nickname: `权威昵称 ${userId}`,
          points: version * 10,
          eloRating,
          isBanned: false,
          emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
        },
      },
    ],
  };
}

const activeEntries = [
  activeSingleEntry("entry-a", "participant-a", 2, 1_600),
  activeSingleEntry("entry-b", "participant-b", 4, 1_500),
  activeSingleEntry("entry-c", "participant-c", 6, 1_400),
  activeSingleEntry("entry-d", "participant-d", 8, 1_300),
];

function singleGroupingMatch(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    id: "match-1",
    createdBy: "manager-1",
    engineVersion: "V2" as const,
    isQuickMatch: false,
    type: "single" as const,
    status: "registration" as const,
    format: "group_only" as const,
    registrationDeadline: new Date("2026-09-04T08:00:00.000Z"),
    entries: activeEntries,
    ...overrides,
  };
}

const activeManager = {
  id: "manager-1",
  role: "user" as const,
  isBanned: false,
  emailVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
};

type TestGroupingPreview = {
  format: "group_only" | "group_then_knockout";
  config: {
    groupCount: number;
    seedMethod: "min_diff" | "snake";
    qualifiersPerGroup?: number;
  };
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
    schemaVersion: number;
    matchId: string;
    expectedEntries: Array<{ entryId: string; version: number }>;
  };
};

test("the dark adapter rejects ambiguous CSRF before auth or database work", async () => {
  let csrfCalls = 0;
  let authCalls = 0;
  const handlers = createV2SingleActionHandlers({
    db: {} as PrismaClient,
    validateCsrfToken: async () => {
      csrfCalls += 1;
      return null;
    },
    getCurrentUser: async () => {
      authCalls += 1;
      return { id: "user-1", role: "user" };
    },
  });
  const formData = csrfForm();
  formData.append("csrfToken", "duplicate-token");

  assert.deepEqual(await handlers.register("match-1", formData), {
    error: "安全校验失败，请刷新页面后重试。",
  });
  assert.equal(csrfCalls, 0);
  assert.equal(authCalls, 0);
});

test("the dark adapter validates CSRF before rejecting protected command fields", async () => {
  const calls: string[] = [];
  const handlers = createV2SingleActionHandlers({
    db: {} as PrismaClient,
    validateCsrfToken: async () => {
      calls.push("csrf");
      return null;
    },
    getCurrentUser: async () => {
      calls.push("auth");
      return { id: "user-1", role: "user" };
    },
  });
  const formData = csrfForm();
  formData.set("adminOverride", "true");

  assert.deepEqual(await handlers.register("match-1", formData), {
    error: "提交的数据无效，请检查后重试。",
  });
  assert.deepEqual(calls, ["csrf"]);
});

test("the dark adapter never reaches the database for an unauthenticated request", async () => {
  const handlers = createV2SingleActionHandlers({
    db: new Proxy(
      {},
      {
        get() {
          throw new Error("database must not be reached");
        },
      },
    ) as PrismaClient,
    validateCsrfToken: async () => null,
    getCurrentUser: async () => null,
  });

  assert.deepEqual(await handlers.register("match-1", csrfForm()), {
    error: "请先登录。",
  });
});

test("the SINGLE adapter rejects other match types before an application write", async () => {
  let transactionRead = false;
  const db = {
    match: {
      findUnique: async () => ({
        type: "double",
        engineVersion: "V2",
        isQuickMatch: false,
      }),
    },
    $transaction: async () => {
      transactionRead = true;
      throw new Error("must not enter a V2 write transaction");
    },
  } as unknown as PrismaClient;
  const handlers = createV2SingleActionHandlers({
    db,
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "user-1", role: "user" }),
  });

  assert.deepEqual(await handlers.register("match-1", csrfForm()), {
    error: "当前状态不允许执行此操作，请刷新页面后重试。",
  });
  assert.equal(transactionRead, false);
});

test("the SINGLE adapter rejects legacy and quick matches before a draft cancellation no-op", async () => {
  for (const match of [
    { type: "single", engineVersion: "LEGACY", isQuickMatch: false },
    { type: "single", engineVersion: "V2", isQuickMatch: true },
  ] as const) {
    let entryRead = false;
    const db = {
      match: { findUnique: async () => match },
      matchEntry: {
        findUnique: async () => {
          entryRead = true;
          return {
            id: "entry-1",
            kind: "INDIVIDUAL",
            status: "DRAFT",
            version: 0,
          };
        },
      },
    } as unknown as PrismaClient;
    const handlers = createV2SingleActionHandlers({
      db,
      validateCsrfToken: async () => null,
      getCurrentUser: async () => ({ id: "user-1", role: "user" }),
    });

    assert.deepEqual(
      await handlers.cancelRegistration("match-1", csrfForm()),
      { error: "当前状态不允许执行此操作，请刷新页面后重试。" },
    );
    assert.equal(entryRead, false);
  }
});

test("a V2 draft cancellation refreshes home, list, and detail registration state", async () => {
  const revalidated: string[][] = [];
  const handlers = createV2SingleActionHandlers({
    db: {
      match: {
        findUnique: async () => ({
          type: "single",
          format: "group_only",
          engineVersion: "V2",
          isQuickMatch: false,
        }),
      },
      matchEntry: {
        findUnique: async () => ({
          id: "entry-1",
          kind: "INDIVIDUAL",
          status: "DRAFT",
          version: 2,
        }),
      },
    } as unknown as PrismaClient,
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "user-1", role: "user" }),
    revalidatePaths: async (paths) => {
      revalidated.push([...paths]);
    },
  });

  assert.deepEqual(
    await handlers.cancelRegistration("match-1", csrfForm()),
    { success: "已退出报名。" },
  );
  assert.deepEqual(revalidated, [
    ["/", "/matchs", "/matchs/match-1"],
  ]);
});

test("the SINGLE registration boundary supports group-then-knockout without a Legacy fallback", async () => {
  let entryRead = false;
  const handlers = createV2SingleActionHandlers({
    db: {
      match: {
        findUnique: async () => ({
          type: "single",
          format: "group_then_knockout",
          engineVersion: "V2",
          isQuickMatch: false,
        }),
      },
      matchEntry: {
        findUnique: async () => {
          entryRead = true;
          return {
            id: "entry-1",
            kind: "INDIVIDUAL",
            status: "DRAFT",
            version: 2,
          };
        },
      },
    } as unknown as PrismaClient,
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "user-1", role: "user" }),
  });

  assert.deepEqual(
    await handlers.cancelRegistration("match-1", csrfForm()),
    { success: "已退出报名。" },
  );
  assert.equal(entryRead, true);
});

test("a failing injected logger cannot escape the safe action boundary", async (context) => {
  context.mock.method(console, "error", () => {});
  let logCalls = 0;
  const handlers = createV2SingleActionHandlers({
    db: {} as PrismaClient,
    validateCsrfToken: async () => null,
    getCurrentUser: async () => {
      throw new Error("authentication backend failed");
    },
    logError: async () => {
      logCalls += 1;
      throw new Error("logger failed");
    },
  });

  assert.deepEqual(await handlers.register("match-1", csrfForm()), {
    error: "操作失败，请稍后重试。",
  });
  assert.equal(logCalls, 1);
});

test("SINGLE grouping preview snapshots Entry versions and publication forwards no display data", async () => {
  const commands: PublishV2SingleGroupingCommand[] = [];
  const revalidated: string[][] = [];
  const groupingService: V2SingleGroupingApplicationService = {
    publish: async (command) => {
      commands.push(command);
      return {
        matchId: command.matchId,
        created: true,
        publishedAt: new Date("2026-09-04T09:00:00.000Z"),
        groupCount: command.draft.groups.length,
        fixtureCount: 2,
      };
    },
  };
  const db = {
    match: { findUnique: async () => singleGroupingMatch() },
    user: { findUnique: async () => activeManager },
  } as unknown as PrismaClient;
  const handlers = createV2SingleActionHandlers({
    db,
    groupingService,
    clock: () => new Date("2026-09-04T09:00:00.000Z"),
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "manager-1", role: "user" }),
    revalidatePaths: async (paths) => {
      revalidated.push([...paths]);
    },
  });

  const previewState = await handlers.previewGrouping(
    "match-1",
    groupingPreviewForm(),
  );
  assert.equal(previewState.error, undefined);
  assert.equal(typeof previewState.previewJson, "string");
  if (!previewState.previewJson) assert.fail("preview JSON was not returned");
  const preview = JSON.parse(previewState.previewJson) as TestGroupingPreview;

  assert.equal(preview.format, "group_only");
  assert.deepEqual(preview.v2Preview, {
    schemaVersion: 1,
    matchId: "match-1",
    expectedEntries: [
      { entryId: "entry-a", version: 2 },
      { entryId: "entry-b", version: 4 },
      { entryId: "entry-c", version: 6 },
      { entryId: "entry-d", version: 8 },
    ],
  });
  assert.deepEqual(
    preview.groups.flatMap((group) => group.players.map((player) => player.id)).sort(),
    ["entry-a", "entry-b", "entry-c", "entry-d"],
  );
  assert.equal(
    preview.groups.some((group) =>
      group.players.some((player) => player.id.startsWith("participant-")),
    ),
    false,
  );

  const expectedGroups = preview.groups.map((group) => ({
    entryIds: group.players.map((player) => player.id),
  }));
  for (const [groupIndex, group] of preview.groups.entries()) {
    group.name = `客户端伪造组名 ${groupIndex}`;
    group.averagePoints = 999_999;
    for (const player of group.players) {
      player.nickname = "客户端伪造昵称";
      player.points = -999;
      player.eloRating = 999_999;
    }
  }
  const publishForm = csrfForm();
  publishForm.set("previewJson", JSON.stringify(preview));

  assert.deepEqual(await handlers.publishGrouping("match-1", publishForm), {
    success: "分组结果已确认并发布。",
  });
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0], {
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
      groups: expectedGroups,
      seedMethod: "snake",
    },
  });
  assert.equal(JSON.stringify(commands[0]).includes("客户端伪造"), false);
  assert.deepEqual(revalidated, [["/", "/matchs", "/matchs/match-1"]]);
});

test("SINGLE grouping preview rechecks manager authority and registration deadline", async () => {
  const scenarios = [
    {
      name: "non-manager",
      match: singleGroupingMatch({ createdBy: "another-manager" }),
      expectedError: "你没有权限执行此操作。",
    },
    {
      name: "registration still open",
      match: singleGroupingMatch({
        registrationDeadline: new Date("2026-09-04T10:00:00.000Z"),
      }),
      expectedError: "当前状态不允许执行此操作，请刷新页面后重试。",
    },
  ] as const;

  for (const scenario of scenarios) {
    const handlers = createV2SingleActionHandlers({
      db: {
        match: { findUnique: async () => scenario.match },
        user: { findUnique: async () => activeManager },
      } as unknown as PrismaClient,
      clock: () => new Date("2026-09-04T09:00:00.000Z"),
      validateCsrfToken: async () => null,
      getCurrentUser: async () => ({ id: "manager-1", role: "user" }),
    });

    assert.deepEqual(
      await handlers.previewGrouping("match-1", groupingPreviewForm()),
      { error: scenario.expectedError },
      scenario.name,
    );
  }
});

test("SINGLE group-then-knockout preview and publication forward only relational group input", async () => {
  const commands: PublishV2SingleGroupingCommand[] = [];
  const handlers = createV2SingleActionHandlers({
    db: {
      match: {
        findUnique: async () =>
          singleGroupingMatch({ format: "group_then_knockout" }),
      },
      user: { findUnique: async () => activeManager },
    } as unknown as PrismaClient,
    groupingService: {
      publish: async (command) => {
        commands.push(command);
        return {
          matchId: command.matchId,
          created: true,
          publishedAt: new Date("2026-09-04T09:00:00.000Z"),
          groupCount: command.draft.groups.length,
          fixtureCount: 2,
        };
      },
    },
    clock: () => new Date("2026-09-04T09:00:00.000Z"),
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "manager-1", role: "user" }),
  });
  const formData = groupingPreviewForm();
  formData.set("qualifiersPerGroup", "1");

  const previewState = await handlers.previewGrouping("match-1", formData);
  assert.equal(previewState.error, undefined);
  if (!previewState.previewJson) assert.fail("preview JSON was not returned");
  const preview = JSON.parse(previewState.previewJson) as TestGroupingPreview;
  assert.equal(preview.format, "group_then_knockout");
  assert.equal(preview.config.qualifiersPerGroup, 1);
  const publishForm = csrfForm();
  publishForm.set("previewJson", previewState.previewJson);
  assert.deepEqual(await handlers.publishGrouping("match-1", publishForm), {
    success: "分组结果已确认并发布。",
  });
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].draft, {
    format: "group_then_knockout",
    qualifiersPerGroup: 1,
    seedMethod: "snake",
    groups: preview.groups.map((group) => ({
      entryIds: group.players.map((player) => player.id),
    })),
  });
});

test("SINGLE table-label action forwards only stable group, fixture versions, labels, and server actor", async () => {
  const commands: UpdateV2SingleGroupTableLabelsCommand[] = [];
  const revalidated: string[][] = [];
  const service: V2SingleGroupTableLabelsApplicationService = {
    update: async (command) => {
      commands.push(command);
      return {
        matchId: command.matchId,
        groupKey: command.groupKey,
        groupName: "第 1 组",
        labels: command.labels,
        changed: true,
        fixtures: command.expectedFixtures.map((fixture) => ({
          fixtureId: fixture.fixtureId,
          version: fixture.version + 1,
        })),
      };
    },
  };
  const handlers = createV2SingleActionHandlers({
    db: {} as PrismaClient,
    groupTableLabelsService: service,
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "manager-1", role: "admin" }),
    revalidatePaths: async (paths) => {
      revalidated.push([...paths]);
    },
  });
  const formData = csrfForm();
  formData.set("groupKey", "group:0001");
  formData.set(
    "expectedFixturesJson",
    JSON.stringify([
      { fixtureId: "fixture-1", version: 4 },
      { fixtureId: "fixture-2", version: 7 },
    ]),
  );
  formData.set("labelsJson", JSON.stringify(["1 号台", "西区馆 A"]));

  assert.deepEqual(
    await handlers.updateGroupTableLabels("match-1", formData),
    { success: "第 1 组桌号已更新。" },
  );
  assert.deepEqual(commands, [
    {
      actor: { id: "manager-1", role: "admin" },
      matchId: "match-1",
      groupKey: "group:0001",
      expectedFixtures: [
        { fixtureId: "fixture-1", version: 4 },
        { fixtureId: "fixture-2", version: 7 },
      ],
      labels: ["1 号台", "西区馆 A"],
    },
  ]);
  assert.deepEqual(revalidated, [
    ["/matchs/match-1", "/matchs/match-1/grouping"],
  ]);

  const forged = csrfForm();
  for (const [field, value] of formData.entries()) forged.set(field, value);
  forged.set("groupName", "客户端伪造组名");
  assert.deepEqual(
    await handlers.updateGroupTableLabels("match-1", forged),
    { error: "提交的数据无效，请检查后重试。" },
  );
  assert.equal(commands.length, 1);
});

test("SINGLE result actions enforce GROUP in the locked core command and refresh affected pages", async () => {
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
  const revalidated: string[][] = [];
  const handlers = createV2SingleActionHandlers({
    db: {
      match: {
        findUnique: async () => ({
          type: "single",
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
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "manager-1", role: "admin" }),
    revalidatePaths: async (paths) => {
      revalidated.push([...paths]);
    },
  });

  const submission = csrfForm();
  submission.set("fixtureId", "fixture-1");
  submission.set("expectedFixtureVersion", "5");
  submission.set("winnerEntryId", "entry-a");
  submission.set("bestOf", "5");
  submission.set("winnerScore", "3");
  submission.set("loserScore", "1");
  assert.deepEqual(await handlers.submitResult("match-1", submission), {
    success: "已登记，等待对手或管理员确认。",
  });

  const correction = csrfForm();
  correction.set("fixtureId", "fixture-1");
  correction.set("expectedFixtureVersion", "6");
  correction.set("resultRevisionId", "revision-confirmed");
  correction.set("correctionMode", "KEEP_WINNER");
  correction.set("bestOf", "7");
  correction.set("winnerScore", "4");
  correction.set("loserScore", "2");
  assert.deepEqual(await handlers.submitCorrection("match-1", correction), {
    success: "已提交胜负更正，原赛果在确认前继续生效。",
  });

  for (const [operation, handler] of [
    ["confirm", handlers.confirmResult],
    ["reject", handlers.rejectResult],
    ["void", handlers.voidResult],
  ] as const) {
    const target = csrfForm();
    target.set("fixtureId", "fixture-1");
    target.set("expectedFixtureVersion", "7");
    target.set("resultRevisionId", `revision-${operation}`);
    await handler("match-1", target);
  }

  const forfeit = csrfForm();
  forfeit.set("fixtureId", "fixture-2");
  forfeit.set("expectedFixtureVersion", "3");
  forfeit.set("winnerEntryId", "entry-a");
  forfeit.set("reason", "对方弃权");
  await handlers.confirmForfeit("match-1", forfeit);
  const forfeitCorrection = csrfForm();
  forfeitCorrection.set("fixtureId", "fixture-2");
  forfeitCorrection.set("expectedFixtureVersion", "4");
  forfeitCorrection.set("resultRevisionId", "revision-forfeit");
  forfeitCorrection.set("reason", "胜方登记错误");
  await handlers.correctForfeit("match-1", forfeitCorrection);

  assert.deepEqual(
    commands.map(({ operation, command }) => ({
      operation,
      stage: command.requiredFixtureStage,
    })),
    [
      "submit",
      "correction",
      "confirm",
      "reject",
      "void",
      "forfeit",
      "forfeit-correction",
    ].map(
      (operation) => ({ operation, stage: "GROUP" }),
    ),
  );
  assert.deepEqual(commands[1]?.command, {
    actor: { actorId: "manager-1", role: "admin" },
    matchId: "match-1",
    fixtureId: "fixture-1",
    expectedFixtureVersion: 6,
    requiredFixtureStage: "GROUP",
    resultRevisionId: "revision-confirmed",
    correctionMode: "KEEP_WINNER",
    score: {
      bestOf: 7,
      winnerScore: 4,
      loserScore: 2,
      text: "4:2（7局4胜）",
    },
  });
  assert.equal("winnerEntryId" in (commands[1]?.command ?? {}), false);
  assert.equal("loserEntryId" in (commands[1]?.command ?? {}), false);
  assert.equal("supersedesRevisionId" in (commands[1]?.command ?? {}), false);
  assert.equal(commands[5]?.command.loserEntryId, "entry-b");
  assert.deepEqual(commands[6]?.command, {
    actor: { actorId: "manager-1", role: "admin" },
    matchId: "match-1",
    fixtureId: "fixture-2",
    expectedFixtureVersion: 4,
    requiredFixtureStage: "GROUP",
    resultRevisionId: "revision-forfeit",
    reason: "胜方登记错误",
  });
  assert.equal("winnerEntryId" in (commands[6]?.command ?? {}), false);
  assert.equal("loserEntryId" in (commands[6]?.command ?? {}), false);
  assert.deepEqual(revalidated, [
    ["/matchs/match-1"],
    ["/matchs/match-1"],
    ["/", "/matchs", "/matchs/match-1", "/rankings", "/profile"],
    ["/matchs/match-1"],
    ["/", "/matchs", "/matchs/match-1", "/rankings", "/profile"],
    ["/", "/matchs", "/matchs/match-1", "/rankings", "/profile"],
    ["/", "/matchs", "/matchs/match-1", "/rankings", "/profile"],
  ]);
});

test("unplayed-fixture voiding forwards only an optimistic GROUP target fixed by the server", async () => {
  const commands: Array<Record<string, unknown>> = [];
  const revalidated: string[][] = [];
  const handlers = createV2SingleActionHandlers({
    db: {
      match: {
        findUnique: async () => ({
          type: "single",
          format: "group_only",
          engineVersion: "V2",
          isQuickMatch: false,
        }),
      },
    } as unknown as PrismaClient,
    fixtureStatusTransition: async (_db, command) => {
      commands.push(command as unknown as Record<string, unknown>);
      return {
        id: command.fixtureId,
        status: "VOIDED" as const,
        version: command.expectedVersion + 1,
      };
    },
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "manager-1", role: "admin" }),
    revalidatePaths: async (paths) => {
      revalidated.push([...paths]);
    },
  });
  const formData = csrfForm();
  formData.set("fixtureId", "fixture-1");
  formData.set("expectedFixtureVersion", "12");

  assert.deepEqual(
    await handlers.voidUnplayedFixture("match-1", formData),
    { success: "未赛对局已作废。" },
  );
  assert.deepEqual(commands, [
    {
      actor: { id: "manager-1", role: "admin" },
      matchId: "match-1",
      fixtureId: "fixture-1",
      expectedVersion: 12,
      to: "VOIDED",
      requiredFixtureStage: "GROUP",
    },
  ]);
  assert.deepEqual(revalidated, [["/", "/matchs", "/matchs/match-1"]]);

  const forged = csrfForm();
  forged.set("fixtureId", "fixture-1");
  forged.set("expectedFixtureVersion", "12");
  forged.set("to", "READY");
  assert.deepEqual(
    await handlers.voidUnplayedFixture("match-1", forged),
    { error: "提交的数据无效，请检查后重试。" },
  );

  const malformedVersion = csrfForm();
  malformedVersion.set("fixtureId", "fixture-1");
  malformedVersion.set("expectedFixtureVersion", "012");
  assert.deepEqual(
    await handlers.voidUnplayedFixture("match-1", malformedVersion),
    { error: "提交的数据无效，请检查后重试。" },
  );
  assert.equal(commands.length, 1);
});
