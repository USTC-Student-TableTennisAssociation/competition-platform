import {
  getV2GroupOnlyGroupingPublishIssues,
  moveV2GroupOnlyGroupingEntry,
  parseV2GroupOnlyGroupingUiPreview,
  serializeV2GroupOnlyGroupingUiPayload,
  type V2GroupOnlyGroupingPublishIssue,
  type V2GroupOnlyGroupingSeedMethod,
  type V2GroupOnlyGroupingUiGroup,
  type V2GroupOnlyGroupingUiParseFailure,
  type V2GroupOnlyGroupingUiParseResult,
  type V2GroupOnlyGroupingUiPayload,
  type V2GroupOnlyGroupingUiPlayer,
} from "./group-only-grouping-ui";

export type V2SingleGroupingSeedMethod = V2GroupOnlyGroupingSeedMethod;
export type V2SingleGroupingUiPlayer = V2GroupOnlyGroupingUiPlayer;
export type V2SingleGroupingUiGroup = V2GroupOnlyGroupingUiGroup;
export type V2SingleGroupingUiPayload =
  V2GroupOnlyGroupingUiPayload<"user">;
export type V2SingleGroupingUiParseFailure =
  V2GroupOnlyGroupingUiParseFailure;
export type V2SingleGroupingUiParseResult =
  V2GroupOnlyGroupingUiParseResult<"user">;
export type V2SingleGroupingPublishIssue =
  V2GroupOnlyGroupingPublishIssue;

export function parseV2SingleGroupingUiPreview(
  rawJson: unknown,
  expectedMatchId: string,
): V2SingleGroupingUiParseResult {
  return parseV2GroupOnlyGroupingUiPreview(
    rawJson,
    expectedMatchId,
    "user",
  );
}

export const moveV2SingleGroupingEntry = moveV2GroupOnlyGroupingEntry;
export function getV2SingleGroupingPublishIssues(
  payload: V2SingleGroupingUiPayload,
) {
  return getV2GroupOnlyGroupingPublishIssues(payload, "user");
}

export function serializeV2SingleGroupingUiPayload(
  payload: V2SingleGroupingUiPayload,
) {
  return serializeV2GroupOnlyGroupingUiPayload(payload, "user");
}
