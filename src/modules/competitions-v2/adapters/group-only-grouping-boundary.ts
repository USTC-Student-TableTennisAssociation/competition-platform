import type { CompetitionFormat } from "@prisma/client";

import type {
  V2GroupOnlyGroupingDraft,
  V2GroupOnlyGroupingExpectedEntry,
} from "../application/group-only-grouping";
import {
  V2ActionBoundaryError,
  parseNonNegativeSafeInteger,
  parseStableIdentifier,
  readOptionalSingleTextField,
  readSingleTextField,
} from "./action-boundary";

export const V2_GROUP_ONLY_GROUPING_PREVIEW_SCHEMA_VERSION = 1;

export type V2GroupOnlyGroupingBoundaryProfile = Readonly<{
  matchType: "single" | "double" | "team";
  competitorType: "user" | "team";
  label: "SINGLE" | "DOUBLE" | "TEAM";
}>;

const MAX_GROUP_COUNT = 256;
const MAX_ENTRY_COUNT = 1_024;
const MAX_GROUP_FIXTURE_COUNT = 10_000;
const MAX_PREVIEW_JSON_LENGTH = 512 * 1_024;
const MAX_DISPLAY_NAME_LENGTH = 200;
const MAX_GROUP_NAME_LENGTH = 100;
const MAX_GENERATED_AT_LENGTH = 64;

const PREVIEW_FORM_FIELDS = [
  "csrfToken",
  "groupCount",
  "qualifiersPerGroup",
  "seedMethod",
] as const;
const PUBLISH_FORM_FIELDS = ["csrfToken", "previewJson"] as const;

export type ParsedV2GroupOnlyGroupingPreviewForm = Readonly<{
  groupCount: number;
  qualifiersPerGroup?: number;
  seedMethod: "min_diff" | "snake";
}>;

export type ParsedV2GroupOnlyGroupingPublication = Readonly<{
  expectedEntries: readonly V2GroupOnlyGroupingExpectedEntry[];
  draft: V2GroupOnlyGroupingDraft;
}>;

function fail(message: string, field?: string): never {
  throw new V2ActionBoundaryError("INVALID_FORM_FIELD", message, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
) {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).every((key) => allowedSet.has(key))) return;
  fail(`${field} contains unsupported fields.`, field);
}

function assertOnlyFormFields(
  formData: FormData,
  allowed: readonly string[],
) {
  const allowedSet = new Set(allowed);
  for (const field of formData.keys()) {
    // React server-action routing metadata is not a competition field.
    if (field.startsWith("$ACTION_")) continue;
    if (!allowedSet.has(field)) {
      fail(`${field} is not accepted by this grouping operation.`, field);
    }
  }
}

function parsePositiveFormInteger(formData: FormData, field: string) {
  const value = parseNonNegativeSafeInteger(
    readSingleTextField(formData, field),
    field,
  );
  if (value < 1) fail(`${field} must be a positive integer.`, field);
  return value;
}

function parseOptionalPositiveFormInteger(formData: FormData, field: string) {
  const raw = readOptionalSingleTextField(formData, field);
  if (raw === undefined) return undefined;
  const value = parseNonNegativeSafeInteger(raw, field);
  if (value < 1) fail(`${field} must be a positive integer.`, field);
  return value;
}

export function parseV2GroupOnlyGroupingPreviewForm(
  formData: FormData,
): ParsedV2GroupOnlyGroupingPreviewForm {
  assertOnlyFormFields(formData, PREVIEW_FORM_FIELDS);
  const groupCount = parsePositiveFormInteger(formData, "groupCount");
  if (groupCount > MAX_GROUP_COUNT) {
    fail(`groupCount must not exceed ${MAX_GROUP_COUNT}.`, "groupCount");
  }
  const qualifiersPerGroup = parseOptionalPositiveFormInteger(
    formData,
    "qualifiersPerGroup",
  );
  const seedMethod = readSingleTextField(formData, "seedMethod");
  if (seedMethod !== "min_diff" && seedMethod !== "snake") {
    fail("seedMethod must be min_diff or snake.", "seedMethod");
  }
  return {
    groupCount,
    ...(qualifiersPerGroup === undefined ? {} : { qualifiersPerGroup }),
    seedMethod,
  };
}

