import {
  V2ActionBoundaryError,
  parseV2FixtureTarget,
  readNonNegativeSafeInteger,
  readPlayedCorrectionMode,
  readStableIdentifier,
  type ParsedV2FixtureTarget,
} from "./action-boundary";
import { V2_MAX_TEAM_SCORE_PER_FIXTURE } from "../domain/group-standings";
import type { V2PlayedCorrectionMode } from "../application/results";

const COMMON_FIELDS = ["csrfToken", "fixtureId", "expectedFixtureVersion"] as const;
const SUBMISSION_FIELDS = [
  ...COMMON_FIELDS,
  "winnerEntryId",
  "winnerScore",
  "loserScore",
] as const;
const CORRECTION_FIELDS = [
  ...COMMON_FIELDS,
  "resultRevisionId",
  "correctionMode",
  "winnerScore",
  "loserScore",
] as const;

function assertOnlyFields(formData: FormData, allowed: readonly string[]) {
  const allowedSet = new Set(allowed);
  for (const field of formData.keys()) {
    // React server-action routing metadata is not a competition field.
    if (field.startsWith("$ACTION_")) continue;
    if (!allowedSet.has(field)) {
      const protectedField = [
        "stage",
        "type",
        "format",
        "matchType",
        "actor",
        "actorId",
        "role",
        "loserEntryId",
        "dependencyId",
        "sourceFixtureId",
        "sourceQualificationStandingId",
        "targetSide",
        "nextFixtureId",
        "nextSide",
      ].includes(field);
      throw new V2ActionBoundaryError(
        protectedField ? "PROTECTED_FIELD" : "INVALID_FORM_FIELD",
        `${field} is not accepted by this V2 TEAM result command.`,
        field,
      );
    }
  }
}

function parseAggregateScore(formData: FormData) {
  const winnerScore = readNonNegativeSafeInteger(formData, "winnerScore");
  const loserScore = readNonNegativeSafeInteger(formData, "loserScore");
  if (
    winnerScore > V2_MAX_TEAM_SCORE_PER_FIXTURE ||
    loserScore > V2_MAX_TEAM_SCORE_PER_FIXTURE
  ) {
    throw new V2ActionBoundaryError(
      "INVALID_SCORE",
      `A TEAM aggregate score cannot exceed ${V2_MAX_TEAM_SCORE_PER_FIXTURE}.`,
      winnerScore > V2_MAX_TEAM_SCORE_PER_FIXTURE
        ? "winnerScore"
        : "loserScore",
    );
  }
  if (winnerScore <= loserScore) {
    throw new V2ActionBoundaryError(
      "INVALID_SCORE",
      "A TEAM aggregate score requires the winner total to exceed the loser total.",
      "winnerScore",
    );
  }
  return { winnerScore, loserScore } as const;
}

export type ParsedV2TeamResultSubmission = ParsedV2FixtureTarget &
  Readonly<{
    winnerEntryId: string;
    score: Readonly<{ winnerScore: number; loserScore: number }>;
  }>;

export function parseV2TeamResultSubmission(
  formData: FormData,
): ParsedV2TeamResultSubmission {
  assertOnlyFields(formData, SUBMISSION_FIELDS);
  return {
    ...parseV2FixtureTarget(formData),
    winnerEntryId: readStableIdentifier(formData, "winnerEntryId"),
    score: parseAggregateScore(formData),
  };
}

export type ParsedV2TeamResultCorrection = ParsedV2FixtureTarget &
  Readonly<{
    resultRevisionId: string;
    correctionMode: V2PlayedCorrectionMode;
    score: Readonly<{ winnerScore: number; loserScore: number }>;
  }>;

export function parseV2TeamResultCorrection(
  formData: FormData,
): ParsedV2TeamResultCorrection {
  assertOnlyFields(formData, CORRECTION_FIELDS);
  return {
    ...parseV2FixtureTarget(formData),
    resultRevisionId: readStableIdentifier(formData, "resultRevisionId"),
    correctionMode: readPlayedCorrectionMode(formData),
    score: parseAggregateScore(formData),
  };
}
