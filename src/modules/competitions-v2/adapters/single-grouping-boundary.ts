import type { CompetitionFormat } from "@prisma/client";

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

export const V2_SINGLE_GROUPING_PREVIEW_SCHEMA_VERSION =
  V2_GROUP_ONLY_GROUPING_PREVIEW_SCHEMA_VERSION;

export type ParsedV2SingleGroupingPreviewForm =
  ParsedV2GroupOnlyGroupingPreviewForm;
export type ParsedV2SingleGroupingPublication =
  ParsedV2GroupOnlyGroupingPublication;

export const parseV2SingleGroupingPreviewForm =
  parseV2GroupOnlyGroupingPreviewForm;

export function parseV2SingleGroupingPublication(
  formData: FormData,
  expectedMatchId: string,
): ParsedV2SingleGroupingPublication {
  return parseV2GroupOnlyGroupingPublication(formData, expectedMatchId, {
    matchType: "single",
    competitorType: "user",
    label: "SINGLE",
  });
}

export const assertV2SingleGroupingPreviewJsonSize =
  assertV2GroupOnlyGroupingPreviewJsonSize;

export function assertV2GroupingPreviewCapacity(input: Readonly<{
  entryCount: number;
  groupCount: number;
}>) {
  return assertV2GroupOnlyGroupingPreviewCapacity({ ...input, label: "SINGLE" });
}

export function assertV2GroupingPreviewQualifiers(input: Readonly<{
  format: CompetitionFormat;
  entryCount: number;
  groupCount: number;
  qualifiersPerGroup?: number;
}>) {
  return assertV2GroupOnlyGroupingPreviewQualifiers(input);
}
