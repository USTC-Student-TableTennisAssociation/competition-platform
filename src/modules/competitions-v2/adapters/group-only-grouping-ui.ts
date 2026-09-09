const MAX_GROUP_COUNT = 256;
const MAX_ENTRY_COUNT = 1_024;
const MAX_GROUP_FIXTURE_COUNT = 10_000;
const MAX_PREVIEW_JSON_LENGTH = 512 * 1_024;
const MAX_IDENTIFIER_LENGTH = 191;
const MAX_DISPLAY_NAME_LENGTH = 200;
const MAX_GROUP_NAME_LENGTH = 100;
const MAX_GENERATED_AT_LENGTH = 64;
const POSTGRES_INT_MAX = 2_147_483_647;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export type V2GroupOnlyGroupingSeedMethod = "min_diff" | "snake";
export type V2GroupOnlyGroupingCompetitorType = "user" | "team";
export type V2GroupOnlyGroupingFormat =
  | "group_only"
  | "group_then_knockout";

export type V2GroupOnlyGroupingUiPlayer = Readonly<{
  id: string;
  nickname: string;
  points: number;
  eloRating: number;
}>;

export type V2GroupOnlyGroupingUiGroup = Readonly<{
  name: string;
  players: readonly V2GroupOnlyGroupingUiPlayer[];
  averagePoints: number;
}>;

export type V2GroupOnlyGroupingUiPayload<
  TCompetitorType extends V2GroupOnlyGroupingCompetitorType =
    V2GroupOnlyGroupingCompetitorType,
> = Readonly<{
  generatedAt: string;
  competitorType: TCompetitorType;
  format: V2GroupOnlyGroupingFormat;
  config: Readonly<{
    groupCount: number;
    seedMethod: V2GroupOnlyGroupingSeedMethod;
    qualifiersPerGroup?: number;
  }>;
  groups: readonly V2GroupOnlyGroupingUiGroup[];
  v2Preview: Readonly<{
    schemaVersion: 1;
    matchId: string;
    expectedEntries: readonly Readonly<{
      entryId: string;
      version: number;
    }>[];
  }>;
}>;

export type V2GroupOnlyGroupingUiParseFailure =
  | "EMPTY"
  | "TOO_LARGE"
  | "INVALID_JSON"
  | "MATCH_MISMATCH"
  | "UNSUPPORTED_STRUCTURE";

export type V2GroupOnlyGroupingUiParseResult<
  TCompetitorType extends V2GroupOnlyGroupingCompetitorType,
> =
  | Readonly<{ ok: true; payload: V2GroupOnlyGroupingUiPayload<TCompetitorType> }>
  | Readonly<{ ok: false; reason: V2GroupOnlyGroupingUiParseFailure }>;

export type V2GroupOnlyGroupingPublishIssue =
  | "INVALID_STRUCTURE"
  | "GROUP_TOO_SMALL"
  | "QUALIFIER_CONFIG_INVALID"
  | "ENTRY_SET_MISMATCH"
  | "TOO_MANY_FIXTURES"
  | "PAYLOAD_TOO_LARGE";

class PreviewValidationError extends Error {
  readonly reason: V2GroupOnlyGroupingUiParseFailure;

  constructor(reason: V2GroupOnlyGroupingUiParseFailure) {
    super(reason);
    this.name = "PreviewValidationError";
    this.reason = reason;
  }
}

function fail(reason: V2GroupOnlyGroupingUiParseFailure): never {
  throw new PreviewValidationError(reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
}

function isStableIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value === value.trim() &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function isPostgresInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= POSTGRES_INT_MAX
  );
}

function isFiniteDisplayNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function calculateAverage(players: readonly V2GroupOnlyGroupingUiPlayer[]) {
  if (players.length === 0) return 0;
  return Math.round(
    players.reduce((sum, player) => sum + player.eloRating, 0) / players.length,
  );
}

