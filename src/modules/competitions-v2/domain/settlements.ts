import { CompetitionDomainError } from "./errors";
import type {
  ResultRevisionStatus,
  ResultSettlementEventKind,
} from "./values";

declare const settlementIdempotencyKeyBrand: unique symbol;
export type SettlementIdempotencyKey = string & {
  readonly [settlementIdempotencyKeyBrand]: true;
};

function assertIdentifier(value: string, name: string) {
  if (value.trim() !== "" && value === value.trim()) return;
  throw new CompetitionDomainError(
    "INVALID_SETTLEMENT_IDENTIFIER",
    `${name} must be a non-empty stable identifier.`,
    { name },
  );
}

function encodeKeyPart(value: string) {
  return encodeURIComponent(value);
}

/** One aggregate settlement event is allowed for each revision and event kind. */
export function createSettlementIdempotencyKey(
  resultRevisionId: string,
  kind: ResultSettlementEventKind,
) {
  assertIdentifier(resultRevisionId, "resultRevisionId");
  return `competition-v2:result-revision:${encodeKeyPart(resultRevisionId)}:${kind}` as SettlementIdempotencyKey;
}

export type SettlementEventDecision =
  | Readonly<{
      action: "RECORD";
      idempotencyKey: SettlementIdempotencyKey;
    }>
  | Readonly<{
      action: "NOOP";
      idempotencyKey: SettlementIdempotencyKey;
    }>;

/**
 * Decides whether to record a settlement event. Repeating the same event is a
 * safe no-op. An application requires a confirmed revision; a reversal
 * requires a prior application and can itself occur only once.
 */
export function decideSettlementEvent(input: Readonly<{
  resultRevisionId: string;
  eventKind: ResultSettlementEventKind;
  revisionStatus: ResultRevisionStatus;
  recordedEventKinds: readonly ResultSettlementEventKind[];
}>): SettlementEventDecision {
  const idempotencyKey = createSettlementIdempotencyKey(
    input.resultRevisionId,
    input.eventKind,
  );

  const hasApplication = input.recordedEventKinds.includes("RESULT_APPLY");
  const hasReversal = input.recordedEventKinds.includes("RESULT_REVERSAL");

  if (hasReversal && !hasApplication) {
    throw new CompetitionDomainError(
      "INVALID_SETTLEMENT_STATE",
      "A recorded result reversal must have a corresponding application.",
      { hasApplication, hasReversal },
    );
  }

  if (input.recordedEventKinds.includes(input.eventKind)) {
    return { action: "NOOP", idempotencyKey };
  }

  if (input.eventKind === "RESULT_APPLY") {
    if (input.revisionStatus === "CONFIRMED" && !hasReversal) {
      return { action: "RECORD", idempotencyKey };
    }
    throw new CompetitionDomainError(
      "INVALID_SETTLEMENT_STATE",
      "A result can be applied only once while its revision is confirmed.",
      {
        eventKind: input.eventKind,
        revisionStatus: input.revisionStatus,
        hasApplication,
        hasReversal,
      },
    );
  }

  const reversibleStatus =
    input.revisionStatus === "CONFIRMED" ||
    input.revisionStatus === "SUPERSEDED" ||
    input.revisionStatus === "VOIDED";
  if (hasApplication && !hasReversal && reversibleStatus) {
    return { action: "RECORD", idempotencyKey };
  }

  throw new CompetitionDomainError(
    "INVALID_SETTLEMENT_STATE",
    "A result reversal requires one prior application and cannot be repeated.",
    {
      eventKind: input.eventKind,
      revisionStatus: input.revisionStatus,
      hasApplication,
      hasReversal,
    },
  );
}
