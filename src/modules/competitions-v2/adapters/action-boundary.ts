import { Prisma } from "@prisma/client";

import { CompetitionDomainError } from "../domain";
import {
  RegistrationSettlementError,
} from "../application/registration-settlements";
import {
  V2CompetitionApplicationError,
} from "../application/entries";
import { V2ResultApplicationError } from "../application/results-errors";
import type { V2PlayedCorrectionMode } from "../application/results";

const IDENTIFIER_MAX_LENGTH = 191;
const REASON_MAX_LENGTH = 500;
const POSTGRES_INT_MAX = 2_147_483_647;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const CANONICAL_UNSIGNED_INTEGER_PATTERN = /^(0|[1-9]\d*)$/;

const PROTECTED_CLIENT_FIELDS = Object.freeze([
  "actor",
  "actorId",
  "role",
  "kind",
  "entryKind",
  "sourceId",
  "status",
  "to",
  "engineVersion",
  "matchType",
  "isQuickMatch",
  "adminOverride",
  "overrideReason",
  "settlementPort",
  "pointsPolicy",
  "resultService",
  "requiredFixtureStage",
  "clock",
  "metadata",
  "expectedEntries",
  "draft",
  "groupingService",
  "groupTableLabelsService",
  "fixtureStatusTransition",
  "supersedesRevisionId",
]);

export type V2ActionBoundaryErrorCode =
  | "INVALID_CSRF_FIELD"
  | "INVALID_FORM_FIELD"
  | "INVALID_IDENTIFIER"
  | "INVALID_INTEGER"
  | "INVALID_SCORE"
  | "INVALID_REASON"
  | "PROTECTED_FIELD"
  | "RESOURCE_NOT_FOUND"
  | "INVALID_RESOURCE_STATE"
  | "FEATURE_NOT_AVAILABLE";

export class V2ActionBoundaryError extends Error {
  readonly code: V2ActionBoundaryErrorCode;
  readonly field?: string;

  constructor(
    code: V2ActionBoundaryErrorCode,
    message: string,
    field?: string,
  ) {
    super(message);
    this.name = "V2ActionBoundaryError";
    this.code = code;
    this.field = field;
  }
}

function fail(
  code: V2ActionBoundaryErrorCode,
  message: string,
  field?: string,
): never {
  throw new V2ActionBoundaryError(code, message, field);
}

/** Rejects ambiguous duplicate keys and File/Blob payloads at this text API. */
export function assertUniqueTextFormData(formData: FormData) {
  const seen = new Set<string>();
  for (const [field, value] of formData.entries()) {
    if (seen.has(field) || typeof value !== "string") {
      fail(
        field === "csrfToken" ? "INVALID_CSRF_FIELD" : "INVALID_FORM_FIELD",
        `${field} must contain at most one text value.`,
        field,
      );
    }
    seen.add(field);
  }
}

/**
 * Reads exactly one textual value. FormData may contain duplicate keys and
 * File values even when TypeScript says a normal form should not send them.
 */
export function readSingleTextField(formData: FormData, field: string) {
  const values = formData.getAll(field);
  if (values.length !== 1 || typeof values[0] !== "string") {
    fail(
      "INVALID_FORM_FIELD",
      `${field} must contain exactly one text value.`,
      field,
    );
  }
  return values[0];
}

export function readOptionalSingleTextField(
  formData: FormData,
  field: string,
) {
  const values = formData.getAll(field);
  if (values.length === 0) return undefined;
  if (values.length !== 1 || typeof values[0] !== "string") {
    fail(
      "INVALID_FORM_FIELD",
      `${field} must contain at most one text value.`,
      field,
    );
  }
  return values[0];
}

/** Ensures the CSRF validator cannot silently accept the first duplicate. */
export function assertSingleCsrfField(
  formData: FormData,
  field = "csrfToken",
) {
  const values = formData.getAll(field);
  if (
    values.length !== 1 ||
    typeof values[0] !== "string" ||
    values[0].length === 0
  ) {
    fail(
      "INVALID_CSRF_FIELD",
      "The CSRF field must contain exactly one non-empty text token.",
      field,
    );
  }
}

/** Client input must never select trusted application-service dependencies. */
export function assertNoProtectedClientFields(formData: FormData) {
  const protectedField = PROTECTED_CLIENT_FIELDS.find(
    (field) => formData.getAll(field).length > 0,
  );
  if (protectedField !== undefined) {
    fail(
      "PROTECTED_FIELD",
      `${protectedField} is controlled by the server.`,
      protectedField,
    );
  }
}

