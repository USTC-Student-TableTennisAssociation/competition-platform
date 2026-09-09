import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import { createV2EntryDisqualificationActionHandler } from "../adapters/entry-disqualification-actions";

function form() {
  const value = new FormData();
  value.set("csrfToken", "csrf");
  value.set("entryId", "entry-1");
  value.set("expectedEntryVersion", "7");
  value.set("reason", "确认无法继续参赛");
  return value;
}

test("the disqualification boundary forwards only the server actor and strict Entry target", async () => {
  const commands: unknown[] = [];
  const paths: string[][] = [];
  const handler = createV2EntryDisqualificationActionHandler({
    db: {} as PrismaClient,
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "manager-1", role: "user" }),
    service: {
      disqualify: async (command) => {
        commands.push(command);
      },
    },
    revalidatePaths: async (next) => {
      paths.push([...next]);
    },
  });

  assert.deepEqual(await handler("match-1", form()), {
    success: "参赛资格已取消，相关未赛对局与淘汰签表已同步处理。",
  });
  assert.deepEqual(commands, [
    {
      actor: { id: "manager-1", role: "user" },
      matchId: "match-1",
      entryId: "entry-1",
      expectedEntryVersion: 7,
      reason: "确认无法继续参赛",
    },
  ]);
  assert.deepEqual(paths[0], [
    "/",
    "/matchs",
    "/matchs/match-1",
    "/matchs/match-1/grouping",
    "/profile",
  ]);
});

test("the disqualification boundary rejects forged fields, duplicate versions, and blank reasons", async () => {
  let authCalls = 0;
  let serviceCalls = 0;
  const handler = createV2EntryDisqualificationActionHandler({
    db: {} as PrismaClient,
    validateCsrfToken: async () => null,
    getCurrentUser: async () => {
      authCalls += 1;
      return { id: "manager-1", role: "admin" };
    },
    service: {
      disqualify: async () => {
        serviceCalls += 1;
      },
    },
    logError: async () => undefined,
  });

  const forged = form();
  forged.set("actorId", "attacker");
  assert.equal(typeof (await handler("match-1", forged)).error, "string");

  const duplicate = form();
  duplicate.append("expectedEntryVersion", "8");
  assert.equal(typeof (await handler("match-1", duplicate)).error, "string");

  const blank = form();
  blank.set("reason", "   ");
  assert.equal(typeof (await handler("match-1", blank)).error, "string");

  assert.equal(authCalls, 0);
  assert.equal(serviceCalls, 0);
});
