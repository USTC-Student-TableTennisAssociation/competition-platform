import StartFixtureForm from "./StartFixtureForm";
import {
  V2DoubleForfeitForm,
  V2DoubleForfeitCorrectionForm,
  V2DoubleResultCorrectionForm,
  V2DoubleResultSubmissionForm,
  V2DoubleRevisionActionForm,
  V2DoubleUnplayedFixtureVoidForm,
} from "@/components/match/v2/V2DoubleResultActionForms";
import {
  V2SingleForfeitForm,
  V2SingleForfeitCorrectionForm,
  V2SingleResultCorrectionForm,
  V2SingleResultSubmissionForm,
  V2SingleRevisionActionForm,
  V2SingleUnplayedFixtureVoidForm,
} from "@/components/match/v2/V2SingleActionForms";
import {
  V2TeamForfeitForm,
  V2TeamForfeitCorrectionForm,
  V2TeamResultCorrectionForm,
  V2TeamResultSubmissionForm,
  V2TeamRevisionActionForm,
  V2TeamUnplayedFixtureVoidForm,
} from "@/components/match/v2/V2TeamResultActionForms";
import type { V2GroupOnlyResultFixtureView } from "@/modules/competitions-v2/read-model/group-only-result-view";

type Fixture = V2GroupOnlyResultFixtureView &
  Readonly<{
    fixtureId: string;
    fixtureVersion: number;
    bestOf?: number;
    startedAt?: string | null;
    sideA: Readonly<{ entryId: string; frozenDisplayName: string }>;
    sideB: Readonly<{ entryId: string; frozenDisplayName: string }>;
  }>;

