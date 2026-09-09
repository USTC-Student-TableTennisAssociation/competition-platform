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

export const V2_SINGLE_MATCH_UNLIMITED_PARTICIPANTS =
  V2_GROUP_ONLY_MATCH_UNLIMITED_PARTICIPANTS;
export const V2_SINGLE_MATCH_CREATION_REQUEST_KEY_PATTERN =
  V2_GROUP_ONLY_MATCH_CREATION_REQUEST_KEY_PATTERN;
export const V2_SINGLE_MATCH_TEXT_LIMITS = V2_GROUP_ONLY_MATCH_TEXT_LIMITS;

export type CreateV2SingleMatchCommand =
  CreateV2GroupOnlyMatchCommand<"single">;
export type CreatedV2SingleMatch = CreatedV2GroupOnlyMatch<"single">;
export type V2SingleMatchApplicationService =
  V2GroupOnlyMatchApplicationService<"single">;
export type CreateV2SingleGroupThenKnockoutMatchCommand =
  CreateV2GroupThenKnockoutMatchCommand<"single">;
export type CreatedV2SingleGroupThenKnockoutMatch =
  CreatedV2GroupThenKnockoutMatch<"single">;
export type V2SingleGroupThenKnockoutMatchApplicationService =
  V2GroupThenKnockoutMatchApplicationService<"single">;
export type V2SingleMatchApplicationServiceDependencies = Readonly<{
  db: Pick<PrismaClient, "$transaction">;
}>;

const SINGLE_CREATION_CONFIG = Object.freeze({
  type: "single" as const,
  format: "group_only" as const,
  fingerprintNamespace: "v2-single-match-create",
  invalidTypeMessage: "The first V2 creation slice supports singles only.",
  invalidFormatMessage:
    "The first V2 creation slice supports group-only matches only.",
  ruleNote: "分组循环赛",
});

const SINGLE_GROUP_THEN_KNOCKOUT_CREATION_CONFIG = Object.freeze({
  ...SINGLE_CREATION_CONFIG,
  format: "group_then_knockout" as const,
  invalidFormatMessage:
    "This V2 creation slice supports group-then-knockout matches only.",
  ruleNote: "先分组后淘汰赛",
});

export function isV2SingleMatchCreationRequestKey(value: unknown) {
  return isV2GroupOnlyMatchCreationRequestKey(value);
}

export function fingerprintV2SingleMatchCreation(
  command: CreateV2SingleMatchCommand,
) {
  return fingerprintV2GroupOnlyMatchCreation(command, SINGLE_CREATION_CONFIG);
}

export function fingerprintV2SingleGroupThenKnockoutMatchCreation(
  command: CreateV2SingleGroupThenKnockoutMatchCommand,
) {
  return fingerprintV2MatchCreation(
    command,
    SINGLE_GROUP_THEN_KNOCKOUT_CREATION_CONFIG,
  );
}

/** Backwards-compatible SINGLE facade over the shared group-only kernel. */
export function createV2SingleMatchApplicationService(
  dependencies: V2SingleMatchApplicationServiceDependencies,
): V2SingleMatchApplicationService {
  return createV2GroupOnlyMatchApplicationService(
    dependencies,
    SINGLE_CREATION_CONFIG,
  );
}

export function createV2SingleGroupThenKnockoutMatchApplicationService(
  dependencies: V2SingleMatchApplicationServiceDependencies,
): V2SingleGroupThenKnockoutMatchApplicationService {
  return createV2MatchApplicationService(
    dependencies,
    SINGLE_GROUP_THEN_KNOCKOUT_CREATION_CONFIG,
  );
}
