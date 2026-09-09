export type V2ResultApplicationErrorCode =
  | "INVALID_COMMAND"
  | "MATCH_NOT_FOUND"
  | "FIXTURE_NOT_FOUND"
  | "RESULT_REVISION_NOT_FOUND"
  | "ACTOR_NOT_FOUND"
  | "ACTOR_NOT_ACTIVE"
  | "ACTOR_ROLE_MISMATCH"
  | "ACTOR_BANNED"
  | "PARTICIPANT_BANNED"
  | "FORBIDDEN"
  | "ENGINE_MISMATCH"
  | "CONCURRENT_WRITE_CONFLICT"
  | "PERSISTENCE_CONFLICT"
  | "STALE_FIXTURE_VERSION"
  | "INVALID_FIXTURE_STATE"
  | "INVALID_FIXTURE_PARTICIPANTS"
  | "INVALID_FIXTURE_ROSTER"
  | "INVALID_RESULT_REVISION"
  | "INVALID_RESULT_REVISION_STATE"
  | "INVALID_CORRECTION"
  | "SETTLEMENT_STATE_CONFLICT"
  | "POINTS_POLICY_VIOLATION"
  | "AGGREGATE_INVARIANT_VIOLATION";

export type V2ResultApplicationErrorDetails = Readonly<
  Record<string, unknown>
>;

export class V2ResultApplicationError extends Error {
  readonly code: V2ResultApplicationErrorCode;
  readonly details: V2ResultApplicationErrorDetails;

  constructor(
    code: V2ResultApplicationErrorCode,
    message: string,
    details: V2ResultApplicationErrorDetails = {},
  ) {
    super(message);
    this.name = "V2ResultApplicationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}
