import type { PrismaClient, UserRole } from "@prisma/client";

import type { V2Actor } from "../application/entries";
import { transitionV2FixtureStatus } from "../application/fixtures";
import type { V2ResultApplicationService } from "../application/results";
import {
  V2ActionBoundaryError,
  assertNoProtectedClientFields,
  assertSingleCsrfField,
  assertUniqueTextFormData,
  mapV2ActionError,
  parseStableIdentifier,
} from "./action-boundary";
import {
  createV2GroupOnlyResultActions,
  V2_TEAM_GROUP_ONLY_RESULT_ACTION_PROFILE,
} from "./group-only-result-actions";
import {
  parseV2TeamResultCorrection,
  parseV2TeamResultSubmission,
} from "./team-result-boundary";

export type V2TeamResultActionState = Readonly<{
  error?: string;
  success?: string;
}>;

export type V2TeamResultActionUser = Readonly<{
  id: string;
  role: UserRole;
}>;

export type V2TeamResultActionDependencies = Readonly<{
  db: PrismaClient;
  validateCsrfToken(formData: FormData): Promise<string | null>;
  getCurrentUser(): Promise<V2TeamResultActionUser | null>;
  revalidatePaths?(paths: readonly string[]): void | Promise<void>;
  logError?(message: string, error: unknown): void | Promise<void>;
  /** @internal Test seam; production composition uses the shared V2 service. */
  resultService?: V2ResultApplicationService;
  /** @internal Test seam; production composition uses the shared transition. */
  fixtureStatusTransition?: typeof transitionV2FixtureStatus;
}>;

export type V2TeamResultActionHandlers = Readonly<{
  voidUnplayedFixture(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2TeamResultActionState>;
  submitResult(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2TeamResultActionState>;
  submitCorrection(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2TeamResultActionState>;
  confirmResult(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2TeamResultActionState>;
  rejectResult(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2TeamResultActionState>;
  voidResult(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2TeamResultActionState>;
  confirmForfeit(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2TeamResultActionState>;
  correctForfeit(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2TeamResultActionState>;
}>;

/**
 * Strict TEAM GROUP Web boundary. KNOCKOUT uses the separate stage-owned
 * composition; roster/captain/manager authorization stays in the shared
 * result application service against the frozen Fixture lineup.
 */
export function createV2TeamResultActionHandlers(
  dependencies: V2TeamResultActionDependencies,
): V2TeamResultActionHandlers {
  const log = async (message: string, error: unknown) => {
    try {
      if (dependencies.logError) await dependencies.logError(message, error);
      else console.error(message, error);
    } catch {
      // Best-effort logging cannot replace a stable mutation response.
    }
  };
  const revalidatePaths = async (paths: readonly string[]) => {
    if (!dependencies.revalidatePaths) return;
    try {
      await dependencies.revalidatePaths(paths);
    } catch (error) {
      await log("V2 TEAM result cache revalidation failed", error);
    }
  };
  const execute = async (
    formData: FormData,
    operation: (actor: V2Actor) => Promise<V2TeamResultActionState>,
  ): Promise<V2TeamResultActionState> => {
    try {
      assertUniqueTextFormData(formData);
      assertSingleCsrfField(formData);
      const csrfError = await dependencies.validateCsrfToken(formData);
      if (csrfError) return { error: csrfError };
      assertNoProtectedClientFields(formData);

      const currentUser = await dependencies.getCurrentUser();
      if (!currentUser) return { error: "请先登录。" };
      if (currentUser.role !== "user" && currentUser.role !== "admin") {
        throw new V2ActionBoundaryError(
          "INVALID_RESOURCE_STATE",
          "The authenticated TEAM result role is unsupported.",
        );
      }
      return await operation({
        id: parseStableIdentifier(currentUser.id, "currentUser.id"),
        role: currentUser.role,
      });
    } catch (error) {
      const safe = mapV2ActionError(error);
      if (safe.shouldLog) await log("V2 TEAM result action failed", error);
      return { error: safe.message };
    }
  };

  const assertTeamMatch = async (matchId: string) => {
    const match = await dependencies.db.match.findUnique({
      where: { id: matchId },
      select: {
        type: true,
        format: true,
        engineVersion: true,
        isQuickMatch: true,
      },
    });
    if (!match) {
      throw new V2ActionBoundaryError(
        "RESOURCE_NOT_FOUND",
        "The match does not exist.",
      );
    }
    if (
      match.engineVersion !== "V2" ||
      match.isQuickMatch ||
      match.type !== "team"
    ) {
      throw new V2ActionBoundaryError(
        "INVALID_RESOURCE_STATE",
        "This adapter accepts non-quick V2 TEAM matches only.",
      );
    }
    if (
      match.format !== "group_only" &&
      match.format !== "group_then_knockout"
    ) {
      throw new V2ActionBoundaryError(
        "INVALID_RESOURCE_STATE",
        "This adapter accepts supported formal V2 competition formats only.",
      );
    }
  };

  const resultActions = createV2GroupOnlyResultActions(
    {
      db: dependencies.db,
      assertMatch: assertTeamMatch,
      revalidatePaths,
      parseResultSubmission: parseV2TeamResultSubmission,
      parseResultCorrection: parseV2TeamResultCorrection,
      ...(dependencies.resultService === undefined
        ? {}
        : { resultService: dependencies.resultService }),
      ...(dependencies.fixtureStatusTransition === undefined
        ? {}
        : { fixtureStatusTransition: dependencies.fixtureStatusTransition }),
    },
    V2_TEAM_GROUP_ONLY_RESULT_ACTION_PROFILE,
  );

  const run = (
    rawMatchId: unknown,
    formData: FormData,
    operation: (
      actor: V2Actor,
      matchId: string,
      formData: FormData,
    ) => Promise<V2TeamResultActionState>,
  ) =>
    execute(formData, async (actor) => {
      const matchId = parseStableIdentifier(rawMatchId, "matchId");
      return operation(actor, matchId, formData);
    });

  return Object.freeze({
    voidUnplayedFixture: (matchId, formData) =>
      run(matchId, formData, resultActions.voidUnplayedFixture),
    submitResult: (matchId, formData) =>
      run(matchId, formData, resultActions.submitResult),
    submitCorrection: (matchId, formData) =>
      run(matchId, formData, resultActions.submitCorrection),
    confirmResult: (matchId, formData) =>
      run(matchId, formData, resultActions.confirmResult),
    rejectResult: (matchId, formData) =>
      run(matchId, formData, resultActions.rejectResult),
    voidResult: (matchId, formData) =>
      run(matchId, formData, resultActions.voidResult),
    confirmForfeit: (matchId, formData) =>
      run(matchId, formData, resultActions.confirmForfeit),
    correctForfeit: (matchId, formData) =>
      run(matchId, formData, resultActions.correctForfeit),
  });
}
