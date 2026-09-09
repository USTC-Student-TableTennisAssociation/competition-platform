import type { PrismaClient, UserRole } from "@prisma/client";

import { isVenueOption } from "../../../lib/locations";
import { V2_COMPETITION_TIMEZONE_OFFSET_MINUTES } from "../competition-time";
import {
  V2_GROUP_ONLY_MATCH_TEXT_LIMITS,
  V2_TEAM_GROUP_ONLY_MATCH_MEMBER_LIMITS,
  type CreateV2MatchCommand,
  type V2FormalMatchFormat,
  type V2MatchApplicationService,
  type V2GroupOnlyMatchType,
} from "../application/group-only-match-creation";
import {
  V2ActionBoundaryError,
  assertSingleCsrfField,
  assertUniqueTextFormData,
  mapV2ActionError,
  parseStableIdentifier,
  readOptionalSingleTextField,
  readSingleTextField,
} from "./action-boundary";

const FORM_FIELDS = [
  "csrfToken",
  "creationRequestKey",
  "title",
  "description",
  "location",
  "timezoneOffset",
  "matchDateTime",
  "date",
  "time",
  "registrationDeadline",
  "deadlineDate",
  "deadlineTime",
  "type",
  "format",
  "groupBestOf",
  "knockoutBestOf",
  "teamRegistrationStart",
  "teamRegistrationDeadline",
  "teamMinMembers",
  "teamMaxMembers",
] as const;
const COMPATIBILITY_EMPTY_FIELDS = [
  "teamRegistrationStart",
  "teamRegistrationDeadline",
] as const;
const TEAM_ONLY_FIELDS = ["teamMinMembers", "teamMaxMembers"] as const;
const REQUIRED_TEXT_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const CANONICAL_TIMEZONE_OFFSET_PATTERN = /^(?:0|[1-9]\d*|-[1-9]\d*)$/;
const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LOCAL_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;
const MAX_TIMEZONE_OFFSET_MINUTES = 14 * 60;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/;

export type V2GroupOnlyMatchCreationState = Readonly<{
  error?: string;
  success?: string;
  createdMatchId?: string;
}>;

export type V2GroupOnlyMatchCreationUser = Readonly<{
  id: string;
  role: UserRole;
}>;

export type V2MatchCreationAdapterDependencies<
  TType extends V2GroupOnlyMatchType,
  TFormat extends V2FormalMatchFormat,
> = Readonly<{
  db: Pick<PrismaClient, "$transaction">;
  validateCsrfToken(formData: FormData): Promise<string | null>;
  getCurrentUser(): Promise<V2GroupOnlyMatchCreationUser | null>;
  logError?(message: string, error: unknown): void | Promise<void>;
  /** @internal Test seam; production composition uses the configured factory. */
  creationService?: V2MatchApplicationService<TType, TFormat>;
}>;

export type V2GroupOnlyMatchCreationAdapterDependencies<
  TType extends V2GroupOnlyMatchType,
> = V2MatchCreationAdapterDependencies<TType, "group_only">;

export type V2MatchCreationAdapterConfig<
  TType extends V2GroupOnlyMatchType,
  TFormat extends V2FormalMatchFormat,
> = Readonly<{
  type: TType;
  format: TFormat;
  typeBoundaryMessage: string;
  formatBoundaryMessage: string;
  featureUnavailableMessage: string;
  closedMessage: string;
  logMessage: string;
  isRequestKey(value: unknown): value is string;
  createService(
    db: Pick<PrismaClient, "$transaction">,
  ): V2MatchApplicationService<TType, TFormat>;
}>;

export type V2GroupOnlyMatchCreationAdapterConfig<
  TType extends V2GroupOnlyMatchType,
> = V2MatchCreationAdapterConfig<TType, "group_only">;

function fail(
  code: V2ActionBoundaryError["code"],
  message: string,
  field?: string,
): never {
  throw new V2ActionBoundaryError(code, message, field);
}

function assertOnlyFormFields(formData: FormData, type: V2GroupOnlyMatchType) {
  const allowed = new Set<string>(FORM_FIELDS);
  for (const field of formData.keys()) {
    // React server-action routing metadata is not a competition field.
    if (field.startsWith("$ACTION_")) continue;
    if (!allowed.has(field)) {
      fail(
        "INVALID_FORM_FIELD",
        `${field} is not accepted by V2 ${type} match creation.`,
        field,
      );
    }
  }
}

