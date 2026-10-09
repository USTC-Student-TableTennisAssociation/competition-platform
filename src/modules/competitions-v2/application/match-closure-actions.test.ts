import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";
import { createV2MatchClosureActionHandlers } from "../adapters/match-closure-actions";

function setup(role: "admin" | "user" | null = "admin") {
  let queries = 0, auth = 0;
  const actions = createV2MatchClosureActionHandlers({
    db: { $transaction: async () => { queries++; throw new Error("Must not reach database."); } } as unknown as Pick<PrismaClient, "$transaction">,
    getCurrentUser: async () => { auth++; return role ? { id: "actor", role } : null; },
    validateCsrfToken: async form => form.get("csrfToken") === "token" ? null : "CSRF invalid",
    logError: async () => {},
  });
  return { actions, queries: () => queries, auth: () => auth };
}
const form = () => { const f = new FormData(); f.set("csrfToken", "token"); return f; };

test("closure rejects unauthenticated users and ordinary competition creators", async () => {
  for (const role of ["user", null] as const) {
    const s = setup(role);
    const state = await s.actions.preview("match", form());
    assert.equal(state.error, role ? "只有管理员可以结束比赛。" : "请先登录。");
    assert.equal(s.queries(), 0);
  }
});
test("closure rejects CSRF errors, duplicate fields, files, and forged server-owned identities before mutation", async () => {
  for (const field of ["actor", "role", "status", "fixtureIds", "metadata", "ignorePending"]) {
    const s = setup(); const f = form(); f.set(field, "forged");
    assert.ok((await s.actions.preview("match", f)).error);
    assert.equal(s.queries(), 0); assert.equal(s.auth(), 0);
  }
  const s = setup();
  const duplicate = form(); duplicate.append("csrfToken", "token");
  assert.ok((await s.actions.preview("match", duplicate)).error);
  const badCsrf = form(); badCsrf.set("csrfToken", "bad");
  assert.equal((await s.actions.preview("match", badCsrf)).error, "CSRF invalid");
  const file = form(); file.set("csrfToken", new Blob(["token"]));
  assert.ok((await s.actions.preview("match", file)).error);
  assert.equal(s.queries(), 0);
});
test("closure requires explicit confirmation and validates the preview fingerprint before opening a transaction", async () => {
  const s = setup();
  const f = form(); f.set("fingerprint", "a".repeat(64));
  assert.ok((await s.actions.finish("match", f)).error);
  f.set("confirm", "no");
  assert.equal((await s.actions.finish("match", f)).error, "请确认作废名单并勾选结束比赛。");
  f.set("confirm", "yes"); f.set("fingerprint", "invalid");
  assert.equal((await s.actions.finish("match", f)).error, "请重新预览对局后再结束比赛。");
  assert.equal(s.queries(), 0);
});
