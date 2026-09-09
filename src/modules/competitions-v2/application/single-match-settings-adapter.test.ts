import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import {
  createV2MatchSettingsHandler,
  createV2SingleMatchSettingsHandler,
  type V2MatchSettingsAdapterDependencies,
} from "../adapters/single-match-settings";
import { V2CompetitionApplicationError } from "./entries";
import type {
  UpdateV2MatchSettingsCommand,
  V2MatchSettingsApplicationService,
} from "./match-settings";

const EXPECTED_UPDATED_AT = "2026-09-04T08:00:00.000Z";
const SAVED_UPDATED_AT = new Date("2026-09-04T08:05:00.000Z");

function settingsForm(
  overrides: Readonly<Record<string, string | Blob | null>> = {},
) {
  const formData = new FormData();
  const fields: Record<string, string | Blob | null> = {
    csrfToken: "valid-token",
    expectedUpdatedAt: EXPECTED_UPDATED_AT,
    title: "  秋季单打积分赛  ",
    description: "  仅进行小组循环。  ",
    location: " 西区乒乓球馆 ",
    date: "2026-10-02",
    time: "19:00",
    deadlineDate: "2026-10-01",
    deadlineTime: "19:00",
    ...overrides,
  };
  for (const [field, value] of Object.entries(fields)) {
    if (value === null) continue;
    if (typeof value === "string") formData.set(field, value);
    else formData.set(field, value, "value.txt");
  }
  return formData;
}

function handlerWith(input: Readonly<{
  commands?: UpdateV2MatchSettingsCommand[];
  calls?: string[];
  csrfError?: string | null;
  authenticated?: boolean;
  serviceError?: unknown;
  changed?: boolean;
  revalidateError?: unknown;
  revalidated?: Array<readonly string[]>;
  logged?: unknown[];
  useCompatibilityFacade?: boolean;
}> = {}) {
  const service: V2MatchSettingsApplicationService = {
    update: async (command) => {
      input.calls?.push("service");
      input.commands?.push(command);
      if (input.serviceError !== undefined) throw input.serviceError;
      return {
        matchId: command.matchId,
        title: command.title,
        description: command.description,
        location: command.location,
        dateTime: command.dateTime,
        registrationDeadline: command.registrationDeadline,
        updatedAt: SAVED_UPDATED_AT,
        changed: input.changed ?? true,
      };
    },
  };
  const dependencies: V2MatchSettingsAdapterDependencies = {
    db: {} as Pick<PrismaClient, "$transaction">,
    settingsService: service,
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
    revalidatePaths: async (paths) => {
      input.calls?.push("revalidate");
      input.revalidated?.push(paths);
      if (input.revalidateError !== undefined) throw input.revalidateError;
    },
    logError: async (_message, error) => {
      input.logged?.push(error);
    },
  };
  return input.useCompatibilityFacade
    ? createV2SingleMatchSettingsHandler(dependencies)
    : createV2MatchSettingsHandler(dependencies);
}

test("the settings adapter forwards normalized settings, schedule, and server actor", async () => {
  const commands: UpdateV2MatchSettingsCommand[] = [];
  const calls: string[] = [];
  const revalidated: Array<readonly string[]> = [];
  const handler = handlerWith({ commands, calls, revalidated });

  assert.deepEqual(await handler("match-1", settingsForm()), {
    success: "比赛基本信息已更新。",
    updatedAt: SAVED_UPDATED_AT.toISOString(),
  });
  assert.deepEqual(calls, ["csrf", "auth", "service", "revalidate"]);
  assert.deepEqual(commands, [
    {
      actor: { id: "creator-1", role: "user" },
      matchId: "match-1",
      expectedUpdatedAt: new Date(EXPECTED_UPDATED_AT),
      title: "秋季单打积分赛",
      description: "仅进行小组循环。",
      location: "西区乒乓球馆",
      dateTime: new Date("2026-10-02T11:00:00.000Z"),
      registrationDeadline: new Date("2026-10-01T11:00:00.000Z"),
    },
  ]);
  assert.deepEqual(Object.keys(commands[0]).sort(), [
    "actor",
    "dateTime",
    "description",
    "expectedUpdatedAt",
    "location",
    "matchId",
    "registrationDeadline",
    "title",
  ]);
  assert.deepEqual(revalidated, [[
    "/",
    "/matchs",
    "/matchs/match-1",
    "/matchs/match-1/edit",
  ]]);
});

test("blank description becomes null and an identical save has a stable response", async () => {
  const commands: UpdateV2MatchSettingsCommand[] = [];
  const handler = handlerWith({
    commands,
    changed: false,
    useCompatibilityFacade: true,
  });

  assert.deepEqual(await handler("match-1", settingsForm({ description: "  " })), {
    success: "比赛基本信息没有变化。",
    updatedAt: SAVED_UPDATED_AT.toISOString(),
  });
  assert.equal(commands[0].description, null);
});