export default function V2GroupOnlyFixtureResultPanel({
  competitionType,
  stage = "GROUP",
  matchId,
  fixture,
}: Readonly<{
  competitionType: "single" | "double" | "team";
  stage?: "GROUP" | "KNOCKOUT";
  matchId: string;
  fixture: Fixture;
}>) {
  const SubmissionForm =
    competitionType === "single"
      ? V2SingleResultSubmissionForm
      : competitionType === "double"
        ? V2DoubleResultSubmissionForm
        : V2TeamResultSubmissionForm;
  const CorrectionForm =
    competitionType === "single"
      ? V2SingleResultCorrectionForm
      : V2DoubleResultCorrectionForm;
  const RevisionForm =
    competitionType === "single"
      ? V2SingleRevisionActionForm
      : competitionType === "double"
        ? V2DoubleRevisionActionForm
        : V2TeamRevisionActionForm;
  const UnplayedVoidForm =
    competitionType === "single"
      ? V2SingleUnplayedFixtureVoidForm
      : competitionType === "double"
        ? V2DoubleUnplayedFixtureVoidForm
        : V2TeamUnplayedFixtureVoidForm;
  const ForfeitForm =
    competitionType === "single"
      ? V2SingleForfeitForm
      : competitionType === "double"
        ? V2DoubleForfeitForm
        : V2TeamForfeitForm;
  const ForfeitCorrectionForm =
    competitionType === "single"
      ? V2SingleForfeitCorrectionForm
      : competitionType === "double"
        ? V2DoubleForfeitCorrectionForm
        : V2TeamForfeitCorrectionForm;

  return (
    <>
      {fixture.startedAt ? <p className="mt-3 text-xs text-sky-200">本场已开始，成员名单已保留。</p> : fixture.canSubmitResult ? <StartFixtureForm matchId={matchId} fixtureId={fixture.fixtureId} version={fixture.fixtureVersion} stage={stage} /> : null}
      {stage === "GROUP" && fixture.canVoidUnplayed ? (
        <div className="mt-3">
          <UnplayedVoidForm
            matchId={matchId}
            fixtureId={fixture.fixtureId}
            expectedFixtureVersion={fixture.fixtureVersion}
          />
        </div>
      ) : null}

      {fixture.canConfirmForfeit ? (
        <ForfeitForm
          matchId={matchId}
          fixtureId={fixture.fixtureId}
          expectedFixtureVersion={fixture.fixtureVersion}
          winnerEntries={fixture.forfeitWinnerEntries}
          stage={stage}
        />
      ) : null}

      {fixture.authoritativeResult ? (
        <div className="mt-3 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3 text-sm text-slate-200">
          <p className="font-medium text-emerald-200">已生效赛果</p>
          <p>
            {fixture.authoritativeResult.winnerFrozenDisplayName} 胜{" "}
            {fixture.authoritativeResult.loserFrozenDisplayName} ·{" "}
            {fixture.authoritativeResult.scoreLabel}
          </p>
          {fixture.authoritativeResult.reason ? (
            <p className="mt-1 text-xs text-slate-400">
              原因：{fixture.authoritativeResult.reason}
            </p>
          ) : null}
          {fixture.canSubmitCorrection &&
          competitionType === "team" &&
          fixture.authoritativeResult.aggregateScore ? (
            <V2TeamResultCorrectionForm
              matchId={matchId}
              fixtureId={fixture.fixtureId}
              expectedFixtureVersion={fixture.fixtureVersion}
              resultRevisionId={fixture.authoritativeResult.revisionId}
              currentWinnerName={
                fixture.authoritativeResult.winnerFrozenDisplayName
              }
              currentLoserName={
                fixture.authoritativeResult.loserFrozenDisplayName
              }
              initialScore={fixture.authoritativeResult.aggregateScore}
              stage={stage}
            />
          ) : fixture.canSubmitCorrection &&
            fixture.authoritativeResult.score ? (
            <CorrectionForm
              matchId={matchId}
              fixtureId={fixture.fixtureId}
              expectedFixtureVersion={fixture.fixtureVersion}
              resultRevisionId={fixture.authoritativeResult.revisionId}
              currentWinnerName={
                fixture.authoritativeResult.winnerFrozenDisplayName
              }
              currentLoserName={
                fixture.authoritativeResult.loserFrozenDisplayName
              }
              initialScore={{
                bestOf: fixture.authoritativeResult.score.bestOf,
                loserScore: fixture.authoritativeResult.score.loserScore,
              }}
              stage={stage}
            />
          ) : null}
          {fixture.canCorrectForfeit ? (
            <ForfeitCorrectionForm
              matchId={matchId}
              fixtureId={fixture.fixtureId}
              expectedFixtureVersion={fixture.fixtureVersion}
              resultRevisionId={fixture.authoritativeResult.revisionId}
              currentWinnerName={
                fixture.authoritativeResult.winnerFrozenDisplayName
              }
              currentLoserName={
                fixture.authoritativeResult.loserFrozenDisplayName
              }
              stage={stage}
            />
          ) : null}
          {stage === "GROUP" && fixture.canVoidConfirmed ? (
            <div className="mt-2">
              <RevisionForm
                matchId={matchId}
                fixtureId={fixture.fixtureId}
                expectedFixtureVersion={fixture.fixtureVersion}
                resultRevisionId={fixture.authoritativeResult.revisionId}
                kind="void"
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {fixture.pendingResult ? (
        <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-sm text-slate-200">
          <p className="font-medium text-amber-200">
            {fixture.authoritativeResult
              ? "更正待确认（原赛果仍生效）"
              : "赛果待确认"}
          </p>
          <p>
            {fixture.pendingResult.winnerFrozenDisplayName} 胜{" "}
            {fixture.pendingResult.loserFrozenDisplayName} ·{" "}
            {fixture.pendingResult.scoreLabel}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            登记人：{fixture.pendingResult.reporterName}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {fixture.canConfirmPending ? (
              <RevisionForm
                matchId={matchId}
                fixtureId={fixture.fixtureId}
                expectedFixtureVersion={fixture.fixtureVersion}
                resultRevisionId={fixture.pendingResult.revisionId}
                kind="confirm"
                stage={stage}
              />
            ) : null}
            {fixture.canRejectPending ? (
              <RevisionForm
                matchId={matchId}
                fixtureId={fixture.fixtureId}
                expectedFixtureVersion={fixture.fixtureVersion}
                resultRevisionId={fixture.pendingResult.revisionId}
                kind="reject"
                stage={stage}
              />
            ) : null}
          </div>
        </div>
      ) : null}

      {fixture.canSubmitResult ? (
        <SubmissionForm
          matchId={matchId}
          fixtureId={fixture.fixtureId}
          expectedFixtureVersion={fixture.fixtureVersion}
          bestOf={fixture.bestOf ?? 5}
          sideA={fixture.sideA}
          sideB={fixture.sideB}
          stage={stage}
        />
      ) : null}
    </>
  );
}
