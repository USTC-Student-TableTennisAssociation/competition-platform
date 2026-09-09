import type { Prisma, PrismaClient } from "@prisma/client";

import type { V2Actor } from "../application/entries";
import { transitionV2FixtureStatus } from "../application/fixtures";
import {
  createV2ResultApplicationService,
  type V2PlayedCorrectionMode,
  type V2ResultApplicationService,
} from "../application/results";
import { V2ActionBoundaryError } from "./action-boundary";
import {
  parseV2GroupOnlyFixtureTarget,
  parseV2GroupOnlyForfeit,
  parseV2GroupOnlyForfeitCorrection,
  parseV2GroupOnlyResultCorrection,
  parseV2GroupOnlyResultSubmission,
  parseV2GroupOnlyRevisionTarget,
} from "./group-only-result-boundary";

export type V2GroupOnlyResultActionState = Readonly<{
  error?: string;
  success?: string;
}>;

export type V2GroupOnlyResultActionProfile = Readonly<{
  submitSuccess: string;
  correctionSuccess: string;
  confirmSuccess: string;
  rejectSuccess: string;
  voidSuccess: string;
  unplayedVoidSuccess: string;
  forfeitSuccess: string;
  forfeitCorrectionSuccess: string;
}>;

export const V2_SINGLE_GROUP_ONLY_RESULT_ACTION_PROFILE = Object.freeze({
  submitSuccess: "已登记，等待对手或管理员确认。",
  correctionSuccess: "已提交胜负更正，原赛果在确认前继续生效。",
  confirmSuccess: "确认成功，结果已生效。",
  rejectSuccess: "已否决该待确认赛果。",
  voidSuccess: "赛果已作废。",
  unplayedVoidSuccess: "未赛对局已作废。",
  forfeitSuccess: "弃权赛果已确认。",
  forfeitCorrectionSuccess: "弃权胜方已更正。",
} satisfies V2GroupOnlyResultActionProfile);

export const V2_DOUBLE_GROUP_ONLY_RESULT_ACTION_PROFILE = Object.freeze({
  ...V2_SINGLE_GROUP_ONLY_RESULT_ACTION_PROFILE,
  submitSuccess: "已登记，等待另一方非登记搭档或管理员确认。",
} satisfies V2GroupOnlyResultActionProfile);

export const V2_TEAM_GROUP_ONLY_RESULT_ACTION_PROFILE = Object.freeze({
  ...V2_SINGLE_GROUP_ONLY_RESULT_ACTION_PROFILE,
  submitSuccess: "已登记，等待对方队长或管理员确认。",
} satisfies V2GroupOnlyResultActionProfile);

export type V2GroupOnlyParsedResultSubmission = Readonly<{
  fixtureId: string;
  expectedFixtureVersion: number;
  winnerEntryId: string;
  score: Prisma.InputJsonValue;
}>;

export type V2GroupOnlyParsedResultCorrection = Readonly<{
  fixtureId: string;
  expectedFixtureVersion: number;
  resultRevisionId: string;
  correctionMode: V2PlayedCorrectionMode;
  score: Prisma.InputJsonValue;
}>;

export type V2GroupOnlyResultActionDependencies = Readonly<{
  db: PrismaClient;
  assertMatch(matchId: string): Promise<void>;
  revalidatePaths(paths: readonly string[]): void | Promise<void>;
  resultService?: V2ResultApplicationService;
  fixtureStatusTransition?: typeof transitionV2FixtureStatus;
  parseResultSubmission?(
    formData: FormData,
  ): V2GroupOnlyParsedResultSubmission;
  parseResultCorrection?(
    formData: FormData,
  ): V2GroupOnlyParsedResultCorrection;
}>;

export type V2StageResultActions = Readonly<{
  submitResult(
    actor: V2Actor,
    matchId: string,
    formData: FormData,
  ): Promise<V2GroupOnlyResultActionState>;
  submitCorrection(
    actor: V2Actor,
    matchId: string,
    formData: FormData,
  ): Promise<V2GroupOnlyResultActionState>;
  confirmResult(
    actor: V2Actor,
    matchId: string,
    formData: FormData,
  ): Promise<V2GroupOnlyResultActionState>;
  rejectResult(
    actor: V2Actor,
    matchId: string,
    formData: FormData,
  ): Promise<V2GroupOnlyResultActionState>;
  confirmForfeit(
    actor: V2Actor,
    matchId: string,
    formData: FormData,
  ): Promise<V2GroupOnlyResultActionState>;
  correctForfeit(
    actor: V2Actor,
    matchId: string,
    formData: FormData,
  ): Promise<V2GroupOnlyResultActionState>;
}>;