function parsePlayer(value: unknown): V2GroupOnlyGroupingUiPlayer {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "nickname", "points", "eloRating"]) ||
    !isStableIdentifier(value.id) ||
    !isBoundedString(value.nickname, MAX_DISPLAY_NAME_LENGTH) ||
    !isFiniteDisplayNumber(value.points) ||
    !isFiniteDisplayNumber(value.eloRating)
  ) {
    fail("UNSUPPORTED_STRUCTURE");
  }
  return {
    id: value.id,
    nickname: value.nickname,
    points: value.points,
    eloRating: value.eloRating,
  };
}

function parseGroup(value: unknown): V2GroupOnlyGroupingUiGroup {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["name", "players", "averagePoints"]) ||
    !isBoundedString(value.name, MAX_GROUP_NAME_LENGTH) ||
    !Array.isArray(value.players) ||
    value.players.length < 2 ||
    value.players.length > MAX_ENTRY_COUNT ||
    !isFiniteDisplayNumber(value.averagePoints)
  ) {
    fail("UNSUPPORTED_STRUCTURE");
  }
  return {
    name: value.name,
    players: value.players.map(parsePlayer),
    averagePoints: value.averagePoints,
  };
}

function parseExpectedEntry(value: unknown) {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["entryId", "version"]) ||
    !isStableIdentifier(value.entryId) ||
    !isPostgresInteger(value.version)
  ) {
    fail("UNSUPPORTED_STRUCTURE");
  }
  return { entryId: value.entryId, version: value.version };
}

function validatePayload<
  TCompetitorType extends V2GroupOnlyGroupingCompetitorType,
>(
  value: unknown,
  expectedMatchId: string,
  expectedCompetitorType: TCompetitorType,
  expectedFormat?: V2GroupOnlyGroupingFormat,
): V2GroupOnlyGroupingUiPayload<TCompetitorType> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "generatedAt",
      "competitorType",
      "format",
      "config",
      "groups",
      "v2Preview",
    ]) ||
    !isBoundedString(value.generatedAt, MAX_GENERATED_AT_LENGTH) ||
    value.generatedAt.length === 0 ||
    !Number.isFinite(new Date(value.generatedAt).getTime()) ||
    value.competitorType !== expectedCompetitorType ||
    (value.format !== "group_only" &&
      value.format !== "group_then_knockout") ||
    (expectedFormat !== undefined && value.format !== expectedFormat) ||
    !isRecord(value.config) ||
    !isPostgresInteger(value.config.groupCount) ||
    value.config.groupCount < 1 ||
    value.config.groupCount > MAX_GROUP_COUNT ||
    (value.config.seedMethod !== "min_diff" &&
      value.config.seedMethod !== "snake") ||
    !Array.isArray(value.groups) ||
    value.groups.length !== value.config.groupCount ||
    !isRecord(value.v2Preview) ||
    !hasOnlyKeys(value.v2Preview, [
      "schemaVersion",
      "matchId",
      "expectedEntries",
    ]) ||
    value.v2Preview.schemaVersion !== 1 ||
    !isStableIdentifier(value.v2Preview.matchId) ||
    !Array.isArray(value.v2Preview.expectedEntries) ||
    value.v2Preview.expectedEntries.length < 2 ||
    value.v2Preview.expectedEntries.length > MAX_ENTRY_COUNT
  ) {
    fail("UNSUPPORTED_STRUCTURE");
  }
  const format = value.format;
  const expectedConfigKeys =
    format === "group_then_knockout"
      ? ["groupCount", "qualifiersPerGroup", "seedMethod"]
      : ["groupCount", "seedMethod"];
  if (
    !hasOnlyKeys(value.config, expectedConfigKeys) ||
    (format === "group_then_knockout" &&
      (!isPostgresInteger(value.config.qualifiersPerGroup) ||
        value.config.qualifiersPerGroup < 1))
  ) {
    fail("UNSUPPORTED_STRUCTURE");
  }
  if (value.v2Preview.matchId !== expectedMatchId) {
    fail("MATCH_MISMATCH");
  }

  const groups = value.groups.map(parseGroup);
  const expectedEntries = value.v2Preview.expectedEntries.map(parseExpectedEntry);
  const groupedIds = groups.flatMap((group) =>
    group.players.map((player) => player.id),
  );
  const expectedIds = expectedEntries.map((entry) => entry.entryId);
  if (
    groupedIds.length > MAX_ENTRY_COUNT ||
    new Set(groupedIds).size !== groupedIds.length ||
    new Set(expectedIds).size !== expectedIds.length ||
    groupedIds.length !== expectedIds.length ||
    groupedIds.some((entryId) => !expectedIds.includes(entryId))
  ) {
    fail("UNSUPPORTED_STRUCTURE");
  }

  const fixtureCount = groups.reduce(
    (total, group) =>
      total + (group.players.length * (group.players.length - 1)) / 2,
    0,
  );
  if (fixtureCount > MAX_GROUP_FIXTURE_COUNT) {
    fail("UNSUPPORTED_STRUCTURE");
  }
  const qualifiersPerGroup =
    format === "group_then_knockout"
      ? (value.config.qualifiersPerGroup as number)
      : undefined;
  if (
    qualifiersPerGroup !== undefined &&
    (groups.some((group) => group.players.length < qualifiersPerGroup) ||
      qualifiersPerGroup * groups.length < 2 ||
      !Number.isSafeInteger(qualifiersPerGroup * groups.length) ||
      !Number.isInteger(Math.log2(qualifiersPerGroup * groups.length)))
  ) {
    fail("UNSUPPORTED_STRUCTURE");
  }

  return {
    generatedAt: value.generatedAt,
    competitorType: expectedCompetitorType,
    format,
    config: {
      groupCount: value.config.groupCount,
      seedMethod: value.config.seedMethod,
      ...(qualifiersPerGroup === undefined ? {} : { qualifiersPerGroup }),
    },
    groups,
    v2Preview: {
      schemaVersion: 1,
      matchId: value.v2Preview.matchId,
      expectedEntries,
    },
  };
}

