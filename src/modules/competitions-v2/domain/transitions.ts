import { CompetitionDomainError } from "./errors";
import type {
  EngineVersion,
  EntryKind,
  EntryMemberStatus,
  EntryStatus,
  FixtureStage,
  FixtureStatus,
  ResultRevisionStatus,
} from "./values";

export type EngineMigrationEvidence = Readonly<{
  migrationVerified: boolean;
  legacyWritesDisabled: boolean;
}>;

const ENTRY_STATUS_TRANSITIONS = {
  DRAFT: ["ACTIVE", "WITHDRAWN", "ARCHIVED"],
  ACTIVE: ["WITHDRAWN", "DISQUALIFIED"],
  WITHDRAWN: ["ARCHIVED"],
  DISQUALIFIED: ["ARCHIVED"],
  ARCHIVED: [],
} as const satisfies Record<EntryStatus, readonly EntryStatus[]>;

const ENTRY_MEMBER_STATUS_TRANSITIONS = {
  ACTIVE: ["WITHDRAWN", "REMOVED", "DISQUALIFIED", "SUPERSEDED"],
  WITHDRAWN: [],
  REMOVED: [],
  DISQUALIFIED: [],
  SUPERSEDED: [],
} as const satisfies Record<EntryMemberStatus, readonly EntryMemberStatus[]>;

const FIXTURE_STATUS_TRANSITIONS = {
  SCHEDULED: ["READY", "VOIDED"],
  READY: ["COMPLETED", "VOIDED"],
  COMPLETED: ["VOIDED"],
  VOIDED: [],
} as const satisfies Record<FixtureStatus, readonly FixtureStatus[]>;

const RESULT_REVISION_STATUS_TRANSITIONS = {
  PENDING: ["CONFIRMED", "REJECTED", "VOIDED"],
  CONFIRMED: ["SUPERSEDED", "VOIDED"],
  REJECTED: [],
  VOIDED: [],
  SUPERSEDED: [],
} as const satisfies Record<ResultRevisionStatus, readonly ResultRevisionStatus[]>;

function includesStatus<T extends string>(values: readonly T[], value: T) {
  return values.includes(value);
}

/**
 * Existing matches may move from LEGACY to V2 only through an explicitly
 * verified migration after the old writer has been disabled for that match.
 * New matches should be created as V2 directly. V2 -> LEGACY is intentionally
 * unsupported because a code rollback must not silently roll data backwards.
 */
export function canTransitionEngineVersion(
  from: EngineVersion,
  to: EngineVersion,
  evidence?: EngineMigrationEvidence,
) {
  if (from === to) return true;
  return (
    from === "LEGACY" &&
    to === "V2" &&
    evidence?.migrationVerified === true &&
    evidence.legacyWritesDisabled === true
  );
}

export function assertEngineVersionTransition(
  from: EngineVersion,
  to: EngineVersion,
  evidence?: EngineMigrationEvidence,
) {
  if (from === to) return;

  if (from === "LEGACY" && to === "V2") {
    if (evidence?.migrationVerified !== true) {
      throw new CompetitionDomainError(
        "ENGINE_MIGRATION_NOT_VERIFIED",
        "A legacy match can only move to V2 after its migration is verified.",
        { from, to },
      );
    }
    if (evidence.legacyWritesDisabled !== true) {
      throw new CompetitionDomainError(
        "LEGACY_WRITES_NOT_DISABLED",
        "Legacy writes must be disabled before a match moves to V2.",
        { from, to },
      );
    }
    return;
  }

  throw new CompetitionDomainError(
    "INVALID_ENGINE_VERSION_TRANSITION",
    `Engine version cannot move from ${from} to ${to}.`,
    { from, to },
  );
}

