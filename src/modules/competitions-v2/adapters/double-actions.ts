import type { PrismaClient, UserRole } from "@prisma/client";

import {
  createV2Entry,
  transitionV2EntryStatus,
  V2CompetitionApplicationError,
  type V2Actor,
} from "../application/entries";
import {
  createV2DoubleGroupingApplicationService,
  type V2DoubleGroupingApplicationService,
} from "../application/double-grouping";
import type { V2SingleGroupTableLabelsApplicationService } from "../application/group-table-labels";
import { createV2RelationalGroupTableLabelsApplicationService } from "../application/relational-group-table-labels";
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
  parseV2DoubleGroupingPreviewForm,
  parseV2DoubleGroupingPublication,
} from "./double-grouping-boundary";
import { parseV2SingleGroupTableLabelsForm } from "./single-group-table-labels-boundary";
import {
  createV2GroupOnlyGroupingPreview,
  V2_DOUBLE_GROUPING_PREVIEW_PROFILE,
} from "./group-only-grouping-preview";
import {
  createV2GroupOnlyResultActions,
  V2_DOUBLE_GROUP_ONLY_RESULT_ACTION_PROFILE,
} from "./group-only-result-actions";

export type V2DoubleActionState = Readonly<{
  error?: string;
  success?: string;
  previewJson?: string;
}>;

export type V2DoubleActionUser = Readonly<{
  id: string;
  role: UserRole;
}>;

export type V2DoubleActionAdapterDependencies = Readonly<{
  db: PrismaClient;
  validateCsrfToken(formData: FormData): Promise<string | null>;
  getCurrentUser(): Promise<V2DoubleActionUser | null>;
  revalidatePaths?(paths: readonly string[]): void | Promise<void>;
  logError?(message: string, error: unknown): void | Promise<void>;
  clock?(): Date;
  /** @internal Test seam; production composition must use the default service. */
  groupingService?: V2DoubleGroupingApplicationService;
  /** @internal Test seam; production composition must use the default command. */
  createEntry?: typeof createV2Entry;
  /** @internal Test seam; production composition must use the default command. */
  transitionEntryStatus?: typeof transitionV2EntryStatus;
  /** @internal Test seam; production composition must use the default service. */
  resultService?: V2ResultApplicationService;
  /** @internal Test seam; production composition must use the default transition. */
  fixtureStatusTransition?: typeof transitionV2FixtureStatus;
  /** @internal Test seam; production uses the relational six-cell service. */
  groupTableLabelsService?: V2SingleGroupTableLabelsApplicationService;
}>;

