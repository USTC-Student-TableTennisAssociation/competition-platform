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

export type V2DoubleGroupingSeedMethod = V2GroupOnlyGroupingSeedMethod;
export type V2DoubleGroupingUiPlayer = V2GroupOnlyGroupingUiPlayer;
export type V2DoubleGroupingUiGroup = V2GroupOnlyGroupingUiGroup;
export type V2DoubleGroupingUiPayload =
  V2GroupOnlyGroupingUiPayload<"team">;
export type V2DoubleGroupingUiParseFailure =
  V2GroupOnlyGroupingUiParseFailure;
export type V2DoubleGroupingUiParseResult =
  V2GroupOnlyGroupingUiParseResult<"team">;
export type V2DoubleGroupingPublishIssue =
  V2GroupOnlyGroupingPublishIssue;

export function parseV2DoubleGroupingUiPreview(
  rawJson: unknown,
  expectedMatchId: string,
): V2DoubleGroupingUiParseResult {
  return parseV2GroupOnlyGroupingUiPreview(
    rawJson,
    expectedMatchId,
    "team",
  );
}

export const moveV2DoubleGroupingEntry = moveV2GroupOnlyGroupingEntry;
export function getV2DoubleGroupingPublishIssues(
  payload: V2DoubleGroupingUiPayload,
) {
  return getV2GroupOnlyGroupingPublishIssues(payload, "team");
}

export function serializeV2DoubleGroupingUiPayload(
  payload: V2DoubleGroupingUiPayload,
) {
  return serializeV2GroupOnlyGroupingUiPayload(payload, "team");
}
