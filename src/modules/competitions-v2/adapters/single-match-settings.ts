import type { PrismaClient, UserRole } from "@prisma/client";

import { isVenueOption } from "../../../lib/locations";
import {
  createV2MatchSettingsApplicationService,
  type V2MatchSettingsApplicationService,
} from "../application/match-settings";
import { V2_SINGLE_MATCH_TEXT_LIMITS } from "../application/matches";
import {
  V2ActionBoundaryError,
  assertSingleCsrfField,
  assertUniqueTextFormData,
  mapV2ActionError,
  parseStableIdentifier,
  readOptionalSingleTextField,
  readSingleTextField,
} from "./action-boundary";
import { V2_COMPETITION_TIMEZONE_OFFSET_MINUTES } from "../competition-time";
import { parseV2LocalDateTime } from "./single-match-creation";

const FORM_FIELDS = [
  "csrfToken",
  "expectedUpdatedAt",
  "title",
  "description",
  "location",
  "date",
  "time",
  "deadlineDate",
  "deadlineTime",
] as const;
const REQUIRED_TEXT_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

export type V2MatchSettingsState = Readonly<{
  error?: string;
  success?: string;
  updatedAt?: string;
}>;

export type V2SingleMatchSettingsState = V2MatchSettingsState;

export type V2MatchSettingsUser = Readonly<{
  id: string;
  role: UserRole;
}>;

export type V2SingleMatchSettingsUser = V2MatchSettingsUser;

export type V2MatchSettingsAdapterDependencies = Readonly<{
  db: Pick<PrismaClient, "$transaction">;
  validateCsrfToken(formData: FormData): Promise<string | null>;
  getCurrentUser(): Promise<V2MatchSettingsUser | null>;
  revalidatePaths?(paths: readonly string[]): void | Promise<void>;
  logError?(message: string, error: unknown): void | Promise<void>;
  clock?(): Date;
  /** @internal Test seam; production composition must use the default service. */
  settingsService?: V2MatchSettingsApplicationService;
}>;

export type V2SingleMatchSettingsAdapterDependencies =
  V2MatchSettingsAdapterDependencies;

function fail(message: string, field?: string): never {
  throw new V2ActionBoundaryError("INVALID_FORM_FIELD", message, field);
}

function assertOnlyFormFields(formData: FormData) {
  const allowed = new Set<string>(FORM_FIELDS);
  for (const field of formData.keys()) {
    // React server-action routing metadata is not a competition field.
    if (field.startsWith("$ACTION_")) continue;
    if (!allowed.has(field)) {
      fail(`${field} is not accepted by V2 match settings.`, field);
    }
  }
}

function normalizedRequiredText(
  formData: FormData,
  field: "title" | "location",
) {
  const value = readSingleTextField(formData, field).trim();
  if (
    value.length === 0 ||
    value.length > V2_SINGLE_MATCH_TEXT_LIMITS[field] ||
    REQUIRED_TEXT_CONTROL_PATTERN.test(value)
  ) {
    fail(`${field} is invalid.`, field);
  }
  return value;
}

function normalizedDescription(formData: FormData) {
  const value = (readOptionalSingleTextField(formData, "description") ?? "").trim();
  if (
    value.length > V2_SINGLE_MATCH_TEXT_LIMITS.description ||
    value.includes("\u0000")
  ) {
    fail("description is invalid.", "description");
  }
  return value === "" ? null : value;
}

function parseExpectedUpdatedAt(formData: FormData) {
  const value = readSingleTextField(formData, "expectedUpdatedAt");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail("expectedUpdatedAt must be a canonical UTC timestamp.", "expectedUpdatedAt");
  }
  return parsed;
}

export function createV2MatchSettingsHandler(
  dependencies: V2MatchSettingsAdapterDependencies,
) {
  const service =
    dependencies.settingsService ??
    createV2MatchSettingsApplicationService({
      db: dependencies.db,
      ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    });

  const log = async (message: string, error: unknown) => {
    try {
      if (dependencies.logError) {
        await dependencies.logError(message, error);
      } else {
        console.error(message, error);
      }
    } catch {
      // Logging is best-effort and must not replace the safe action response.
    }
  };
  const revalidate = async (paths: readonly string[]) => {
    if (!dependencies.revalidatePaths) return;
    try {
      await dependencies.revalidatePaths(paths);
    } catch (error) {
      // The database transaction already committed. Do not report it as failed.
      await log("V2 match settings cache revalidation failed", error);
    }
  };

  return async function updateV2MatchSettings(
    rawMatchId: unknown,
    formData: FormData,
  ): Promise<V2MatchSettingsState> {
    try {
      assertUniqueTextFormData(formData);
      assertSingleCsrfField(formData);
      const csrfError = await dependencies.validateCsrfToken(formData);
      if (csrfError) return { error: csrfError };
      assertOnlyFormFields(formData);

      const currentUser = await dependencies.getCurrentUser();
      if (!currentUser) return { error: "请先登录。" };
      if (currentUser.role !== "user" && currentUser.role !== "admin") {
        await log(
          "V2 match settings received an unknown authenticated role",
          currentUser,
        );
        return { error: "账号权限状态异常，请重新登录后重试。" };
      }

      const title = normalizedRequiredText(formData, "title");
      const description = normalizedDescription(formData);
      const location = normalizedRequiredText(formData, "location");
      if (!isVenueOption(location)) {
        fail("location is not an available venue.", "location");
      }
      const dateTime = parseV2LocalDateTime(
        `${readSingleTextField(formData, "date")}T${readSingleTextField(formData, "time")}`,
        V2_COMPETITION_TIMEZONE_OFFSET_MINUTES,
      );
      const registrationDeadline = parseV2LocalDateTime(
        `${readSingleTextField(formData, "deadlineDate")}T${readSingleTextField(formData, "deadlineTime")}`,
        V2_COMPETITION_TIMEZONE_OFFSET_MINUTES,
      );
      if (registrationDeadline.getTime() >= dateTime.getTime()) {
        fail(
          "registration deadline must be earlier than match date-time.",
          "deadlineDate",
        );
      }
      const result = await service.update({
        actor: {
          id: parseStableIdentifier(currentUser.id, "currentUser.id"),
          role: currentUser.role,
        },
        matchId: parseStableIdentifier(rawMatchId, "matchId"),
        expectedUpdatedAt: parseExpectedUpdatedAt(formData),
        title,
        description,
        location,
        dateTime,
        registrationDeadline,
      });

      await revalidate([
        "/",
        "/matchs",
        `/matchs/${result.matchId}`,
        `/matchs/${result.matchId}/edit`,
      ]);
      return {
        success: result.changed ? "比赛基本信息已更新。" : "比赛基本信息没有变化。",
        updatedAt: result.updatedAt.toISOString(),
      };
    } catch (error) {
      const safe = mapV2ActionError(error);
      if (safe.shouldLog) await log("V2 match settings action failed", error);
      return { error: safe.message };
    }
  };
}

/** Backwards-compatible facade retained for the original SINGLE action API. */
export function createV2SingleMatchSettingsHandler(
  dependencies: V2SingleMatchSettingsAdapterDependencies,
) {
  return createV2MatchSettingsHandler(dependencies);
}
