export type CompetitionDomainErrorCode =
  | "INVALID_ENGINE_VERSION_TRANSITION"
  | "ENGINE_MIGRATION_NOT_VERIFIED"
  | "LEGACY_WRITES_NOT_DISABLED"
  | "ENGINE_WRITE_MISMATCH"
  | "INVALID_ENTRY_KIND_TRANSITION"
  | "INVALID_ENTRY_STATUS_TRANSITION"
  | "INVALID_ENTRY_MEMBER_STATUS_TRANSITION"
  | "INVALID_ENTRY_SOURCE_KEY"
  | "ENTRY_MEMBERSHIP_FROZEN"
  | "ENTRY_MEMBERSHIP_NOT_EDITABLE"
  | "ENTRY_ROSTER_VERSION_NOT_ALLOWED"
  | "INVALID_ENTRY_MEMBERS"
  | "INVALID_FIXTURE_STAGE_TRANSITION"
  | "INVALID_FIXTURE_STATUS_TRANSITION"
  | "INVALID_FIXTURE_METADATA"
  | "INVALID_FIXTURE_PARTICIPANTS"
  | "INVALID_RESULT_REVISION_STATUS_TRANSITION"
  | "INVALID_SETTLEMENT_IDENTIFIER"
  | "INVALID_SETTLEMENT_STATE";

export type CompetitionDomainErrorDetails = Readonly<Record<string, unknown>>;

export class CompetitionDomainError extends Error {
  readonly code: CompetitionDomainErrorCode;
  readonly details: CompetitionDomainErrorDetails;

  constructor(
    code: CompetitionDomainErrorCode,
    message: string,
    details: CompetitionDomainErrorDetails = {},
  ) {
    super(message);
    this.name = "CompetitionDomainError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}
