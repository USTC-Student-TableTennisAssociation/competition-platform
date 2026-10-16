import type { PrismaClient, UserRole } from "@prisma/client";
import { createV2ProgressiveKnockoutPublicationApplicationService } from "../application/progressive-knockout-publication";
import { createV2ProgressiveQualificationApplicationService } from "../application/progressive-qualification";
import {
  V2ActionBoundaryError,
  assertSingleCsrfField,
  assertUniqueTextFormData,
  mapV2ActionError,
  readStableIdentifier
} from "./action-boundary";
import type { V2Actor } from "../application/entries";

export type V2ProgressiveKnockoutActionState = Readonly<{
  error?: string;
  success?: string
}>;

type Dependencies = Readonly<{
  db: Pick<PrismaClient, "$transaction">;
  getCurrentUser(): Promise<{ id: string; role: UserRole } | null>;
  validateCsrfToken(formData: FormData): Promise<string | null>;
  revalidatePaths?(paths: readonly string[]): void | Promise<void>;
  logError?(message: string, error: unknown): void | Promise<void>;
  publicationService?: {
    publish(command: { actor: V2Actor; matchId: string }): Promise<{ created: boolean }>
  };
  qualificationService?: {
    freezeGroup(command: {
      actor: V2Actor;
      matchId: string;
      groupId: string
    }): Promise<{ created: boolean }>
  };
}>;

export function createV2ProgressiveKnockoutActionHandlers(dependencies: Dependencies) {
  const publish = dependencies.publicationService ??
    createV2ProgressiveKnockoutPublicationApplicationService({ db: dependencies.db });
  const qualification = dependencies.qualificationService ??
    createV2ProgressiveQualificationApplicationService({ db: dependencies.db });
  const log = async (message: string, error: unknown) => {
    try {
      await dependencies.logError?.(message, error);
    } catch {
      /* Logging cannot replace a committed result. */
    }
  };

  async function execute(
    formData: FormData,
    freeze: boolean
  ): Promise<V2ProgressiveKnockoutActionState> {
    try {
      assertUniqueTextFormData(formData);
      assertSingleCsrfField(formData);
      const allowed = new Set(["csrfToken", "matchId", ...(freeze ? ["groupId"] : [])]);
      for (const name of formData.keys())
        if (!name.startsWith("$ACTION_") && !allowed.has(name))
          throw new V2ActionBoundaryError(
            "INVALID_FORM_FIELD",
            `${name} is not accepted by progressive knockout actions.`,
            name
          );
      const csrfError = await dependencies.validateCsrfToken(formData);
      if (csrfError) return { error: csrfError };
      const user = await dependencies.getCurrentUser();
      if (!user) return { error: "请先登录。" };
      if (user.role !== "user" && user.role !== "admin")
        throw new V2ActionBoundaryError("INVALID_RESOURCE_STATE", "Unsupported actor role.");
      const actor: V2Actor = { id: user.id, role: user.role };
      const matchId = readStableIdentifier(formData, "matchId");
      const result = freeze
        ? await qualification.freezeGroup({
            actor,
            matchId,
            groupId: readStableIdentifier(formData, "groupId")
          })
        : await publish.publish({ actor, matchId });
      try {
        await dependencies.revalidatePaths?.([
          "/",
          "/matchs",
          `/matchs/${matchId}`,
          `/matchs/${matchId}/grouping`,
          "/profile"
        ]);
      } catch (error) {
        await log("Progressive knockout revalidation failed", error);
      }
      return {
        success: freeze
          ? (result.created
              ? "本组晋级名单已确认，淘汰签位已更新；双方确定的场次现在可以比赛。"
              : "本组晋级名单已确认，无需重复操作。")
          : (result.created
              ? "淘汰赛程已提前发布，可安排场地并逐组确认晋级。"
              : "淘汰赛程已发布，无需重复操作。")
      };
    } catch (error) {
      const safe = mapV2ActionError(error);
      if (safe.shouldLog) await log("Progressive knockout action failed", error);
      return { error: safe.message };
    }
  }
  return {
    publish: (formData: FormData) => execute(formData, false),
    freezeGroup: (formData: FormData) => execute(formData, true)
  };
}
