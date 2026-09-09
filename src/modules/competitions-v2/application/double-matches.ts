import type { PrismaClient } from "@prisma/client";

import {
  V2_GROUP_ONLY_MATCH_CREATION_REQUEST_KEY_PATTERN,
  V2_GROUP_ONLY_MATCH_TEXT_LIMITS,
  V2_GROUP_ONLY_MATCH_UNLIMITED_PARTICIPANTS,
  createV2GroupOnlyMatchApplicationService,
  createV2MatchApplicationService,
  fingerprintV2GroupOnlyMatchCreation,
  fingerprintV2MatchCreation,
  isV2GroupOnlyMatchCreationRequestKey,
  type CreateV2GroupThenKnockoutMatchCommand,
  type CreateV2GroupOnlyMatchCommand,
  type CreatedV2GroupThenKnockoutMatch,
  type CreatedV2GroupOnlyMatch,
  type V2GroupThenKnockoutMatchApplicationService,
  type V2GroupOnlyMatchApplicationService,
} from "./group-only-match-creation";

export const V2_DOUBLE_MATCH_UNLIMITED_PARTICIPANTS =
  V2_GROUP_ONLY_MATCH_UNLIMITED_PARTICIPANTS;
export const V2_DOUBLE_MATCH_CREATION_REQUEST_KEY_PATTERN =
  V2_GROUP_ONLY_MATCH_CREATION_REQUEST_KEY_PATTERN;
export const V2_DOUBLE_MATCH_TEXT_LIMITS = V2_GROUP_ONLY_MATCH_TEXT_LIMITS;

export type CreateV2DoubleMatchCommand =
  CreateV2GroupOnlyMatchCommand<"double">;
export type CreatedV2DoubleMatch = CreatedV2GroupOnlyMatch<"double">;
export type V2DoubleMatchApplicationService =
  V2GroupOnlyMatchApplicationService<"double">;
export type CreateV2DoubleGroupThenKnockoutMatchCommand =
  CreateV2GroupThenKnockoutMatchCommand<"double">;
export type CreatedV2DoubleGroupThenKnockoutMatch =
  CreatedV2GroupThenKnockoutMatch<"double">;
export type V2DoubleGroupThenKnockoutMatchApplicationService =
  V2GroupThenKnockoutMatchApplicationService<"double">;
export type V2DoubleMatchApplicationServiceDependencies = Readonly<{
  db: Pick<PrismaClient, "$transaction">;
}>;

const DOUBLE_CREATION_CONFIG = Object.freeze({
  type: "double" as const,
  format: "group_only" as const,
  fingerprintNamespace: "v2-double-match-create",
  invalidTypeMessage: "This V2 creation slice supports doubles only.",
  invalidFormatMessage:
    "This V2 creation slice supports group-only matches only.",
  ruleNote: "双打分组循环赛",
});

const DOUBLE_GROUP_THEN_KNOCKOUT_CREATION_CONFIG = Object.freeze({
  ...DOUBLE_CREATION_CONFIG,
  format: "group_then_knockout" as const,
  invalidFormatMessage:
    "This V2 creation slice supports group-then-knockout matches only.",
  ruleNote: "先分组后淘汰赛",
});

export function isV2DoubleMatchCreationRequestKey(value: unknown) {
  return isV2GroupOnlyMatchCreationRequestKey(value);
}

export function fingerprintV2DoubleMatchCreation(
  command: CreateV2DoubleMatchCommand,
) {
  return fingerprintV2GroupOnlyMatchCreation(command, DOUBLE_CREATION_CONFIG);
}

export function fingerprintV2DoubleGroupThenKnockoutMatchCreation(
  command: CreateV2DoubleGroupThenKnockoutMatchCommand,
) {
  return fingerprintV2MatchCreation(
    command,
    DOUBLE_GROUP_THEN_KNOCKOUT_CREATION_CONFIG,
  );
}

/** DOUBLE facade over the shared audited/idempotent group-only kernel. */
export function createV2DoubleMatchApplicationService(
  dependencies: V2DoubleMatchApplicationServiceDependencies,
): V2DoubleMatchApplicationService {
  return createV2GroupOnlyMatchApplicationService(
    dependencies,
    DOUBLE_CREATION_CONFIG,
  );
}

export function createV2DoubleGroupThenKnockoutMatchApplicationService(
  dependencies: V2DoubleMatchApplicationServiceDependencies,
): V2DoubleGroupThenKnockoutMatchApplicationService {
  return createV2MatchApplicationService(
    dependencies,
    DOUBLE_GROUP_THEN_KNOCKOUT_CREATION_CONFIG,
  );
}
