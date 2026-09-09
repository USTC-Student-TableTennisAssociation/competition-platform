import type { PrismaClient, UserRole } from "@prisma/client";

import {
  createV2TeamGroupingApplicationService,
  type V2TeamGroupingApplicationService,
} from "../application/team-grouping";
import type { V2SingleGroupTableLabelsApplicationService } from "../application/group-table-labels";
import { createV2RelationalGroupTableLabelsApplicationService } from "../application/relational-group-table-labels";
import type { V2Actor } from "../application/entries";
import {
  V2ActionBoundaryError,
  assertNoProtectedClientFields,
  assertSingleCsrfField,
  assertUniqueTextFormData,
  mapV2ActionError,
  parseStableIdentifier,
} from "./action-boundary";
import {
  parseV2TeamGroupingPreviewForm,
  parseV2TeamGroupingPublication,
} from "./team-grouping-boundary";
import { parseV2SingleGroupTableLabelsForm } from "./single-group-table-labels-boundary";
import {
  createV2GroupOnlyGroupingPreview,
  V2_TEAM_GROUPING_PREVIEW_PROFILE,
} from "./group-only-grouping-preview";

export type V2TeamGroupingActionState = Readonly<{
  error?: string;
  success?: string;
  previewJson?: string;
}>;

export type V2TeamGroupingActionUser = Readonly<{
  id: string;
  role: UserRole;
}>;

export type V2TeamGroupingActionDependencies = Readonly<{
  db: PrismaClient;
  validateCsrfToken(formData: FormData): Promise<string | null>;
  getCurrentUser(): Promise<V2TeamGroupingActionUser | null>;
  revalidatePaths?(paths: readonly string[]): void | Promise<void>;
  logError?(message: string, error: unknown): void | Promise<void>;
  clock?(): Date;
  /** @internal Test seam; production composition uses the TEAM facade. */
  groupingService?: V2TeamGroupingApplicationService;
  /** @internal Test seam; production uses the relational six-cell service. */
  groupTableLabelsService?: V2SingleGroupTableLabelsApplicationService;
}>;

export type V2TeamGroupingActionHandlers = Readonly<{
  previewGrouping(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2TeamGroupingActionState>;
  publishGrouping(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2TeamGroupingActionState>;
  updateGroupTableLabels(
    matchId: unknown,
    formData: FormData,
  ): Promise<V2TeamGroupingActionState>;
}>;

export function createV2TeamGroupingActionHandlers(
  dependencies: V2TeamGroupingActionDependencies,
): V2TeamGroupingActionHandlers {
  const groupingService =
    dependencies.groupingService ??
    createV2TeamGroupingApplicationService({
      db: dependencies.db,
      ...(dependencies.clock === undefined
        ? {}
        : { clock: dependencies.clock }),
    });
  const groupTableLabelsService =
    dependencies.groupTableLabelsService ??
    createV2RelationalGroupTableLabelsApplicationService(
      { db: dependencies.db },
      { matchType: "team" },
    );

  const log = async (message: string, error: unknown) => {
    try {
      if (dependencies.logError) await dependencies.logError(message, error);
      else console.error(message, error);
    } catch {
      // Best-effort logging cannot replace the stable action response.
    }
  };
  const revalidate = async (matchId: string) => {
    if (!dependencies.revalidatePaths) return;
    try {
      await dependencies.revalidatePaths([
        "/",
        "/matchs",
        `/matchs/${matchId}`,
        `/matchs/${matchId}/grouping`,
      ]);
    } catch (error) {
      await log("V2 TEAM grouping cache revalidation failed", error);
    }
  };
  const execute = async (
    formData: FormData,
    operation: (actor: V2Actor) => Promise<V2TeamGroupingActionState>,
  ): Promise<V2TeamGroupingActionState> => {
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
          "The authenticated TEAM grouping role is unsupported.",
        );
      }
      return await operation({
        id: parseStableIdentifier(currentUser.id, "currentUser.id"),
        role: currentUser.role,
      });
    } catch (error) {
      const safe = mapV2ActionError(error);
      if (safe.shouldLog) await log("V2 TEAM grouping action failed", error);
      return { error: safe.message };
    }
  };

  return Object.freeze({
    previewGrouping: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseStableIdentifier(rawMatchId, "matchId");
        const requested = parseV2TeamGroupingPreviewForm(formData);
        return createV2GroupOnlyGroupingPreview(
          {
            db: dependencies.db,
            ...(dependencies.clock === undefined
              ? {}
              : { clock: dependencies.clock }),
          },
          V2_TEAM_GROUPING_PREVIEW_PROFILE,
          { matchId, actor, requested },
        );
      }),

    publishGrouping: (rawMatchId, formData) =>
      execute(formData, async (actor) => {
        const matchId = parseStableIdentifier(rawMatchId, "matchId");
        const publication = parseV2TeamGroupingPublication(formData, matchId);
        const result = await groupingService.publish({
          actor,
          matchId,
          expectedEntries: publication.expectedEntries,
          draft: publication.draft,
        });
        await revalidate(matchId);
        return {
          success: result.created
            ? "团体分组结果已确认并发布。"
            : "团体分组结果已发布，无需重复操作。",
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
  });
}