function parseJsonNonNegativeInteger(value: unknown, field: string) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > 2_147_483_647
  ) {
    fail(`${field} must be a non-negative PostgreSQL integer.`, field);
  }
  return value;
}

function parseJsonPositiveInteger(value: unknown, field: string) {
  const parsed = parseJsonNonNegativeInteger(value, field);
  if (parsed < 1) fail(`${field} must be a positive integer.`, field);
  return parsed;
}

function assertBoundedDisplayString(
  value: unknown,
  maximum: number,
  field: string,
) {
  if (typeof value !== "string" || value.length > maximum) {
    fail(`${field} is not a bounded display string.`, field);
  }
}

function assertFiniteDisplayNumber(value: unknown, field: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${field} is not a finite display number.`, field);
  }
}

function parseExpectedEntries(
  value: unknown,
): readonly V2GroupOnlyGroupingExpectedEntry[] {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.length > MAX_ENTRY_COUNT
  ) {
    fail("v2Preview.expectedEntries has an invalid size.", "previewJson");
  }
  const entries = value.map((rawEntry, index) => {
    const field = `v2Preview.expectedEntries[${index}]`;
    if (!isRecord(rawEntry)) fail(`${field} must be an object.`, "previewJson");
    assertOnlyKeys(rawEntry, ["entryId", "version"], field);
    return {
      entryId: parseStableIdentifier(rawEntry.entryId, `${field}.entryId`),
      version: parseJsonNonNegativeInteger(rawEntry.version, `${field}.version`),
    };
  });
  if (new Set(entries.map((entry) => entry.entryId)).size !== entries.length) {
    fail("v2Preview.expectedEntries contains duplicate Entry IDs.", "previewJson");
  }
  return entries;
}

function parseDisplayGroups(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_GROUP_COUNT) {
    fail("groups has an invalid size.", "previewJson");
  }
  let fixtureCount = 0;
  const allEntryIds: string[] = [];
  const groups = value.map((rawGroup, groupIndex) => {
    const groupField = `groups[${groupIndex}]`;
    if (!isRecord(rawGroup)) {
      fail(`${groupField} must be an object.`, "previewJson");
    }
    assertOnlyKeys(rawGroup, ["name", "players", "averagePoints"], groupField);
    assertBoundedDisplayString(
      rawGroup.name,
      MAX_GROUP_NAME_LENGTH,
      `${groupField}.name`,
    );
    assertFiniteDisplayNumber(
      rawGroup.averagePoints,
      `${groupField}.averagePoints`,
    );
    if (
      !Array.isArray(rawGroup.players) ||
      rawGroup.players.length < 2 ||
      rawGroup.players.length > MAX_ENTRY_COUNT
    ) {
      fail(`${groupField}.players must contain at least two entries.`, "previewJson");
    }
    fixtureCount +=
      (rawGroup.players.length * (rawGroup.players.length - 1)) / 2;
    if (fixtureCount > MAX_GROUP_FIXTURE_COUNT) {
      fail(
        `The grouping would create more than ${MAX_GROUP_FIXTURE_COUNT} fixtures.`,
        "previewJson",
      );
    }

    const entryIds = rawGroup.players.map((rawPlayer, playerIndex) => {
      const playerField = `${groupField}.players[${playerIndex}]`;
      if (!isRecord(rawPlayer)) {
        fail(`${playerField} must be an object.`, "previewJson");
      }
      assertOnlyKeys(
        rawPlayer,
        ["id", "nickname", "points", "eloRating"],
        playerField,
      );
      const entryId = parseStableIdentifier(rawPlayer.id, `${playerField}.id`);
      assertBoundedDisplayString(
        rawPlayer.nickname,
        MAX_DISPLAY_NAME_LENGTH,
        `${playerField}.nickname`,
      );
      assertFiniteDisplayNumber(rawPlayer.points, `${playerField}.points`);
      assertFiniteDisplayNumber(rawPlayer.eloRating, `${playerField}.eloRating`);
      allEntryIds.push(entryId);
      return entryId;
    });
    return { entryIds };
  });

  if (allEntryIds.length > MAX_ENTRY_COUNT) {
    fail(`The preview contains more than ${MAX_ENTRY_COUNT} entries.`, "previewJson");
  }
  if (new Set(allEntryIds).size !== allEntryIds.length) {
    fail("An Entry appears more than once in the grouping preview.", "previewJson");
  }
  return { groups, allEntryIds };
}

function assertQualifiers(
  format: CompetitionFormat,
  qualifiersPerGroup: number | undefined,
  groups: readonly Readonly<{ entryIds: readonly string[] }>[],
) {
  if (format === "group_only") {
    if (qualifiersPerGroup !== undefined) {
      fail(
        "qualifiersPerGroup is not accepted for group_only.",
        "previewJson",
      );
    }
    return;
  }
  if (qualifiersPerGroup === undefined) {
    fail("qualifiersPerGroup is required for group_then_knockout.", "previewJson");
  }
  const totalQualified = qualifiersPerGroup * groups.length;
  if (
    !Number.isSafeInteger(totalQualified) ||
    totalQualified < 2 ||
    !Number.isInteger(Math.log2(totalQualified)) ||
    groups.some((group) => group.entryIds.length < qualifiersPerGroup)
  ) {
    fail("The qualifier configuration is inconsistent with the groups.", "previewJson");
  }
}

export function parseV2GroupOnlyGroupingPublication(
  formData: FormData,
  expectedMatchId: string,
  profile: V2GroupOnlyGroupingBoundaryProfile,
): ParsedV2GroupOnlyGroupingPublication {
  assertOnlyFormFields(formData, PUBLISH_FORM_FIELDS);
  const rawJson = readSingleTextField(formData, "previewJson");
  assertV2GroupOnlyGroupingPreviewJsonSize(rawJson);

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(rawJson);
  } catch {
    fail("previewJson must contain valid JSON.", "previewJson");
  }
  if (!isRecord(rawPayload)) {
    fail("previewJson must contain an object.", "previewJson");
  }
  assertOnlyKeys(
    rawPayload,
    [
      "generatedAt",
      "competitorType",
      "format",
      "config",
      "groups",
      "v2Preview",
    ],
    "previewJson",
  );
  if (
    typeof rawPayload.generatedAt !== "string" ||
    rawPayload.generatedAt.length === 0 ||
    rawPayload.generatedAt.length > MAX_GENERATED_AT_LENGTH ||
    !Number.isFinite(new Date(rawPayload.generatedAt).getTime())
  ) {
    fail("generatedAt is invalid.", "previewJson");
  }
  if (rawPayload.competitorType !== profile.competitorType) {
    fail(
      `competitorType must be ${profile.competitorType} for ${profile.label} V2.`,
      "previewJson",
    );
  }
  if (
    rawPayload.format !== "group_only" &&
    rawPayload.format !== "group_then_knockout"
  ) {
    fail("format is invalid.", "previewJson");
  }
  const format = rawPayload.format;

  if (!isRecord(rawPayload.config)) {
    fail("config must be an object.", "previewJson");
  }
  assertOnlyKeys(
    rawPayload.config,
    ["groupCount", "qualifiersPerGroup", "seedMethod"],
    "config",
  );
  const groupCount = parseJsonPositiveInteger(
    rawPayload.config.groupCount,
    "config.groupCount",
  );
  if (groupCount > MAX_GROUP_COUNT) {
    fail(`config.groupCount must not exceed ${MAX_GROUP_COUNT}.`, "previewJson");
  }
  const seedMethod = rawPayload.config.seedMethod;
  if (seedMethod !== "min_diff" && seedMethod !== "snake") {
    fail("config.seedMethod is invalid.", "previewJson");
  }
  const qualifiersPerGroup =
    rawPayload.config.qualifiersPerGroup === undefined
      ? undefined
      : parseJsonPositiveInteger(
          rawPayload.config.qualifiersPerGroup,
          "config.qualifiersPerGroup",
        );

  if (!isRecord(rawPayload.v2Preview)) {
    fail("v2Preview must be an object.", "previewJson");
  }
  assertOnlyKeys(
    rawPayload.v2Preview,
    ["schemaVersion", "matchId", "expectedEntries"],
    "v2Preview",
  );
  if (
    rawPayload.v2Preview.schemaVersion !==
    V2_GROUP_ONLY_GROUPING_PREVIEW_SCHEMA_VERSION
  ) {
    fail("v2Preview.schemaVersion is unsupported.", "previewJson");
  }
  const previewMatchId = parseStableIdentifier(
    rawPayload.v2Preview.matchId,
    "v2Preview.matchId",
  );
  if (previewMatchId !== expectedMatchId) {
    fail("The grouping preview belongs to another match.", "previewJson");
  }
  const expectedEntries = parseExpectedEntries(
    rawPayload.v2Preview.expectedEntries,
  );
  const parsedGroups = parseDisplayGroups(rawPayload.groups);
  if (groupCount !== parsedGroups.groups.length) {
    fail("config.groupCount does not match groups.", "previewJson");
  }
  const expectedIds = new Set(expectedEntries.map((entry) => entry.entryId));
  if (
    expectedIds.size !== parsedGroups.allEntryIds.length ||
    parsedGroups.allEntryIds.some((entryId) => !expectedIds.has(entryId))
  ) {
    fail("The grouped Entries do not match the preview snapshot.", "previewJson");
  }
  assertQualifiers(format, qualifiersPerGroup, parsedGroups.groups);

  return {
    expectedEntries,
    draft: {
      format,
      groups: parsedGroups.groups,
      seedMethod,
      ...(qualifiersPerGroup === undefined ? {} : { qualifiersPerGroup }),
    },
  };
}

export function assertV2GroupOnlyGroupingPreviewJsonSize(rawJson: string) {
  if (rawJson.length === 0 || rawJson.length > MAX_PREVIEW_JSON_LENGTH) {
    fail("previewJson is empty or too large.", "previewJson");
  }
}

export function assertV2GroupOnlyGroupingPreviewCapacity(input: Readonly<{
  entryCount: number;
  groupCount: number;
  label?: "SINGLE" | "DOUBLE" | "TEAM";
}>) {
  if (input.entryCount < 2 || input.entryCount > MAX_ENTRY_COUNT) {
    fail(
      `${input.label ?? "V2"} grouping requires 2-${MAX_ENTRY_COUNT} active Entries.`,
    );
  }
  if (
    input.groupCount < 1 ||
    input.groupCount > MAX_GROUP_COUNT ||
    input.groupCount * 2 > input.entryCount
  ) {
    fail(`Every ${input.label ?? "V2"} group must contain at least two Entries.`);
  }
  const baseSize = Math.floor(input.entryCount / input.groupCount);
  const remainder = input.entryCount % input.groupCount;
  const fixtureCount =
    remainder * ((baseSize + 1) * baseSize) / 2 +
    (input.groupCount - remainder) * (baseSize * (baseSize - 1)) / 2;
  if (fixtureCount > MAX_GROUP_FIXTURE_COUNT) {
    fail(
      `The grouping would create more than ${MAX_GROUP_FIXTURE_COUNT} fixtures.`,
    );
  }
}

export function assertV2GroupOnlyGroupingPreviewQualifiers(input: Readonly<{
  format: CompetitionFormat;
  entryCount: number;
  groupCount: number;
  qualifiersPerGroup?: number;
}>) {
  if (input.format === "group_only") {
    if (input.qualifiersPerGroup !== undefined) {
      fail("qualifiersPerGroup is not accepted for group_only.");
    }
    return;
  }
  if (input.qualifiersPerGroup === undefined) {
    fail("qualifiersPerGroup is required for group_then_knockout.");
  }
  const smallestGroupSize = Math.floor(input.entryCount / input.groupCount);
  const totalQualified = input.qualifiersPerGroup * input.groupCount;
  if (
    input.qualifiersPerGroup > smallestGroupSize ||
    totalQualified < 2 ||
    !Number.isSafeInteger(totalQualified) ||
    !Number.isInteger(Math.log2(totalQualified))
  ) {
    fail("The qualifier configuration is inconsistent with the groups.");
  }
}
