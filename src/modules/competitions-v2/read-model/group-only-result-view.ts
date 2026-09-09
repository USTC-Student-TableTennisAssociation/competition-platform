import type {
  V2GroupOnlyActiveResult,
  V2GroupOnlyRevisionReadModel,
} from "./group-only-results";
import { V2_MAX_TEAM_SCORE_PER_FIXTURE } from "../domain/group-standings";

export type V2GroupOnlyResultViewer = Readonly<{
  userId: string;
}> | null;

export type V2GroupOnlyResultViewProfile = Readonly<{
  initialSubmitPolicy:
    | "PARTICIPANT_OR_MANAGER"
    | "CAPTAIN_OR_MANAGER"
    | "MANAGER_ONLY";
  participantConfirmPolicy: "ANY_MEMBER" | "CAPTAIN_ONLY";
  playedScoreKind: "RACKET_GAMES" | "TEAM_AGGREGATE";
}>;

export const V2_SINGLE_GROUP_ONLY_RESULT_VIEW_PROFILE = Object.freeze({
  initialSubmitPolicy: "PARTICIPANT_OR_MANAGER",
  participantConfirmPolicy: "ANY_MEMBER",
  playedScoreKind: "RACKET_GAMES",
} satisfies V2GroupOnlyResultViewProfile);

export const V2_DOUBLE_GROUP_ONLY_RESULT_VIEW_PROFILE = Object.freeze({
  initialSubmitPolicy: "PARTICIPANT_OR_MANAGER",
  participantConfirmPolicy: "ANY_MEMBER",
  playedScoreKind: "RACKET_GAMES",
} satisfies V2GroupOnlyResultViewProfile);

export const V2_TEAM_GROUP_ONLY_RESULT_VIEW_PROFILE = Object.freeze({
  initialSubmitPolicy: "CAPTAIN_OR_MANAGER",
  participantConfirmPolicy: "CAPTAIN_ONLY",
  playedScoreKind: "TEAM_AGGREGATE",
} satisfies V2GroupOnlyResultViewProfile);

export type V2GroupOnlyPlayedScore = Readonly<{
  bestOf: 3 | 5 | 7;
  winnerScore: number;
  loserScore: number;
}>;

export type V2GroupOnlyTeamAggregateScore = Readonly<{
  winnerScore: number;
  loserScore: number;
}>;

export type V2GroupOnlyResultRevisionView = Readonly<{
  revisionId: string;
  revisionVersion: number;
  resolutionKind: "PLAYED" | "FORFEIT";
  winnerEntryId: string;
  loserEntryId: string;
  winnerFrozenDisplayName: string;
  loserFrozenDisplayName: string;
  score: V2GroupOnlyPlayedScore | null;
  aggregateScore: V2GroupOnlyTeamAggregateScore | null;
  scoreLabel: string;
  reporterId: string;
  reporterName: string;
  reason: string | null;
}>;

type ResultMember = Readonly<{
  userId: string;
  role?: "player" | "captain" | "substitute";
  isCurrentlyBanned: boolean;
}>;

export type V2GroupOnlyResultFixtureSide = Readonly<{
  entryId: string;
  entryStatus: "DRAFT" | "ACTIVE" | "WITHDRAWN" | "DISQUALIFIED" | "ARCHIVED";
  frozenDisplayName: string;
  members: readonly ResultMember[];
}>;

export type V2GroupOnlyResultFixtureInput = Readonly<{
  fixtureId: string;
  fixtureVersion: number;
  bestOf?: number;
  status: "SCHEDULED" | "READY" | "COMPLETED" | "VOIDED";
  sideA: V2GroupOnlyResultFixtureSide;
  sideB: V2GroupOnlyResultFixtureSide;
  activeResult: V2GroupOnlyActiveResult;
}>;