export function parseV2GroupOnlyGroupingUiPreview<
  TCompetitorType extends V2GroupOnlyGroupingCompetitorType,
>(
  rawJson: unknown,
  expectedMatchId: string,
  expectedCompetitorType: TCompetitorType,
  expectedFormat?: V2GroupOnlyGroupingFormat,
): V2GroupOnlyGroupingUiParseResult<TCompetitorType> {
  if (typeof rawJson !== "string" || rawJson.length === 0) {
    return { ok: false, reason: "EMPTY" };
  }
  if (rawJson.length > MAX_PREVIEW_JSON_LENGTH) {
    return { ok: false, reason: "TOO_LARGE" };
  }

  let value: unknown;
  try {
    value = JSON.parse(rawJson);
  } catch {
    return { ok: false, reason: "INVALID_JSON" };
  }

  try {
    return {
      ok: true,
      payload: validatePayload(
        value,
        expectedMatchId,
        expectedCompetitorType,
        expectedFormat,
      ),
    };
  } catch (error) {
    if (error instanceof PreviewValidationError) {
      return { ok: false, reason: error.reason };
    }
    return { ok: false, reason: "UNSUPPORTED_STRUCTURE" };
  }
}

export function moveV2GroupOnlyGroupingEntry<
  TCompetitorType extends V2GroupOnlyGroupingCompetitorType,
>(
  payload: V2GroupOnlyGroupingUiPayload<TCompetitorType>,
  entryId: string,
  sourceGroupIndex: number,
  targetGroupIndex: number,
): V2GroupOnlyGroupingUiPayload<TCompetitorType> | null {
  if (
    !Number.isSafeInteger(sourceGroupIndex) ||
    !Number.isSafeInteger(targetGroupIndex) ||
    sourceGroupIndex < 0 ||
    targetGroupIndex < 0 ||
    sourceGroupIndex >= payload.groups.length ||
    targetGroupIndex >= payload.groups.length ||
    sourceGroupIndex === targetGroupIndex
  ) {
    return null;
  }
  const source = payload.groups[sourceGroupIndex];
  const movingPlayer = source.players.find((player) => player.id === entryId);
  if (
    !movingPlayer ||
    payload.groups.some(
      (group, index) =>
        index !== sourceGroupIndex &&
        group.players.some((player) => player.id === entryId),
    )
  ) {
    return null;
  }

  const groups = payload.groups.map((group, groupIndex) => {
    if (groupIndex === sourceGroupIndex) {
      const players = group.players.filter((player) => player.id !== entryId);
      return { ...group, players, averagePoints: calculateAverage(players) };
    }
    if (groupIndex === targetGroupIndex) {
      const players = [...group.players, movingPlayer];
      return { ...group, players, averagePoints: calculateAverage(players) };
    }
    return group;
  });

  return { ...payload, groups };
}

