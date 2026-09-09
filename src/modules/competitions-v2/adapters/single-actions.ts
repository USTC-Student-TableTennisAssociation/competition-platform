import type { PrismaClient, UserRole } from "@prisma/client";

import {
  createV2Entry,
  transitionV2EntryStatus,
  type V2Actor,
} from "../application/entries";
import { transitionV2FixtureStatus } from "../application/fixtures";
import {
  createV2SingleGroupingApplicationService,
  type V2SingleGroupingApplicationService,
} from "../application/grouping";
import {
  type V2SingleGroupTableLabelsApplicationService,
} from "../application/group-table-labels";
import { createV2RelationalGroupTableLabelsApplicationService } from "../application/relational-group-table-labels";
import {
  type V2ResultApplicationService,
} from "../application/results";
import {
  V2ActionBoundaryError,
  assertNoProtectedClientFields,
  assertSingleCsrfField,
  assertUniqueTextFormData,
  mapV2ActionError,
  parseStableIdentifier,
  parseV2FixtureTarget,
} from "./action-boundary";
import {
  createV2GroupOnlyResultActions,
  V2_SINGLE_GROUP_ONLY_RESULT_ACTION_PROFILE,
} from "./group-only-result-actions";
import {
  parseV2SingleGroupingPreviewForm,
  parseV2SingleGroupingPublication,
} from "./single-grouping-boundary";
import { parseV2SingleGroupTableLabelsForm } from "./single-group-table-labels-boundary";
import {
  createV2GroupOnlyGroupingPreview,
  V2_SINGLE_GROUPING_PREVIEW_PROFILE,
} from "./group-only-grouping-preview";

export type V2SingleActionState = Readonly<{
  error?: string;
  success?: string;
  previewJson?: string;
}>;

export type V2SingleActionUser = Readonly<{
  id: string;
  role: UserRole;
}>;

export type V2SingleActionAdapterDependencies = Readonly<{
  db: PrismaClient;
  validateCsrfToken(formData: FormData): Promise<string | null>;
  getCurrentUser(): Promise<V2SingleActionUser | null>;
  revalidatePaths?(paths: readonly string[]): void | Promise<void>;
  logError?(message: string, error: unknown): void | Promise<void>;
  clock?(): Date;
  /** @internal Test seam; production composition must use the default service. */
  groupingService?: V2SingleGroupingApplicationService;
  /** @internal Test seam; production composition must use the default service. */
  groupTableLabelsService?: V2SingleGroupTableLabelsApplicationService;
  /** @internal Test seam; production composition must use the default service. */
  resultService?: V2ResultApplicationService;
  /** @internal Test seam; production composition must use the default transition. */
  fixtureStatusTransition?: typeof transitionV2FixtureStatus;
}>;

