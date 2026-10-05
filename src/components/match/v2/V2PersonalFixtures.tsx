import { ChevronRight } from "lucide-react";
import ScheduleFixtureDialog, {
  FixtureTrigger,
} from "@/components/match/detail/ScheduleFixtureDialog";
import type { V2GroupOnlyGroupingFixture } from "@/modules/competitions-v2/read-model/group-only-grouping";
import type { V2GroupOnlyResultFixtureView } from "@/modules/competitions-v2/read-model/group-only-result-view";
import V2FixtureCard from "./V2FixtureCard";

type Fixture = V2GroupOnlyGroupingFixture &
  Readonly<{
    stage: "GROUP" | "KNOCKOUT";
    label: string;
    tableLabels: readonly string[];
    view: V2GroupOnlyResultFixtureView;
  }>;

export default function V2PersonalFixtures({
  matchId,
  competitionType,
  fixtures,
  currentUserId = null,
  isManager = false,
}: Readonly<{
  matchId: string;
  competitionType: "single" | "double" | "team";
  fixtures: readonly Fixture[];
  currentUserId?: string | null;
  isManager?: boolean;
}>) {
  const priority = (fixture: Fixture) =>
    fixture.view.canConfirmPending
      ? 0
      : fixture.view.canSubmitResult
        ? 1
        : fixture.view.pendingResult
          ? 2
          : 3;
  const ordered = [...fixtures].sort((a, b) => priority(a) - priority(b));
  return (
    <ScheduleFixtureDialog
      fixtures={ordered.map((fixture) => ({
        fixtureId: fixture.fixtureId,
        title: fixture.view.canSubmitResult
          ? "录入比分"
          : fixture.view.canConfirmPending
            ? "确认比分"
            : "对局详情",
        content: (
          <V2FixtureCard
            matchId={matchId}
            competitionType={competitionType}
            stage={fixture.stage}
            label={fixture.label}
            tableLabels={fixture.tableLabels}
            fixture={fixture}
            view={fixture.view}
            currentUserId={currentUserId}
            isManager={isManager}
          />
        ),
      }))}
    >
      <div className="divide-y divide-white/10 border-y border-white/10">
        {ordered.map((fixture) => {
          const { view } = fixture;
          const result = view.authoritativeResult ?? view.pendingResult;
          const score = result?.score ?? result?.aggregateScore;
          const aWon = result?.winnerEntryId === fixture.sideA.entryId;
          const scoreLabel = score
            ? `${aWon ? score.winnerScore : score.loserScore} : ${aWon ? score.loserScore : score.winnerScore}`
            : result?.resolutionKind === "FORFEIT"
              ? "弃权"
              : "VS";
          const action = view.canConfirmPending
            ? "确认比分"
            : view.canSubmitResult
              ? "录入比分"
              : view.pendingResult
                ? "等待确认"
                : fixture.status === "COMPLETED"
                  ? "已结束"
                  : fixture.status === "VOIDED"
                    ? "已作废"
                    : fixture.startedAt
                      ? "比赛中"
                      : "待比赛";
          const actionable = view.canConfirmPending || view.canSubmitResult;
          return (
            <FixtureTrigger
              key={fixture.fixtureId}
              fixtureId={fixture.fixtureId}
              label={`${fixture.label}，${fixture.sideA.frozenDisplayName} 对 ${fixture.sideB.frozenDisplayName}，${action}`}
              className="block w-full px-1 py-4 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline-2 focus-visible:outline-orange-300 sm:px-3 sm:py-5"
            >
              <span className="mb-3 flex items-center justify-between gap-3 text-xs">
                <span className="text-slate-400">
                  {fixture.label}
                  {fixture.tableLabels.length
                    ? ` · ${fixture.tableLabels.join("、")}`
                    : ""}
                </span>
                <span
                  className={`inline-flex shrink-0 items-center gap-1 ${actionable ? "text-white" : view.pendingResult ? "text-amber-200" : "text-slate-400"}`}
                >
                  {action}
                  <ChevronRight size={14} aria-hidden="true" />
                </span>
              </span>
              <span className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 sm:gap-6">
                <span className="break-words text-sm font-medium leading-6 text-slate-100">
                  {fixture.sideA.frozenDisplayName}
                </span>
                <span
                  className={`whitespace-nowrap tabular-nums ${score ? "text-lg font-semibold text-slate-100" : "text-xs text-slate-500"}`}
                >
                  {scoreLabel}
                </span>
                <span className="break-words text-right text-sm font-medium leading-6 text-slate-100">
                  {fixture.sideB.frozenDisplayName}
                </span>
              </span>
            </FixtureTrigger>
          );
        })}
      </div>
    </ScheduleFixtureDialog>
  );
}
