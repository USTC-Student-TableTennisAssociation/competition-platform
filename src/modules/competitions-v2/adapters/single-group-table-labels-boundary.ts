import type { V2SingleGroupExpectedFixture } from "../application/group-table-labels";
import {
  V2_GROUP_TABLE_LABEL_MAX_COUNT,
  V2_GROUP_TABLE_LABEL_MAX_LENGTH,
  isValidV2GroupTableLabels,
} from "../domain/group-fixture-metadata";
import {
  V2ActionBoundaryError,
  parseStableIdentifier,
  readSingleTextField,
  readStableIdentifier,
} from "./action-boundary";

const FORM_FIELDS = [
  "csrfToken",
  "groupKey",
  "expectedFixturesJson",
  "labelsJson",
] as const;
const MAX_FIXTURE_COUNT = 10_000;
const MAX_EXPECTED_FIXTURES_JSON_LENGTH = 1024 * 1024;
const MAX_LABELS_JSON_LENGTH = 16 * 1024;

export type ParsedV2SingleGroupTableLabelsForm = Readonly<{
  groupKey: string;
  expectedFixtures: readonly V2SingleGroupExpectedFixture[];
  labels: readonly string[];
}>;

function fail(message: string, field: string): never {
  throw new V2ActionBoundaryError("INVALID_FORM_FIELD", message, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyFormFields(formData: FormData) {
  const allowed = new Set<string>(FORM_FIELDS);
  for (const field of formData.keys()) {
    // React server-action routing metadata is not a competition field.
    if (field.startsWith("$ACTION_")) continue;
    if (!allowed.has(field)) {
      fail(`${field} is not accepted by this label operation.`, field);
    }
  }
}

function parseJson(raw: string, maximum: number, field: string): unknown {
  if (raw.length < 1 || raw.length > maximum) {
    fail(`${field} is empty or too large.`, field);
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail(`${field} must contain valid JSON.`, field);
  }
}

function parseExpectedFixtures(
  raw: string,
): readonly V2SingleGroupExpectedFixture[] {
  const value = parseJson(
    raw,
    MAX_EXPECTED_FIXTURES_JSON_LENGTH,
    "expectedFixturesJson",
  );
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FIXTURE_COUNT) {
    fail("expectedFixturesJson has an invalid size.", "expectedFixturesJson");
  }
  const fixtures = value.map((rawFixture, index) => {
    if (
      !isRecord(rawFixture) ||
      Object.keys(rawFixture).length !== 2 ||
      !("fixtureId" in rawFixture) ||
      !("version" in rawFixture)
    ) {
      fail(
        `expectedFixturesJson[${index}] must contain only fixtureId and version.`,
        "expectedFixturesJson",
      );
    }
    if (
      typeof rawFixture.version !== "number" ||
      !Number.isSafeInteger(rawFixture.version) ||
      rawFixture.version < 0 ||
      rawFixture.version > 2_147_483_647
    ) {
      fail(
        `expectedFixturesJson[${index}].version is invalid.`,
        "expectedFixturesJson",
      );
    }
    return {
      fixtureId: parseStableIdentifier(
        rawFixture.fixtureId,
        `expectedFixturesJson[${index}].fixtureId`,
      ),
      version: rawFixture.version,
    };
  });
  if (new Set(fixtures.map((fixture) => fixture.fixtureId)).size !== fixtures.length) {
    fail("expectedFixturesJson contains duplicate Fixture IDs.", "expectedFixturesJson");
  }
  return fixtures;
}

function parseLabels(raw: string) {
  const value = parseJson(raw, MAX_LABELS_JSON_LENGTH, "labelsJson");
  if (!isValidV2GroupTableLabels(value)) {
    fail(
      `labelsJson must contain at most ${V2_GROUP_TABLE_LABEL_MAX_COUNT} unique, trimmed strings of at most ${V2_GROUP_TABLE_LABEL_MAX_LENGTH} characters.`,
      "labelsJson",
    );
  }
  return [...value];
}

export function parseV2SingleGroupTableLabelsForm(
  formData: FormData,
): ParsedV2SingleGroupTableLabelsForm {
  assertOnlyFormFields(formData);
  return {
    groupKey: readStableIdentifier(formData, "groupKey"),
    expectedFixtures: parseExpectedFixtures(
      readSingleTextField(formData, "expectedFixturesJson"),
    ),
    labels: parseLabels(readSingleTextField(formData, "labelsJson")),
  };
}
