const PUBLICATION_NAME = "V2_SINGLE_GROUPING";
const PUBLICATION_VERSION = 1;
const DISPLAY_SCHEMA_VERSION = 1;
const POSTGRES_INT_MAX = 2_147_483_647;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export const V2_GROUP_TABLE_LABEL_MAX_COUNT = 32;
export const V2_GROUP_TABLE_LABEL_MAX_LENGTH = 64;

const IMMUTABLE_KEYS = [
  "publication",
  "publicationVersion",
  "groupIndex",
  "groupName",
  "format",
  "qualifiersPerGroup",
  "seedMethod",
  "sideAPosition",
  "sideBPosition",
] as const;
const ROOT_KEYS = [...IMMUTABLE_KEYS, "v2Display"] as const;
const DISPLAY_KEYS = ["schemaVersion", "tableLabels"] as const;

export type V2SingleGroupFixturePublicationMetadata = Readonly<{
  publication: typeof PUBLICATION_NAME;
  publicationVersion: typeof PUBLICATION_VERSION;
  groupIndex: number;
  groupName: string;
  format: "group_only";
  qualifiersPerGroup: null;
  seedMethod: "min_diff" | "snake";
  sideAPosition: number;
  sideBPosition: number;
}>;

export type V2SingleGroupFixtureMetadata = Readonly<{
  publication: V2SingleGroupFixturePublicationMetadata;
  tableLabels: readonly string[];
  hasDisplayMetadata: boolean;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
) {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isPositivePostgresInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= POSTGRES_INT_MAX
  );
}

export function isValidV2GroupTableLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= V2_GROUP_TABLE_LABEL_MAX_LENGTH &&
    value === value.trim() &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

export function isValidV2GroupTableLabels(
  value: unknown,
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= V2_GROUP_TABLE_LABEL_MAX_COUNT &&
    value.every(isValidV2GroupTableLabel) &&
    new Set(value).size === value.length
  );
}

/**
 * Parses the complete, server-owned metadata contract for a published V2
 * SINGLE group fixture. Unknown root/display fields fail closed. The mutable
 * display namespace is deliberately separate from the immutable publication
 * identity so a publication retry can ignore a later label edit.
 */
export function parseV2SingleGroupFixtureMetadata(
  value: unknown,
): V2SingleGroupFixtureMetadata | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ROOT_KEYS)) return null;
  if (
    value.publication !== PUBLICATION_NAME ||
    value.publicationVersion !== PUBLICATION_VERSION ||
    !isPositivePostgresInteger(value.groupIndex) ||
    value.groupName !== `第 ${value.groupIndex} 组` ||
    value.format !== "group_only" ||
    value.qualifiersPerGroup !== null ||
    (value.seedMethod !== "min_diff" && value.seedMethod !== "snake") ||
    !isPositivePostgresInteger(value.sideAPosition) ||
    !isPositivePostgresInteger(value.sideBPosition) ||
    value.sideAPosition >= value.sideBPosition
  ) {
    return null;
  }

  const publication: V2SingleGroupFixturePublicationMetadata = {
    publication: value.publication,
    publicationVersion: value.publicationVersion,
    groupIndex: value.groupIndex,
    groupName: value.groupName,
    format: value.format,
    qualifiersPerGroup: value.qualifiersPerGroup,
    seedMethod: value.seedMethod,
    sideAPosition: value.sideAPosition,
    sideBPosition: value.sideBPosition,
  };

  if (value.v2Display === undefined) {
    return { publication, tableLabels: [], hasDisplayMetadata: false };
  }
  if (
    !isRecord(value.v2Display) ||
    !hasOnlyKeys(value.v2Display, DISPLAY_KEYS) ||
    value.v2Display.schemaVersion !== DISPLAY_SCHEMA_VERSION ||
    !isValidV2GroupTableLabels(value.v2Display.tableLabels)
  ) {
    return null;
  }
  return {
    publication,
    tableLabels: [...value.v2Display.tableLabels],
    hasDisplayMetadata: true,
  };
}

/**
 * Read-model parser for the mutable display namespace only. It intentionally
 * ignores every non-display metadata field, treats a missing namespace as the
 * pre-label empty state, and rejects malformed/extended display objects.
 */
export function parseV2SingleGroupTableLabelsFromMetadata(
  value: unknown,
): readonly string[] | null {
  if (value === null || value === undefined) return [];
  if (!isRecord(value)) return null;
  if (value.v2Display === undefined) return [];
  if (
    !isRecord(value.v2Display) ||
    !hasOnlyKeys(value.v2Display, DISPLAY_KEYS) ||
    value.v2Display.schemaVersion !== DISPLAY_SCHEMA_VERSION ||
    !isValidV2GroupTableLabels(value.v2Display.tableLabels)
  ) {
    return null;
  }
  return [...value.v2Display.tableLabels];
}

export function sameV2SingleGroupFixturePublication(
  left: unknown,
  right: unknown,
) {
  const parsedLeft = parseV2SingleGroupFixtureMetadata(left);
  const parsedRight = parseV2SingleGroupFixtureMetadata(right);
  if (!parsedLeft || !parsedRight) return false;
  return IMMUTABLE_KEYS.every(
    (key) => parsedLeft.publication[key] === parsedRight.publication[key],
  );
}

export function sameV2GroupTableLabels(
  left: readonly string[],
  right: readonly string[],
) {
  return (
    left.length === right.length &&
    left.every((label, index) => label === right[index])
  );
}

export function buildV2SingleGroupFixtureMetadata(
  publication: V2SingleGroupFixturePublicationMetadata,
  tableLabels: readonly string[],
) {
  if (!isValidV2GroupTableLabels(tableLabels)) return null;
  return {
    ...publication,
    v2Display: {
      schemaVersion: DISPLAY_SCHEMA_VERSION,
      tableLabels: [...tableLabels],
    },
  };
}
