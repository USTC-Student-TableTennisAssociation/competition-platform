import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import {
  createV2DoubleGroupThenKnockoutMatchCreationHandler,
  type V2DoubleGroupThenKnockoutMatchCreationAdapterDependencies,
} from "../adapters/double-match-creation";
import {
  createV2SingleGroupThenKnockoutMatchCreationHandler,
  type V2SingleGroupThenKnockoutMatchCreationAdapterDependencies,
} from "../adapters/single-match-creation";
import {
  createV2TeamGroupThenKnockoutMatchCreationHandler,
  type V2TeamGroupThenKnockoutMatchCreationAdapterDependencies,
} from "../adapters/team-match-creation";
import {
  createV2DoubleGroupThenKnockoutMatchApplicationService,
  type CreateV2DoubleGroupThenKnockoutMatchCommand,
  type V2DoubleGroupThenKnockoutMatchApplicationService,
} from "./double-matches";
import {
  type CreatedV2Match,
  type V2FormalMatchFormat,
  type V2GroupOnlyMatchType,
} from "./group-only-match-creation";
import type {
  V2CompetitionDatabase,
  V2CompetitionTransaction,
} from "./entries";
import {
  createV2SingleGroupThenKnockoutMatchApplicationService,
  fingerprintV2SingleGroupThenKnockoutMatchCreation,
  fingerprintV2SingleMatchCreation,
  type CreateV2SingleGroupThenKnockoutMatchCommand,
  type V2SingleGroupThenKnockoutMatchApplicationService,
} from "./matches";
import {
  createV2TeamGroupThenKnockoutMatchApplicationService,
  type CreateV2TeamGroupThenKnockoutMatchCommand,
  type V2TeamGroupThenKnockoutMatchApplicationService,
} from "./team-matches";

type State = {
  existing: Record<string, unknown> | null;
  matchData: Record<string, unknown> | null;
  auditData: Record<string, unknown> | null;
  calls: string[];
};

function state(): State {
  return { existing: null, matchData: null, auditData: null, calls: [] };
}

