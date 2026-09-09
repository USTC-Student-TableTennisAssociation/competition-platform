import type { PrismaClient, UserRole } from "@prisma/client";
import { replaceCompetitionRoster } from "../application/roster-management";
import { V2CompetitionApplicationError } from "../application/entries";
import { assertUniqueTextFormData, assertSingleCsrfField, parseStableIdentifier, readNonNegativeSafeInteger, readOptionalReason, readOptionalSingleTextField, readSingleTextField, readStableIdentifier, mapV2ActionError } from "./action-boundary";

export type RosterManagementState = Readonly<{ error?: string; success?: string }>;

export function createRosterManagementHandler(dependencies: {
  db: Pick<PrismaClient, "$transaction">;
  getCurrentUser(): Promise<{ id: string; role: UserRole } | null>;
  validateCsrfToken(data: FormData): Promise<string | null>;
  revalidatePaths(paths: readonly string[]): void | Promise<void>;
}) {
  return async (rawMatchId: unknown, formData: FormData): Promise<RosterManagementState> => {
    try {
      assertUniqueTextFormData(formData);
      assertSingleCsrfField(formData);
      const csrf = await dependencies.validateCsrfToken(formData);
      if (csrf) return { error: csrf };
      const allowed = new Set(["csrfToken", "entryId", "expectedEntryVersion", "memberIds", "captainId", "reason"]);
      for (const field of formData.keys()) if (!field.startsWith("$ACTION_") && !allowed.has(field)) return { error: "名单提交包含无效字段。" };
      const actor = await dependencies.getCurrentUser();
      if (!actor || actor.role !== "admin") return { error: "只有平台管理员可以更换成员。" };
      const matchId = parseStableIdentifier(rawMatchId, "matchId");
      let memberIds: unknown;
      try { memberIds = JSON.parse(readSingleTextField(formData, "memberIds")); } catch { return { error: "成员名单无效。" }; }
      if (!Array.isArray(memberIds)) return { error: "成员名单无效。" };
      const ids = memberIds.map(value => parseStableIdentifier(value, "memberId"));
      const reason = readOptionalReason(formData);
      if (!reason) return { error: "请填写换人原因。" };
      const captain = readOptionalSingleTextField(formData, "captainId");
      const result = await replaceCompetitionRoster(dependencies.db, {
        actor, matchId, entryId: readStableIdentifier(formData, "entryId"), expectedEntryVersion: readNonNegativeSafeInteger(formData, "expectedEntryVersion"),
        memberIds: ids, ...(captain ? { captainId: parseStableIdentifier(captain, "captainId") } : {}), reason,
      });
      await dependencies.revalidatePaths(["/", "/matchs", `/matchs/${matchId}`, `/matchs/${matchId}/grouping`, "/profile"]);
      return { success: `名单已更新，已同步 ${result.updatedFixtureCount} 场未开始对局。此前个人成绩保留。` };
    } catch (error) {
      if (error instanceof V2CompetitionApplicationError && error.code === "INVALID_INPUT") return { error: error.message };
      const mapped = mapV2ActionError(error);
      if (mapped.shouldLog) console.error("roster-management-failed", error instanceof Error ? error.name : "UnknownError");
      return { error: mapped.message };
    }
  };
}
