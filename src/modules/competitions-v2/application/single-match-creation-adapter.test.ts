import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import {
  V2_SINGLE_MATCH_CREATION_CLOSED_MESSAGE,
  createV2SingleMatchCreationHandler,
  resolveExistingV2SingleMatchCreationHandler,
  type V2SingleMatchCreationAdapterDependencies,
} from "../adapters/single-match-creation";
import {
  V2CompetitionApplicationError,
} from "./entries";
import type {
  CreateV2SingleMatchCommand,
  V2SingleMatchApplicationService,
} from "./matches";

const DEFAULT_FIELDS = {
  csrfToken: "valid-token",
  creationRequestKey: "3d594650-3436-4a7f-bd48-9d700f17db33",
  title: "  秋季单打积分赛  ",
  description: "  仅进行小组循环。  ",
  location: " 西区乒乓球馆 ",
  timezoneOffset: "-480",
  matchDateTime: "2026-10-01T19:00",
  date: "2026-10-01",
  time: "19:00",
  registrationDeadline: "2026-09-30T17:00",
  deadlineDate: "2026-09-30",
  deadlineTime: "17:00",
  type: "single",
  format: "group_only",
      groupBestOf: "5", knockoutBestOf: "5",
  teamRegistrationStart: "",
  teamRegistrationDeadline: "",
} as const;

function creationForm(
  overrides: Readonly<Record<string, string | Blob | null>> = {},
) {
  const formData = new FormData();
  const fields: Record<string, string | Blob | null> = {
    ...DEFAULT_FIELDS,
    ...overrides,
  };
  for (const [field, value] of Object.entries(fields)) {
    if (value === null) continue;
    if (typeof value === "string") formData.set(field, value);
    else formData.set(field, value, "value.txt");
  }
  return formData;
}

function createdMatch(command: CreateV2SingleMatchCommand) {
  return {
    id: "created-match-v2",
    created: true,
    title: command.title,
    description: command.description,
    location: command.location,
    dateTime: command.dateTime,
    registrationDeadline: command.registrationDeadline,
    type: command.type,
    format: command.format,
    status: "registration" as const,
    engineVersion: "V2" as const,
    isQuickMatch: false as const,
    maxParticipants: 2_147_483_647,
    createdBy: command.actor.id,
  };
}

function handlerWith(input: Readonly<{
  commands?: CreateV2SingleMatchCommand[];
  serviceError?: unknown;
  calls?: string[];
  authenticated?: boolean;
  csrfError?: string | null;
  logErrors?: unknown[];
  resolveExisting?: boolean;
}> = {}) {
  const service: V2SingleMatchApplicationService = {
    create: async (command) => {
      input.calls?.push("service");
      input.commands?.push(command);
      if (input.serviceError !== undefined) throw input.serviceError;
      return createdMatch(command);
    },
    resolveExisting: async (command) => {
      input.calls?.push("resolve-existing");
      input.commands?.push(command);
      if (input.serviceError !== undefined) throw input.serviceError;
      if (input.resolveExisting === false) return null;
      return { ...createdMatch(command), created: false };
    },
  };
  const dependencies: V2SingleMatchCreationAdapterDependencies = {
    db: {} as Pick<PrismaClient, "$transaction">,
    creationService: service,
    validateCsrfToken: async () => {
      input.calls?.push("csrf");
      return input.csrfError ?? null;
    },
    getCurrentUser: async () => {
      input.calls?.push("auth");
      return input.authenticated === false
        ? null
        : { id: "creator-1", role: "user" };
    },
    logError: async (_message, error) => {
      input.logErrors?.push(error);
    },
  };
  return {
    create: createV2SingleMatchCreationHandler(dependencies),
    resolveExisting:
      resolveExistingV2SingleMatchCreationHandler(dependencies),
  };
}