export type V2GroupOnlyResultActions = V2StageResultActions &
  Readonly<{
    voidUnplayedFixture(
      actor: V2Actor,
      matchId: string,
      formData: FormData,
    ): Promise<V2GroupOnlyResultActionState>;
    voidResult(
      actor: V2Actor,
      matchId: string,
      formData: FormData,
    ): Promise<V2GroupOnlyResultActionState>;
  }>;

const DETAIL_PATHS = (matchId: string) => [`/matchs/${matchId}`] as const;
const SETTLEMENT_PATHS = (matchId: string) =>
  ["/", "/matchs", `/matchs/${matchId}`, "/rankings", "/profile"] as const;
const UNPLAYED_PATHS = (matchId: string) =>
  ["/", "/matchs", `/matchs/${matchId}`] as const;

type V2WebResultStage = "GROUP" | "KNOCKOUT";

/**
 * Shared result command adapter. `requiredFixtureStage` is selected only by
 * server composition; participant identities are completed from the exact
 * persisted Fixture and are re-validated again while the core holds its lock.
 */
function createV2StageResultActions(
  dependencies: V2GroupOnlyResultActionDependencies,
  profile: V2GroupOnlyResultActionProfile,
  requiredFixtureStage: V2WebResultStage,
): V2StageResultActions {
  const resultService =
    dependencies.resultService ??
    createV2ResultApplicationService({ db: dependencies.db });
  const parseResultSubmission =
    dependencies.parseResultSubmission ?? parseV2GroupOnlyResultSubmission;
  const parseResultCorrection =
    dependencies.parseResultCorrection ?? parseV2GroupOnlyResultCorrection;
  const actorContext = (actor: V2Actor) => ({
    actorId: actor.id,
    role: actor.role,
  });
  const resolveExactFixtureSides = async (
    matchId: string,
    fixtureId: string,
    winnerEntryId: string,
  ) => {
    const fixture = await dependencies.db.matchFixture.findFirst({
      where: { id: fixtureId, matchId, stage: requiredFixtureStage },
      select: { sideAEntryId: true, sideBEntryId: true },
    });
    if (!fixture) {
      throw new V2ActionBoundaryError(
        "RESOURCE_NOT_FOUND",
        `The ${requiredFixtureStage.toLowerCase()} Fixture does not exist.`,
      );
    }
    if (
      !fixture.sideAEntryId ||
      !fixture.sideBEntryId ||
      fixture.sideAEntryId === fixture.sideBEntryId ||
      (winnerEntryId !== fixture.sideAEntryId &&
        winnerEntryId !== fixture.sideBEntryId)
    ) {
      throw new V2ActionBoundaryError(
        "INVALID_RESOURCE_STATE",
        "The selected winner is not an exact resolved Fixture side.",
        "winnerEntryId",
      );
    }
    return {
      winnerEntryId,
      loserEntryId:
        winnerEntryId === fixture.sideAEntryId
          ? fixture.sideBEntryId
          : fixture.sideAEntryId,
    };
  };

  return Object.freeze({
    submitResult: async (actor, matchId, formData) => {
      await dependencies.assertMatch(matchId);
      const input = parseResultSubmission(formData);
      const participants = await resolveExactFixtureSides(
        matchId,
        input.fixtureId,
        input.winnerEntryId,
      );
      await resultService.submitRevision({
        actor: actorContext(actor),
        matchId,
        fixtureId: input.fixtureId,
        expectedFixtureVersion: input.expectedFixtureVersion,
        requiredFixtureStage,
        winnerEntryId: participants.winnerEntryId,
        loserEntryId: participants.loserEntryId,
        score: input.score,
      });
      await dependencies.revalidatePaths(DETAIL_PATHS(matchId));
      return { success: profile.submitSuccess };
    },

    submitCorrection: async (actor, matchId, formData) => {
      await dependencies.assertMatch(matchId);
      const input = parseResultCorrection(formData);
      await resultService.submitCorrection({
        actor: actorContext(actor),
        matchId,
        fixtureId: input.fixtureId,
        expectedFixtureVersion: input.expectedFixtureVersion,
        requiredFixtureStage,
        resultRevisionId: input.resultRevisionId,
        correctionMode: input.correctionMode,
        score: input.score,
      });
      await dependencies.revalidatePaths(DETAIL_PATHS(matchId));
      return { success: profile.correctionSuccess };
    },

    confirmResult: async (actor, matchId, formData) => {
      await dependencies.assertMatch(matchId);
      const target = parseV2GroupOnlyRevisionTarget(formData);
      await resultService.confirmRevision({
        actor: actorContext(actor),
        matchId,
        fixtureId: target.fixtureId,
        expectedFixtureVersion: target.expectedFixtureVersion,
        requiredFixtureStage,
        resultRevisionId: target.resultRevisionId,
      });
      await dependencies.revalidatePaths(SETTLEMENT_PATHS(matchId));
      return { success: profile.confirmSuccess };
    },

    rejectResult: async (actor, matchId, formData) => {
      await dependencies.assertMatch(matchId);
      const target = parseV2GroupOnlyRevisionTarget(formData, {
        includeReason: true,
      });
      await resultService.rejectRevision({
        actor: actorContext(actor),
        matchId,
        fixtureId: target.fixtureId,
        expectedFixtureVersion: target.expectedFixtureVersion,
        requiredFixtureStage,
        resultRevisionId: target.resultRevisionId,
        reason: target.reason,
      });
      await dependencies.revalidatePaths(DETAIL_PATHS(matchId));
      return { success: profile.rejectSuccess };
    },

    confirmForfeit: async (actor, matchId, formData) => {
      await dependencies.assertMatch(matchId);
      const target = parseV2GroupOnlyForfeit(formData);
      const participants = await resolveExactFixtureSides(
        matchId,
        target.fixtureId,
        target.winnerEntryId,
      );
      await resultService.confirmForfeit({
        actor: actorContext(actor),
        matchId,
        fixtureId: target.fixtureId,
        expectedFixtureVersion: target.expectedFixtureVersion,
        requiredFixtureStage,
        winnerEntryId: participants.winnerEntryId,
        loserEntryId: participants.loserEntryId,
        reason: target.reason,
      });
      await dependencies.revalidatePaths(SETTLEMENT_PATHS(matchId));
      return { success: profile.forfeitSuccess };
    },

    correctForfeit: async (actor, matchId, formData) => {
      await dependencies.assertMatch(matchId);
      const target = parseV2GroupOnlyForfeitCorrection(formData);
      await resultService.correctForfeit({
        actor: actorContext(actor),
        matchId,
        fixtureId: target.fixtureId,
        expectedFixtureVersion: target.expectedFixtureVersion,
        requiredFixtureStage,
        resultRevisionId: target.resultRevisionId,
        reason: target.reason,
      });
      await dependencies.revalidatePaths(SETTLEMENT_PATHS(matchId));
      return { success: profile.forfeitCorrectionSuccess };
    },
  });
}