export function parseStableIdentifier(value: unknown, field: string) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > IDENTIFIER_MAX_LENGTH ||
    value !== value.trim() ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    fail(
      "INVALID_IDENTIFIER",
      `${field} must be one non-empty stable identifier.`,
      field,
    );
  }
  return value;
}

export function readStableIdentifier(formData: FormData, field: string) {
  return parseStableIdentifier(readSingleTextField(formData, field), field);
}

export function parseNonNegativeSafeInteger(value: unknown, field: string) {
  if (
    typeof value !== "string" ||
    !CANONICAL_UNSIGNED_INTEGER_PATTERN.test(value)
  ) {
    fail(
      "INVALID_INTEGER",
      `${field} must be a canonical non-negative integer.`,
      field,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > POSTGRES_INT_MAX) {
    fail(
      "INVALID_INTEGER",
      `${field} must fit a non-negative PostgreSQL integer.`,
      field,
    );
  }
  return parsed;
}

export function readNonNegativeSafeInteger(
  formData: FormData,
  field: string,
) {
  return parseNonNegativeSafeInteger(readSingleTextField(formData, field), field);
}

export function readOptionalReason(formData: FormData, field = "reason") {
  const raw = readOptionalSingleTextField(formData, field);
  if (raw === undefined) return undefined;
  const reason = raw.trim();
  if (reason === "") return undefined;
  if (
    reason.length > REASON_MAX_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(reason.replace(/[\n\r\t]/g, ""))
  ) {
    fail(
      "INVALID_REASON",
      `${field} must be at most ${REASON_MAX_LENGTH} characters.`,
      field,
    );
  }
  return reason;
}

export type ParsedV2FixtureTarget = Readonly<{
  fixtureId: string;
  expectedFixtureVersion: number;
}>;

export function parseV2FixtureTarget(
  formData: FormData,
): ParsedV2FixtureTarget {
  return {
    fixtureId: readStableIdentifier(formData, "fixtureId"),
    expectedFixtureVersion: readNonNegativeSafeInteger(
      formData,
      "expectedFixtureVersion",
    ),
  };
}

export type ParsedSingleResultSubmission = ParsedV2FixtureTarget &
  Readonly<{
    winnerEntryId: string;
    loserEntryId: string;
    score: Readonly<{
      bestOf: 3 | 5 | 7;
      winnerScore: number;
      loserScore: number;
      text: string;
    }>;
  }>;

type ParsedSingleScore = ParsedSingleResultSubmission["score"];

function parseSingleScore(formData: FormData): ParsedSingleScore {
  const bestOfValue = readNonNegativeSafeInteger(formData, "bestOf");
  if (bestOfValue !== 3 && bestOfValue !== 5 && bestOfValue !== 7) {
    fail("INVALID_SCORE", "bestOf must be 3, 5, or 7.", "bestOf");
  }
  const bestOf: 3 | 5 | 7 = bestOfValue;
  const winnerScore = readNonNegativeSafeInteger(formData, "winnerScore");
  const loserScore = readNonNegativeSafeInteger(formData, "loserScore");
  const winsNeeded = (bestOf + 1) / 2;
  if (winnerScore !== winsNeeded || loserScore >= winsNeeded) {
    fail(
      "INVALID_SCORE",
      "The score is inconsistent with the declared winner.",
      "winnerScore",
    );
  }
  return {
    bestOf,
    winnerScore,
    loserScore,
    text: `${winnerScore}:${loserScore}（${bestOf}局${winsNeeded}胜）`,
  };
}

export function parseSingleResultSubmission(
  formData: FormData,
): ParsedSingleResultSubmission {
  const target = parseV2FixtureTarget(formData);
  const winnerEntryId = readStableIdentifier(formData, "winnerEntryId");
  const loserEntryId = readStableIdentifier(formData, "loserEntryId");
  if (winnerEntryId === loserEntryId) {
    fail(
      "INVALID_SCORE",
      "The result winner and loser must be distinct entries.",
      "winnerEntryId",
    );
  }

  return {
    ...target,
    winnerEntryId,
    loserEntryId,
    score: parseSingleScore(formData),
  };
}

export type ParsedSingleResultCorrection = ParsedV2FixtureTarget &
  Readonly<{
    resultRevisionId: string;
    correctionMode: V2PlayedCorrectionMode;
    score: ParsedSingleScore;
  }>;

export function readPlayedCorrectionMode(
  formData: FormData,
): V2PlayedCorrectionMode {
  const mode = readOptionalSingleTextField(formData, "correctionMode");
  if (mode === undefined || mode === "SWAP_WINNER") return "SWAP_WINNER";
  if (mode === "KEEP_WINNER") return mode;
  fail(
    "INVALID_FORM_FIELD",
    "correctionMode must be KEEP_WINNER or SWAP_WINNER.",
    "correctionMode",
  );
}

/**
 * A correction caller selects only the confirmed revision and new score. The
 * server-side result service derives the selected keep/swap participants while
 * holding the fixture and revision locks. Missing mode preserves the legacy
 * exact-swap behavior.
 */
export function parseSingleResultCorrection(
  formData: FormData,
): ParsedSingleResultCorrection {
  for (const field of ["winnerEntryId", "loserEntryId"] as const) {
    if (formData.has(field)) {
      fail(
        "PROTECTED_FIELD",
        `${field} is derived from the confirmed result by the server.`,
        field,
      );
    }
  }
  return {
    ...parseV2FixtureTarget(formData),
    resultRevisionId: readStableIdentifier(formData, "resultRevisionId"),
    correctionMode: readPlayedCorrectionMode(formData),
    score: parseSingleScore(formData),
  };
}

export type ParsedV2RevisionTarget = ParsedV2FixtureTarget &
  Readonly<{
    resultRevisionId: string;
    reason?: string;
  }>;

export function parseV2RevisionTarget(
  formData: FormData,
  options: Readonly<{ includeReason?: boolean }> = {},
): ParsedV2RevisionTarget {
  const target = parseV2FixtureTarget(formData);
  const reason = options.includeReason ? readOptionalReason(formData) : undefined;
  return {
    ...target,
    resultRevisionId: readStableIdentifier(formData, "resultRevisionId"),
    ...(reason === undefined ? {} : { reason }),
  };
}

export type SafeV2ActionError = Readonly<{
  message: string;
  shouldLog: boolean;
}>;

const ACTOR_ERROR_CODES = new Set([
  "ACTOR_NOT_ACTIVE",
  "ACTOR_ROLE_STALE",
  "ACTOR_NOT_FOUND",
  "ACTOR_ROLE_MISMATCH",
  "ACTOR_BANNED",
]);
const NOT_FOUND_ERROR_CODES = new Set([
  "MATCH_NOT_FOUND",
  "ENTRY_NOT_FOUND",
  "ENTRY_SOURCE_NOT_FOUND",
  "FIXTURE_NOT_FOUND",
  "RESULT_REVISION_NOT_FOUND",
  "MATCH_ENTRY_NOT_FOUND",
]);
const CONFLICT_ERROR_CODES = new Set([
  "CONCURRENT_WRITE_CONFLICT",
  "PERSISTENCE_CONFLICT",
  "ENTRY_MEMBER_CONFLICT",
  "ENTRY_VERSION_CONFLICT",
  "FIXTURE_VERSION_CONFLICT",
  "FIXTURE_KEY_CONFLICT",
  "FIXTURE_DEPENDENCY_CONFLICT",
  "STALE_FIXTURE_VERSION",
]);
const ENGINE_ERROR_CODES = new Set([
  "ENGINE_MISMATCH",
  "ENGINE_WRITE_MISMATCH",
  "INVALID_ENGINE_VERSION_TRANSITION",
  "ENGINE_MIGRATION_NOT_VERIFIED",
  "LEGACY_WRITES_NOT_DISABLED",
]);
const STATE_ERROR_CODES = new Set([
  "ENTRY_SOURCE_NOT_ACTIVE",
  "ENTRY_KIND_MATCH_TYPE_MISMATCH",
  "ENTRY_ROSTER_CORRUPT",
  "FIXTURE_CREATION_NOT_ALLOWED",
  "FIXTURE_ENTRY_INVALID",
  "FIXTURE_LINEUP_INVALID",
  "FIXTURE_LINEUP_FROZEN",
  "FIXTURE_RESULT_REQUIRED",
  "FIXTURE_RESULT_MANAGED_STATUS",
  "FIXTURE_STAGE_NOT_ALLOWED",
  "FIXTURE_DEPENDENCY_INVALID",
  "FIXTURE_DEPENDENCY_CYCLE",
  "INVALID_FIXTURE_STATE",
  "INVALID_FIXTURE_PARTICIPANTS",
  "INVALID_FIXTURE_ROSTER",
  "INVALID_RESULT_REVISION",
  "INVALID_RESULT_REVISION_STATE",
  "INVALID_CORRECTION",
  "INVALID_ENTRY_STATE",
  "INVALID_ROSTER",
  "INVALID_ENTRY_KIND_TRANSITION",
  "INVALID_ENTRY_STATUS_TRANSITION",
  "INVALID_ENTRY_MEMBER_STATUS_TRANSITION",
  "ENTRY_MEMBERSHIP_FROZEN",
  "ENTRY_MEMBERSHIP_NOT_EDITABLE",
  "ENTRY_ROSTER_VERSION_NOT_ALLOWED",
  "INVALID_ENTRY_MEMBERS",
  "INVALID_FIXTURE_STAGE_TRANSITION",
  "INVALID_FIXTURE_STATUS_TRANSITION",
  "INVALID_FIXTURE_METADATA",
  "INVALID_RESULT_REVISION_STATUS_TRANSITION",
]);
const INVARIANT_ERROR_CODES = new Set([
  "SETTLEMENT_STATE_CONFLICT",
  "POINTS_POLICY_VIOLATION",
  "AGGREGATE_INVARIANT_VIOLATION",
  "INVALID_SETTLEMENT_IDENTIFIER",
  "INVALID_SETTLEMENT_STATE",
]);

function mapKnownV2ErrorCode(code: string): SafeV2ActionError {
  if (ACTOR_ERROR_CODES.has(code)) {
    return {
      message: "登录状态或账号状态已变化，请重新登录后重试。",
      shouldLog: false,
    };
  }
  if (NOT_FOUND_ERROR_CODES.has(code)) {
    return {
      message: "相关比赛、报名或赛果不存在，请刷新页面后重试。",
      shouldLog: false,
    };
  }
  if (code === "FORBIDDEN") {
    return { message: "你没有权限执行此操作。", shouldLog: false };
  }
  if (code === "REGISTRATION_CLOSED") {
    return {
      message: "当前不在可报名或退出的时间范围内。",
      shouldLog: false,
    };
  }
  if (code === "PARTICIPANT_BANNED") {
    return {
      message: "参赛者账号状态已变化，当前操作无法完成。",
      shouldLog: false,
    };
  }
  if (CONFLICT_ERROR_CODES.has(code)) {
    return {
      message: "数据已被其他操作更新，请刷新页面后重试。",
      shouldLog: false,
    };
  }
  if (ENGINE_ERROR_CODES.has(code)) {
    return {
      message: "比赛处理模式已变化，请刷新页面后重试。",
      shouldLog: true,
    };
  }
  if (code === "PENDING_RESULT_REQUIRES_REVIEW") {
    return { message: "请先核实并确认或驳回该参赛方的待确认比分，再安排退赛。", shouldLog: false };
  }
  if (code === "INVALID_INPUT" || code === "INVALID_COMMAND") {
    return {
      message: "提交的数据无效，请检查后重试。",
      shouldLog: false,
    };
  }
  if (STATE_ERROR_CODES.has(code)) {
    return {
      message: "当前状态不允许执行此操作，请刷新页面后重试。",
      shouldLog: false,
    };
  }
  if (INVARIANT_ERROR_CODES.has(code)) {
    return {
      message: "数据状态异常，操作未生效，请联系管理员。",
      shouldLog: true,
    };
  }
  return { message: "操作失败，请稍后重试。", shouldLog: true };
}

/** Converts internal errors to stable messages without leaking details. */
export function mapV2ActionError(error: unknown): SafeV2ActionError {
  if (error instanceof V2ActionBoundaryError) {
    if (error.code === "INVALID_CSRF_FIELD") {
      return {
        message: "安全校验失败，请刷新页面后重试。",
        shouldLog: false,
      };
    }
    if (error.code === "RESOURCE_NOT_FOUND") {
      return {
        message: "相关比赛、报名或赛果不存在，请刷新页面后重试。",
        shouldLog: false,
      };
    }
    if (error.code === "INVALID_RESOURCE_STATE") {
      return {
        message: "当前状态不允许执行此操作，请刷新页面后重试。",
        shouldLog: false,
      };
    }
    if (error.code === "FEATURE_NOT_AVAILABLE") {
      return {
        message: "该 V2 分组模式暂未开放，请使用纯小组赛。",
        shouldLog: false,
      };
    }
    return {
      message: "提交的数据无效，请检查后重试。",
      shouldLog: false,
    };
  }

  if (
    error instanceof V2CompetitionApplicationError ||
    error instanceof V2ResultApplicationError ||
    error instanceof CompetitionDomainError ||
    error instanceof RegistrationSettlementError
  ) {
    return mapKnownV2ErrorCode(error.code);
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const databaseCode =
      typeof error.meta?.code === "string" ? error.meta.code : null;
    if (
      error.code === "P2034" ||
      (error.code === "P2010" &&
        (databaseCode === "40001" || databaseCode === "40P01")) ||
      error.code === "P2002" ||
      error.code === "P2003"
    ) {
      return {
        message: "数据已被其他操作更新，请刷新页面后重试。",
        shouldLog: false,
      };
    }
    return { message: "操作失败，请稍后重试。", shouldLog: true };
  }

  return { message: "操作失败，请稍后重试。", shouldLog: true };
}
