import {
  V2ActionBoundaryError,
  parseSingleResultCorrection,
  parseV2FixtureTarget,
  parseV2RevisionTarget,
  readNonNegativeSafeInteger,
  readOptionalReason,
  readStableIdentifier,
  type ParsedSingleResultCorrection,
  type ParsedV2FixtureTarget,
  type ParsedV2RevisionTarget,
} from "./action-boundary";

const COMMON_FIELDS = ["csrfToken", "fixtureId", "expectedFixtureVersion"] as const;
const SUBMISSION_FIELDS = [
  ...COMMON_FIELDS,
  "winnerEntryId",
  "bestOf",
  "winnerScore",
  "loserScore",
] as const;
const CORRECTION_FIELDS = [
  ...COMMON_FIELDS,
  "resultRevisionId",
  "correctionMode",
  "bestOf",
  "winnerScore",
  "loserScore",
] as const;
const REVISION_FIELDS = [...COMMON_FIELDS, "resultRevisionId"] as const;
const REVISION_WITH_REASON_FIELDS = [...REVISION_FIELDS, "reason"] as const;
const FORFEIT_FIELDS = [
  ...COMMON_FIELDS,
  "winnerEntryId",
  "reason",
] as const;
const FORFEIT_CORRECTION_FIELDS = [
  ...COMMON_FIELDS,
  "resultRevisionId",
  "reason",
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
        protectedField ||
          (field === "loserEntryId" && allowed === FORFEIT_FIELDS) ||
          ((field === "winnerEntryId" || field === "loserEntryId") &&
            allowed === FORFEIT_CORRECTION_FIELDS)
          ? "PROTECTED_FIELD"
          : "INVALID_FORM_FIELD",
        `${field} is not accepted by this V2 group-only result command.`,
        field,
      );
    }
  }
}

export type ParsedV2GroupOnlyResultSubmission = ParsedV2FixtureTarget &
  Readonly<{
    winnerEntryId: string;
    score: Readonly<{
      bestOf: 3 | 5 | 7;
      winnerScore: number;
      loserScore: number;
      text: string;
    }>;
  }>;
export type ParsedV2GroupOnlyResultCorrection = ParsedSingleResultCorrection;
export type ParsedV2GroupOnlyFixtureTarget = ParsedV2FixtureTarget;
export type ParsedV2GroupOnlyRevisionTarget = ParsedV2RevisionTarget;

export function parseV2GroupOnlyResultSubmission(
  formData: FormData,
): ParsedV2GroupOnlyResultSubmission {
  assertOnlyFields(formData, SUBMISSION_FIELDS);
  const bestOfValue = readNonNegativeSafeInteger(formData, "bestOf");
  if (bestOfValue !== 3 && bestOfValue !== 5 && bestOfValue !== 7) {
    throw new V2ActionBoundaryError(
      "INVALID_SCORE",
      "bestOf must be 3, 5, or 7.",
      "bestOf",
    );
  }
  const bestOf: 3 | 5 | 7 = bestOfValue;
  const winnerScore = readNonNegativeSafeInteger(formData, "winnerScore");
  const loserScore = readNonNegativeSafeInteger(formData, "loserScore");
  const winsNeeded = (bestOf + 1) / 2;
  if (winnerScore !== winsNeeded || loserScore >= winsNeeded) {
    throw new V2ActionBoundaryError(
      "INVALID_SCORE",
      "The score is inconsistent with the declared winner.",
      "winnerScore",
    );
  }
  return {
    ...parseV2FixtureTarget(formData),
    winnerEntryId: readStableIdentifier(formData, "winnerEntryId"),
    score: {
      bestOf,
      winnerScore,
      loserScore,
      text: `${winnerScore}:${loserScore}（${bestOf}局${winsNeeded}胜）`,
    },
  };
}

export function parseV2GroupOnlyResultCorrection(
  formData: FormData,
): ParsedV2GroupOnlyResultCorrection {
  assertOnlyFields(formData, CORRECTION_FIELDS);
  return parseSingleResultCorrection(formData);
}

export function parseV2GroupOnlyFixtureTarget(
  formData: FormData,
): ParsedV2GroupOnlyFixtureTarget {
  assertOnlyFields(formData, COMMON_FIELDS);
  return parseV2FixtureTarget(formData);
}

export function parseV2GroupOnlyRevisionTarget(
  formData: FormData,
  options: Readonly<{ includeReason?: boolean }> = {},
): ParsedV2GroupOnlyRevisionTarget {
  assertOnlyFields(
    formData,
    options.includeReason ? REVISION_WITH_REASON_FIELDS : REVISION_FIELDS,
  );
  return parseV2RevisionTarget(formData, options);
}

export type ParsedV2GroupOnlyForfeit = ParsedV2FixtureTarget &
  Readonly<{
    winnerEntryId: string;
    reason: string;
  }>;

/** The loser is deliberately absent: it is derived from the locked Fixture. */
export function parseV2GroupOnlyForfeit(
  formData: FormData,
): ParsedV2GroupOnlyForfeit {
  assertOnlyFields(formData, FORFEIT_FIELDS);
  const reason = readOptionalReason(formData);
  if (!reason) {
    throw new V2ActionBoundaryError(
      "INVALID_REASON",
      "A forfeit requires a non-empty reason.",
      "reason",
    );
  }
  return {
    ...parseV2FixtureTarget(formData),
    winnerEntryId: readStableIdentifier(formData, "winnerEntryId"),
    reason,
  };
}

export type ParsedV2GroupOnlyForfeitCorrection = ParsedV2FixtureTarget &
  Readonly<{
    resultRevisionId: string;
    reason: string;
  }>;

/** Both adjudicated sides are derived from the locked FORFEIT predecessor. */
export function parseV2GroupOnlyForfeitCorrection(
  formData: FormData,
): ParsedV2GroupOnlyForfeitCorrection {
  assertOnlyFields(formData, FORFEIT_CORRECTION_FIELDS);
  const reason = readOptionalReason(formData);
  if (!reason) {
    throw new V2ActionBoundaryError(
      "INVALID_REASON",
      "A forfeit correction requires a non-empty reason.",
      "reason",
    );
  }
  return {
    ...parseV2FixtureTarget(formData),
    resultRevisionId: readStableIdentifier(formData, "resultRevisionId"),
    reason,
  };
}