/** KNOCKOUT deliberately exposes no unplayed or confirmed VOID command. */
export function createV2KnockoutResultActions(
  dependencies: V2GroupOnlyResultActionDependencies,
  profile: V2GroupOnlyResultActionProfile,
): V2StageResultActions {
  return createV2StageResultActions(dependencies, profile, "KNOCKOUT");
}

/**
 * Backwards-compatible GROUP facade. Group-only and group-then callers share
 * it; the core freezes every GROUP write after a qualification snapshot exists.
 */
export function createV2GroupOnlyResultActions(
  dependencies: V2GroupOnlyResultActionDependencies,
  profile: V2GroupOnlyResultActionProfile,
): V2GroupOnlyResultActions {
  const shared = createV2StageResultActions(dependencies, profile, "GROUP");
  const fixtureStatusTransition =
    dependencies.fixtureStatusTransition ?? transitionV2FixtureStatus;
  const resultService =
    dependencies.resultService ??
    createV2ResultApplicationService({ db: dependencies.db });
  const actorContext = (actor: V2Actor) => ({
    actorId: actor.id,
    role: actor.role,
  });
  return Object.freeze({
    ...shared,
    voidUnplayedFixture: async (actor, matchId, formData) => {
      await dependencies.assertMatch(matchId);
      const target = parseV2GroupOnlyFixtureTarget(formData);
      await fixtureStatusTransition(dependencies.db, {
        actor,
        matchId,
        fixtureId: target.fixtureId,
        expectedVersion: target.expectedFixtureVersion,
        to: "VOIDED",
        requiredFixtureStage: "GROUP",
      });
      await dependencies.revalidatePaths(UNPLAYED_PATHS(matchId));
      return { success: profile.unplayedVoidSuccess };
    },
    voidResult: async (actor, matchId, formData) => {
      await dependencies.assertMatch(matchId);
      const target = parseV2GroupOnlyRevisionTarget(formData, {
        includeReason: true,
      });
      await resultService.voidRevision({
        actor: actorContext(actor),
        matchId,
        fixtureId: target.fixtureId,
        expectedFixtureVersion: target.expectedFixtureVersion,
        requiredFixtureStage: "GROUP",
        resultRevisionId: target.resultRevisionId,
        reason: target.reason,
      });
      await dependencies.revalidatePaths(SETTLEMENT_PATHS(matchId));
      return { success: profile.voidSuccess };
    },
  });
}
