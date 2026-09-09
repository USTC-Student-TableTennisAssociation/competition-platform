import type { PrismaClient, UserRole } from "@prisma/client";

import type { V2Actor } from "../application/entries";
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
  createV2KnockoutResultActions,
  V2_DOUBLE_GROUP_ONLY_RESULT_ACTION_PROFILE,
  V2_SINGLE_GROUP_ONLY_RESULT_ACTION_PROFILE,
  V2_TEAM_GROUP_ONLY_RESULT_ACTION_PROFILE,
  type V2GroupOnlyResultActionProfile,
  type V2GroupOnlyResultActionState,
} from "./group-only-result-actions";
import {
  parseV2TeamResultCorrection,
  parseV2TeamResultSubmission,
} from "./team-result-boundary";

export type V2KnockoutResultActionState = V2GroupOnlyResultActionState;

export type V2KnockoutResultActionProfile = Readonly<{
  matchType: "single" | "double" | "team";
  result: V2GroupOnlyResultActionProfile;
  scoreKind: "RACKET_GAMES" | "TEAM_AGGREGATE";
}>;

export const V2_SINGLE_KNOCKOUT_RESULT_ACTION_PROFILE = Object.freeze({
  matchType: "single",
  result: V2_SINGLE_GROUP_ONLY_RESULT_ACTION_PROFILE,
  scoreKind: "RACKET_GAMES",
} satisfies V2KnockoutResultActionProfile);

export const V2_DOUBLE_KNOCKOUT_RESULT_ACTION_PROFILE = Object.freeze({
  matchType: "double",
  result: V2_DOUBLE_GROUP_ONLY_RESULT_ACTION_PROFILE,
  scoreKind: "RACKET_GAMES",
} satisfies V2KnockoutResultActionProfile);

export const V2_TEAM_KNOCKOUT_RESULT_ACTION_PROFILE = Object.freeze({
  matchType: "team",
  result: V2_TEAM_GROUP_ONLY_RESULT_ACTION_PROFILE,
  scoreKind: "TEAM_AGGREGATE",
} satisfies V2KnockoutResultActionProfile);

export type V2KnockoutResultActionUser = Readonly<{
  id: string;
  role: UserRole;
}>;

export type V2KnockoutResultActionDependencies = Readonly<{
  db: PrismaClient;
  validateCsrfToken(formData: FormData): Promise<string | null>;
  getCurrentUser(): Promise<V2KnockoutResultActionUser | null>;
  revalidatePaths?(paths: readonly string[]): void | Promise<void>;
  logError?(message: string, error: unknown): void | Promise<void>;
  /** @internal Test seam; production uses the shared result service. */
  resultService?: V2ResultApplicationService;
}>;

export type V2KnockoutResultActionHandlers = Readonly<{
  submitResult(matchId: unknown, formData: FormData): Promise<V2KnockoutResultActionState>;
  submitCorrection(matchId: unknown, formData: FormData): Promise<V2KnockoutResultActionState>;
  confirmResult(matchId: unknown, formData: FormData): Promise<V2KnockoutResultActionState>;
  rejectResult(matchId: unknown, formData: FormData): Promise<V2KnockoutResultActionState>;
  confirmForfeit(matchId: unknown, formData: FormData): Promise<V2KnockoutResultActionState>;
  correctForfeit(matchId: unknown, formData: FormData): Promise<V2KnockoutResultActionState>;
}>;

/**
 * One strict browser boundary for every knockout match type. Match type and
 * KNOCKOUT stage are injected by production composition and never accepted
 * from FormData. The core remains authoritative for frozen-lineup permissions.
 */
export function createV2KnockoutResultActionHandlers(
  dependencies: V2KnockoutResultActionDependencies,
  profile: V2KnockoutResultActionProfile,
): V2KnockoutResultActionHandlers {
  const log = async (message: string, error: unknown) => {
    try {
      if (dependencies.logError) await dependencies.logError(message, error);
      else console.error(message, error);
    } catch {
      // A best-effort logger cannot replace a stable action response.
    }
  };
  const revalidatePaths = async (paths: readonly string[]) => {
    if (!dependencies.revalidatePaths) return;
    try {
      await dependencies.revalidatePaths(paths);
    } catch (error) {
      await log("V2 knockout result cache revalidation failed", error);
    }
  };
  const execute = async (
    formData: FormData,
    operation: (actor: V2Actor) => Promise<V2KnockoutResultActionState>,
  ): Promise<V2KnockoutResultActionState> => {
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
          "The authenticated result role is unsupported.",
        );
      }
      return await operation({
        id: parseStableIdentifier(currentUser.id, "currentUser.id"),
        role: currentUser.role,
      });
    } catch (error) {
      const safe = mapV2ActionError(error);
      if (safe.shouldLog) await log("V2 knockout result action failed", error);
      return { error: safe.message };
    }
  };
  const assertMatch = async (matchId: string) => {
    const match = await dependencies.db.match.findUnique({
      where: { id: matchId },
      select: {
        engineVersion: true,
        isQuickMatch: true,
        type: true,
        format: true,
      },
    });
    if (!match) {
      throw new V2ActionBoundaryError("RESOURCE_NOT_FOUND", "The match does not exist.");
    }
    if (
      match.engineVersion !== "V2" ||
      match.isQuickMatch ||
      match.type !== profile.matchType ||
      match.format !== "group_then_knockout"
    ) {
      throw new V2ActionBoundaryError(
        "INVALID_RESOURCE_STATE",
        `This adapter accepts formal V2 ${profile.matchType} group-then-knockout matches only.`,
      );
    }
  };
  const actions = createV2KnockoutResultActions(
    {
      db: dependencies.db,
      assertMatch,
      revalidatePaths,
      ...(dependencies.resultService === undefined
        ? {}
        : { resultService: dependencies.resultService }),
      ...(profile.scoreKind === "TEAM_AGGREGATE"
        ? {
            parseResultSubmission: parseV2TeamResultSubmission,
            parseResultCorrection: parseV2TeamResultCorrection,
          }
        : {}),
    },
    profile.result,
  );
  const run = (
    rawMatchId: unknown,
    formData: FormData,
    operation: (
      actor: V2Actor,
      matchId: string,
      formData: FormData,
    ) => Promise<V2KnockoutResultActionState>,
  ) =>
    execute(formData, async (actor) => {
      const matchId = parseStableIdentifier(rawMatchId, "matchId");
      return operation(actor, matchId, formData);
    });

  return Object.freeze({
    submitResult: (matchId, formData) =>
      run(matchId, formData, actions.submitResult),
    submitCorrection: (matchId, formData) =>
      run(matchId, formData, actions.submitCorrection),
    confirmResult: (matchId, formData) =>
      run(matchId, formData, actions.confirmResult),
    rejectResult: (matchId, formData) =>
      run(matchId, formData, actions.rejectResult),
    confirmForfeit: (matchId, formData) =>
      run(matchId, formData, actions.confirmForfeit),
    correctForfeit: (matchId, formData) =>
      run(matchId, formData, actions.correctForfeit),
  });
}
