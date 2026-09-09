import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchV2DoubleMatchCreation,
  resolveV2DoubleMatchCreationRoute,
} from "../adapters/double-match-creation-dispatch";

function form(input: Readonly<{
  type?: string;
  format?: string;
  requestKey?: string | null;
}> = {}) {
  const value = new FormData();
  value.set("type", input.type ?? "double");
  value.set("format", input.format ?? "group_only");
  if (input.requestKey !== undefined && input.requestKey !== null) {
    value.set("creationRequestKey", input.requestKey);
  }
  return value;
}

test("DOUBLE dispatch is exact, independently gated, and retains durable retries", () => {
  assert.equal(resolveV2DoubleMatchCreationRoute(form(), false), "legacy");
  assert.equal(resolveV2DoubleMatchCreationRoute(form(), true), "v2-create");
  assert.equal(
    resolveV2DoubleMatchCreationRoute(form({ requestKey: "retry" }), false),
    "v2-resolve-existing",
  );
  for (const unsupported of [
    form({ type: "single", requestKey: "ignored" }),
    form({ type: "team", requestKey: "ignored" }),
    form({ format: "group_then_knockout", requestKey: "ignored" }),
  ]) {
    assert.equal(resolveV2DoubleMatchCreationRoute(unsupported, true), "legacy");
    assert.equal(resolveV2DoubleMatchCreationRoute(unsupported, false), "legacy");
  }
});

test("DOUBLE dispatch rejects ambiguous selector fields", () => {
  const duplicateType = form();
  duplicateType.append("type", "double");
  const duplicateFormat = form();
  duplicateFormat.append("format", "group_only");
  const duplicateKey = form({ requestKey: "one" });
  duplicateKey.append("creationRequestKey", "two");
  for (const invalid of [duplicateType, duplicateFormat, duplicateKey]) {
    assert.equal(resolveV2DoubleMatchCreationRoute(invalid, false), "invalid");
    assert.equal(resolveV2DoubleMatchCreationRoute(invalid, true), "invalid");
  }
});

test("DOUBLE dispatch invokes exactly one V2 operation and never falls through", async () => {
  const calls: string[] = [];
  const create = await dispatchV2DoubleMatchCreation({
    formData: form({ requestKey: "request" }),
    serverEnabled: true,
    createV2: async () => {
      calls.push("create");
      return { error: "rejected" };
    },
    resolveExistingV2: async () => {
      calls.push("resolve");
      return { success: "unexpected" };
    },
  });
  assert.deepEqual(create, {
    kind: "v2",
    operation: "create",
    state: { error: "rejected" },
  });
  assert.deepEqual(calls, ["create"]);

  const resolve = await dispatchV2DoubleMatchCreation({
    formData: form({ requestKey: "request" }),
    serverEnabled: false,
    createV2: async () => ({ success: "unexpected" }),
    resolveExistingV2: async () => {
      calls.push("resolve");
      return { error: "closed" };
    },
  });
  assert.deepEqual(resolve, {
    kind: "v2",
    operation: "resolve-existing",
    state: { error: "closed" },
  });
  assert.deepEqual(calls, ["create", "resolve"]);
});

test("DOUBLE Legacy routes invoke no V2 operation", async () => {
  let calls = 0;
  const result = await dispatchV2DoubleMatchCreation({
    formData: form({ type: "team", requestKey: "ignored" }),
    serverEnabled: true,
    createV2: async () => {
      calls += 1;
      return {};
    },
    resolveExistingV2: async () => {
      calls += 1;
      return {};
    },
  });
  assert.deepEqual(result, { kind: "legacy" });
  assert.equal(calls, 0);
});
