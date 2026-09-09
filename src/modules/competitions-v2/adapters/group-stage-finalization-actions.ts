import type { PrismaClient, UserRole } from "@prisma/client";

import {
  createV2QualificationAndKnockoutPublicationApplicationService,
  type V2QualificationAndKnockoutPublicationApplicationService,
} from "../application/qualification-and-knockout-publication";
import {
  V2ActionBoundaryError,
  assertSingleCsrfField,
  assertUniqueTextFormData,
  mapV2ActionError,
  parseStableIdentifier,
} from "./action-boundary";

export type V2GroupStageFinalizationActionState = Readonly<{
  error?: string;
  success?: string;
}>;

export type V2GroupStageFinalizationActionUser = Readonly<{
  id: string;
  role: UserRole;
}>;

export type V2GroupStageFinalizationActionDependencies = Readonly<{
  db: Pick<PrismaClient, "$transaction">;
  validateCsrfToken(formData: FormData): Promise<string | null>;
  getCurrentUser(): Promise<V2GroupStageFinalizationActionUser | null>;
  revalidatePaths?(paths: readonly string[]): void | Promise<void>;
  logError?(message: string, error: unknown): void | Promise<void>;
  clock?(): Date;
  /** @internal Test seam; production composition must use the atomic service. */
  finalizationService?: V2QualificationAndKnockoutPublicationApplicationService;
}>;

function assertOnlyCsrf(formData: FormData) {
  for (const field of formData.keys()) {
    // React server-action routing metadata is not a competition field.
    if (field.startsWith("$ACTION_")) continue;
    if (field !== "csrfToken") {
      throw new V2ActionBoundaryError(
        "INVALID_FORM_FIELD",
        `${field} is not accepted by group-stage finalization.`,
        field,
      );
    }
  }
}

/**
 * The sole Web mutation for closing a V2 group phase. The browser supplies no
 * qualification or bracket identity: both are derived and persisted by the
 * one Serializable freeze-and-publish application transaction.
 */
export function createV2GroupStageFinalizationActionHandler(
  dependencies: V2GroupStageFinalizationActionDependencies,
) {
  const service =
    dependencies.finalizationService ??
    createV2QualificationAndKnockoutPublicationApplicationService({
      db: dependencies.db,
      ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    });
  const log = async (message: string, error: unknown) => {
    try {
      if (dependencies.logError) await dependencies.logError(message, error);
      else console.error(message, error);
    } catch {
      // Logging must never replace the stable action response.
    }
  };

  return async function finalizeGroupStage(
    rawMatchId: unknown,
    formData: FormData,
  ): Promise<V2GroupStageFinalizationActionState> {
    try {
      assertUniqueTextFormData(formData);
      assertSingleCsrfField(formData);
      assertOnlyCsrf(formData);
      const csrfError = await dependencies.validateCsrfToken(formData);
      if (csrfError) return { error: csrfError };

      const currentUser = await dependencies.getCurrentUser();
      if (!currentUser) return { error: "请先登录。" };
      if (currentUser.role !== "user" && currentUser.role !== "admin") {
        throw new V2ActionBoundaryError(
          "INVALID_RESOURCE_STATE",
          "The authenticated group-stage finalization role is unsupported.",
        );
      }
      const matchId = parseStableIdentifier(rawMatchId, "matchId");
      const actorId = parseStableIdentifier(currentUser.id, "currentUser.id");
      const result = await service.freezeAndPublish({
        actor: { id: actorId, role: currentUser.role },
        matchId,
      });

      if (dependencies.revalidatePaths) {
        try {
          await dependencies.revalidatePaths([
            "/",
            "/matchs",
            `/matchs/${matchId}`,
            `/matchs/${matchId}/grouping`,
            "/profile",
          ]);
        } catch (error) {
          await log("V2 group-stage finalization cache revalidation failed", error);
        }
      }
      return {
        success: result.knockout.created
          ? "小组排名已冻结，淘汰签表已生成。"
          : "淘汰签表已生成，无需重复操作。",
      };
    } catch (error) {
      const safe = mapV2ActionError(error);
      if (safe.shouldLog) {
        await log("V2 group-stage finalization action failed", error);
      }
      return { error: safe.message };
    }
  };
}
