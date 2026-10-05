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
  pendingHint,
}: Readonly<{
  competitionType: "single" | "double" | "team";
  stage?: "GROUP" | "KNOCKOUT";
  matchId: string;
  fixture: Fixture;
  pendingHint?: string | null;
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
      {fixture.authoritativeResult ? (
        <div className="mt-3 border-t border-white/8 pt-3 text-xs leading-5 text-slate-400">
          <p className="text-emerald-300">已确认</p>
          {fixture.authoritativeResult.reason ? (
            <p className="mt-1 text-xs text-slate-400">
              原因：{fixture.authoritativeResult.reason}
            </p>
          ) : null}
          {fixture.canSubmitCorrection ||
          fixture.canCorrectForfeit ||
          (stage === "GROUP" && fixture.canVoidConfirmed) ? (
            <details className="mt-3">
              <summary className="w-fit cursor-pointer py-1 text-xs text-slate-400 hover:text-slate-200">
                {stage === "GROUP" && fixture.canVoidConfirmed
                  ? "更正或作废成绩"
                  : "申请更正比分"}
              </summary>
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
            </details>
          ) : null}
        </div>
      ) : null}

      {fixture.pendingResult ? (
        <div className="border-t border-white/8 pt-4 text-sm leading-6 text-slate-200">
          <p className="font-medium text-amber-200">
            {fixture.authoritativeResult
              ? "更正待确认（原赛果仍生效）"
              : "赛果待确认"}
          </p>
          {fixture.authoritativeResult ? (
            <p>
              {fixture.pendingResult.winnerFrozenDisplayName} 胜{" "}
              {fixture.pendingResult.loserFrozenDisplayName} ·{" "}
              {fixture.pendingResult.scoreLabel}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-slate-400">
            登记人：{fixture.pendingResult.reporterName}
          </p>
          {pendingHint ? (
            <p className="mt-2 text-xs leading-6 text-slate-200">
              {pendingHint}
            </p>
          ) : null}
          {fixture.canConfirmPending && !fixture.canRejectPending ? (
            <p className="mt-2 text-xs leading-5 text-slate-400">
              比分有误时，请联系比赛管理员处理。
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap gap-2">
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
        <div>
          <SubmissionForm
            matchId={matchId}
            fixtureId={fixture.fixtureId}
            expectedFixtureVersion={fixture.fixtureVersion}
            bestOf={fixture.bestOf ?? 5}
            sideA={fixture.sideA}
            sideB={fixture.sideB}
            stage={stage}
          />
          {!fixture.startedAt ? (
            <details className="mt-4 border-b border-white/8 pb-3 text-xs text-slate-400">
              <summary className="w-fit cursor-pointer py-1 hover:text-slate-200">
                赛前记录 · 标记开始比赛（可选）
              </summary>
              <StartFixtureForm
                matchId={matchId}
                fixtureId={fixture.fixtureId}
                version={fixture.fixtureVersion}
                stage={stage}
              />
            </details>
          ) : null}
        </div>
      ) : null}
      {fixture.canConfirmForfeit ||
      (stage === "GROUP" && fixture.canVoidUnplayed) ? (
        <details className="mt-3 border-t border-white/8 pt-3">
          <summary className="w-fit cursor-pointer py-1 text-xs text-slate-400 hover:text-slate-200">
            弃权与对局管理
          </summary>
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
        </details>
      ) : null}
    </>
  );
}
