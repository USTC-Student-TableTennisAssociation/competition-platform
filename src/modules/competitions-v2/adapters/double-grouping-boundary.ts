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

export const V2_DOUBLE_GROUPING_PREVIEW_SCHEMA_VERSION =
  V2_GROUP_ONLY_GROUPING_PREVIEW_SCHEMA_VERSION;

export type ParsedV2DoubleGroupingPreviewForm =
  ParsedV2GroupOnlyGroupingPreviewForm;
export type ParsedV2DoubleGroupingPublication =
  ParsedV2GroupOnlyGroupingPublication;

export const parseV2DoubleGroupingPreviewForm =
  parseV2GroupOnlyGroupingPreviewForm;

export function parseV2DoubleGroupingPublication(
  formData: FormData,
  expectedMatchId: string,
): ParsedV2DoubleGroupingPublication {
  return parseV2GroupOnlyGroupingPublication(formData, expectedMatchId, {
    matchType: "double",
    competitorType: "team",
    label: "DOUBLE",
  });
}

export const assertV2DoubleGroupingPreviewJsonSize =
  assertV2GroupOnlyGroupingPreviewJsonSize;

export function assertV2DoubleGroupingPreviewCapacity(input: Readonly<{
  entryCount: number;
  groupCount: number;
}>) {
  return assertV2GroupOnlyGroupingPreviewCapacity({ ...input, label: "DOUBLE" });
}

export const assertV2DoubleGroupingPreviewQualifiers =
  assertV2GroupOnlyGroupingPreviewQualifiers;
