import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import {
  V2_TEAM_MATCH_CREATION_CLOSED_MESSAGE,
  createV2TeamMatchCreationHandler,
  resolveExistingV2TeamMatchCreationHandler,
  type V2TeamMatchCreationAdapterDependencies,
} from "../adapters/team-match-creation";
import type {
  CreateV2TeamMatchCommand,
  V2TeamMatchApplicationService,
} from "./team-matches";

const FIELDS = {
  csrfToken: "token",
  creationRequestKey: "3d594650-3436-4a7f-bd48-9d700f17db33",
  title: "  秋季团体赛  ",
  description: "  团体自动报名。  ",
  location: " 西区乒乓球馆 ",
  timezoneOffset: "-480",
  matchDateTime: "2026-10-01T19:00",
  date: "2026-10-01",
  time: "19:00",
  registrationDeadline: "2026-09-29T17:00",
  deadlineDate: "2026-09-29",
  deadlineTime: "17:00",
  type: "team",
  format: "group_only",
      groupBestOf: "5", knockoutBestOf: "5",
  teamRegistrationStart: "2026-09-01T09:00",
  teamRegistrationDeadline: "2026-09-30T17:00",
  teamMinMembers: "3",
  teamMaxMembers: "6",
} as const;

function form(overrides: Record<string, string | null> = {}) {
  const value = new FormData();
  for (const [field, fieldValue] of Object.entries({ ...FIELDS, ...overrides })) {
    if (fieldValue !== null) value.set(field, fieldValue);
  }
  return value;
}

function fixture(command: CreateV2TeamMatchCommand) {
  return {
    id: "team-match",
    ...command,
    status: "registration" as const,
    engineVersion: "V2" as const,
    isQuickMatch: false as const,
    maxParticipants: 2_147_483_647,
    createdBy: command.actor.id,
    created: true,
  };
}

function handlers(input: Readonly<{
  commands?: CreateV2TeamMatchCommand[];
  resolveMissing?: boolean;
}> = {}) {
  const service: V2TeamMatchApplicationService = {
    create: async (command) => {
      input.commands?.push(command);
      return fixture(command);
    },
    resolveExisting: async (command) => {
      input.commands?.push(command);
      return input.resolveMissing ? null : { ...fixture(command), created: false };
    },
  };
  const dependencies: V2TeamMatchCreationAdapterDependencies = {
    db: {} as Pick<PrismaClient, "$transaction">,
    creationService: service,
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "creator-1", role: "user" }),
    logError: async () => undefined,
  };
  return {
    create: createV2TeamMatchCreationHandler(dependencies),
    resolve: resolveExistingV2TeamMatchCreationHandler(dependencies),
  };
}

test("strict TEAM adapter builds one normalized Beijing-time command", async () => {
  const commands: CreateV2TeamMatchCommand[] = [];
  assert.deepEqual(await handlers({ commands }).create(form()), {
    success: "比赛创建成功。",
    createdMatchId: "team-match",
  });
  assert.deepEqual(commands, [
    {
      actor: { id: "creator-1", role: "user" },
      requestKey: FIELDS.creationRequestKey,
      title: "秋季团体赛",
      description: "团体自动报名。",
      location: "西区乒乓球馆",
      dateTime: new Date("2026-10-01T11:00:00.000Z"),
      registrationDeadline: new Date("2026-09-30T09:00:00.000Z"),
      type: "team",
      format: "group_only",
      groupBestOf: 5, knockoutBestOf: 5,
      teamRegistrationStart: new Date("2026-09-01T01:00:00.000Z"),
      teamRegistrationDeadline: new Date("2026-09-30T09:00:00.000Z"),
      teamMinMembers: 3,
      teamMaxMembers: 6,
    },
  ]);
});

test("TEAM adapter rejects non-exact type/format/window/limits and protected fields", async () => {
  for (const invalid of [
    form({ type: "single" }),
    form({ type: "double" }),
    form({ format: "group_then_knockout" }),
    form({ engineVersion: "V2" }),
    form({ teamRegistrationStart: null }),
    form({ teamRegistrationStart: "2026-09-30T17:00" }),
    form({ teamRegistrationDeadline: "2026-10-01T19:00" }),
    form({ teamMinMembers: "0" }),
    form({ teamMinMembers: "03" }),
    form({ teamMinMembers: "7", teamMaxMembers: "6" }),
    form({ teamMaxMembers: "51" }),
  ]) {
    const commands: CreateV2TeamMatchCommand[] = [];
    const result = await handlers({ commands }).create(invalid);
    assert.equal(typeof result.error, "string");
    assert.equal(commands.length, 0);
  }
});

test("disabled TEAM boundary resolves durable requests but never creates", async () => {
  const commands: CreateV2TeamMatchCommand[] = [];
  assert.equal(
    (await handlers({ commands }).resolve(form())).createdMatchId,
    "team-match",
  );
  assert.equal(commands.length, 1);
  assert.deepEqual(await handlers({ resolveMissing: true }).resolve(form()), {
    error: V2_TEAM_MATCH_CREATION_CLOSED_MESSAGE,
  });
});
