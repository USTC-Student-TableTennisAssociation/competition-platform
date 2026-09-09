import type { V2TeamMatchCreationState } from "./team-match-creation";
import {
  dispatchV2GroupOnlyMatchCreation,
  resolveV2GroupOnlyMatchCreationRoute,
  type V2GroupOnlyMatchCreationDispatch,
  type V2GroupOnlyMatchCreationRoute,
} from "./group-only-match-creation-dispatch";

export type V2TeamMatchCreationRoute = V2GroupOnlyMatchCreationRoute;
export type V2TeamMatchCreationDispatch = V2GroupOnlyMatchCreationDispatch;

export function resolveV2TeamMatchCreationRoute(
  formData: FormData,
  serverEnabled: boolean,
): V2TeamMatchCreationRoute {
  return resolveV2GroupOnlyMatchCreationRoute(formData, serverEnabled, "team");
}

export function dispatchV2TeamMatchCreation(input: Readonly<{
  formData: FormData;
  serverEnabled: boolean;
  createV2(formData: FormData): Promise<V2TeamMatchCreationState>;
  resolveExistingV2(formData: FormData): Promise<V2TeamMatchCreationState>;
}>): Promise<V2TeamMatchCreationDispatch> {
  return dispatchV2GroupOnlyMatchCreation({
    ...input,
    eligibleType: "team",
  });
}
