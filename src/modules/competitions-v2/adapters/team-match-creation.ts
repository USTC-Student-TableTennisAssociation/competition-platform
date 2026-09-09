import {
  createV2TeamGroupThenKnockoutMatchApplicationService,
  createV2TeamMatchApplicationService,
  isV2TeamMatchCreationRequestKey,
} from "../application/team-matches";
import {
  createV2MatchCreationBoundary,
  createV2GroupOnlyMatchCreationBoundary,
  type V2MatchCreationAdapterDependencies,
  type V2GroupOnlyMatchCreationAdapterDependencies,
  type V2GroupOnlyMatchCreationState,
  type V2GroupOnlyMatchCreationUser,
} from "./group-only-match-creation";

export type V2TeamMatchCreationState = V2GroupOnlyMatchCreationState;
export type V2TeamMatchCreationUser = V2GroupOnlyMatchCreationUser;
export type V2TeamMatchCreationAdapterDependencies =
  V2GroupOnlyMatchCreationAdapterDependencies<"team">;
export type V2TeamGroupThenKnockoutMatchCreationAdapterDependencies =
  V2MatchCreationAdapterDependencies<"team", "group_then_knockout">;

export const V2_TEAM_MATCH_CREATION_CLOSED_MESSAGE =
  "V2 团体比赛创建功能已关闭，请刷新页面后重试。";
export const V2_TEAM_GROUP_THEN_KNOCKOUT_MATCH_CREATION_CLOSED_MESSAGE =
  "V2 团体先分组后淘汰赛创建功能已关闭，请刷新页面后重试。";

const TEAM_ADAPTER_CONFIG = Object.freeze({
  type: "team" as const,
  format: "group_only" as const,
  typeBoundaryMessage: "This V2 creation slice supports team matches only.",
  formatBoundaryMessage:
    "The team V2 creation slice supports group-only matches only.",
  featureUnavailableMessage: "当前 V2 团体创建仅支持纯小组赛。",
  closedMessage: V2_TEAM_MATCH_CREATION_CLOSED_MESSAGE,
  logMessage: "V2 team match creation failed",
  isRequestKey: isV2TeamMatchCreationRequestKey,
  createService: (
    db: Parameters<typeof createV2TeamMatchApplicationService>[0]["db"],
  ) => createV2TeamMatchApplicationService({ db }),
});

const TEAM_GROUP_THEN_KNOCKOUT_ADAPTER_CONFIG = Object.freeze({
  type: "team" as const,
  format: "group_then_knockout" as const,
  typeBoundaryMessage: "This V2 creation slice supports team matches only.",
  formatBoundaryMessage:
    "This V2 creation slice supports group-then-knockout matches only.",
  featureUnavailableMessage: "当前 V2 创建入口不支持该团体赛制。",
  closedMessage: V2_TEAM_GROUP_THEN_KNOCKOUT_MATCH_CREATION_CLOSED_MESSAGE,
  logMessage: "V2 team group-then-knockout match creation failed",
  isRequestKey: isV2TeamMatchCreationRequestKey,
  createService: (
    db: Parameters<
      typeof createV2TeamGroupThenKnockoutMatchApplicationService
    >[0]["db"],
  ) => createV2TeamGroupThenKnockoutMatchApplicationService({ db }),
});

export function createV2TeamMatchCreationHandler(
  dependencies: V2TeamMatchCreationAdapterDependencies,
) {
  return createV2GroupOnlyMatchCreationBoundary(
    dependencies,
    TEAM_ADAPTER_CONFIG,
    "create",
  );
}

export function resolveExistingV2TeamMatchCreationHandler(
  dependencies: V2TeamMatchCreationAdapterDependencies,
) {
  return createV2GroupOnlyMatchCreationBoundary(
    dependencies,
    TEAM_ADAPTER_CONFIG,
    "resolve-existing",
  );
}

export function createV2TeamGroupThenKnockoutMatchCreationHandler(
  dependencies: V2TeamGroupThenKnockoutMatchCreationAdapterDependencies,
) {
  return createV2MatchCreationBoundary(
    dependencies,
    TEAM_GROUP_THEN_KNOCKOUT_ADAPTER_CONFIG,
    "create",
  );
}

export function resolveExistingV2TeamGroupThenKnockoutMatchCreationHandler(
  dependencies: V2TeamGroupThenKnockoutMatchCreationAdapterDependencies,
) {
  return createV2MatchCreationBoundary(
    dependencies,
    TEAM_GROUP_THEN_KNOCKOUT_ADAPTER_CONFIG,
    "resolve-existing",
  );
}