function normalizedRequiredText(
  formData: FormData,
  field: "title" | "location",
) {
  const normalized = readSingleTextField(formData, field).trim();
  if (
    normalized.length === 0 ||
    normalized.length > V2_GROUP_ONLY_MATCH_TEXT_LIMITS[field] ||
    REQUIRED_TEXT_CONTROL_PATTERN.test(normalized)
  ) {
    fail("INVALID_FORM_FIELD", `${field} is invalid.`, field);
  }
  return normalized;
}

function normalizedDescription(formData: FormData) {
  const raw = readOptionalSingleTextField(formData, "description") ?? "";
  const normalized = raw.trim();
  if (
    normalized.length > V2_GROUP_ONLY_MATCH_TEXT_LIMITS.description ||
    normalized.includes("\u0000")
  ) {
    fail("INVALID_FORM_FIELD", "description is invalid.", "description");
  }
  return normalized === "" ? null : normalized;
}

export function parseV2GroupOnlyTimezoneOffset(formData: FormData) {
  const raw = readSingleTextField(formData, "timezoneOffset");
  if (!CANONICAL_TIMEZONE_OFFSET_PATTERN.test(raw)) {
    fail(
      "INVALID_FORM_FIELD",
      "timezoneOffset must be a canonical minute offset.",
      "timezoneOffset",
    );
  }
  const offset = Number(raw);
  if (
    !Number.isSafeInteger(offset) ||
    Math.abs(offset) > MAX_TIMEZONE_OFFSET_MINUTES
  ) {
    fail(
      "INVALID_FORM_FIELD",
      "timezoneOffset is outside the supported range.",
      "timezoneOffset",
    );
  }
  return offset;
}

function presentValue(value: string | undefined) {
  return value === undefined || value === "" ? null : value;
}

function resolveLocalDateTimeInput(
  formData: FormData,
  fields: Readonly<{ combined: string; date: string; time: string }>,
) {
  const combined = presentValue(
    readOptionalSingleTextField(formData, fields.combined),
  );
  const date = presentValue(readOptionalSingleTextField(formData, fields.date));
  const time = presentValue(readOptionalSingleTextField(formData, fields.time));
  if ((date === null) !== (time === null)) {
    fail(
      "INVALID_FORM_FIELD",
      `${fields.date} and ${fields.time} must be supplied together.`,
      fields.combined,
    );
  }
  const splitValue = date && time ? `${date}T${time}` : null;
  if (combined && splitValue && combined !== splitValue) {
    fail(
      "INVALID_FORM_FIELD",
      `${fields.combined} conflicts with its date and time fields.`,
      fields.combined,
    );
  }
  const resolved = combined ?? splitValue;
  if (!resolved) {
    fail(
      "INVALID_FORM_FIELD",
      `${fields.combined} is required.`,
      fields.combined,
    );
  }
  return resolved;
}

export function parseV2GroupOnlyLocalDateTime(
  input: string,
  timezoneOffsetMinutes: number,
) {
  const match = LOCAL_DATE_TIME_PATTERN.exec(input);
  if (!match) fail("INVALID_FORM_FIELD", "Local date-time is invalid.");
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (year === 0) {
    fail("INVALID_FORM_FIELD", "Local date-time year is invalid.");
  }
  const localAsUtc = new Date(0);
  localAsUtc.setUTCFullYear(year, month - 1, day);
  localAsUtc.setUTCHours(hour, minute, 0, 0);
  if (
    localAsUtc.getUTCFullYear() !== year ||
    localAsUtc.getUTCMonth() !== month - 1 ||
    localAsUtc.getUTCDate() !== day ||
    localAsUtc.getUTCHours() !== hour ||
    localAsUtc.getUTCMinutes() !== minute
  ) {
    fail("INVALID_FORM_FIELD", "Local date-time is not a real calendar time.");
  }
  const parsed = new Date(
    localAsUtc.getTime() + timezoneOffsetMinutes * 60 * 1_000,
  );
  if (!Number.isFinite(parsed.getTime())) {
    fail("INVALID_FORM_FIELD", "Local date-time is outside the valid range.");
  }
  return parsed;
}

function assertCanonicalSplitFields(formData: FormData) {
  for (const field of ["date", "deadlineDate"] as const) {
    const value = presentValue(readOptionalSingleTextField(formData, field));
    if (value && !LOCAL_DATE_PATTERN.test(value)) {
      fail("INVALID_FORM_FIELD", `${field} is invalid.`, field);
    }
  }
  for (const field of ["time", "deadlineTime"] as const) {
    const value = presentValue(readOptionalSingleTextField(formData, field));
    if (value && !LOCAL_TIME_PATTERN.test(value)) {
      fail("INVALID_FORM_FIELD", `${field} is invalid.`, field);
    }
  }
}

