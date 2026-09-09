import type { V2SingleMatchCreationState } from "./single-match-creation";
import {
  MATCH_CREATION_DISPATCH_INVALID_MESSAGE,
  dispatchV2GroupOnlyMatchCreation,
  resolveV2GroupOnlyMatchCreationRoute,
  type V2GroupOnlyMatchCreationDispatch,
  type V2GroupOnlyMatchCreationRoute,
} from "./group-only-match-creation-dispatch";

export { MATCH_CREATION_DISPATCH_INVALID_MESSAGE };
export type V2SingleMatchCreationRoute = V2GroupOnlyMatchCreationRoute;
export type V2SingleMatchCreationDispatch = V2GroupOnlyMatchCreationDispatch;

export function resolveV2SingleMatchCreationRoute(
  formData: FormData,
  serverEnabled: boolean,
): V2SingleMatchCreationRoute {
  return resolveV2GroupOnlyMatchCreationRoute(
    formData,
    serverEnabled,
    "single",
  );
}

export function dispatchV2SingleMatchCreation(input: Readonly<{
  formData: FormData;
  serverEnabled: boolean;
  createV2(formData: FormData): Promise<V2SingleMatchCreationState>;
  resolveExistingV2(formData: FormData): Promise<V2SingleMatchCreationState>;
}>): Promise<V2SingleMatchCreationDispatch> {
  return dispatchV2GroupOnlyMatchCreation({
    ...input,
    eligibleType: "single",
  });
}
