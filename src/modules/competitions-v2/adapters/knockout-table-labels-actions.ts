import type { PrismaClient, UserRole } from "@prisma/client";

import { createV2KnockoutTableLabelsApplicationService } from "../application/knockout-table-labels";
import {
  V2_GROUP_TABLE_LABEL_MAX_COUNT,
  V2_GROUP_TABLE_LABEL_MAX_LENGTH,
  isValidV2GroupTableLabels,
} from "../domain/group-fixture-metadata";
import {
  V2ActionBoundaryError,
  assertSingleCsrfField,
  assertUniqueTextFormData,
  mapV2ActionError,
  parseStableIdentifier,
  readNonNegativeSafeInteger,
  readSingleTextField,
  readStableIdentifier,
} from "./action-boundary";

export type V2KnockoutTableLabelsActionState = Readonly<{
  error?: string;
  success?: string;
}>;

type Service = Readonly<{
  update(command: {
    actor: { id: string; role: "user" | "admin" };
    matchId: string;
    fixtureId: string;
    expectedFixtureVersion: number;
    labels: readonly string[];
  }): Promise<Readonly<{ changed: boolean; roundNumber: number; position: number }>>;
}>;

export type V2KnockoutTableLabelsActionDependencies = Readonly<{
  db: Pick<PrismaClient, "$transaction">;
  validateCsrfToken(formData: FormData): Promise<string | null>;
  getCurrentUser(): Promise<Readonly<{ id: string; role: UserRole }> | null>;
  revalidatePaths?(paths: readonly string[]): void | Promise<void>;
  logError?(message: string, error: unknown): void | Promise<void>;
  /** @internal Test seam. */
  service?: Service;
}>;

function parseLabels(formData: FormData) {
  const raw = readSingleTextField(formData, "labelsJson");
  if (raw.length < 1 || raw.length > 16 * 1024) {
    throw new V2ActionBoundaryError(
      "INVALID_FORM_FIELD",
      "labelsJson is empty or too large.",
      "labelsJson",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new V2ActionBoundaryError(
      "INVALID_FORM_FIELD",
      "labelsJson must contain valid JSON.",
      "labelsJson",
    );
  }
  if (!isValidV2GroupTableLabels(value)) {
    throw new V2ActionBoundaryError(
      "INVALID_FORM_FIELD",
      `labelsJson must contain at most ${V2_GROUP_TABLE_LABEL_MAX_COUNT} unique, trimmed strings of at most ${V2_GROUP_TABLE_LABEL_MAX_LENGTH} characters.`,
      "labelsJson",
    );
  }
  return [...value];
}

function parseForm(formData: FormData) {
  const allowed = new Set([
    "csrfToken",
    "fixtureId",
    "expectedFixtureVersion",
    "labelsJson",
  ]);
  for (const field of formData.keys()) {
    // React server-action routing metadata is not a competition field.
    if (field.startsWith("$ACTION_")) continue;
    if (!allowed.has(field)) {
      throw new V2ActionBoundaryError(
        "INVALID_FORM_FIELD",
        `${field} is not accepted by knockout table labels.`,
        field,
      );
    }
  }
  return {
    fixtureId: readStableIdentifier(formData, "fixtureId"),
    expectedFixtureVersion: readNonNegativeSafeInteger(
      formData,
      "expectedFixtureVersion",
    ),
    labels: parseLabels(formData),
  };
}

export function createV2KnockoutTableLabelsActionHandler(
  dependencies: V2KnockoutTableLabelsActionDependencies,
) {
  const service =
    dependencies.service ??
    createV2KnockoutTableLabelsApplicationService({ db: dependencies.db });
  const log = async (message: string, error: unknown) => {
    try {
      if (dependencies.logError) await dependencies.logError(message, error);
      else console.error(message, error);
    } catch {
      // Logging must not replace the stable action response.
    }
  };

  return async function updateKnockoutTableLabels(
    rawMatchId: unknown,
    formData: FormData,
  ): Promise<V2KnockoutTableLabelsActionState> {
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
          "The authenticated role cannot manage knockout labels.",
        );
      }
      const matchId = parseStableIdentifier(rawMatchId, "matchId");
      const result = await service.update({
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
            `/matchs/${matchId}`,
            `/matchs/${matchId}/grouping`,
          ]);
        } catch (error) {
          await log("V2 knockout table-label cache revalidation failed", error);
        }
      }
      const label = `第 ${result.roundNumber} 轮第 ${result.position} 场`;
      return {
        success: result.changed ? `${label}桌号已更新。` : `${label}桌号未变化。`,
      };
    } catch (error) {
      const safe = mapV2ActionError(error);
      if (safe.shouldLog) await log("V2 knockout table-label update failed", error);
      return { error: safe.message };
    }
  };
}
