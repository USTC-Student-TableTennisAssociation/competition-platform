import type { V2DoubleMatchCreationState } from "./double-match-creation";
import {
  dispatchV2GroupOnlyMatchCreation,
  resolveV2GroupOnlyMatchCreationRoute,
  type V2GroupOnlyMatchCreationDispatch,
  type V2GroupOnlyMatchCreationRoute,
} from "./group-only-match-creation-dispatch";

export type V2DoubleMatchCreationRoute = V2GroupOnlyMatchCreationRoute;
export type V2DoubleMatchCreationDispatch = V2GroupOnlyMatchCreationDispatch;

export function resolveV2DoubleMatchCreationRoute(
  formData: FormData,
  serverEnabled: boolean,
): V2DoubleMatchCreationRoute {
  return resolveV2GroupOnlyMatchCreationRoute(
    formData,
    serverEnabled,
    "double",
  );
}

export function dispatchV2DoubleMatchCreation(input: Readonly<{
  formData: FormData;
  serverEnabled: boolean;
  createV2(formData: FormData): Promise<V2DoubleMatchCreationState>;
  resolveExistingV2(formData: FormData): Promise<V2DoubleMatchCreationState>;
}>): Promise<V2DoubleMatchCreationDispatch> {
  return dispatchV2GroupOnlyMatchCreation({
    ...input,
    eligibleType: "double",
  });
}
