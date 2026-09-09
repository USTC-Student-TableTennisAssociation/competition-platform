import type { CompetitionFormat, PrismaClient } from "@prisma/client";

import type { V2Actor } from "./entries";
import {
  createV2GroupOnlyGroupingApplicationService,
  V2_DOUBLE_GROUP_ONLY_GROUPING_PROFILE,
  V2_DOUBLE_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE,
  type PublishV2GroupOnlyGroupingResult,
} from "./group-only-grouping";

export type V2DoubleGroupingExpectedEntry = Readonly<{
  entryId: string;
  version: number;
}>;

export type V2DoubleGroupingDraft = Readonly<{
  format: CompetitionFormat;
  groups: readonly Readonly<{ entryIds: readonly string[] }>[];
  qualifiersPerGroup?: number;
  seedMethod?: "min_diff" | "snake";
}>;

export type PublishV2DoubleGroupingCommand = Readonly<{
  actor: V2Actor;
  matchId: string;
  expectedEntries: readonly V2DoubleGroupingExpectedEntry[];
  draft: V2DoubleGroupingDraft;
}>;

export type PublishV2DoubleGroupingResult = PublishV2GroupOnlyGroupingResult;

export type V2DoubleGroupingApplicationService = Readonly<{
  publish(
    command: PublishV2DoubleGroupingCommand,
  ): Promise<PublishV2DoubleGroupingResult>;
}>;

export type V2DoubleGroupingApplicationServiceDependencies = Readonly<{
  db: Pick<PrismaClient, "$transaction">;
  clock?: () => Date;
}>;

/** Thin DOUBLE facade over the shared relational group-phase publication kernel. */
export function createV2DoubleGroupingApplicationService(
  dependencies: V2DoubleGroupingApplicationServiceDependencies,
): V2DoubleGroupingApplicationService {
  const groupOnlyService = createV2GroupOnlyGroupingApplicationService(
    dependencies,
    V2_DOUBLE_GROUP_ONLY_GROUPING_PROFILE,
  );
  const groupThenKnockoutService = createV2GroupOnlyGroupingApplicationService(
    dependencies,
    V2_DOUBLE_GROUP_THEN_KNOCKOUT_GROUPING_PROFILE,
  );
  return Object.freeze({
    publish: (command) =>
      (command.draft.format === "group_then_knockout"
        ? groupThenKnockoutService
        : groupOnlyService
      ).publish(command),
  });
}
