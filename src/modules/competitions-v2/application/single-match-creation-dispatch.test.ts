import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchV2SingleMatchCreation,
  resolveV2SingleMatchCreationRoute,
} from "../adapters/single-match-creation-dispatch";

function creationForm(input: Readonly<{
  type?: string;
  format?: string;
  requestKey?: string | null;
}> = {}) {
  const formData = new FormData();
  formData.set("type", input.type ?? "single");
  formData.set("format", input.format ?? "group_only");
  if (input.requestKey !== null && input.requestKey !== undefined) {
    formData.set("creationRequestKey", input.requestKey);
  }
  return formData;
}

test("the server flag and exact supported shape determine the creation route", () => {
  const eligible = creationForm();
  assert.equal(
    resolveV2SingleMatchCreationRoute(eligible, false),
    "legacy",
  );
  assert.equal(
    resolveV2SingleMatchCreationRoute(eligible, true),
    "v2-create",
  );

  const oldEnabledForm = creationForm({ requestKey: "" });
  assert.equal(
    resolveV2SingleMatchCreationRoute(oldEnabledForm, false),
    "v2-resolve-existing",
  );

  for (const unsupported of [
    creationForm({ type: "double", requestKey: "client-key" }),
    creationForm({ type: "team", requestKey: "client-key" }),
    creationForm({
      format: "group_then_knockout",
      requestKey: "client-key",
    }),
  ]) {
    assert.equal(
      resolveV2SingleMatchCreationRoute(unsupported, false),
      "legacy",
    );
    assert.equal(
      resolveV2SingleMatchCreationRoute(unsupported, true),
      "legacy",
    );
  }
});

test("ambiguous dispatch fields fail closed before either engine is selected", () => {
  const duplicateType = creationForm();
  duplicateType.append("type", "team");
  const duplicateFormat = creationForm();
  duplicateFormat.append("format", "group_then_knockout");
  const duplicateKey = creationForm({ requestKey: "first" });
  duplicateKey.append("creationRequestKey", "second");
  const fileType = creationForm();
  fileType.set("type", new Blob(["single"]), "type.txt");
  const fileKey = creationForm();
  fileKey.set("creationRequestKey", new Blob(["key"]), "key.txt");

  for (const invalid of [
    duplicateType,
    duplicateFormat,
    duplicateKey,
    fileType,
    fileKey,
    creationForm({ type: "singles" }),
    creationForm({ format: "knockout_only" }),
  ]) {
    assert.equal(resolveV2SingleMatchCreationRoute(invalid, false), "invalid");
    assert.equal(resolveV2SingleMatchCreationRoute(invalid, true), "invalid");
  }

  const ignoredDuplicateKey = creationForm({
    type: "double",
    requestKey: "first",
  });
  ignoredDuplicateKey.append("creationRequestKey", "second");
  assert.equal(
    resolveV2SingleMatchCreationRoute(ignoredDuplicateKey, true),
    "legacy",
  );
});

test("a V2 error is returned without invoking another creation path", async () => {
  let createCalls = 0;
  let resolveCalls = 0;
  const formData = creationForm({ requestKey: "request-key" });

  const created = await dispatchV2SingleMatchCreation({
    formData,
    serverEnabled: true,
    createV2: async () => {
      createCalls += 1;
      return { error: "V2 rejected the command" };
    },
    resolveExistingV2: async () => {
      resolveCalls += 1;
      return { success: "unexpected" };
    },
  });
  assert.deepEqual(created, {
    kind: "v2",
    operation: "create",
    state: { error: "V2 rejected the command" },
  });
  assert.equal(createCalls, 1);
  assert.equal(resolveCalls, 0);

  const resolved = await dispatchV2SingleMatchCreation({
    formData,
    serverEnabled: false,
    createV2: async () => {
      createCalls += 1;
      return { success: "unexpected" };
    },
    resolveExistingV2: async () => {
      resolveCalls += 1;
      return { error: "feature disabled" };
    },
  });
  assert.deepEqual(resolved, {
    kind: "v2",
    operation: "resolve-existing",
    state: { error: "feature disabled" },
  });
  assert.equal(createCalls, 1);
  assert.equal(resolveCalls, 1);
});

test("unexpected V2 failures propagate and never fall through to Legacy", async () => {
  const sentinel = new Error("V2 storage failed");
  let resolveCalls = 0;
  await assert.rejects(
    dispatchV2SingleMatchCreation({
      formData: creationForm(),
      serverEnabled: true,
      createV2: async () => {
        throw sentinel;
      },
      resolveExistingV2: async () => {
        resolveCalls += 1;
        return { success: "unexpected" };
      },
    }),
    (error: unknown) => error === sentinel,
  );
  assert.equal(resolveCalls, 0);
});

test("Legacy routes do not invoke either V2 handler", async () => {
  let v2Calls = 0;
  const result = await dispatchV2SingleMatchCreation({
    formData: creationForm({ type: "team", requestKey: "ignored" }),
    serverEnabled: true,
    createV2: async () => {
      v2Calls += 1;
      return { success: "unexpected" };
    },
    resolveExistingV2: async () => {
      v2Calls += 1;
      return { success: "unexpected" };
    },
  });
  assert.deepEqual(result, { kind: "legacy" });
  assert.equal(v2Calls, 0);
});

test("an invalid route is handled as an error without invoking either engine", async () => {
  let v2Calls = 0;
  const formData = creationForm();
  formData.append("format", "group_then_knockout");
  const result = await dispatchV2SingleMatchCreation({
    formData,
    serverEnabled: false,
    createV2: async () => {
      v2Calls += 1;
      return { success: "unexpected" };
    },
    resolveExistingV2: async () => {
      v2Calls += 1;
      return { success: "unexpected" };
    },
  });
  assert.deepEqual(result, {
    kind: "rejected",
    state: { error: "提交的数据无效，请检查后重试。" },
  });
  assert.equal(v2Calls, 0);
});
