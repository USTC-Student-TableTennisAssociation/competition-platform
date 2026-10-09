import type { PrismaClient, UserRole } from "@prisma/client";
import { finishV2Match, previewV2MatchClosure, V2MatchClosureError, type V2MatchClosurePreview } from "../application/match-closure";
import { assertSingleCsrfField, assertUniqueTextFormData, mapV2ActionError, parseStableIdentifier, readOptionalReason, readSingleTextField, V2ActionBoundaryError } from "./action-boundary";

export type V2MatchClosureActionState = Readonly<{
  preview?: V2MatchClosurePreview;
  error?: string;
  success?: string;
}>;

type Dependencies = Readonly<{
  db: Pick<PrismaClient, "$transaction">;
  validateCsrfToken(formData: FormData): Promise<string | null>;
  getCurrentUser(): Promise<Readonly<{ id: string; role: UserRole }> | null>;
  revalidatePaths?(paths: readonly string[]): void | Promise<void>;
  logError?(message: string, error: unknown): void | Promise<void>;
}>;

export function createV2MatchClosureActionHandlers(dependencies: Dependencies) {
  async function run(rawMatchId: unknown, form: FormData, finish: boolean): Promise<V2MatchClosureActionState> {
    try {
      assertUniqueTextFormData(form);
      assertSingleCsrfField(form);
      const allowed = new Set(finish ? ["csrfToken", "fingerprint", "confirm", "reason"] : ["csrfToken"]);
      for (const key of form.keys()) {
        if (!key.startsWith("$ACTION_") && !allowed.has(key)) throw new V2ActionBoundaryError("INVALID_FORM_FIELD", "Unexpected match closure field.", key);
      }
      const csrfError = await dependencies.validateCsrfToken(form);
      if (csrfError) return { error: csrfError };
      const user = await dependencies.getCurrentUser();
      if (!user) return { error: "请先登录。" };
      if (user.role !== "admin") return { error: "只有管理员可以结束比赛。" };
      const input = { actor: { id: parseStableIdentifier(user.id, "currentUser.id"), role: "admin" as const }, matchId: parseStableIdentifier(rawMatchId, "matchId") };
      if (!finish) return { preview: await previewV2MatchClosure(dependencies.db, input) };
      if (readSingleTextField(form, "confirm") !== "yes") return { error: "请确认作废名单并勾选结束比赛。" };
      const result = await finishV2Match(dependencies.db, {
        ...input, expectedFingerprint: readSingleTextField(form, "fingerprint"), reason: readOptionalReason(form),
      });
      if (dependencies.revalidatePaths) {
        try {
          await dependencies.revalidatePaths(["/", "/matchs", `/matchs/${input.matchId}`, `/matchs/${input.matchId}/grouping`, "/profile"]);
        } catch (error) {
          try { await dependencies.logError?.("V2 match closure cache revalidation failed", error); } catch {}
        }
      }
      return { success: result.alreadyFinished ? "比赛已结束，无需重复操作。" : `比赛已结束，${result.voidedCount} 场未提交成绩的对局已作废。` };
    } catch (error) {
      if (error instanceof V2MatchClosureError) return { error: error.message };
      const safe = mapV2ActionError(error);
      if (safe.shouldLog) {
        try { await dependencies.logError?.("V2 match closure action failed", error); } catch {}
      }
      return { error: safe.message };
    }
  }
  return {
    preview: (matchId: unknown, form: FormData) => run(matchId, form, false),
    finish: (matchId: unknown, form: FormData) => run(matchId, form, true),
  };
}
