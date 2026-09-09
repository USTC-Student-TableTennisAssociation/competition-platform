import type { CompetitionFormat, PrismaClient } from "@prisma/client";

import type { V2Actor } from "./entries";
import {
  createV2GroupOnlyGroupingApplicationService,
  V2_SINGLE_GROUP_ONLY_GROUPING_PROFILE,
  V2_SINGLE_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE,
  type PublishV2GroupOnlyGroupingResult,
} from "./group-only-grouping";

export type V2SingleGroupingExpectedEntry = Readonly<{
  entryId: string;
  version: number;
}>;

export type V2SingleGroupingDraft = Readonly<{
  format: CompetitionFormat;
  groups: readonly Readonly<{ entryIds: readonly string[] }>[];
  qualifiersPerGroup?: number;
  seedMethod?: "min_diff" | "snake";
}>;

export type PublishV2SingleGroupingCommand = Readonly<{
  actor: V2Actor;
  matchId: string;
  expectedEntries: readonly V2SingleGroupingExpectedEntry[];
  draft: V2SingleGroupingDraft;
}>;

export type PublishV2SingleGroupingResult = PublishV2GroupOnlyGroupingResult;

export type V2SingleGroupingApplicationService = Readonly<{
  publish(
    command: PublishV2SingleGroupingCommand,
  ): Promise<PublishV2SingleGroupingResult>;
}>;

export type V2SingleGroupingApplicationServiceDependencies = Readonly<{
  db: Pick<PrismaClient, "$transaction">;
  clock?: () => Date;
}>;

/** Stable SINGLE facade retained for existing routes and UI adapters. */
export function createV2SingleGroupingApplicationService(
  dependencies: V2SingleGroupingApplicationServiceDependencies,
): V2SingleGroupingApplicationService {
  const groupOnlyService = createV2GroupOnlyGroupingApplicationService(
    dependencies,
    V2_SINGLE_GROUP_ONLY_GROUPING_PROFILE,
  );
  const groupThenKnockoutService = createV2GroupOnlyGroupingApplicationService(
    dependencies,
    V2_SINGLE_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE,
  );
  return Object.freeze({
    publish: (command) =>
      (command.draft.format === "group_then_knockout"
        ? groupThenKnockoutService
        : groupOnlyService
      ).publish(command),
  });
}
