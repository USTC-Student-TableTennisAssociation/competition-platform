import type { PrismaClient, UserRole } from "@prisma/client";

import {
  createV2EntryDisqualificationApplicationService,
  type DisqualifyV2EntryCommand,
} from "../application/entry-disqualification";
import {
  V2ActionBoundaryError,
  assertSingleCsrfField,
  assertUniqueTextFormData,
  mapV2ActionError,
  parseStableIdentifier,
  readNonNegativeSafeInteger,
  readOptionalReason,
  readStableIdentifier,
} from "./action-boundary";

export type V2EntryDisqualificationActionState = Readonly<{
  error?: string;
  success?: string;
}>;

type Service = Readonly<{
  disqualify(command: DisqualifyV2EntryCommand): Promise<unknown>;
}>;

export type V2EntryDisqualificationActionDependencies = Readonly<{
  db: Pick<PrismaClient, "$transaction">;
  validateCsrfToken(formData: FormData): Promise<string | null>;
  getCurrentUser(): Promise<Readonly<{ id: string; role: UserRole }> | null>;
  revalidatePaths?(paths: readonly string[]): void | Promise<void>;
  logError?(message: string, error: unknown): void | Promise<void>;
  /** @internal Test seam. */
  service?: Service;
}>;

function parseForm(formData: FormData) {
  const allowed = new Set([
    "csrfToken",
    "entryId",
    "expectedEntryVersion",
    "reason",
  ]);
  for (const field of formData.keys()) {
    // React server-action routing metadata is not a competition field.
    if (field.startsWith("$ACTION_")) continue;
    if (!allowed.has(field)) {
      throw new V2ActionBoundaryError(
        "INVALID_FORM_FIELD",
        `${field} is not accepted by Entry disqualification.`,
        field,
      );
    }
  }
  const reason = readOptionalReason(formData);
  if (!reason) {
    throw new V2ActionBoundaryError(
      "INVALID_REASON",
      "A disqualification requires a reason.",
      "reason",
    );
  }
  return {
    entryId: readStableIdentifier(formData, "entryId"),
    expectedEntryVersion: readNonNegativeSafeInteger(
      formData,
      "expectedEntryVersion",
    ),
    reason,
  };
}

export function createV2EntryDisqualificationActionHandler(
  dependencies: V2EntryDisqualificationActionDependencies,
) {
  const service =
    dependencies.service ??
    createV2EntryDisqualificationApplicationService({ db: dependencies.db });
  const log = async (message: string, error: unknown) => {
    try {
      if (dependencies.logError) await dependencies.logError(message, error);
      else console.error(message, error);
    } catch {
      // Logging never replaces the stable action response.
    }
  };
  return async function disqualifyEntry(
    rawMatchId: unknown,
    formData: FormData,
  ): Promise<V2EntryDisqualificationActionState> {
    try {
      assertUniqueTextFormData(formData);
      assertSingleCsrfField(formData);
      const csrfError = await dependencies.validateCsrfToken(formData);
      if (csrfError) return { error: csrfError };
      const input = parseForm(formData);
      const currentUser = await dependencies.getCurrentUser();
      if (!currentUser) return { error: "请先登录。" };
      if (currentUser.role !== "user" && currentUser.role !== "admin") {
        throw new V2ActionBoundaryError(
          "INVALID_RESOURCE_STATE",
          "The authenticated role cannot manage a V2 Entry.",
        );
      }
      const matchId = parseStableIdentifier(rawMatchId, "matchId");
      await service.disqualify({
        actor: {
          id: parseStableIdentifier(currentUser.id, "currentUser.id"),
          role: currentUser.role,
        },
        matchId,
        ...input,
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
          await log("V2 Entry disqualification cache revalidation failed", error);
        }
      }
      return { success: "参赛资格已取消，相关未赛对局与淘汰签表已同步处理。" };
    } catch (error) {
      const safe = mapV2ActionError(error);
      if (safe.shouldLog) await log("V2 Entry disqualification failed", error);
      return { error: safe.message };
    }
  };
}

/** A voluntary withdrawal must resolve pending score reports before exit. */
export function createV2EntryWithdrawalActionHandler(dependencies: V2EntryDisqualificationActionDependencies) {
  const application = createV2EntryDisqualificationApplicationService({ db: dependencies.db });
  const handler = createV2EntryDisqualificationActionHandler({ ...dependencies, service: { disqualify: application.withdraw } });
  return async (matchId: unknown, formData: FormData): Promise<V2EntryDisqualificationActionState> => {
    const state = await handler(matchId, formData);
    return state.success ? { success: "已安排退赛，已确认成绩保留，剩余对局已按弃权处理。" } : state;
  };
}