export type V2GroupOnlyResultFixtureView = Readonly<{
  authoritativeResult: V2GroupOnlyResultRevisionView | null;
  pendingResult: V2GroupOnlyResultRevisionView | null;
  canSubmitResult: boolean;
  canVoidUnplayed: boolean;
  canConfirmPending: boolean;
  canRejectPending: boolean;
  canSubmitCorrection: boolean;
  canVoidConfirmed: boolean;
  canConfirmForfeit: boolean;
  canCorrectForfeit: boolean;
  forfeitWinnerEntries: readonly Readonly<{
    entryId: string;
    frozenDisplayName: string;
  }>[];
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseV2GroupOnlyPlayedScore(
  score: unknown,
): V2GroupOnlyPlayedScore | null {
  if (!isRecord(score)) return null;
  const bestOf = score.bestOf;
  const winnerScore = score.winnerScore;
  const loserScore = score.loserScore;
  if (
    (bestOf !== 3 && bestOf !== 5 && bestOf !== 7) ||
    typeof winnerScore !== "number" ||
    typeof loserScore !== "number" ||
    !Number.isSafeInteger(winnerScore) ||
    !Number.isSafeInteger(loserScore)
  ) {
    return null;
  }
  const winsNeeded = (bestOf + 1) / 2;
  if (winnerScore !== winsNeeded || loserScore < 0 || loserScore >= winsNeeded) {
    return null;
  }
  return { bestOf, winnerScore, loserScore };
}

export function parseV2GroupOnlyTeamAggregateScore(
  score: unknown,
): V2GroupOnlyTeamAggregateScore | null {
  if (!isRecord(score)) return null;
  const winnerScore = score.winnerScore;
  const loserScore = score.loserScore;
  if (
    typeof winnerScore !== "number" ||
    typeof loserScore !== "number" ||
    !Number.isSafeInteger(winnerScore) ||
    !Number.isSafeInteger(loserScore) ||
    winnerScore < 0 ||
    loserScore < 0 ||
    winnerScore > V2_MAX_TEAM_SCORE_PER_FIXTURE ||
    loserScore > V2_MAX_TEAM_SCORE_PER_FIXTURE ||
    winnerScore <= loserScore
  ) {
    return null;
  }
  return { winnerScore, loserScore };
}

export function formatV2GroupOnlyResultScore(
  resolutionKind: "PLAYED" | "FORFEIT",
  score: unknown,
  playedScoreKind: V2GroupOnlyResultViewProfile["playedScoreKind"] =
    "RACKET_GAMES",
) {
  if (resolutionKind === "FORFEIT") return "弃权判胜（1:0）";
  if (playedScoreKind === "TEAM_AGGREGATE") {
    const parsed = parseV2GroupOnlyTeamAggregateScore(score);
    if (!parsed) return "团体总比分数据异常";
    return `${parsed.winnerScore}:${parsed.loserScore}（团体总比分）`;
  }
  const parsed = parseV2GroupOnlyPlayedScore(score);
  if (!parsed) return "比分数据异常";
  return `${parsed.winnerScore}:${parsed.loserScore}（${parsed.bestOf}局${parsed.winnerScore}胜）`;
}

function mapRevision(
  revision: V2GroupOnlyRevisionReadModel,
  profile: V2GroupOnlyResultViewProfile,
): V2GroupOnlyResultRevisionView {
  const score =
    revision.resolutionKind === "PLAYED" &&
    profile.playedScoreKind === "RACKET_GAMES"
      ? parseV2GroupOnlyPlayedScore(revision.score)
      : null;
  const aggregateScore =
    revision.resolutionKind === "PLAYED" &&
    profile.playedScoreKind === "TEAM_AGGREGATE"
      ? parseV2GroupOnlyTeamAggregateScore(revision.score)
      : null;
  return {
    revisionId: revision.revisionId,
    revisionVersion: revision.revisionVersion,
    resolutionKind: revision.resolutionKind,
    winnerEntryId: revision.winnerEntryId,
    loserEntryId: revision.loserEntryId,
    winnerFrozenDisplayName: revision.winnerDisplayNameSnapshot,
    loserFrozenDisplayName: revision.loserDisplayNameSnapshot,
    score,
    aggregateScore,
    scoreLabel: formatV2GroupOnlyResultScore(
      revision.resolutionKind,
      revision.score,
      profile.playedScoreKind,
    ),
    reporterId: revision.reporter.userId,
    reporterName: revision.reporter.nickname,
    reason: revision.reason,
  };
}

function sideEligible(side: V2GroupOnlyResultFixtureSide) {
  return (
    side.entryStatus === "ACTIVE" &&
    side.members.length > 0 &&
    side.members.every((member) => !member.isCurrentlyBanned)
  );
}

/** Mirrors application-service authorization only to hide impossible UI writes. */
export function buildV2GroupOnlyResultFixtureView(
  fixture: V2GroupOnlyResultFixtureInput,
  viewer: V2GroupOnlyResultViewer,
  isManager: boolean,
  profile: V2GroupOnlyResultViewProfile,
  options: Readonly<{ stage?: "GROUP" | "KNOCKOUT" }> = {},
): V2GroupOnlyResultFixtureView {
  const stage = options.stage ?? "GROUP";
  const frozenUserIds = new Set([
    ...fixture.sideA.members.map((member) => member.userId),
    ...fixture.sideB.members.map((member) => member.userId),
  ]);
  const viewerParticipates = Boolean(
    viewer && frozenUserIds.has(viewer.userId),
  );
  const viewerMember = viewer
    ? [...fixture.sideA.members, ...fixture.sideB.members].find(
        (member) => member.userId === viewer.userId,
      )
    : undefined;
  const viewerIsCaptain = viewerMember?.role === "captain";
  const viewerMaySubmit =
    profile.initialSubmitPolicy === "PARTICIPANT_OR_MANAGER"
      ? viewerParticipates
      : profile.initialSubmitPolicy === "CAPTAIN_OR_MANAGER"
        ? viewerIsCaptain
        : false;
  const viewerMayConfirm =
    profile.participantConfirmPolicy === "CAPTAIN_ONLY"
      ? viewerIsCaptain
      : viewerParticipates;
  const sideAEligible = sideEligible(fixture.sideA);
  const sideBEligible = sideEligible(fixture.sideB);
  const bothEntriesEligible = sideAEligible && sideBEligible;
  const eitherMemberBanned = [...fixture.sideA.members, ...fixture.sideB.members]
    .some((member) => member.isCurrentlyBanned);
  const pending = fixture.activeResult.pendingRevision;
  const confirmed = fixture.activeResult.confirmedRevision;
  const correctionPending = fixture.activeResult.state === "CORRECTION_PENDING";
  const confirmedView = confirmed ? mapRevision(confirmed, profile) : null;
  const correctedForfeitWinnerEligible =
    confirmed?.loserEntryId === fixture.sideA.entryId
      ? sideAEligible
      : confirmed?.loserEntryId === fixture.sideB.entryId
        ? sideBEligible
        : false;
  const forfeitWinnerEntries = [
    ...(sideAEligible
      ? [{
          entryId: fixture.sideA.entryId,
          frozenDisplayName: fixture.sideA.frozenDisplayName,
        }]
      : []),
    ...(sideBEligible
      ? [{
          entryId: fixture.sideB.entryId,
          frozenDisplayName: fixture.sideB.frozenDisplayName,
        }]
      : []),
  ];

  return {
    authoritativeResult: confirmedView,
    pendingResult: pending ? mapRevision(pending, profile) : null,
    canSubmitResult:
      fixture.status === "READY" &&
      fixture.activeResult.state === "NONE" &&
      bothEntriesEligible &&
      (isManager || viewerMaySubmit),
    canVoidUnplayed:
      stage === "GROUP" &&
      isManager &&
      (fixture.status === "SCHEDULED" || fixture.status === "READY") &&
      fixture.activeResult.state === "NONE",
    canConfirmPending: Boolean(
      pending &&
        !eitherMemberBanned &&
        (correctionPending
          ? isManager
          : bothEntriesEligible &&
            (isManager ||
              (viewerMayConfirm && viewer?.userId !== pending.reporter.userId))),
    ),
    canRejectPending: Boolean(pending && isManager),
    canSubmitCorrection: Boolean(
      confirmedView?.resolutionKind === "PLAYED" &&
        (confirmedView.score || confirmedView.aggregateScore) &&
        fixture.status === "COMPLETED" &&
        fixture.activeResult.state === "CONFIRMED" &&
        !eitherMemberBanned &&
        isManager,
    ),
    canVoidConfirmed: Boolean(
      stage === "GROUP" &&
        confirmed &&
        fixture.activeResult.state === "CONFIRMED" &&
        isManager,
    ),
    canConfirmForfeit:
      isManager &&
      fixture.status === "READY" &&
      fixture.activeResult.state === "NONE" &&
      forfeitWinnerEntries.length > 0,
    canCorrectForfeit: Boolean(
      isManager &&
        fixture.status === "COMPLETED" &&
        fixture.activeResult.state === "CONFIRMED" &&
        confirmedView?.resolutionKind === "FORFEIT" &&
        correctedForfeitWinnerEligible,
    ),
    forfeitWinnerEntries,
  };
}
