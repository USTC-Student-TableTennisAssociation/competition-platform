import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchV2TeamMatchCreation,
  resolveV2TeamMatchCreationRoute,
} from "../adapters/team-match-creation-dispatch";

function form(input: Readonly<{
  type?: string;
  format?: string;
  requestKey?: string | null;
}> = {}) {
  const value = new FormData();
  value.set("type", input.type ?? "team");
  value.set("format", input.format ?? "group_only");
  if (input.requestKey !== undefined && input.requestKey !== null) {
    value.set("creationRequestKey", input.requestKey);
  }
  return value;
}

test("TEAM dispatch is exact, independently gated, and preserves durable retry", () => {
  assert.equal(resolveV2TeamMatchCreationRoute(form(), false), "legacy");
  assert.equal(resolveV2TeamMatchCreationRoute(form(), true), "v2-create");
  assert.equal(
    resolveV2TeamMatchCreationRoute(form({ requestKey: "retry" }), false),
    "v2-resolve-existing",
  );
  for (const unsupported of [
    form({ type: "single", requestKey: "ignored" }),
    form({ type: "double", requestKey: "ignored" }),
    form({ format: "group_then_knockout", requestKey: "ignored" }),
  ]) {
    assert.equal(resolveV2TeamMatchCreationRoute(unsupported, true), "legacy");
    assert.equal(resolveV2TeamMatchCreationRoute(unsupported, false), "legacy");
  }
});

test("TEAM dispatch rejects ambiguous selectors and invokes one V2 operation", async () => {
  const duplicate = form({ requestKey: "one" });
  duplicate.append("creationRequestKey", "two");
  assert.equal(resolveV2TeamMatchCreationRoute(duplicate, true), "invalid");

  const calls: string[] = [];
  const result = await dispatchV2TeamMatchCreation({
    formData: form({ requestKey: "request" }),
    serverEnabled: true,
    createV2: async () => {
      calls.push("create");
      return { success: "created" };
    },
    resolveExistingV2: async () => {
      calls.push("resolve");
      return { error: "unexpected" };
    },
  });
  assert.deepEqual(result, {
    kind: "v2",
    operation: "create",
    state: { success: "created" },
  });
  assert.deepEqual(calls, ["create"]);
});
