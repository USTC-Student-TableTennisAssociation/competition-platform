import {
  createV2DoubleGroupThenKnockoutMatchApplicationService,
  createV2DoubleMatchApplicationService,
  isV2DoubleMatchCreationRequestKey,
} from "../application/double-matches";
import {
  createV2MatchCreationBoundary,
  createV2GroupOnlyMatchCreationBoundary,
  type V2MatchCreationAdapterDependencies,
  type V2GroupOnlyMatchCreationAdapterDependencies,
  type V2GroupOnlyMatchCreationState,
  type V2GroupOnlyMatchCreationUser,
} from "./group-only-match-creation";

export type V2DoubleMatchCreationState = V2GroupOnlyMatchCreationState;
export type V2DoubleMatchCreationUser = V2GroupOnlyMatchCreationUser;
export type V2DoubleMatchCreationAdapterDependencies =
  V2GroupOnlyMatchCreationAdapterDependencies<"double">;
export type V2DoubleGroupThenKnockoutMatchCreationAdapterDependencies =
  V2MatchCreationAdapterDependencies<"double", "group_then_knockout">;

export const V2_DOUBLE_MATCH_CREATION_CLOSED_MESSAGE =
  "V2 双打比赛创建功能已关闭，请刷新页面后重试。";
export const V2_DOUBLE_GROUP_THEN_KNOCKOUT_MATCH_CREATION_CLOSED_MESSAGE =
  "V2 双打先分组后淘汰赛创建功能已关闭，请刷新页面后重试。";

const DOUBLE_ADAPTER_CONFIG = Object.freeze({
  type: "double" as const,
  format: "group_only" as const,
  typeBoundaryMessage: "This V2 creation slice supports doubles only.",
  formatBoundaryMessage:
    "The doubles V2 creation slice supports group-only matches only.",
  featureUnavailableMessage: "当前 V2 双打创建仅支持纯小组赛。",
  closedMessage: V2_DOUBLE_MATCH_CREATION_CLOSED_MESSAGE,
  logMessage: "V2 double match creation failed",
  isRequestKey: isV2DoubleMatchCreationRequestKey,
  createService: (db: Parameters<typeof createV2DoubleMatchApplicationService>[0]["db"]) =>
    createV2DoubleMatchApplicationService({ db }),
});

const DOUBLE_GROUP_THEN_KNOCKOUT_ADAPTER_CONFIG = Object.freeze({
  type: "double" as const,
  format: "group_then_knockout" as const,
  typeBoundaryMessage: "This V2 creation slice supports doubles only.",
  formatBoundaryMessage:
    "This V2 creation slice supports group-then-knockout matches only.",
  featureUnavailableMessage: "当前 V2 创建入口不支持该双打赛制。",
  closedMessage: V2_DOUBLE_GROUP_THEN_KNOCKOUT_MATCH_CREATION_CLOSED_MESSAGE,
  logMessage: "V2 double group-then-knockout match creation failed",
  isRequestKey: isV2DoubleMatchCreationRequestKey,
  createService: (
    db: Parameters<
      typeof createV2DoubleGroupThenKnockoutMatchApplicationService
    >[0]["db"],
  ) => createV2DoubleGroupThenKnockoutMatchApplicationService({ db }),
});

export function createV2DoubleMatchCreationHandler(
  dependencies: V2DoubleMatchCreationAdapterDependencies,
) {
  return createV2GroupOnlyMatchCreationBoundary(
    dependencies,
    DOUBLE_ADAPTER_CONFIG,
    "create",
  );
}

export function resolveExistingV2DoubleMatchCreationHandler(
  dependencies: V2DoubleMatchCreationAdapterDependencies,
) {
  return createV2GroupOnlyMatchCreationBoundary(
    dependencies,
    DOUBLE_ADAPTER_CONFIG,
    "resolve-existing",
  );
}

export function createV2DoubleGroupThenKnockoutMatchCreationHandler(
  dependencies: V2DoubleGroupThenKnockoutMatchCreationAdapterDependencies,
) {
  return createV2MatchCreationBoundary(
    dependencies,
    DOUBLE_GROUP_THEN_KNOCKOUT_ADAPTER_CONFIG,
    "create",
  );
}

export function resolveExistingV2DoubleGroupThenKnockoutMatchCreationHandler(
  dependencies: V2DoubleGroupThenKnockoutMatchCreationAdapterDependencies,
) {
  return createV2MatchCreationBoundary(
    dependencies,
    DOUBLE_GROUP_THEN_KNOCKOUT_ADAPTER_CONFIG,
    "resolve-existing",
  );
}
