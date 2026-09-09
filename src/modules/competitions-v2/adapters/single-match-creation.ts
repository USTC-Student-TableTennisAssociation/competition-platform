import {
  createV2SingleGroupThenKnockoutMatchApplicationService,
  createV2SingleMatchApplicationService,
  isV2SingleMatchCreationRequestKey,
} from "../application/matches";
import {
  createV2MatchCreationBoundary,
  createV2GroupOnlyMatchCreationBoundary,
  parseV2GroupOnlyLocalDateTime,
  parseV2GroupOnlyTimezoneOffset,
  type V2MatchCreationAdapterDependencies,
  type V2GroupOnlyMatchCreationAdapterDependencies,
  type V2GroupOnlyMatchCreationState,
  type V2GroupOnlyMatchCreationUser,
} from "./group-only-match-creation";

export type V2SingleMatchCreationState = V2GroupOnlyMatchCreationState;
export type V2SingleMatchCreationUser = V2GroupOnlyMatchCreationUser;
export type V2SingleMatchCreationAdapterDependencies =
  V2GroupOnlyMatchCreationAdapterDependencies<"single">;
export type V2SingleGroupThenKnockoutMatchCreationAdapterDependencies =
  V2MatchCreationAdapterDependencies<"single", "group_then_knockout">;

export const V2_SINGLE_MATCH_CREATION_CLOSED_MESSAGE =
  "V2 比赛创建功能已关闭，请刷新页面后重试。";
export const V2_SINGLE_GROUP_THEN_KNOCKOUT_MATCH_CREATION_CLOSED_MESSAGE =
  "V2 单打先分组后淘汰赛创建功能已关闭，请刷新页面后重试。";

export const parseV2TimezoneOffset = parseV2GroupOnlyTimezoneOffset;
export const parseV2LocalDateTime = parseV2GroupOnlyLocalDateTime;

const SINGLE_ADAPTER_CONFIG = Object.freeze({
  type: "single" as const,
  format: "group_only" as const,
  typeBoundaryMessage: "This V2 creation handler accepts singles only.",
  formatBoundaryMessage:
    "This V2 creation handler accepts group-only matches only.",
  featureUnavailableMessage: "当前 V2 创建处理器不接受该比赛组合。",
  closedMessage: V2_SINGLE_MATCH_CREATION_CLOSED_MESSAGE,
  logMessage: "V2 single match creation failed",
  isRequestKey: isV2SingleMatchCreationRequestKey,
  createService: (db: Parameters<typeof createV2SingleMatchApplicationService>[0]["db"]) =>
    createV2SingleMatchApplicationService({ db }),
});

const SINGLE_GROUP_THEN_KNOCKOUT_ADAPTER_CONFIG = Object.freeze({
  type: "single" as const,
  format: "group_then_knockout" as const,
  typeBoundaryMessage: "This V2 creation slice supports singles only.",
  formatBoundaryMessage:
    "This V2 creation slice supports group-then-knockout matches only.",
  featureUnavailableMessage: "当前 V2 创建入口不支持该单打赛制。",
  closedMessage: V2_SINGLE_GROUP_THEN_KNOCKOUT_MATCH_CREATION_CLOSED_MESSAGE,
  logMessage: "V2 single group-then-knockout match creation failed",
  isRequestKey: isV2SingleMatchCreationRequestKey,
  createService: (
    db: Parameters<
      typeof createV2SingleGroupThenKnockoutMatchApplicationService
    >[0]["db"],
  ) => createV2SingleGroupThenKnockoutMatchApplicationService({ db }),
});

export function createV2SingleMatchCreationHandler(
  dependencies: V2SingleMatchCreationAdapterDependencies,
) {
  return createV2GroupOnlyMatchCreationBoundary(
    dependencies,
    SINGLE_ADAPTER_CONFIG,
    "create",
  );
}

export function resolveExistingV2SingleMatchCreationHandler(
  dependencies: V2SingleMatchCreationAdapterDependencies,
) {
  return createV2GroupOnlyMatchCreationBoundary(
    dependencies,
    SINGLE_ADAPTER_CONFIG,
    "resolve-existing",
  );
}

export function createV2SingleGroupThenKnockoutMatchCreationHandler(
  dependencies: V2SingleGroupThenKnockoutMatchCreationAdapterDependencies,
) {
  return createV2MatchCreationBoundary(
    dependencies,
    SINGLE_GROUP_THEN_KNOCKOUT_ADAPTER_CONFIG,
    "create",
  );
}

export function resolveExistingV2SingleGroupThenKnockoutMatchCreationHandler(
  dependencies: V2SingleGroupThenKnockoutMatchCreationAdapterDependencies,
) {
  return createV2MatchCreationBoundary(
    dependencies,
    SINGLE_GROUP_THEN_KNOCKOUT_ADAPTER_CONFIG,
    "resolve-existing",
  );
}