test("ambiguous or non-text FormData is rejected before CSRF, auth, or service work", async () => {
  const duplicate = settingsForm();
  duplicate.append("title", "第二个标题");
  const duplicateCalls: string[] = [];
  assert.deepEqual(await handlerWith({ calls: duplicateCalls })("match-1", duplicate), {
    error: "提交的数据无效，请检查后重试。",
  });
  assert.deepEqual(duplicateCalls, []);

  const file = settingsForm({ location: new Blob(["西区乒乓球馆"]) });
  const fileCalls: string[] = [];
  assert.deepEqual(await handlerWith({ calls: fileCalls })("match-1", file), {
    error: "提交的数据无效，请检查后重试。",
  });
  assert.deepEqual(fileCalls, []);
});

test("CSRF is authoritative and every unaccepted field fails closed", async () => {
  const protectedForm = settingsForm({ engineVersion: "V2" });
  const csrfCalls: string[] = [];
  assert.deepEqual(
    await handlerWith({
      calls: csrfCalls,
      csrfError: "安全校验失败，请刷新页面后重试。",
    })("match-1", protectedForm),
    { error: "安全校验失败，请刷新页面后重试。" },
  );
  assert.deepEqual(csrfCalls, ["csrf"]);

  for (const field of [
    "type",
    "format",
    "status",
    "rule",
    "teamRegistrationStart",
    "teamRegistrationDeadline",
    "teamMinMembers",
    "teamMaxMembers",
    "maxParticipants",
    "createdBy",
    "groupingGeneratedAt",
    "creationRequestKey",
    "creationRequestFingerprint",
    "actorId",
    "adminOverride",
  ]) {
    const calls: string[] = [];
    assert.deepEqual(
      await handlerWith({ calls })("match-1", settingsForm({ [field]: "attacker" })),
      { error: "提交的数据无效，请检查后重试。" },
    );
    assert.deepEqual(calls, ["csrf"]);
  }
});

test("authentication and canonical field validation happen before the service", async () => {
  const unauthenticatedCalls: string[] = [];
  assert.deepEqual(
    await handlerWith({
      calls: unauthenticatedCalls,
      authenticated: false,
    })("match-1", settingsForm()),
    { error: "请先登录。" },
  );
  assert.deepEqual(unauthenticatedCalls, ["csrf", "auth"]);

  const invalidCases = [
    settingsForm({ expectedUpdatedAt: "2026-09-04T08:00:00Z" }),
    settingsForm({ expectedUpdatedAt: "not-a-date" }),
    settingsForm({ location: "不存在的场馆" }),
    settingsForm({ title: "x".repeat(201) }),
    settingsForm({ description: "x".repeat(5_001) }),
    settingsForm({ date: "2026-02-30" }),
    settingsForm({ deadlineDate: "2026-10-03" }),
  ];
  for (const formData of invalidCases) {
    const calls: string[] = [];
    assert.deepEqual(await handlerWith({ calls })("match-1", formData), {
      error: "提交的数据无效，请检查后重试。",
    });
    assert.deepEqual(calls, ["csrf", "auth"]);
  }

  const untrustedTimezoneCalls: string[] = [];
  assert.deepEqual(
    await handlerWith({ calls: untrustedTimezoneCalls })(
      "match-1",
      settingsForm({ timezoneOffset: "-480" }),
    ),
    { error: "提交的数据无效，请检查后重试。" },
  );
  assert.deepEqual(untrustedTimezoneCalls, ["csrf"]);
});

test("application failures are safe and never fall through to another writer", async () => {
  const conflict = new V2CompetitionApplicationError(
    "CONCURRENT_WRITE_CONFLICT",
    "secret write conflict",
  );
  assert.deepEqual(
    await handlerWith({ serviceError: conflict })("match-1", settingsForm()),
    { error: "数据已被其他操作更新，请刷新页面后重试。" },
  );

  const unknown = new Error("secret persistence detail");
  const logged: unknown[] = [];
  assert.deepEqual(
    await handlerWith({ serviceError: unknown, logged })("match-1", settingsForm()),
    { error: "操作失败，请稍后重试。" },
  );
  assert.deepEqual(logged, [unknown]);
});

test("cache revalidation failure after commit remains a successful save", async () => {
  const cacheError = new Error("cache unavailable");
  const logged: unknown[] = [];
  assert.deepEqual(
    await handlerWith({ revalidateError: cacheError, logged })(
      "match-1",
      settingsForm(),
    ),
    {
      success: "比赛基本信息已更新。",
      updatedAt: SAVED_UPDATED_AT.toISOString(),
    },
  );
  assert.deepEqual(logged, [cacheError]);
});
