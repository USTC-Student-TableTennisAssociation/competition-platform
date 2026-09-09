import {
  V2_GROUP_ONLY_GROUPING_PREVIEW_SCHEMA_VERSION,
  assertV2GroupOnlyGroupingPreviewCapacity,
  assertV2GroupOnlyGroupingPreviewJsonSize,
  assertV2GroupOnlyGroupingPreviewQualifiers,
  parseV2GroupOnlyGroupingPreviewForm,
  parseV2GroupOnlyGroupingPublication,
  type ParsedV2GroupOnlyGroupingPreviewForm,
  type ParsedV2GroupOnlyGroupingPublication,
} from "./group-only-grouping-boundary";

export const V2_TEAM_GROUPING_PREVIEW_SCHEMA_VERSION =
  V2_GROUP_ONLY_GROUPING_PREVIEW_SCHEMA_VERSION;

export type ParsedV2TeamGroupingPreviewForm =
  ParsedV2GroupOnlyGroupingPreviewForm;
export type ParsedV2TeamGroupingPublication =
  ParsedV2GroupOnlyGroupingPublication;

export const parseV2TeamGroupingPreviewForm =
  parseV2GroupOnlyGroupingPreviewForm;

export function parseV2TeamGroupingPublication(
  formData: FormData,
  expectedMatchId: string,
): ParsedV2TeamGroupingPublication {
  return parseV2GroupOnlyGroupingPublication(formData, expectedMatchId, {
    matchType: "team",
    competitorType: "team",
    label: "TEAM",
  });
}

export const assertV2TeamGroupingPreviewJsonSize =
  assertV2GroupOnlyGroupingPreviewJsonSize;

export function assertV2TeamGroupingPreviewCapacity(input: Readonly<{
  entryCount: number;
  groupCount: number;
}>) {
  return assertV2GroupOnlyGroupingPreviewCapacity({ ...input, label: "TEAM" });
}

export const assertV2TeamGroupingPreviewQualifiers =
  assertV2GroupOnlyGroupingPreviewQualifiers;
