import assert from "node:assert/strict";
import test from "node:test";

import { createV2KnockoutTableLabelsActionHandler } from "../adapters/knockout-table-labels-actions";

function form(overrides: Readonly<Record<string, string>> = {}) {
  const value = new FormData();
  value.set("csrfToken", "csrf");
  value.set("fixtureId", "fixture-1");
  value.set("expectedFixtureVersion", "2");
  value.set("labelsJson", JSON.stringify(["3 号台", "西区馆"]));
  for (const [key, item] of Object.entries(overrides)) value.set(key, item);
  return value;
}

test("knockout label action sends only server-authenticated identities", async () => {
  const commands: unknown[] = [];
  const paths: string[][] = [];
  const handler = createV2KnockoutTableLabelsActionHandler({
    db: {} as never,
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "owner-1", role: "user" }),
    revalidatePaths: async (value) => {
      paths.push([...value]);
    },
    service: {
      update: async (command) => {
        commands.push(command);
        return { changed: true, roundNumber: 1, position: 2 };
      },
    },
  });

  const result = await handler("match-1", form());

  assert.deepEqual(result, { success: "第 1 轮第 2 场桌号已更新。" });
  assert.deepEqual(commands, [
    {
      actor: { id: "owner-1", role: "user" },
      matchId: "match-1",
      fixtureId: "fixture-1",
      expectedFixtureVersion: 2,
      labels: ["3 号台", "西区馆"],
    },
  ]);
  assert.deepEqual(paths, [
    ["/matchs/match-1", "/matchs/match-1/grouping"],
  ]);
});

test("knockout label action rejects duplicate, malformed, and protected fields", async () => {
  let calls = 0;
  const handler = createV2KnockoutTableLabelsActionHandler({
    db: {} as never,
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "admin-1", role: "admin" }),
    service: {
      update: async () => {
        calls += 1;
        return { changed: false, roundNumber: 1, position: 1 };
      },
    },
  });

  const duplicate = form();
  duplicate.append("fixtureId", "fixture-2");
  assert.ok((await handler("match-1", duplicate)).error);

  const invalidLabels = form({ labelsJson: JSON.stringify(["3 号台", "3 号台"]) });
  assert.ok((await handler("match-1", invalidLabels)).error);

  const protectedField = form({ actorId: "attacker" });
  assert.ok((await handler("match-1", protectedField)).error);
  assert.equal(calls, 0);
});

test("knockout label action validates CSRF before authentication or writes", async () => {
  let authCalls = 0;
  let serviceCalls = 0;
  const handler = createV2KnockoutTableLabelsActionHandler({
    db: {} as never,
    validateCsrfToken: async () => "CSRF 无效。",
    getCurrentUser: async () => {
      authCalls += 1;
      return { id: "owner-1", role: "user" };
    },
    service: {
      update: async () => {
        serviceCalls += 1;
        return { changed: false, roundNumber: 1, position: 1 };
      },
    },
  });

  assert.deepEqual(await handler("match-1", form()), { error: "CSRF 无效。" });
  assert.equal(authCalls, 0);
  assert.equal(serviceCalls, 0);
});
