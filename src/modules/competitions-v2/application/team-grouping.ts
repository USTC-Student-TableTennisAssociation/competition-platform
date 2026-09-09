import type { CompetitionFormat, PrismaClient } from "@prisma/client";

import type { V2Actor } from "./entries";
import {
  createV2GroupOnlyGroupingApplicationService,
  V2_TEAM_GROUP_ONLY_GROUPING_PROFILE,
  V2_TEAM_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE,
  type PublishV2GroupOnlyGroupingResult,
} from "./group-only-grouping";

export type V2TeamGroupingExpectedEntry = Readonly<{
  entryId: string;
  version: number;
}>;

export type V2TeamGroupingDraft = Readonly<{
  format: CompetitionFormat;
  groups: readonly Readonly<{ entryIds: readonly string[] }>[];
  qualifiersPerGroup?: number;
  seedMethod?: "min_diff" | "snake";
}>;

export type PublishV2TeamGroupingCommand = Readonly<{
  actor: V2Actor;
  matchId: string;
  expectedEntries: readonly V2TeamGroupingExpectedEntry[];
  draft: V2TeamGroupingDraft;
}>;

export type PublishV2TeamGroupingResult = PublishV2GroupOnlyGroupingResult;

export type V2TeamGroupingApplicationService = Readonly<{
  publish(
    command: PublishV2TeamGroupingCommand,
  ): Promise<PublishV2TeamGroupingResult>;
}>;

export type V2TeamGroupingApplicationServiceDependencies = Readonly<{
  db: Pick<PrismaClient, "$transaction">;
  clock?: () => Date;
}>;

/** Thin TEAM facade over the shared relational group-phase publication kernel. */
export function createV2TeamGroupingApplicationService(
  dependencies: V2TeamGroupingApplicationServiceDependencies,
): V2TeamGroupingApplicationService {
  const groupOnlyService = createV2GroupOnlyGroupingApplicationService(
    dependencies,
    V2_TEAM_GROUP_ONLY_GROUPING_PROFILE,
  );
  const groupThenKnockoutService = createV2GroupOnlyGroupingApplicationService(
    dependencies,
    V2_TEAM_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE,
  );
  return Object.freeze({
    publish: (command) =>
      (command.draft.format === "group_then_knockout"
        ? groupThenKnockoutService
        : groupOnlyService
      ).publish(command),
  });
}