export type V2DoubleActionHandlers = Readonly<{
  register(matchId: unknown, formData: FormData): Promise<V2DoubleActionState>;
  cancelRegistration(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2DoubleActionState>;
  previewGrouping(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2DoubleActionState>;
  publishGrouping(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2DoubleActionState>;
  updateGroupTableLabels(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2DoubleActionState>;
  voidUnplayedFixture(matchId: unknown, formData: FormData): Promise<V2DoubleActionState>;
  submitResult(matchId: unknown, formData: FormData): Promise<V2DoubleActionState>;
  submitCorrection(matchId: unknown, formData: FormData): Promise<V2DoubleActionState>;
  confirmResult(matchId: unknown, formData: FormData): Promise<V2DoubleActionState>;
  rejectResult(matchId: unknown, formData: FormData): Promise<V2DoubleActionState>;
  voidResult(matchId: unknown, formData: FormData): Promise<V2DoubleActionState>;
  confirmForfeit(matchId: unknown, formData: FormData): Promise<V2DoubleActionState>;
  correctForfeit(matchId: unknown, formData: FormData): Promise<V2DoubleActionState>;
}>;

const ALLOWED_FORM_FIELDS = new Set(["csrfToken"]);
const RETRYABLE_CODES = new Set([
  "CONCURRENT_WRITE_CONFLICT",
  "PERSISTENCE_CONFLICT",
  "ENTRY_VERSION_CONFLICT",
]);

function assertOnlyRegistrationFields(formData: FormData) {
  for (const field of formData.keys()) {
    // React server-action routing metadata is not a competition field.
    if (field.startsWith("$ACTION_")) continue;
    if (!ALLOWED_FORM_FIELDS.has(field)) {
      throw new V2ActionBoundaryError(
        "INVALID_FORM_FIELD",
        `${field} is not accepted by V2 doubles registration.`,
        field,
      );
    }
  }
}

function isRetryableEntryError(error: unknown) {
  return (
    error instanceof V2CompetitionApplicationError &&
    RETRYABLE_CODES.has(error.code)
  );
}

/**
 * Strict server boundary for the first DOUBLE slice. The browser never chooses
 * a source team or Entry: both are resolved from the authenticated partner and
 * the authoritative MatchDoublesTeam relation.
 */
export function createV2DoubleActionHandlers(
  dependencies: V2DoubleActionAdapterDependencies,
): V2DoubleActionHandlers {
  const createEntry = dependencies.createEntry ?? createV2Entry;
  const transitionEntryStatus =
    dependencies.transitionEntryStatus ?? transitionV2EntryStatus;
  const groupingService =
    dependencies.groupingService ??
    createV2DoubleGroupingApplicationService({
      db: dependencies.db,
      ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    });
  const groupTableLabelsService =
    dependencies.groupTableLabelsService ??
    createV2RelationalGroupTableLabelsApplicationService(
      { db: dependencies.db },
      { matchType: "double" },
    );

  const log = async (message: string, error: unknown) => {
    try {
      if (dependencies.logError) await dependencies.logError(message, error);
      else console.error(message, error);
    } catch {
      // Best-effort logging cannot replace a stable mutation result.
    }
  };

  const revalidatePaths = async (paths: readonly string[]) => {
    if (!dependencies.revalidatePaths) return;
    try {
      await dependencies.revalidatePaths(paths);
    } catch (error) {
      await log("V2 doubles cache revalidation failed", error);
    }
  };
  const revalidate = (matchId: string) =>
    revalidatePaths(["/", "/matchs", `/matchs/${matchId}`, "/team-invites"]);

  const execute = async (
    formData: FormData,
    operation: (actor: V2Actor) => Promise<V2DoubleActionState>,
    validateFields?: (formData: FormData) => void,
  ): Promise<V2DoubleActionState> => {
    try {
      assertUniqueTextFormData(formData);
      assertSingleCsrfField(formData);
      const csrfError = await dependencies.validateCsrfToken(formData);
      if (csrfError) return { error: csrfError };
      validateFields?.(formData);
      assertNoProtectedClientFields(formData);

      const currentUser = await dependencies.getCurrentUser();
      if (!currentUser) return { error: "请先登录。" };
      if (currentUser.role !== "user" && currentUser.role !== "admin") {
        await log(
          "V2 doubles action received an unknown authenticated role",
          currentUser,
        );
        return { error: "账号权限状态异常，请重新登录后重试。" };
      }
      return await operation({
        id: parseStableIdentifier(currentUser.id, "currentUser.id"),
        role: currentUser.role,
      });
    } catch (error) {
      const safe = mapV2ActionError(error);
      if (safe.shouldLog) await log("V2 doubles action failed", error);
      return { error: safe.message };
    }
  };

  const assertDoubleMatch = async (matchId: string) => {
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
    if (match.type !== "double") {
      throw new V2ActionBoundaryError(
        "INVALID_RESOURCE_STATE",
        "This adapter accepts doubles matches only.",
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

  const findActorSource = async (matchId: string, actorId: string) => {
    const sources = await dependencies.db.matchDoublesTeam.findMany({
      where: {
        matchId,
        members: { some: { userId: actorId } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 2,
      select: { id: true },
    });
    if (sources.length === 0) {
      throw new V2ActionBoundaryError(
        "RESOURCE_NOT_FOUND",
        "The authenticated user has no doubles source team for this match.",
      );
    }
    if (sources.length !== 1) {
      throw new V2ActionBoundaryError(
        "INVALID_RESOURCE_STATE",
        "The authenticated user belongs to multiple doubles source teams.",
      );
    }
    return sources[0].id;
  };

  const findSourceEntry = async (matchId: string, sourceId: string) =>
    dependencies.db.matchEntry.findUnique({
      where: {
        matchId_sourceDoublesTeamId: {
          matchId,
          sourceDoublesTeamId: sourceId,
        },
      },
      select: { id: true, kind: true, status: true, version: true },
    });

  const ensureActive = async (
    matchId: string,
    sourceId: string,
    actor: V2Actor,
  ) => {
    const created = await createEntry(dependencies.db, {
      actor,
      matchId,
      kind: "DOUBLES",
      sourceId,
      status: "ACTIVE",
    });
    if (created.status === "ACTIVE") return;
    if (created.status !== "DRAFT") {
      throw new V2ActionBoundaryError(
        "INVALID_RESOURCE_STATE",
        "A terminal doubles Entry cannot be registered again.",
      );
    }
    await transitionEntryStatus(dependencies.db, {
      actor,
      matchId,
      entryId: created.id,
      expectedVersion: created.version,
      to: "ACTIVE",
    });
  };
  const resultActions = createV2GroupOnlyResultActions(
    {
      db: dependencies.db,
      assertMatch: assertDoubleMatch,
      revalidatePaths,
      ...(dependencies.resultService === undefined
        ? {}
        : { resultService: dependencies.resultService }),
      ...(dependencies.fixtureStatusTransition === undefined
        ? {}
        : { fixtureStatusTransition: dependencies.fixtureStatusTransition }),
    },
    V2_DOUBLE_GROUP_ONLY_RESULT_ACTION_PROFILE,
  );

  return Object.freeze({
    register: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseStableIdentifier(rawMatchId, "matchId");
        await assertDoubleMatch(matchId);
        const sourceId = await findActorSource(matchId, actor.id);
        try {
          await ensureActive(matchId, sourceId, actor);
        } catch (error) {
          if (!isRetryableEntryError(error)) throw error;
          const resolved = await findSourceEntry(matchId, sourceId);
          if (!resolved || resolved.kind !== "DOUBLES" || resolved.status !== "ACTIVE") {
            throw error;
          }
        }
        await revalidate(matchId);
        return { success: "双打小队报名成功。" };
      }, assertOnlyRegistrationFields),

    cancelRegistration: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseStableIdentifier(rawMatchId, "matchId");
        await assertDoubleMatch(matchId);
        const sourceId = await findActorSource(matchId, actor.id);
        const entry = await findSourceEntry(matchId, sourceId);
        if (!entry || entry.kind !== "DOUBLES") {
          throw new V2ActionBoundaryError(
            "RESOURCE_NOT_FOUND",
            "The doubles registration does not exist.",
          );
        }
        if (entry.status === "DRAFT") {
          await revalidate(matchId);
          return { success: "双打小队已退出报名。" };
        }
        if (entry.status !== "ACTIVE") {
          throw new V2ActionBoundaryError(
            "INVALID_RESOURCE_STATE",
            "Only an active doubles registration can be cancelled.",
          );
        }
        try {
          await transitionEntryStatus(dependencies.db, {
            actor,
            matchId,
            entryId: entry.id,
            expectedVersion: entry.version,
            to: "DRAFT",
          });
        } catch (error) {
          if (!isRetryableEntryError(error)) throw error;
          const resolved = await findSourceEntry(matchId, sourceId);
          if (!resolved || resolved.kind !== "DOUBLES" || resolved.status !== "DRAFT") {
            throw error;
          }
        }
        await revalidate(matchId);
        return { success: "双打小队已退出报名。" };
      }, assertOnlyRegistrationFields),

    previewGrouping: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseStableIdentifier(rawMatchId, "matchId");
        const requested = parseV2DoubleGroupingPreviewForm(formData);
        return createV2GroupOnlyGroupingPreview(
          {
            db: dependencies.db,
            ...(dependencies.clock === undefined
              ? {}
              : { clock: dependencies.clock }),
          },
          V2_DOUBLE_GROUPING_PREVIEW_PROFILE,
          { matchId, actor, requested },
        );
      }),

    publishGrouping: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseStableIdentifier(rawMatchId, "matchId");
        const publication = parseV2DoubleGroupingPublication(
          formData,
          matchId,
        );
        const result = await groupingService.publish({
          actor,
          matchId,
          expectedEntries: publication.expectedEntries,
          draft: publication.draft,
        });
        await revalidate(matchId);
        return {
          success: result.created
            ? "双打分组结果已确认并发布。"
            : "双打分组结果已发布，无需重复操作。",
        };
      }),

    updateGroupTableLabels: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseStableIdentifier(rawMatchId, "matchId");
        const input = parseV2SingleGroupTableLabelsForm(formData);
        const result = await groupTableLabelsService.update({
          actor,
          matchId,
          groupKey: input.groupKey,
          expectedFixtures: input.expectedFixtures,
          labels: input.labels,
        });
        await revalidate(matchId);
        return {
          success: result.changed
            ? `${result.groupName}桌号已更新。`
            : `${result.groupName}桌号未变化。`,
        };
      }),

    voidUnplayedFixture: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseStableIdentifier(rawMatchId, "matchId");
        return resultActions.voidUnplayedFixture(actor, matchId, formData);
      }),

    submitResult: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseStableIdentifier(rawMatchId, "matchId");
        return resultActions.submitResult(actor, matchId, formData);
      }),

    submitCorrection: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseStableIdentifier(rawMatchId, "matchId");
        return resultActions.submitCorrection(actor, matchId, formData);
      }),

    confirmResult: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseStableIdentifier(rawMatchId, "matchId");
        return resultActions.confirmResult(actor, matchId, formData);
      }),

    rejectResult: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseStableIdentifier(rawMatchId, "matchId");
        return resultActions.rejectResult(actor, matchId, formData);
      }),

    voidResult: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseStableIdentifier(rawMatchId, "matchId");
        return resultActions.voidResult(actor, matchId, formData);
      }),

    confirmForfeit: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseStableIdentifier(rawMatchId, "matchId");
        return resultActions.confirmForfeit(actor, matchId, formData);
      }),

    correctForfeit: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseStableIdentifier(rawMatchId, "matchId");
        return resultActions.correctForfeit(actor, matchId, formData);
      }),
  });
}
