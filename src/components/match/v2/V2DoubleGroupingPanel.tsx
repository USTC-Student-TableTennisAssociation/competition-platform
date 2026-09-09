"use client";

import {
  finalizeV2GroupStageAction,
  previewV2DoubleGroupingAction,
  publishV2DoubleGroupingAction,
  updateV2DoubleGroupTableLabelsAction,
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

/** DOUBLE exposes grouping only; result and knockout controls remain absent. */
export default function V2DoubleGroupingPanel(props: Props) {
  return (
    <V2GroupOnlyGroupingPanel
      {...props}
      matchLabel="双打"
      entryLabel="小队"
      countUnit="队"
      competitorType="team"
      previewAction={previewV2DoubleGroupingAction}
      publishAction={publishV2DoubleGroupingAction}
      finalizeAction={finalizeV2GroupStageAction}
      updateTableLabelsAction={updateV2DoubleGroupTableLabelsAction}
    />
  );
}
