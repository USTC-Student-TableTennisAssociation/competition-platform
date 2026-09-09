import assert from "node:assert/strict";
import test from "node:test";

import {
  dispatchV2MatchCreation,
  MATCH_CREATION_PAUSED_MESSAGE,
  resolveV2MatchCreationRoute,
  type V2MatchCreationCapabilities,
  type V2MatchCreationHandlers,
} from "../adapters/group-only-match-creation-dispatch";
import type {
  V2FormalMatchFormat,
  V2GroupOnlyMatchType,
} from "./group-only-match-creation";

const SLICES = [
  ["single", "group_only"],
  ["single", "group_then_knockout"],
  ["double", "group_only"],
  ["double", "group_then_knockout"],
  ["team", "group_only"],
  ["team", "group_then_knockout"],
] as const satisfies ReadonlyArray<
  readonly [V2GroupOnlyMatchType, V2FormalMatchFormat]
>;

function form(
  type: V2GroupOnlyMatchType,
  format: V2FormalMatchFormat,
  requestKey?: string,
) {
  const value = new FormData();
  value.set("type", type);
  value.set("format", format);
  if (requestKey !== undefined) value.set("creationRequestKey", requestKey);
  return value;
}

function capabilities(
  enabled?: readonly [V2GroupOnlyMatchType, V2FormalMatchFormat],
): V2MatchCreationCapabilities {
  return {
    single: {
      group_only:
        enabled?.[0] === "single" && enabled[1] === "group_only",
      group_then_knockout:
        enabled?.[0] === "single" && enabled[1] === "group_then_knockout",
    },
    double: {
      group_only:
        enabled?.[0] === "double" && enabled[1] === "group_only",
      group_then_knockout:
        enabled?.[0] === "double" && enabled[1] === "group_then_knockout",
    },
    team: {
      group_only: enabled?.[0] === "team" && enabled[1] === "group_only",
      group_then_knockout:
        enabled?.[0] === "team" && enabled[1] === "group_then_knockout",
    },
  };
}

function handlers(calls: string[]): V2MatchCreationHandlers {
  const slice = (name: string) => ({
    createV2: async () => {
      calls.push(`${name}:create`);
      return { success: `${name}:created` };
    },
    resolveExistingV2: async () => {
      calls.push(`${name}:resolve`);
      return { error: `${name}:closed` };
    },
  });
  return {
    single: {
      group_only: slice("single:group_only"),
      group_then_knockout: slice("single:group_then_knockout"),
    },
    double: {
      group_only: slice("double:group_only"),
      group_then_knockout: slice("double:group_then_knockout"),
    },
    team: {
      group_only: slice("team:group_only"),
      group_then_knockout: slice("team:group_then_knockout"),
    },
  };
}

test("the exhaustive six-cell capability matrix selects only the exact enabled slice", async () => {
  for (const selected of SLICES) {
    for (const candidate of SLICES) {
      const decision = resolveV2MatchCreationRoute(
        form(candidate[0], candidate[1]),
        capabilities(selected),
      );
      if (candidate[0] === selected[0] && candidate[1] === selected[1]) {
        assert.deepEqual(decision, {
          kind: "v2",
          operation: "create",
          type: candidate[0],
          format: candidate[1],
        });
      } else {
        assert.deepEqual(decision, {
          kind: "legacy",
          type: candidate[0],
          format: candidate[1],
        });
      }
    }

    const calls: string[] = [];
    const dispatched = await dispatchV2MatchCreation({
      formData: form(selected[0], selected[1]),
      capabilities: capabilities(selected),
      handlers: handlers(calls),
    });
    assert.equal(dispatched.kind, "v2");
    assert.deepEqual(calls, [`${selected[0]}:${selected[1]}:create`]);
  }
});

test("a disabled valid slice stays Legacy only when no durable V2 key exists", () => {
  for (const [type, format] of SLICES) {
    assert.deepEqual(
      resolveV2MatchCreationRoute(form(type, format), capabilities()),
      { kind: "legacy", type, format },
    );
    assert.deepEqual(
      resolveV2MatchCreationRoute(
        form(type, format, "durable-v2-key"),
        capabilities(),
      ),
      { kind: "v2", operation: "resolve-existing", type, format },
    );
  }
});

test("PAUSED rejects fresh creation but still resolves an already-issued V2 key", async () => {
  assert.deepEqual(
    resolveV2MatchCreationRoute(
      form("team", "group_then_knockout"),
      capabilities(),
      "paused",
    ),
    { kind: "paused" },
  );
  assert.deepEqual(
    resolveV2MatchCreationRoute(
      form("team", "group_then_knockout", "durable-v2-key"),
      capabilities(),
      "paused",
    ),
    {
      kind: "v2",
      operation: "resolve-existing",
      type: "team",
      format: "group_then_knockout",
    },
  );

  const calls: string[] = [];
  assert.deepEqual(
    await dispatchV2MatchCreation({
      formData: form("single", "group_only"),
      capabilities: capabilities(),
      disabledRoute: "paused",
      handlers: handlers(calls),
    }),
    { kind: "rejected", state: { error: MATCH_CREATION_PAUSED_MESSAGE } },
  );
  assert.deepEqual(calls, []);
});

test("a gate change replays an old key through resolve-existing and never invokes Legacy", async () => {
  const replay = form(
    "double",
    "group_then_knockout",
    "3d594650-3436-4a7f-bd48-9d700f17db33",
  );
  const calls: string[] = [];
  const registry = handlers(calls);

  const initiallyEnabled = await dispatchV2MatchCreation({
    formData: replay,
    capabilities: capabilities(["double", "group_then_knockout"]),
    handlers: registry,
  });
  assert.equal(initiallyEnabled.kind, "v2");
  assert.equal(
    initiallyEnabled.kind === "v2" ? initiallyEnabled.operation : null,
    "create",
  );

  const afterDisable = await dispatchV2MatchCreation({
    formData: replay,
    capabilities: capabilities(),
    handlers: registry,
  });
  assert.deepEqual(afterDisable, {
    kind: "v2",
    operation: "resolve-existing",
    state: { error: "double:group_then_knockout:closed" },
  });
  assert.deepEqual(calls, [
    "double:group_then_knockout:create",
    "double:group_then_knockout:resolve",
  ]);
});

test("ambiguous selectors or request keys fail closed before any handler", async () => {
  const cases = [
    (() => {
      const value = form("single", "group_only");
      value.append("type", "double");
      return value;
    })(),
    (() => {
      const value = form("single", "group_only");
      value.append("format", "group_then_knockout");
      return value;
    })(),
    (() => {
      const value = form("single", "group_only", "first");
      value.append("creationRequestKey", "second");
      return value;
    })(),
    (() => {
      const value = form("single", "group_only");
      value.set("type", new Blob(["single"]), "type.txt");
      return value;
    })(),
  ];

  for (const value of cases) {
    const calls: string[] = [];
    assert.deepEqual(
      await dispatchV2MatchCreation({
        formData: value,
        capabilities: capabilities(["single", "group_only"]),
        handlers: handlers(calls),
      }),
      {
        kind: "rejected",
        state: { error: "提交的数据无效，请检查后重试。" },
      },
    );
    assert.deepEqual(calls, []);
  }
});