test("the dark creation adapter builds only the normalized V2 SINGLE command", async () => {
  const commands: CreateV2SingleMatchCommand[] = [];
  const calls: string[] = [];
  const handler = handlerWith({ commands, calls }).create;

  assert.deepEqual(await handler(creationForm()), {
    success: "比赛创建成功。",
    createdMatchId: "created-match-v2",
  });
  assert.deepEqual(calls, ["csrf", "auth", "service"]);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0], {
    actor: { id: "creator-1", role: "user" },
    requestKey: "3d594650-3436-4a7f-bd48-9d700f17db33",
    title: "秋季单打积分赛",
    description: "仅进行小组循环。",
    location: "西区乒乓球馆",
    dateTime: new Date("2026-10-01T11:00:00.000Z"),
    registrationDeadline: new Date("2026-09-30T09:00:00.000Z"),
    type: "single",
    format: "group_only",
      groupBestOf: 5, knockoutBestOf: 5,
  });
  assert.deepEqual(Object.keys(commands[0]).sort(), [
    "actor",
    "dateTime",
    "description",
    "format",
    "groupBestOf",
    "knockoutBestOf",
    "location",
    "registrationDeadline",
    "requestKey",
    "title",
    "type",
  ]);
});

test("the disabled-flag boundary resolves only an existing durable request", async () => {
  const commands: CreateV2SingleMatchCommand[] = [];
  const calls: string[] = [];
  const existing = handlerWith({ commands, calls }).resolveExisting;

  assert.deepEqual(await existing(creationForm()), {
    success: "比赛创建成功。",
    createdMatchId: "created-match-v2",
  });
  assert.deepEqual(calls, ["csrf", "auth", "resolve-existing"]);
  assert.equal(commands.length, 1);

  const missingCalls: string[] = [];
  const missing = handlerWith({
    calls: missingCalls,
    resolveExisting: false,
  }).resolveExisting;
  assert.deepEqual(await missing(creationForm()), {
    error: V2_SINGLE_MATCH_CREATION_CLOSED_MESSAGE,
  });
  assert.deepEqual(missingCalls, ["csrf", "auth", "resolve-existing"]);
});

test("V2 uses Beijing time regardless of the Legacy form's browser-offset compatibility field", async () => {
  const scenarios = [
    {
      fields: {
        timezoneOffset: "-480",
        matchDateTime: "",
        registrationDeadline: "",
      },
      dateTime: "2026-10-01T11:00:00.000Z",
      deadline: "2026-09-30T09:00:00.000Z",
    },
    {
      fields: {
        timezoneOffset: "300",
        matchDateTime: "2026-10-01T19:00",
        date: null,
        time: null,
        registrationDeadline: "2026-09-30T17:00",
        deadlineDate: null,
        deadlineTime: null,
      },
      dateTime: "2026-10-01T11:00:00.000Z",
      deadline: "2026-09-30T09:00:00.000Z",
    },
  ] as const;

  for (const scenario of scenarios) {
    const commands: CreateV2SingleMatchCommand[] = [];
    const handler = handlerWith({ commands }).create;
    assert.equal((await handler(creationForm(scenario.fields))).error, undefined);
    assert.equal(commands[0].dateTime.toISOString(), scenario.dateTime);
    assert.equal(
      commands[0].registrationDeadline.toISOString(),
      scenario.deadline,
    );
  }
});

test("invalid, impossible, contradictory, or unordered local times never reach the service", async () => {
  const invalidCases: ReadonlyArray<Readonly<Record<string, string | null>>> = [
    { matchDateTime: "2026-10-01T19:30" },
    {
      matchDateTime: "2026-02-30T19:00",
      date: "2026-02-30",
      time: "19:00",
    },
    { timezoneOffset: "-0480" },
    { timezoneOffset: "841" },
    { timezoneOffset: "" },
    {
      registrationDeadline: "2026-10-01T19:00",
      deadlineDate: "2026-10-01",
      deadlineTime: "19:00",
    },
    { date: "2026-10-01", time: "" },
    { time: "19:00:00", matchDateTime: "2026-10-01T19:00:00" },
  ];

  for (const fields of invalidCases) {
    const commands: CreateV2SingleMatchCommand[] = [];
    const handler = handlerWith({ commands }).create;
    assert.deepEqual(await handler(creationForm(fields)), {
      error: "提交的数据无效，请检查后重试。",
    });
    assert.equal(commands.length, 0);
  }
});