export type V2SingleActionHandlers = Readonly<{
  register(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2SingleActionState>;
  cancelRegistration(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2SingleActionState>;
  previewGrouping(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2SingleActionState>;
  publishGrouping(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2SingleActionState>;
  updateGroupTableLabels(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2SingleActionState>;
  markFixtureReady(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2SingleActionState>;
  voidUnplayedFixture(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2SingleActionState>;
  submitResult(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2SingleActionState>;
  submitCorrection(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2SingleActionState>;
  confirmResult(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2SingleActionState>;
  rejectResult(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2SingleActionState>;
  voidResult(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2SingleActionState>;
  confirmForfeit(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2SingleActionState>;
  correctForfeit(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2SingleActionState>;
}>;

/**
 * Framework-independent V2-only boundary. The production Server Actions
 * compose it with trusted auth, CSRF, Prisma, and cache dependencies. It does
 * not choose an engine, expose match creation, or fall back to Legacy. Both
 * formal SINGLE formats share this boundary; fixture stage remains a trusted
 * server-side capability in the result adapters.
 */
export function createV2SingleActionHandlers(
  dependencies: V2SingleActionAdapterDependencies,
): V2SingleActionHandlers {
  const groupingService =
    dependencies.groupingService ??
    createV2SingleGroupingApplicationService({
      db: dependencies.db,
      ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    });
  const groupTableLabelsService =
    dependencies.groupTableLabelsService ??
    createV2RelationalGroupTableLabelsApplicationService(
      { db: dependencies.db },
      { matchType: "single" },
    );
  const fixtureStatusTransition =
    dependencies.fixtureStatusTransition ?? transitionV2FixtureStatus;

  const log = async (message: string, error: unknown) => {
    try {
      if (dependencies.logError) {
        await dependencies.logError(message, error);
        return;
      }
      console.error(message, error);
    } catch (loggingError) {
      // Error reporting is best-effort. It must never replace the original safe
      // action response or make a committed mutation appear to have failed.
      try {
        console.error("V2 action logger failed", loggingError);
      } catch {
        // A replaced/broken console must not escape the action boundary either.
      }
    }
  };

  const revalidate = async (paths: readonly string[]) => {
    if (!dependencies.revalidatePaths) return;
    try {
      await dependencies.revalidatePaths(paths);
    } catch (error) {
      // The mutation has already committed. A cache refresh failure must not
      // make an idempotent command look like a failed database transaction.
      await log("V2 action cache revalidation failed", error);
    }
  };

  const execute = async (
    formData: FormData,
    operation: (actor: V2Actor) => Promise<V2SingleActionState>,
  ): Promise<V2SingleActionState> => {
    try {
      assertUniqueTextFormData(formData);
      assertSingleCsrfField(formData);
      const csrfError = await dependencies.validateCsrfToken(formData);
      if (csrfError) return { error: csrfError };
      assertNoProtectedClientFields(formData);

      const currentUser = await dependencies.getCurrentUser();
      if (!currentUser) return { error: "请先登录。" };
      if (currentUser.role !== "user" && currentUser.role !== "admin") {
        await log("V2 action received an unknown authenticated role", currentUser);
        return { error: "账号权限状态异常，请重新登录后重试。" };
      }

      return await operation({
        id: parseStableIdentifier(currentUser.id, "currentUser.id"),
        role: currentUser.role,
      });
    } catch (error) {
      const safe = mapV2ActionError(error);
      if (safe.shouldLog) await log("V2 single action failed", error);
      return { error: safe.message };
    }
  };

  const parseMatchId = (matchId: unknown) =>
    parseStableIdentifier(matchId, "matchId");

  const assertSingleMatch = async (matchId: string) => {
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
    if (match.engineVersion !== "V2" || match.isQuickMatch) {
      throw new V2ActionBoundaryError(
        "INVALID_RESOURCE_STATE",
        "This adapter accepts non-quick V2 matches only.",
      );
    }
    if (match.type !== "single") {
      throw new V2ActionBoundaryError(
        "INVALID_RESOURCE_STATE",
        "This adapter accepts singles matches only.",
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

  const createGroupingPreview = async (
    matchId: string,
    actorInput: V2Actor,
    formData: FormData,
  ): Promise<V2SingleActionState> => {
    const requested = parseV2SingleGroupingPreviewForm(formData);
    return createV2GroupOnlyGroupingPreview(
      {
        db: dependencies.db,
        ...(dependencies.clock === undefined
          ? {}
          : { clock: dependencies.clock }),
      },
      V2_SINGLE_GROUPING_PREVIEW_PROFILE,
      { matchId, actor: actorInput, requested },
    );
  };
  const resultActions = createV2GroupOnlyResultActions(
    {
      db: dependencies.db,
      assertMatch: assertSingleMatch,
      revalidatePaths: revalidate,
      ...(dependencies.resultService === undefined
        ? {}
        : { resultService: dependencies.resultService }),
      ...(dependencies.fixtureStatusTransition === undefined
        ? {}
        : { fixtureStatusTransition: dependencies.fixtureStatusTransition }),
    },
    V2_SINGLE_GROUP_ONLY_RESULT_ACTION_PROFILE,
  );

  return Object.freeze({
    register: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseMatchId(rawMatchId);
        await assertSingleMatch(matchId);
        const entry = await createV2Entry(dependencies.db, {
          actor,
          matchId,
          kind: "INDIVIDUAL",
          sourceId: actor.id,
          status: "ACTIVE",
        });

        if (entry.status === "DRAFT") {
          await transitionV2EntryStatus(dependencies.db, {
            actor,
            matchId,
            entryId: entry.id,
            expectedVersion: entry.version,
            to: "ACTIVE",
          });
        } else if (entry.status !== "ACTIVE") {
          throw new V2ActionBoundaryError(
            "INVALID_RESOURCE_STATE",
            "A terminal entry cannot be registered again.",
          );
        }

        await revalidate(["/", "/matchs", `/matchs/${matchId}`]);
        return { success: "报名成功。" };
      }),

    cancelRegistration: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseMatchId(rawMatchId);
        await assertSingleMatch(matchId);
        const entry = await dependencies.db.matchEntry.findUnique({
          where: {
            matchId_sourceUserId: {
              matchId,
              sourceUserId: actor.id,
            },
          },
          select: { id: true, kind: true, status: true, version: true },
        });
        if (!entry || entry.kind !== "INDIVIDUAL") {
          throw new V2ActionBoundaryError(
            "RESOURCE_NOT_FOUND",
            "The individual registration does not exist.",
          );
        }
        if (entry.status === "DRAFT") {
          await revalidate(["/", "/matchs", `/matchs/${matchId}`]);
          return { success: "已退出报名。" };
        }
        if (entry.status !== "ACTIVE") {
          throw new V2ActionBoundaryError(
            "INVALID_RESOURCE_STATE",
            "Only an active registration can be cancelled.",
          );
        }

        await transitionV2EntryStatus(dependencies.db, {
          actor,
          matchId,
          entryId: entry.id,
          expectedVersion: entry.version,
          to: "DRAFT",
        });
        await revalidate(["/", "/matchs", `/matchs/${matchId}`]);
        return { success: "已退出报名。" };
      }),

    previewGrouping: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseMatchId(rawMatchId);
        return createGroupingPreview(matchId, actor, formData);
      }),

    publishGrouping: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseMatchId(rawMatchId);
        const publication = parseV2SingleGroupingPublication(
          formData,
          matchId,
        );
        const result = await groupingService.publish({
          actor,
          matchId,
          expectedEntries: publication.expectedEntries,
          draft: publication.draft,
        });
        await revalidate(["/", "/matchs", `/matchs/${matchId}`]);
        return {
          success: result.created
            ? "分组结果已确认并发布。"
            : "分组结果已发布，无需重复操作。",
        };
      }),

    updateGroupTableLabels: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseMatchId(rawMatchId);
        const input = parseV2SingleGroupTableLabelsForm(formData);
        const result = await groupTableLabelsService.update({
          actor,
          matchId,
          groupKey: input.groupKey,
          expectedFixtures: input.expectedFixtures,
          labels: input.labels,
        });
        await revalidate([`/matchs/${matchId}`, `/matchs/${matchId}/grouping`]);
        return {
          success: result.changed
            ? `${result.groupName}桌号已更新。`
            : `${result.groupName}桌号未变化。`,
        };
      }),

    markFixtureReady: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseMatchId(rawMatchId);
        await assertSingleMatch(matchId);
        const target = parseV2FixtureTarget(formData);
        await fixtureStatusTransition(dependencies.db, {
          actor,
          matchId,
          fixtureId: target.fixtureId,
          expectedVersion: target.expectedFixtureVersion,
          to: "READY",
        });
        await revalidate([`/matchs/${matchId}`]);
        return { success: "对局已就绪。" };
      }),

    voidUnplayedFixture: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseMatchId(rawMatchId);
        return resultActions.voidUnplayedFixture(actor, matchId, formData);
      }),

    submitResult: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseMatchId(rawMatchId);
        return resultActions.submitResult(actor, matchId, formData);
      }),

    submitCorrection: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseMatchId(rawMatchId);
        return resultActions.submitCorrection(actor, matchId, formData);
      }),

    confirmResult: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseMatchId(rawMatchId);
        return resultActions.confirmResult(actor, matchId, formData);
      }),

    rejectResult: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseMatchId(rawMatchId);
        return resultActions.rejectResult(actor, matchId, formData);
      }),

    voidResult: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseMatchId(rawMatchId);
        return resultActions.voidResult(actor, matchId, formData);
      }),

    confirmForfeit: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseMatchId(rawMatchId);
        return resultActions.confirmForfeit(actor, matchId, formData);
      }),

    correctForfeit: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseMatchId(rawMatchId);
        return resultActions.correctForfeit(actor, matchId, formData);
      }),
  });
}
