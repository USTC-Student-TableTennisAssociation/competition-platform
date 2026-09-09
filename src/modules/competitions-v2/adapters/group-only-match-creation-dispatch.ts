import type { V2GroupOnlyMatchCreationState } from "./group-only-match-creation";
import type {
  V2FormalMatchFormat,
  V2GroupOnlyMatchType,
} from "../application/group-only-match-creation";

export type V2MatchCreationCapabilities = Readonly<
  Record<
    V2GroupOnlyMatchType,
    Readonly<Record<V2FormalMatchFormat, boolean>>
  >
>;

export type V2MatchCreationDisabledRoute = "legacy" | "paused";

export type V2MatchCreationHandler = (
  formData: FormData,
) => Promise<V2GroupOnlyMatchCreationState>;

export type V2MatchCreationHandlers = Readonly<
  Record<
    V2GroupOnlyMatchType,
    Readonly<
      Record<
        V2FormalMatchFormat,
        Readonly<{
          createV2: V2MatchCreationHandler;
          resolveExistingV2: V2MatchCreationHandler;
        }>
      >
    >
  >
>;

export type V2MatchCreationDecision =
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "paused" }>
  | Readonly<{
      kind: "legacy";
      type: V2GroupOnlyMatchType;
      format: V2FormalMatchFormat;
    }>
  | Readonly<{
      kind: "v2";
      operation: "create" | "resolve-existing";
      type: V2GroupOnlyMatchType;
      format: V2FormalMatchFormat;
    }>;

export type V2GroupOnlyMatchCreationRoute =
  | "legacy"
  | "v2-create"
  | "v2-resolve-existing"
  | "invalid";

export const MATCH_CREATION_DISPATCH_INVALID_MESSAGE =
  "提交的数据无效，请检查后重试。";
export const MATCH_CREATION_PAUSED_MESSAGE =
  "比赛创建正在切换或维护中，请稍后刷新后重试。";

function uniqueDispatchTextField(
  formData: FormData,
  field: "type" | "format",
  legacyDefault: string,
) {
  const values = formData.getAll(field);
  if (values.length === 0) return legacyDefault;
  if (values.length !== 1 || typeof values[0] !== "string") return null;
  return values[0];
}

function hasOneTextRequestKey(formData: FormData) {
  const values = formData.getAll("creationRequestKey");
  if (values.length === 0) return { valid: true, present: false } as const;
  if (values.length !== 1 || typeof values[0] !== "string") {
    return { valid: false, present: true } as const;
  }
  return { valid: true, present: true } as const;
}

function isV2MatchType(value: string): value is V2GroupOnlyMatchType {
  return value === "single" || value === "double" || value === "team";
}

function isV2MatchFormat(value: string): value is V2FormalMatchFormat {
  return value === "group_only" || value === "group_then_knockout";
}

/**
 * Selects exactly one type x format slice from server-owned capabilities.
 * A durable key always stays on V2 so a gate change cannot silently create a
 * second Legacy match; without a key, a disabled valid slice retains Legacy.
 */
export function resolveV2MatchCreationRoute(
  formData: FormData,
  capabilities: V2MatchCreationCapabilities,
  disabledRoute: V2MatchCreationDisabledRoute = "legacy",
): V2MatchCreationDecision {
  const type = uniqueDispatchTextField(formData, "type", "single");
  const format = uniqueDispatchTextField(formData, "format", "group_only");
  if (
    type === null ||
    format === null ||
    !isV2MatchType(type) ||
    !isV2MatchFormat(format)
  ) {
    return { kind: "invalid" };
  }
  const requestKey = hasOneTextRequestKey(formData);
  if (!requestKey.valid) return { kind: "invalid" };
  if (capabilities[type][format] === true) {
    return { kind: "v2", operation: "create", type, format };
  }
  if (requestKey.present) {
    return { kind: "v2", operation: "resolve-existing", type, format };
  }
  if (disabledRoute === "paused") return { kind: "paused" };
  return { kind: "legacy", type, format };
}

export function resolveV2GroupOnlyMatchCreationRoute(
  formData: FormData,
  serverEnabled: boolean,
  eligibleType: "single" | "double" | "team",
): V2GroupOnlyMatchCreationRoute {
  const type = uniqueDispatchTextField(formData, "type", "single");
  const format = uniqueDispatchTextField(formData, "format", "group_only");
  if (
    type === null ||
    format === null ||
    !["single", "double", "team"].includes(type) ||
    !["group_only", "group_then_knockout"].includes(format)
  ) {
    return "invalid";
  }
  if (type !== eligibleType || format !== "group_only") return "legacy";
  const requestKey = hasOneTextRequestKey(formData);
  if (!requestKey.valid) return "invalid";
  if (serverEnabled) return "v2-create";
  if (requestKey.present) return "v2-resolve-existing";
  return "legacy";
}

export type V2GroupOnlyMatchCreationDispatch =
  | Readonly<{ kind: "legacy" }>
  | Readonly<{ kind: "rejected"; state: V2GroupOnlyMatchCreationState }>
  | Readonly<{
      kind: "v2";
      operation: "create" | "resolve-existing";
      state: V2GroupOnlyMatchCreationState;
    }>;

export type V2MatchCreationDispatch = V2GroupOnlyMatchCreationDispatch;

export async function dispatchV2MatchCreation(input: Readonly<{
  formData: FormData;
  capabilities: V2MatchCreationCapabilities;
  disabledRoute?: V2MatchCreationDisabledRoute;
  handlers: V2MatchCreationHandlers;
}>): Promise<V2MatchCreationDispatch> {
  const decision = resolveV2MatchCreationRoute(
    input.formData,
    input.capabilities,
    input.disabledRoute,
  );
  if (decision.kind === "legacy") return { kind: "legacy" };
  if (decision.kind === "invalid") {
    return {
      kind: "rejected",
      state: { error: MATCH_CREATION_DISPATCH_INVALID_MESSAGE },
    };
  }
  if (decision.kind === "paused") {
    return {
      kind: "rejected",
      state: { error: MATCH_CREATION_PAUSED_MESSAGE },
    };
  }
  const slice = input.handlers[decision.type][decision.format];
  const state =
    decision.operation === "create"
      ? await slice.createV2(input.formData)
      : await slice.resolveExistingV2(input.formData);
  return { kind: "v2", operation: decision.operation, state };
}

export async function dispatchV2GroupOnlyMatchCreation(input: Readonly<{
  formData: FormData;
  serverEnabled: boolean;
  eligibleType: "single" | "double" | "team";
  createV2(formData: FormData): Promise<V2GroupOnlyMatchCreationState>;
  resolveExistingV2(
    formData: FormData,
  ): Promise<V2GroupOnlyMatchCreationState>;
}>): Promise<V2GroupOnlyMatchCreationDispatch> {
  const route = resolveV2GroupOnlyMatchCreationRoute(
    input.formData,
    input.serverEnabled,
    input.eligibleType,
  );
  if (route === "legacy") return { kind: "legacy" };
  if (route === "invalid") {
    return {
      kind: "rejected",
      state: { error: MATCH_CREATION_DISPATCH_INVALID_MESSAGE },
    };
  }
  const operation = route === "v2-create" ? "create" : "resolve-existing";
  const state =
    operation === "create"
      ? await input.createV2(input.formData)
      : await input.resolveExistingV2(input.formData);
  return { kind: "v2", operation, state };
}