function parseTeamMemberLimit(
  formData: FormData,
  field: "teamMinMembers" | "teamMaxMembers",
) {
  const raw = readSingleTextField(formData, field);
  if (!POSITIVE_INTEGER_PATTERN.test(raw)) {
    fail("INVALID_FORM_FIELD", `${field} is invalid.`, field);
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < V2_TEAM_GROUP_ONLY_MATCH_MEMBER_LIMITS.minimum ||
    value > V2_TEAM_GROUP_ONLY_MATCH_MEMBER_LIMITS.maximum
  ) {
    fail("INVALID_FORM_FIELD", `${field} is outside the supported range.`, field);
  }
  return value;
}

function parseCreationCommand<
  TType extends V2GroupOnlyMatchType,
  TFormat extends V2FormalMatchFormat,
>(
  formData: FormData,
  actor: Readonly<{ id: string; role: "user" | "admin" }>,
  config: V2MatchCreationAdapterConfig<TType, TFormat>,
): CreateV2MatchCommand<TType, TFormat> {
  const type = readSingleTextField(formData, "type");
  if (type !== config.type) {
    if (type === "single" || type === "double" || type === "team") {
      fail("FEATURE_NOT_AVAILABLE", config.typeBoundaryMessage, "type");
    }
    fail("INVALID_FORM_FIELD", "type is invalid.", "type");
  }
  const format = readSingleTextField(formData, "format");
  if (
    format !== config.format &&
    (format === "group_only" || format === "group_then_knockout")
  ) {
    fail("FEATURE_NOT_AVAILABLE", config.formatBoundaryMessage, "format");
  }
  if (format !== config.format) {
    fail("INVALID_FORM_FIELD", "format is invalid.", "format");
  }

  assertOnlyFormFields(formData, config.type);
  if (config.type !== "team") {
    for (const field of COMPATIBILITY_EMPTY_FIELDS) {
      const value = readOptionalSingleTextField(formData, field);
      if (value !== undefined && value !== "") {
        fail(
          "INVALID_FORM_FIELD",
          `${field} is not accepted for ${config.type.toUpperCase()} V2 creation.`,
          field,
        );
      }
    }
    for (const field of TEAM_ONLY_FIELDS) {
      if (readOptionalSingleTextField(formData, field) !== undefined) {
        fail(
          "INVALID_FORM_FIELD",
          `${field} is not accepted for ${config.type.toUpperCase()} V2 creation.`,
          field,
        );
      }
    }
  }
  const requestKey = readSingleTextField(formData, "creationRequestKey");
  if (!config.isRequestKey(requestKey)) {
    fail(
      "INVALID_FORM_FIELD",
      "creationRequestKey must be a canonical UUID v4.",
      "creationRequestKey",
    );
  }
  const title = normalizedRequiredText(formData, "title");
  const description = normalizedDescription(formData);
  const location = normalizedRequiredText(formData, "location");
  if (!isVenueOption(location)) {
    fail("INVALID_FORM_FIELD", "location is not an available venue.", "location");
  }
  // Validate the shared Legacy compatibility field, while V2 uses CST.
  parseV2GroupOnlyTimezoneOffset(formData);
  assertCanonicalSplitFields(formData);
  const dateTime = parseV2GroupOnlyLocalDateTime(
    resolveLocalDateTimeInput(formData, {
      combined: "matchDateTime",
      date: "date",
      time: "time",
    }),
    V2_COMPETITION_TIMEZONE_OFFSET_MINUTES,
  );
  const registrationDeadline = parseV2GroupOnlyLocalDateTime(
    resolveLocalDateTimeInput(formData, {
      combined: "registrationDeadline",
      date: "deadlineDate",
      time: "deadlineTime",
    }),
    V2_COMPETITION_TIMEZONE_OFFSET_MINUTES,
  );
  if (registrationDeadline.getTime() >= dateTime.getTime()) {
    fail(
      "INVALID_FORM_FIELD",
      "The registration deadline must be earlier than the match start time.",
      "registrationDeadline",
    );
  }
  function preset(field: string): 3 | 5 | 7 {
    const raw = readOptionalSingleTextField(formData, field) ?? "5";
    if (raw !== "3" && raw !== "5" && raw !== "7") fail("INVALID_FORM_FIELD", "请选择有效局制。", field);
    return Number(raw) as 3 | 5 | 7;
  }
  const groupBestOf = preset("groupBestOf");
  const knockoutBestOf = preset("knockoutBestOf");
  if (config.type === "team") {
    const teamRegistrationStart = parseV2GroupOnlyLocalDateTime(
      readSingleTextField(formData, "teamRegistrationStart"),
      V2_COMPETITION_TIMEZONE_OFFSET_MINUTES,
    );
    const teamRegistrationDeadline = parseV2GroupOnlyLocalDateTime(
      readSingleTextField(formData, "teamRegistrationDeadline"),
      V2_COMPETITION_TIMEZONE_OFFSET_MINUTES,
    );
    const teamMinMembers = parseTeamMemberLimit(formData, "teamMinMembers");
    const teamMaxMembers = parseTeamMemberLimit(formData, "teamMaxMembers");
    if (teamRegistrationStart.getTime() >= teamRegistrationDeadline.getTime()) {
      fail(
        "INVALID_FORM_FIELD",
        "The TEAM registration start must be earlier than its deadline.",
        "teamRegistrationStart",
      );
    }
    if (teamRegistrationDeadline.getTime() >= dateTime.getTime()) {
      fail(
        "INVALID_FORM_FIELD",
        "The TEAM registration deadline must be earlier than the match start time.",
        "teamRegistrationDeadline",
      );
    }
    if (teamMaxMembers < teamMinMembers) {
      fail(
        "INVALID_FORM_FIELD",
        "teamMaxMembers must not be smaller than teamMinMembers.",
        "teamMaxMembers",
      );
    }
    return {
      actor,
      requestKey,
      title,
      description,
      location,
      dateTime,
      registrationDeadline: teamRegistrationDeadline,
      type: config.type,
      teamRegistrationStart,
      teamRegistrationDeadline,
      teamMinMembers,
      teamMaxMembers,
      format: config.format,
      groupBestOf,
      knockoutBestOf,
    } as CreateV2MatchCommand<TType, TFormat>;
  }

  return {
    actor,
    requestKey,
    title,
    description,
    location,
    dateTime,
    registrationDeadline,
    type: config.type,
    format: config.format,
    groupBestOf,
    knockoutBestOf,
  } as CreateV2MatchCommand<TType, TFormat>;
}