export function getV2GroupOnlyGroupingPublishIssues(
  payload: V2GroupOnlyGroupingUiPayload,
  expectedCompetitorType?: V2GroupOnlyGroupingCompetitorType,
  expectedFormat?: V2GroupOnlyGroupingFormat,
): readonly V2GroupOnlyGroupingPublishIssue[] {
  const issues = new Set<V2GroupOnlyGroupingPublishIssue>();
  if (
    !isRecord(payload) ||
    !hasOnlyKeys(payload, [
      "generatedAt",
      "competitorType",
      "format",
      "config",
      "groups",
      "v2Preview",
    ]) ||
    (payload.format !== "group_only" &&
      payload.format !== "group_then_knockout") ||
    (expectedFormat !== undefined && payload.format !== expectedFormat) ||
    (payload.competitorType !== "user" && payload.competitorType !== "team") ||
    (expectedCompetitorType !== undefined &&
      payload.competitorType !== expectedCompetitorType) ||
    payload.groups.length !== payload.config.groupCount
  ) {
    issues.add("INVALID_STRUCTURE");
  }
  if (payload.groups.some((group) => group.players.length < 2)) {
    issues.add("GROUP_TOO_SMALL");
  }
  const qualifiersPerGroup = payload.config.qualifiersPerGroup;
  if (
    (payload.format === "group_only" && qualifiersPerGroup !== undefined) ||
    (payload.format === "group_then_knockout" &&
      (!Number.isSafeInteger(qualifiersPerGroup) ||
        (qualifiersPerGroup ?? 0) < 1 ||
        payload.groups.some(
          (group) => group.players.length < (qualifiersPerGroup ?? 0),
        ) ||
        !Number.isSafeInteger((qualifiersPerGroup ?? 0) * payload.groups.length) ||
        (qualifiersPerGroup ?? 0) * payload.groups.length < 2 ||
        !Number.isInteger(
          Math.log2((qualifiersPerGroup ?? 0) * payload.groups.length),
        )))
  ) {
    issues.add("QUALIFIER_CONFIG_INVALID");
  }

  const groupedIds = payload.groups.flatMap((group) =>
    group.players.map((player) => player.id),
  );
  const expectedIds = payload.v2Preview.expectedEntries.map(
    (entry) => entry.entryId,
  );
  if (
    groupedIds.length !== expectedIds.length ||
    new Set(groupedIds).size !== groupedIds.length ||
    new Set(expectedIds).size !== expectedIds.length ||
    groupedIds.some((entryId) => !expectedIds.includes(entryId))
  ) {
    issues.add("ENTRY_SET_MISMATCH");
  }

  const fixtureCount = payload.groups.reduce(
    (total, group) =>
      total + (group.players.length * (group.players.length - 1)) / 2,
    0,
  );
  if (fixtureCount > MAX_GROUP_FIXTURE_COUNT) {
    issues.add("TOO_MANY_FIXTURES");
  }

  try {
    if (JSON.stringify(payload).length > MAX_PREVIEW_JSON_LENGTH) {
      issues.add("PAYLOAD_TOO_LARGE");
    }
  } catch {
    issues.add("INVALID_STRUCTURE");
  }
  return [...issues];
}

export function serializeV2GroupOnlyGroupingUiPayload(
  payload: V2GroupOnlyGroupingUiPayload,
  expectedCompetitorType?: V2GroupOnlyGroupingCompetitorType,
  expectedFormat?: V2GroupOnlyGroupingFormat,
) {
  if (
    getV2GroupOnlyGroupingPublishIssues(
      payload,
      expectedCompetitorType,
      expectedFormat,
    ).length > 0
  ) {
    return null;
  }
  try {
    const serialized = JSON.stringify(payload);
    return serialized.length <= MAX_PREVIEW_JSON_LENGTH ? serialized : null;
  } catch {
    return null;
  }
}
