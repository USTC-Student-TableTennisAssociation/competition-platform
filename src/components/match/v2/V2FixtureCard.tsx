import type { ReactNode } from "react";
import V2GroupOnlyFixtureResultPanel from "./V2GroupOnlyFixtureResultPanel";
import FixtureScoreboard from "./FixtureScoreboard";
import type { V2GroupOnlyGroupingFixture } from "@/modules/competitions-v2/read-model/group-only-grouping";
import type { V2GroupOnlyResultFixtureView } from "@/modules/competitions-v2/read-model/group-only-result-view";
import {
  V2_SINGLE_GROUP_ONLY_RESULT_VIEW_PROFILE,
  V2_DOUBLE_GROUP_ONLY_RESULT_VIEW_PROFILE,
  V2_TEAM_GROUP_ONLY_RESULT_VIEW_PROFILE,
} from "@/modules/competitions-v2/read-model/group-only-result-view";
import { memberFixtureGuidance } from "@/modules/competitions-v2/read-model/member-fixture-guidance";

type Props = Readonly<{
  matchId: string;
  competitionType: "single" | "double" | "team";
  stage: "GROUP" | "KNOCKOUT";
  label: string;
  tableLabels: readonly string[];
  fixture: V2GroupOnlyGroupingFixture;
  view: V2GroupOnlyResultFixtureView;
  children?: ReactNode;
  currentUserId?: string | null;
  isManager?: boolean;
}>;

const statusLabels = {
  SCHEDULED: "等待对阵",
  READY: "待比赛",
  COMPLETED: "已完成",
  VOIDED: "已作废",
};

export default function V2FixtureCard({
  matchId,
  competitionType,
  stage,
  label,
  tableLabels,
  fixture,
  view,
  children,
  currentUserId = null,
  isManager = false,
}: Props) {
  const guidance = memberFixtureGuidance(
    fixture,
    view,
    currentUserId,
    isManager,
    competitionType === "team"
      ? V2_TEAM_GROUP_ONLY_RESULT_VIEW_PROFILE
      : competitionType === "double"
        ? V2_DOUBLE_GROUP_ONLY_RESULT_VIEW_PROFILE
        : V2_SINGLE_GROUP_ONLY_RESULT_VIEW_PROFILE,
  );
  const result = view.authoritativeResult ?? view.pendingResult;
  const score = result?.score ?? result?.aggregateScore;
  const sideAWon = result?.winnerEntryId === fixture.sideA.entryId;
  const scores = score
    ? sideAWon
      ? [score.winnerScore, score.loserScore]
      : [score.loserScore, score.winnerScore]
    : null;
  const status = view.pendingResult
    ? view.authoritativeResult
      ? "待更正"
      : "待确认"
    : fixture.status === "READY" && fixture.startedAt
      ? "比赛中"
      : statusLabels[fixture.status];
  return (
    <article className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <p className="text-slate-400">
          {label}
          {tableLabels.length ? ` · ${tableLabels.join("、")}` : ""}
        </p>
        <span
          className={
            view.pendingResult
              ? "text-amber-300"
              : fixture.status === "COMPLETED"
                ? "text-emerald-300"
                : "text-slate-400"
          }
        >
          {status}
        </span>
      </div>
      {guidance.roleHint ? (
        <p className="mt-4 text-xs leading-6 text-slate-300">
          {guidance.roleHint}
        </p>
      ) : null}
      {!view.canSubmitResult ? (
        <>
          <p className="mt-4 text-xs text-slate-500">
            {competitionType === "team"
              ? "团体总比分"
              : `${result?.score?.bestOf ?? fixture.bestOf ?? 5} 局 ${((result?.score?.bestOf ?? fixture.bestOf ?? 5) + 1) / 2} 胜 · 整场局分`}
          </p>
          <FixtureScoreboard
            sideAName={fixture.sideA.frozenDisplayName}
            sideBName={fixture.sideB.frozenDisplayName}
            scoreA={
              scores?.[0] ??
              (result?.resolutionKind === "FORFEIT"
                ? sideAWon
                  ? "胜"
                  : "弃权"
                : "—")
            }
            scoreB={
              scores?.[1] ??
              (result?.resolutionKind === "FORFEIT"
                ? sideAWon
                  ? "弃权"
                  : "胜"
                : "—")
            }
            sideACaption={guidance.sideACaption}
            sideBCaption={guidance.sideBCaption}
          />
        </>
      ) : null}
      <V2GroupOnlyFixtureResultPanel
        matchId={matchId}
        competitionType={competitionType}
        stage={stage}
        fixture={{ ...fixture, ...view }}
        pendingHint={guidance.pendingHint}
      />
      {competitionType !== "single" ? (
        <details className="mt-5 border-t border-white/8 pt-3 text-xs text-slate-400">
          <summary className="w-fit cursor-pointer py-1 hover:text-slate-200">
            本场成员
          </summary>
          <div className="mt-2 grid grid-cols-2 gap-4 leading-5">
            {[fixture.sideA, fixture.sideB].map((side) => (
              <p key={side.entryId}>
                {side.members
                  .map(
                    (member) =>
                      `${member.frozenDisplayName}${member.role === "captain" ? "（队长）" : member.role === "substitute" ? "（替补）" : ""}`,
                  )
                  .join("、")}
              </p>
            ))}
          </div>
        </details>
      ) : null}
      {children}
    </article>
  );
}
