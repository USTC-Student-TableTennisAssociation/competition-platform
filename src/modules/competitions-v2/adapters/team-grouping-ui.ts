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

export type V2TeamGroupingSeedMethod = V2GroupOnlyGroupingSeedMethod;
export type V2TeamGroupingUiPlayer = V2GroupOnlyGroupingUiPlayer;
export type V2TeamGroupingUiGroup = V2GroupOnlyGroupingUiGroup;
export type V2TeamGroupingUiPayload = V2GroupOnlyGroupingUiPayload<"team">;
export type V2TeamGroupingUiParseFailure =
  V2GroupOnlyGroupingUiParseFailure;
export type V2TeamGroupingUiParseResult =
  V2GroupOnlyGroupingUiParseResult<"team">;
export type V2TeamGroupingPublishIssue = V2GroupOnlyGroupingPublishIssue;

export function parseV2TeamGroupingUiPreview(
  rawJson: unknown,
  expectedMatchId: string,
): V2TeamGroupingUiParseResult {
  return parseV2GroupOnlyGroupingUiPreview(rawJson, expectedMatchId, "team");
}

export const moveV2TeamGroupingEntry = moveV2GroupOnlyGroupingEntry;

export function getV2TeamGroupingPublishIssues(
  payload: V2TeamGroupingUiPayload,
) {
  return getV2GroupOnlyGroupingPublishIssues(payload, "team");
}

export function serializeV2TeamGroupingUiPayload(
  payload: V2TeamGroupingUiPayload,
) {
  return serializeV2GroupOnlyGroupingUiPayload(payload, "team");
}