test("text bounds, venue membership, protected fields, and non-empty team placeholders fail closed", async () => {
  const invalidCases: ReadonlyArray<Readonly<Record<string, string>>> = [
    { title: "x".repeat(201) },
    { description: "x".repeat(5_001) },
    { location: "不存在的场馆" },
    { engine: "V2" },
    { engineVersion: "V2" },
    { status: "registration" },
    { max: "32" },
    { maxParticipants: "32" },
    { rule: "client-owned" },
    { team: "client-owned" },
    { isQuickMatch: "false" },
    { actorId: "attacker" },
    { role: "admin" },
    { createdBy: "attacker" },
    { adminOverride: "true" },
    { teamMinMembers: "" },
    { teamMaxMembers: "" },
    { teamRegistrationStart: "2026-09-01T09:00" },
    { teamRegistrationDeadline: "2026-09-30T17:00" },
    { creationRequestKey: "not-a-canonical-v4-uuid" },
  ];

  for (const fields of invalidCases) {
    const commands: CreateV2SingleMatchCommand[] = [];
    const handler = handlerWith({ commands }).create;
    assert.deepEqual(await handler(creationForm(fields)), {
      error: "提交的数据无效，请检查后重试。",
    });
    assert.equal(commands.length, 0);
  }
});

test("unsupported match types and format return an explicit unavailable state", async () => {
  const unsupportedCases: ReadonlyArray<Readonly<Record<string, string>>> = [
    { type: "double" },
    { type: "team", teamMinMembers: "3", teamMaxMembers: "6" },
    { format: "group_then_knockout" },
  ];
  for (const fields of unsupportedCases) {
    const commands: CreateV2SingleMatchCommand[] = [];
    const handler = handlerWith({ commands }).create;
    assert.deepEqual(await handler(creationForm(fields)), {
      error: "当前 V2 创建处理器不接受该比赛组合。",
    });
    assert.equal(commands.length, 0);
  }
});

test("ambiguous FormData is rejected and CSRF/auth finish before command parsing", async () => {
  const duplicate = creationForm();
  duplicate.append("title", "另一个标题");
  const duplicateCalls: string[] = [];
  assert.deepEqual(await handlerWith({ calls: duplicateCalls }).create(duplicate), {
    error: "提交的数据无效，请检查后重试。",
  });
  assert.deepEqual(duplicateCalls, []);

  const fileValue = creationForm({ description: new Blob(["description"]) });
  assert.deepEqual(await handlerWith().create(fileValue), {
    error: "提交的数据无效，请检查后重试。",
  });

  const protectedForm = creationForm({ engineVersion: "V2" });
  const csrfCalls: string[] = [];
  assert.deepEqual(
    await handlerWith({
      calls: csrfCalls,
      csrfError: "安全校验失败，请刷新页面后重试。",
    }).create(protectedForm),
    { error: "安全校验失败，请刷新页面后重试。" },
  );
  assert.deepEqual(csrfCalls, ["csrf"]);

  const unauthenticatedCalls: string[] = [];
  assert.deepEqual(
    await handlerWith({
      calls: unauthenticatedCalls,
      authenticated: false,
    }).create(protectedForm),
    { error: "请先登录后再发布比赛。" },
  );
  assert.deepEqual(unauthenticatedCalls, ["csrf", "auth"]);
});

test("application and unknown failures map to safe states without leaking internals", async () => {
  const conflict = new V2CompetitionApplicationError(
    "CONCURRENT_WRITE_CONFLICT",
    "secret database conflict",
    { secret: "do-not-leak" },
  );
  assert.deepEqual(
    await handlerWith({ serviceError: conflict }).create(creationForm()),
    { error: "数据已被其他操作更新，请刷新页面后重试。" },
  );

  const inactive = new V2CompetitionApplicationError(
    "ACTOR_NOT_ACTIVE",
    "secret actor state",
  );
  assert.deepEqual(
    await handlerWith({ serviceError: inactive }).create(creationForm()),
    { error: "登录状态或账号状态已变化，请重新登录后重试。" },
  );

  const unknown = new Error("secret backend detail");
  const logged: unknown[] = [];
  const state = await handlerWith({
    serviceError: unknown,
    logErrors: logged,
  }).create(creationForm());
  assert.deepEqual(state, { error: "操作失败，请稍后重试。" });
  assert.deepEqual(logged, [unknown]);
  assert.equal(JSON.stringify(state).includes("secret"), false);
});
