import type {
  V2MatchCreationCapabilities,
  V2MatchCreationDisabledRoute,
} from "../../../modules/competitions-v2/adapters/group-only-match-creation-dispatch";

const V2_COMPETITIONS_CREATION_MODE_ENV = "V2_COMPETITIONS_CREATION_MODE";

export type V2CompetitionsCreationMode = "PAUSED" | "V2";

export type V2MatchCreationPolicy = Readonly<{
  mode: V2CompetitionsCreationMode;
  capabilities: V2MatchCreationCapabilities;
  disabledRoute: V2MatchCreationDisabledRoute;
}>;

function capabilities(enabled: boolean): V2MatchCreationCapabilities {
  return Object.freeze({
    single: Object.freeze({
      group_only: enabled,
      group_then_knockout: enabled,
    }),
    double: Object.freeze({
      group_only: enabled,
      group_then_knockout: enabled,
    }),
    team: Object.freeze({
      group_only: enabled,
      group_then_knockout: enabled,
    }),
  });
}

/**
 * Formal competitions have one writer. PAUSED is a maintenance switch, not
 * a choice between two implementations. The old LEGACY setting cannot open
 * a retired writer.
 */
export function getV2CompetitionsCreationMode(): V2CompetitionsCreationMode {
  const value = process.env[V2_COMPETITIONS_CREATION_MODE_ENV];
  return value === "PAUSED" ? "PAUSED" : "V2";
}

export function getV2MatchCreationPolicy(): V2MatchCreationPolicy {
  const mode = getV2CompetitionsCreationMode();
  return Object.freeze({
    mode,
    capabilities: capabilities(mode === "V2"),
    disabledRoute: "paused",
  });
}

/** All six formal type x format cells cut over together. */
export function getV2MatchCreationCapabilities(): V2MatchCreationCapabilities {
  return getV2MatchCreationPolicy().capabilities;
}

/** Compatibility helpers retained for server callers and source tests. */
export function isV2CompetitionsPublicEnabled() {
  return getV2CompetitionsCreationMode() === "V2";
}

export const isV2SingleGroupOnlyCreationEnabled =
  isV2CompetitionsPublicEnabled;
export const isV2DoubleGroupOnlyCreationEnabled =
  isV2CompetitionsPublicEnabled;
export const isV2TeamGroupOnlyCreationEnabled =
  isV2CompetitionsPublicEnabled;
export const isV2SingleGroupThenKnockoutCreationEnabled =
  isV2CompetitionsPublicEnabled;
export const isV2DoubleGroupThenKnockoutCreationEnabled =
  isV2CompetitionsPublicEnabled;
export const isV2TeamGroupThenKnockoutCreationEnabled =
  isV2CompetitionsPublicEnabled;
