export const ENGINE_VERSIONS = ["LEGACY", "V2"] as const;
export type EngineVersion = (typeof ENGINE_VERSIONS)[number];

export const ENTRY_KINDS = ["INDIVIDUAL", "DOUBLES", "TEAM"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const ENTRY_STATUSES = [
  "DRAFT",
  "ACTIVE",
  "WITHDRAWN",
  "DISQUALIFIED",
  "ARCHIVED",
] as const;
export type EntryStatus = (typeof ENTRY_STATUSES)[number];

export const ENTRY_MEMBER_STATUSES = [
  "ACTIVE",
  "WITHDRAWN",
  "REMOVED",
  "DISQUALIFIED",
  "SUPERSEDED",
] as const;
export type EntryMemberStatus = (typeof ENTRY_MEMBER_STATUSES)[number];

export const FIXTURE_STAGES = ["GROUP", "KNOCKOUT", "FREE_PLAY"] as const;
export type FixtureStage = (typeof FIXTURE_STAGES)[number];

export const FIXTURE_STATUSES = [
  "SCHEDULED",
  "READY",
  "COMPLETED",
  "VOIDED",
] as const;
export type FixtureStatus = (typeof FIXTURE_STATUSES)[number];

export const RESULT_REVISION_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "REJECTED",
  "VOIDED",
  "SUPERSEDED",
] as const;
export type ResultRevisionStatus = (typeof RESULT_REVISION_STATUSES)[number];

export const SETTLEMENT_EVENT_KINDS = [
  "RESULT_APPLY",
  "RESULT_REVERSAL",
  "REGISTRATION_APPLY",
  "REGISTRATION_REVERSAL",
] as const;
export type SettlementEventKind = (typeof SETTLEMENT_EVENT_KINDS)[number];

export const RESULT_SETTLEMENT_EVENT_KINDS = [
  "RESULT_APPLY",
  "RESULT_REVERSAL",
] as const;
export type ResultSettlementEventKind =
  (typeof RESULT_SETTLEMENT_EVENT_KINDS)[number];
