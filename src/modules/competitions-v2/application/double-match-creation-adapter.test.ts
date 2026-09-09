import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import {
  V2_DOUBLE_MATCH_CREATION_CLOSED_MESSAGE,
  createV2DoubleMatchCreationHandler,
  resolveExistingV2DoubleMatchCreationHandler,
  type V2DoubleMatchCreationAdapterDependencies,
} from "../adapters/double-match-creation";
import type {
  CreateV2DoubleMatchCommand,
  V2DoubleMatchApplicationService,
} from "./double-matches";

const FIELDS = {
  csrfToken: "token",
  creationRequestKey: "3d594650-3436-4a7f-bd48-9d700f17db33",
  title: "  秋季双打赛  ",
  description: "  双人组队报名。  ",
  location: " 西区乒乓球馆 ",
  timezoneOffset: "-480",
  matchDateTime: "2026-10-01T19:00",
  date: "2026-10-01",
  time: "19:00",
  registrationDeadline: "2026-09-30T17:00",
  deadlineDate: "2026-09-30",
  deadlineTime: "17:00",
  type: "double",
  format: "group_only",
      groupBestOf: "5", knockoutBestOf: "5",
  teamRegistrationStart: "",
  teamRegistrationDeadline: "",
} as const;

function form(overrides: Record<string, string | null> = {}) {
  const value = new FormData();
  for (const [field, fieldValue] of Object.entries({ ...FIELDS, ...overrides })) {
    if (fieldValue !== null) value.set(field, fieldValue);
  }
  return value;
}

function fixture(command: CreateV2DoubleMatchCommand) {
  return {
    id: "double-match",
    ...command,
    location: command.location,
    status: "registration" as const,
    engineVersion: "V2" as const,
    isQuickMatch: false as const,
    maxParticipants: 2_147_483_647,
    createdBy: command.actor.id,
    created: true,
  };
}

function handlers(input: Readonly<{
  commands?: CreateV2DoubleMatchCommand[];
  resolveMissing?: boolean;
}> = {}) {
  const service: V2DoubleMatchApplicationService = {
    create: async (command) => {
      input.commands?.push(command);
      return fixture(command);
    },
    resolveExisting: async (command) => {
      input.commands?.push(command);
      return input.resolveMissing ? null : { ...fixture(command), created: false };
    },
  };
  const dependencies: V2DoubleMatchCreationAdapterDependencies = {
    db: {} as Pick<PrismaClient, "$transaction">,
    creationService: service,
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "creator-1", role: "user" }),
    logError: async () => undefined,
  };
  return {
    create: createV2DoubleMatchCreationHandler(dependencies),
    resolve: resolveExistingV2DoubleMatchCreationHandler(dependencies),
  };
}

test("strict DOUBLE adapter builds one normalized Beijing-time command", async () => {
  const commands: CreateV2DoubleMatchCommand[] = [];
  const result = await handlers({ commands }).create(form());
  assert.deepEqual(result, {
    success: "比赛创建成功。",
    createdMatchId: "double-match",
  });
  assert.deepEqual(commands, [
    {
      actor: { id: "creator-1", role: "user" },
      requestKey: FIELDS.creationRequestKey,
      title: "秋季双打赛",
      description: "双人组队报名。",
      location: "西区乒乓球馆",
      dateTime: new Date("2026-10-01T11:00:00.000Z"),
      registrationDeadline: new Date("2026-09-30T09:00:00.000Z"),
      type: "double",
      format: "group_only",
      groupBestOf: 5, knockoutBestOf: 5,
    },
  ]);
});

test("DOUBLE adapter rejects other shapes and client-owned fields", async () => {
  for (const invalid of [
    form({ type: "single" }),
    form({ type: "team" }),
    form({ format: "group_then_knockout" }),
    form({ engineVersion: "V2" }),
    form({ teamRegistrationStart: "2026-09-01T10:00" }),
  ]) {
    const commands: CreateV2DoubleMatchCommand[] = [];
    const result = await handlers({ commands }).create(invalid);
    assert.equal(typeof result.error, "string");
    assert.equal(commands.length, 0);
  }
});

test("disabled DOUBLE boundary resolves a durable request but never creates", async () => {
  const commands: CreateV2DoubleMatchCommand[] = [];
  assert.equal((await handlers({ commands }).resolve(form())).createdMatchId, "double-match");
  assert.equal(commands.length, 1);
  assert.deepEqual(await handlers({ resolveMissing: true }).resolve(form()), {
    error: V2_DOUBLE_MATCH_CREATION_CLOSED_MESSAGE,
  });
});

test("DOUBLE adapter requires one textual CSRF field before auth/service", async () => {
  const commands: CreateV2DoubleMatchCommand[] = [];
  const missing = form({ csrfToken: null });
  assert.deepEqual(await handlers({ commands }).create(missing), {
    error: "安全校验失败，请刷新页面后重试。",
  });
  const duplicate = form();
  duplicate.append("csrfToken", "second");
  assert.deepEqual(await handlers({ commands }).create(duplicate), {
    error: "安全校验失败，请刷新页面后重试。",
  });
  assert.equal(commands.length, 0);
});