function fakeDatabase(value: State): V2CompetitionDatabase {
  const tx = {
    $queryRaw: async () => [{ id: "creator-1" }],
    user: {
      findUnique: async () => ({
        id: "creator-1",
        role: "user",
        isBanned: false,
        emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    },
    match: {
      findUnique: async () => {
        value.calls.push("find");
        return value.existing;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        value.calls.push("create");
        value.matchData = data;
        const created = {
          id: `${String(data.type)}-group-then-match`,
          title: data.title,
          description: data.description,
          location: data.location,
          dateTime: data.dateTime,
          registrationDeadline: data.registrationDeadline,
          type: data.type,
          format: data.format,
          status: data.status,
          engineVersion: data.engineVersion,
          isQuickMatch: data.isQuickMatch,
          maxParticipants: data.maxParticipants,
          createdBy: data.createdBy,
        };
        value.existing = {
          ...created,
          creationRequestFingerprint: data.creationRequestFingerprint,
        };
        return created;
      },
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        value.calls.push("audit");
        value.auditData = data;
        return { id: "audit-1" };
      },
    },
  };
  return {
    $transaction: async <T>(
      operation: (transaction: V2CompetitionTransaction) => Promise<T>,
    ) => operation(tx as unknown as V2CompetitionTransaction),
  } as unknown as Pick<PrismaClient, "$transaction">;
}

const BASE = {
  actor: { id: "creator-1", role: "user" as const },
  requestKey: "3d594650-3436-4a7f-bd48-9d700f17db33",
  title: "秋季赛事",
  description: "先分组后淘汰",
  location: "西区乒乓球馆",
  dateTime: new Date("2026-10-01T11:00:00.000Z"),
  registrationDeadline: new Date("2026-09-30T09:00:00.000Z"),
  format: "group_then_knockout" as const,
};

function singleCommand(): CreateV2SingleGroupThenKnockoutMatchCommand {
  return { ...BASE, type: "single" };
}

function doubleCommand(): CreateV2DoubleGroupThenKnockoutMatchCommand {
  return { ...BASE, type: "double" };
}

function teamCommand(): CreateV2TeamGroupThenKnockoutMatchCommand {
  return {
    ...BASE,
    type: "team",
    registrationDeadline: new Date("2026-09-30T09:00:00.000Z"),
    teamRegistrationStart: new Date("2026-09-01T01:00:00.000Z"),
    teamRegistrationDeadline: new Date("2026-09-30T09:00:00.000Z"),
    teamMinMembers: 3,
    teamMaxMembers: 6,
  };
}

test("all three application facades persist exact V2 group-then-knockout matches idempotently", async () => {
  const singleState = state();
  const single = createV2SingleGroupThenKnockoutMatchApplicationService({
    db: fakeDatabase(singleState),
  });
  const singleFirst = await single.create(singleCommand());
  const singleReplay = await single.create(singleCommand());
  assert.equal(singleFirst.format, "group_then_knockout");
  assert.equal(singleReplay.created, false);
  assert.equal(singleReplay.id, singleFirst.id);
  assert.equal(singleState.matchData?.format, "group_then_knockout");
  assert.deepEqual(singleState.matchData?.rule, { note: "先分组后淘汰赛" });

  const doubleState = state();
  const double = createV2DoubleGroupThenKnockoutMatchApplicationService({
    db: fakeDatabase(doubleState),
  });
  const doubleFirst = await double.create(doubleCommand());
  const doubleReplay = await double.resolveExisting(doubleCommand());
  assert.equal(doubleFirst.type, "double");
  assert.equal(doubleReplay?.created, false);
  assert.equal(doubleState.matchData?.format, "group_then_knockout");
  assert.deepEqual(doubleState.matchData?.rule, { note: "先分组后淘汰赛" });

  const teamState = state();
  const team = createV2TeamGroupThenKnockoutMatchApplicationService({
    db: fakeDatabase(teamState),
  });
  const teamFirst = await team.create(teamCommand());
  const teamReplay = await team.create(teamCommand());
  assert.equal(teamFirst.type, "team");
  assert.equal(teamReplay.created, false);
  assert.equal(
    (teamState.matchData?.registrationDeadline as Date).toISOString(),
    teamCommand().teamRegistrationDeadline.toISOString(),
  );
  assert.equal(teamState.matchData?.format, "group_then_knockout");
  assert.deepEqual(teamState.matchData?.rule, { note: "先分组后淘汰赛" });
});

test("format participates in the durable fingerprint without changing group-only fingerprints", () => {
  const groupThen = singleCommand();
  assert.notEqual(
    fingerprintV2SingleGroupThenKnockoutMatchCreation(groupThen),
    fingerprintV2SingleMatchCreation({
      ...groupThen,
      format: "group_only",
    }),
  );
});

const FORM_BASE = {
  csrfToken: "token",
  creationRequestKey: BASE.requestKey,
  title: "  秋季赛事  ",
  description: "  先分组后淘汰  ",
  location: " 西区乒乓球馆 ",
  timezoneOffset: "-480",
  matchDateTime: "2026-10-01T19:00",
  date: "2026-10-01",
  time: "19:00",
  registrationDeadline: "2026-09-30T17:00",
  deadlineDate: "2026-09-30",
  deadlineTime: "17:00",
  format: "group_then_knockout",
  teamRegistrationStart: "",
  teamRegistrationDeadline: "",
} as const;

function form(
  type: "single" | "double" | "team",
  overrides: Readonly<Record<string, string | null>> = {},
) {
  const team =
    type === "team"
      ? {
          teamRegistrationStart: "2026-09-01T09:00",
          teamRegistrationDeadline: "2026-09-30T17:00",
          teamMinMembers: "3",
          teamMaxMembers: "6",
        }
      : {};
  const value = new FormData();
  for (const [field, fieldValue] of Object.entries({
    ...FORM_BASE,
    ...team,
    type,
    ...overrides,
  })) {
    if (fieldValue !== null) value.set(field, fieldValue);
  }
  return value;
}

function created<
  TType extends V2GroupOnlyMatchType,
  TFormat extends V2FormalMatchFormat,
>(command: {
  actor: { id: string };
  type: TType;
  format: TFormat;
}): CreatedV2Match<TType, TFormat> {
  return {
    id: `${command.type}-created`,
    title: "秋季赛事",
    description: "先分组后淘汰",
    location: "西区乒乓球馆",
    dateTime: new Date("2026-10-01T11:00:00.000Z"),
    registrationDeadline: new Date("2026-09-30T09:00:00.000Z"),
    type: command.type,
    format: command.format,
    status: "registration" as const,
    engineVersion: "V2" as const,
    isQuickMatch: false as const,
    maxParticipants: 2_147_483_647,
    createdBy: command.actor.id,
    created: true,
  };
}

test("the shared group-then adapter accepts every exact type and rejects overposted policy", async () => {
  const singleCommands: CreateV2SingleGroupThenKnockoutMatchCommand[] = [];
  const singleService: V2SingleGroupThenKnockoutMatchApplicationService = {
    create: async (command) => {
      singleCommands.push(command);
      return created(command);
    },
    resolveExisting: async () => null,
  };
  const singleDependencies: V2SingleGroupThenKnockoutMatchCreationAdapterDependencies = {
    db: {} as Pick<PrismaClient, "$transaction">,
    creationService: singleService,
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "creator-1", role: "user" }),
  };

  const doubleCommands: CreateV2DoubleGroupThenKnockoutMatchCommand[] = [];
  const doubleService: V2DoubleGroupThenKnockoutMatchApplicationService = {
    create: async (command) => {
      doubleCommands.push(command);
      return created(command);
    },
    resolveExisting: async () => null,
  };
  const doubleDependencies: V2DoubleGroupThenKnockoutMatchCreationAdapterDependencies = {
    db: {} as Pick<PrismaClient, "$transaction">,
    creationService: doubleService,
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "creator-1", role: "user" }),
  };

  const teamCommands: CreateV2TeamGroupThenKnockoutMatchCommand[] = [];
  const teamService: V2TeamGroupThenKnockoutMatchApplicationService = {
    create: async (command) => {
      teamCommands.push(command);
      return created(command);
    },
    resolveExisting: async () => null,
  };
  const teamDependencies: V2TeamGroupThenKnockoutMatchCreationAdapterDependencies = {
    db: {} as Pick<PrismaClient, "$transaction">,
    creationService: teamService,
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "creator-1", role: "user" }),
  };

  const scenarios = [
    {
      type: "single" as const,
      commands: singleCommands,
      handler: createV2SingleGroupThenKnockoutMatchCreationHandler(
        singleDependencies,
      ),
    },
    {
      type: "double" as const,
      commands: doubleCommands,
      handler: createV2DoubleGroupThenKnockoutMatchCreationHandler(
        doubleDependencies,
      ),
    },
    {
      type: "team" as const,
      commands: teamCommands,
      handler: createV2TeamGroupThenKnockoutMatchCreationHandler(
        teamDependencies,
      ),
    },
  ];

  for (const scenario of scenarios) {
    assert.equal((await scenario.handler(form(scenario.type))).createdMatchId, `${scenario.type}-created`);
    assert.equal(scenario.commands.length, 1);
    assert.equal(scenario.commands[0].format, "group_then_knockout");

    for (const protectedField of [
      "engineVersion",
      "status",
      "maxParticipants",
      "rule",
      "createdBy",
      "adminOverride",
      "creationRequestFingerprint",
    ]) {
      const result = await scenario.handler(
        form(scenario.type, { [protectedField]: "client-owned" }),
      );
      assert.deepEqual(result, { error: "提交的数据无效，请检查后重试。" });
      assert.equal(scenario.commands.length, 1, protectedField);
    }
  }
});