export function createV2MatchCreationBoundary<
  TType extends V2GroupOnlyMatchType,
  TFormat extends V2FormalMatchFormat,
>(
  dependencies: V2MatchCreationAdapterDependencies<TType, TFormat>,
  config: V2MatchCreationAdapterConfig<TType, TFormat>,
  operation: "create" | "resolve-existing",
) {
  const service =
    dependencies.creationService ?? config.createService(dependencies.db);

  const log = async (message: string, error: unknown) => {
    try {
      if (dependencies.logError) await dependencies.logError(message, error);
      else console.error(message, error);
    } catch {
      // Error reporting cannot replace a stable boundary response.
    }
  };

  return async function handle(
    formData: FormData,
  ): Promise<V2GroupOnlyMatchCreationState> {
    try {
      assertUniqueTextFormData(formData);
      assertSingleCsrfField(formData);
      const csrfError = await dependencies.validateCsrfToken(formData);
      if (csrfError) return { error: csrfError };
      const currentUser = await dependencies.getCurrentUser();
      if (!currentUser) return { error: "请先登录后再发布比赛。" };
      if (currentUser.role !== "user" && currentUser.role !== "admin") {
        throw new Error("Authenticated user has an unsupported role.");
      }
      const command = parseCreationCommand(
        formData,
        {
          id: parseStableIdentifier(currentUser.id, "currentUser.id"),
          role: currentUser.role,
        },
        config,
      );
      const created =
        operation === "create"
          ? await service.create(command)
          : await service.resolveExisting(command);
      if (!created) return { error: config.closedMessage };
      return { success: "比赛创建成功。", createdMatchId: created.id };
    } catch (error) {
      const safe =
        error instanceof V2ActionBoundaryError &&
        error.code === "FEATURE_NOT_AVAILABLE"
          ? { message: config.featureUnavailableMessage, shouldLog: false }
          : mapV2ActionError(error);
      if (safe.shouldLog) await log(config.logMessage, error);
      return { error: safe.message };
    }
  };
}

export function createV2GroupOnlyMatchCreationBoundary<
  TType extends V2GroupOnlyMatchType,
>(
  dependencies: V2GroupOnlyMatchCreationAdapterDependencies<TType>,
  config: V2GroupOnlyMatchCreationAdapterConfig<TType>,
  operation: "create" | "resolve-existing",
) {
  return createV2MatchCreationBoundary(dependencies, config, operation);
}
