"use client";

import {
  finalizeV2GroupStageAction,
  previewV2SingleGroupingAction,
  publishV2SingleGroupingAction,
  updateV2SingleGroupTableLabelsAction,
} from "@/app/matchs/v2-actions";

import V2GroupOnlyGroupingPanel from "./V2GroupOnlyGroupingPanel";

type Props = Readonly<{
  matchId: string;
  participantCount: number;
  defaultGroupCount: number;
  format?: "group_only" | "group_then_knockout";
  defaultQualifiersPerGroup?: number;
  published?: boolean;
  managementState?:
    | "UNPUBLISHED"
    | "GROUP_IN_PROGRESS"
    | "READY_TO_FINALIZE"
    | "KNOCKOUT_PUBLISHED";
  knockoutSummary?: Readonly<{ fixtureCount: number; roundCount: number }> | null;
  knockoutProfile?: "PROGRESSIVE_GROUP_RANK" | "GLOBAL_SNAPSHOT" | null;
  canEditTableLabels?: boolean;
  publishedGroups?: readonly Readonly<{
    groupId?: string;
    groupKey: string;
    label: string;
    tableLabels: readonly string[];
    expectedFixtures: readonly Readonly<{
      fixtureId: string;
      version: number;
    }>[];
    competitorNames?: readonly string[];
    qualificationState?: "PENDING" | "READY_TO_CONFIRM" | "FROZEN";
  }>[];
}>;

/** Stable SINGLE UI facade over the shared group-only panel. */
export default function V2SingleGroupingPanel(props: Props) {
  return (
    <V2GroupOnlyGroupingPanel
      {...props}
      matchLabel="单打"
      entryLabel=" Entry"
      countUnit="人"
      competitorType="user"
      previewAction={previewV2SingleGroupingAction}
      publishAction={publishV2SingleGroupingAction}
      finalizeAction={finalizeV2GroupStageAction}
      updateTableLabelsAction={updateV2SingleGroupTableLabelsAction}
    />
  );
}