/** Prevents a writer for one engine from mutating a match owned by the other. */
export function assertEngineCanWrite(
  matchEngineVersion: EngineVersion,
  writerEngineVersion: EngineVersion,
) {
  if (matchEngineVersion === writerEngineVersion) return;
  throw new CompetitionDomainError(
    "ENGINE_WRITE_MISMATCH",
    `${writerEngineVersion} cannot write a ${matchEngineVersion} match.`,
    { matchEngineVersion, writerEngineVersion },
  );
}

export function canTransitionEntryKind(from: EntryKind, to: EntryKind) {
  return from === to;
}

export function assertEntryKindTransition(from: EntryKind, to: EntryKind) {
  if (canTransitionEntryKind(from, to)) return;
  throw new CompetitionDomainError(
    "INVALID_ENTRY_KIND_TRANSITION",
    "An entry kind is immutable; create a new entry instead of changing it.",
    { from, to },
  );
}

export function canTransitionEntryStatus(from: EntryStatus, to: EntryStatus) {
  return (
    from === to ||
    includesStatus(
      ENTRY_STATUS_TRANSITIONS[from] as readonly EntryStatus[],
      to,
    )
  );
}

export function assertEntryStatusTransition(from: EntryStatus, to: EntryStatus) {
  if (canTransitionEntryStatus(from, to)) return;
  throw new CompetitionDomainError(
    "INVALID_ENTRY_STATUS_TRANSITION",
    `Entry status cannot move from ${from} to ${to}.`,
    { from, to },
  );
}

export function canTransitionEntryMemberStatus(
  from: EntryMemberStatus,
  to: EntryMemberStatus,
) {
  return (
    from === to ||
    includesStatus(
      ENTRY_MEMBER_STATUS_TRANSITIONS[
        from
      ] as readonly EntryMemberStatus[],
      to,
    )
  );
}

export function assertEntryMemberStatusTransition(
  from: EntryMemberStatus,
  to: EntryMemberStatus,
) {
  if (canTransitionEntryMemberStatus(from, to)) return;
  throw new CompetitionDomainError(
    "INVALID_ENTRY_MEMBER_STATUS_TRANSITION",
    `Entry member status cannot move from ${from} to ${to}.`,
    { from, to },
  );
}

export function canTransitionFixtureStage(from: FixtureStage, to: FixtureStage) {
  return from === to;
}

export function assertFixtureStageTransition(
  from: FixtureStage,
  to: FixtureStage,
) {
  if (canTransitionFixtureStage(from, to)) return;
  throw new CompetitionDomainError(
    "INVALID_FIXTURE_STAGE_TRANSITION",
    "A fixture stage is immutable; create a replacement fixture instead.",
    { from, to },
  );
}

export function canTransitionFixtureStatus(
  from: FixtureStatus,
  to: FixtureStatus,
) {
  return (
    from === to ||
    includesStatus(
      FIXTURE_STATUS_TRANSITIONS[from] as readonly FixtureStatus[],
      to,
    )
  );
}

export function assertFixtureStatusTransition(
  from: FixtureStatus,
  to: FixtureStatus,
) {
  if (canTransitionFixtureStatus(from, to)) return;
  throw new CompetitionDomainError(
    "INVALID_FIXTURE_STATUS_TRANSITION",
    `Fixture status cannot move from ${from} to ${to}.`,
    { from, to },
  );
}

export function canTransitionResultRevisionStatus(
  from: ResultRevisionStatus,
  to: ResultRevisionStatus,
) {
  return (
    from === to ||
    includesStatus(
      RESULT_REVISION_STATUS_TRANSITIONS[
        from
      ] as readonly ResultRevisionStatus[],
      to,
    )
  );
}

export function assertResultRevisionStatusTransition(
  from: ResultRevisionStatus,
  to: ResultRevisionStatus,
) {
  if (canTransitionResultRevisionStatus(from, to)) return;
  throw new CompetitionDomainError(
    "INVALID_RESULT_REVISION_STATUS_TRANSITION",
    `Result revision status cannot move from ${from} to ${to}.`,
    { from, to },
  );
}
