import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import { createV2TeamResultActionHandlers } from "../adapters/team-result-actions";
import type { V2ResultApplicationService } from "./results";

function targetForm(version = 5) {
  const value = new FormData();
  value.set("csrfToken", "token");
  value.set("fixtureId", "fixture-1");
  value.set("expectedFixtureVersion", String(version));
  return value;
}

function setup(
  match: Readonly<{
    type: "single" | "double" | "team";
    format: "group_only" | "group_then_knockout";
    engineVersion: "LEGACY" | "V2";
    isQuickMatch: boolean;
  }> = {
    type: "team",
    format: "group_only",
    engineVersion: "V2",
    isQuickMatch: false,
  },
) {
  const commands: Array<{
    operation: string;
    command: Record<string, unknown>;
  }> = [];
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
  const handlers = createV2TeamResultActionHandlers({
    db: {
      match: { findUnique: async () => match },
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
    getCurrentUser: async () => ({ id: "captain-a", role: "user" }),
    revalidatePaths: async (paths) => {
      revalidated.push([...paths]);
    },
    logError: async () => undefined,
  });
  return { handlers, commands, revalidated };
}

test("TEAM result boundary injects GROUP and accepts aggregate team scores", async () => {
  const { handlers, commands } = setup();
  const submission = targetForm();
  submission.set("winnerEntryId", "entry-a");
  submission.set("winnerScore", "5");
  submission.set("loserScore", "3");
  assert.deepEqual(await handlers.submitResult("match-1", submission), {
    success: "已登记，等待对方队长或管理员确认。",
  });

  const correction = targetForm(6);
  correction.set("resultRevisionId", "revision-confirmed");
  correction.set("correctionMode", "KEEP_WINNER");
  correction.set("winnerScore", "4");
  correction.set("loserScore", "2");
  assert.equal(
    (await handlers.submitCorrection("match-1", correction)).error,
    undefined,
  );

  for (const [operation, handler] of [
    ["confirm", handlers.confirmResult],
    ["reject", handlers.rejectResult],
    ["void", handlers.voidResult],
  ] as const) {
    const form = targetForm(7);
    form.set("resultRevisionId", `revision-${operation}`);
    assert.equal((await handler("match-1", form)).error, undefined);
  }
  assert.equal(
    (await handlers.voidUnplayedFixture("match-1", targetForm(8))).error,
    undefined,
  );

  const forfeit = targetForm(9);
  forfeit.set("winnerEntryId", "entry-a");
  forfeit.set("reason", "对方弃权");
  assert.equal(
    (await handlers.confirmForfeit("match-1", forfeit)).error,
    undefined,
  );
  const forfeitCorrection = targetForm(10);
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
  assert.deepEqual(commands[0], {
    operation: "submit",
    command: {
      actor: { actorId: "captain-a", role: "user" },
      matchId: "match-1",
      fixtureId: "fixture-1",
      expectedFixtureVersion: 5,
      requiredFixtureStage: "GROUP",
      winnerEntryId: "entry-a",
      loserEntryId: "entry-b",
      score: { winnerScore: 5, loserScore: 3 },
    },
  });
  assert.equal(commands[1]?.command.correctionMode, "KEEP_WINNER");
  assert.deepEqual(commands.at(-1), {
    operation: "forfeit-correction",
    command: {
      actor: { actorId: "captain-a", role: "user" },
      matchId: "match-1",
      fixtureId: "fixture-1",
      expectedFixtureVersion: 10,
      requiredFixtureStage: "GROUP",
      resultRevisionId: "revision-forfeit",
      reason: "胜方登记错误",
    },
  });
});

test("TEAM result boundary rejects racket fields, forged capabilities, and forged forfeit loser", async () => {
  const { handlers, commands } = setup();

  const racketScore = targetForm();
  racketScore.set("winnerEntryId", "entry-a");
  racketScore.set("winnerScore", "3");
  racketScore.set("loserScore", "1");
  racketScore.set("bestOf", "5");
  assert.equal(typeof (await handlers.submitResult("match-1", racketScore)).error, "string");

  const tied = targetForm();
  tied.set("winnerEntryId", "entry-a");
  tied.set("winnerScore", "2");
  tied.set("loserScore", "2");
  assert.equal(typeof (await handlers.submitResult("match-1", tied)).error, "string");

  const forgedStage = targetForm();
  forgedStage.set("requiredFixtureStage", "KNOCKOUT");
  assert.equal(
    typeof (await handlers.voidUnplayedFixture("match-1", forgedStage)).error,
    "string",
  );

  const forgedForfeit = targetForm();
  forgedForfeit.set("winnerEntryId", "entry-a");
  forgedForfeit.set("loserEntryId", "attacker-selected-loser");
  forgedForfeit.set("reason", "伪造负方");
  assert.equal(
    typeof (await handlers.confirmForfeit("match-1", forgedForfeit)).error,
    "string",
  );
  assert.equal(commands.length, 0);
});

test("TEAM result boundary fails closed for unsupported match discriminators", async () => {
  for (const match of [
    {
      type: "double",
      format: "group_only",
      engineVersion: "V2",
      isQuickMatch: false,
    },
    {
      type: "team",
      format: "group_only",
      engineVersion: "V2",
      isQuickMatch: true,
    },
    {
      type: "team",
      format: "group_only",
      engineVersion: "LEGACY",
      isQuickMatch: false,
    },
  ] as const) {
    const { handlers, commands } = setup(match);
    assert.equal(
      typeof (await handlers.voidUnplayedFixture("match-1", targetForm())).error,
      "string",
    );
    assert.equal(commands.length, 0);
  }
});
