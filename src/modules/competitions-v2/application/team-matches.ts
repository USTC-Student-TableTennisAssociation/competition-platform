import type { PrismaClient } from "@prisma/client";

import {
  V2_GROUP_ONLY_MATCH_CREATION_REQUEST_KEY_PATTERN,
  V2_GROUP_ONLY_MATCH_TEXT_LIMITS,
  V2_GROUP_ONLY_MATCH_UNLIMITED_PARTICIPANTS,
  V2_TEAM_GROUP_ONLY_MATCH_MEMBER_LIMITS,
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

export const V2_TEAM_MATCH_UNLIMITED_PARTICIPANTS =
  V2_GROUP_ONLY_MATCH_UNLIMITED_PARTICIPANTS;
export const V2_TEAM_MATCH_CREATION_REQUEST_KEY_PATTERN =
  V2_GROUP_ONLY_MATCH_CREATION_REQUEST_KEY_PATTERN;
export const V2_TEAM_MATCH_TEXT_LIMITS = V2_GROUP_ONLY_MATCH_TEXT_LIMITS;
export const V2_TEAM_MATCH_MEMBER_LIMITS =
  V2_TEAM_GROUP_ONLY_MATCH_MEMBER_LIMITS;

export type CreateV2TeamMatchCommand = CreateV2GroupOnlyMatchCommand<"team">;
export type CreatedV2TeamMatch = CreatedV2GroupOnlyMatch<"team">;
export type V2TeamMatchApplicationService =
  V2GroupOnlyMatchApplicationService<"team">;
export type CreateV2TeamGroupThenKnockoutMatchCommand =
  CreateV2GroupThenKnockoutMatchCommand<"team">;
export type CreatedV2TeamGroupThenKnockoutMatch =
  CreatedV2GroupThenKnockoutMatch<"team">;
export type V2TeamGroupThenKnockoutMatchApplicationService =
  V2GroupThenKnockoutMatchApplicationService<"team">;
export type V2TeamMatchApplicationServiceDependencies = Readonly<{
  db: Pick<PrismaClient, "$transaction">;
}>;

const TEAM_CREATION_CONFIG = Object.freeze({
  type: "team" as const,
  format: "group_only" as const,
  fingerprintNamespace: "v2-team-match-create",
  invalidTypeMessage: "This V2 creation slice supports team matches only.",
  invalidFormatMessage:
    "This V2 creation slice supports group-only matches only.",
  ruleNote: "团体分组循环赛",
});

const TEAM_GROUP_THEN_KNOCKOUT_CREATION_CONFIG = Object.freeze({
  ...TEAM_CREATION_CONFIG,
  format: "group_then_knockout" as const,
  invalidFormatMessage:
    "This V2 creation slice supports group-then-knockout matches only.",
  ruleNote: "先分组后淘汰赛",
});

export function isV2TeamMatchCreationRequestKey(value: unknown) {
  return isV2GroupOnlyMatchCreationRequestKey(value);
}

export function fingerprintV2TeamMatchCreation(
  command: CreateV2TeamMatchCommand,
) {
  return fingerprintV2GroupOnlyMatchCreation(command, TEAM_CREATION_CONFIG);
}

export function fingerprintV2TeamGroupThenKnockoutMatchCreation(
  command: CreateV2TeamGroupThenKnockoutMatchCommand,
) {
  return fingerprintV2MatchCreation(
    command,
    TEAM_GROUP_THEN_KNOCKOUT_CREATION_CONFIG,
  );
}

/** TEAM facade over the shared audited/idempotent group-only kernel. */
export function createV2TeamMatchApplicationService(
  dependencies: V2TeamMatchApplicationServiceDependencies,
): V2TeamMatchApplicationService {
  return createV2GroupOnlyMatchApplicationService(
    dependencies,
    TEAM_CREATION_CONFIG,
  );
}

export function createV2TeamGroupThenKnockoutMatchApplicationService(
  dependencies: V2TeamMatchApplicationServiceDependencies,
): V2TeamGroupThenKnockoutMatchApplicationService {
  return createV2MatchApplicationService(
    dependencies,
    TEAM_GROUP_THEN_KNOCKOUT_CREATION_CONFIG,
  );
}
