"use client";

import {
  finalizeV2GroupStageAction,
  previewV2TeamGroupingAction,
  publishV2TeamGroupingAction,
  updateV2TeamGroupTableLabelsAction,
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
  canEditTableLabels?: boolean;
  publishedGroups?: readonly Readonly<{
    groupKey: string;
    label: string;
    tableLabels: readonly string[];
    expectedFixtures: readonly Readonly<{
      fixtureId: string;
      version: number;
    }>[];
    competitorNames?: readonly string[];
  }>[];
}>;

/** TEAM grouping facade over the shared group-only panel. */
export default function V2TeamGroupingPanel(props: Props) {
  return (
    <V2GroupOnlyGroupingPanel
      {...props}
      matchLabel="团体"
      entryLabel="队伍"
      countUnit="队"
      competitorType="team"
      previewAction={previewV2TeamGroupingAction}
      publishAction={publishV2TeamGroupingAction}
      finalizeAction={finalizeV2GroupStageAction}
      updateTableLabelsAction={updateV2TeamGroupTableLabelsAction}
    />
  );
}
