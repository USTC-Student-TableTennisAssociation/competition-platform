import type { Prisma } from "@prisma/client";

export type V2GroupOnlyRevisionUserDisplay = Readonly<{
  userId: string;
  nickname: string;
  avatarUrl: string | null;
}>;

export type V2GroupOnlyRevisionReadModel = Readonly<{
  revisionId: string;
  revisionVersion: number;
  status: "PENDING" | "CONFIRMED";
  resolutionKind: "PLAYED" | "FORFEIT";
  winnerEntryId: string;
  loserEntryId: string;
  winnerDisplayNameSnapshot: string;
  loserDisplayNameSnapshot: string;
  score: Prisma.JsonValue;
  reporter: V2GroupOnlyRevisionUserDisplay;
  verifier: V2GroupOnlyRevisionUserDisplay | null;
  supersedesRevisionId: string | null;
  reason: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type V2GroupOnlyActiveResult =
  | Readonly<{
      state: "NONE";
      currentRevisionId: null;
      revisionVersion: null;
      authoritativeConfirmedRevisionId: null;
      pendingRevision: null;
      confirmedRevision: null;
    }>
  | Readonly<{
      state: "PENDING";
      currentRevisionId: string;
      revisionVersion: number;
      authoritativeConfirmedRevisionId: null;
      pendingRevision: V2GroupOnlyRevisionReadModel;
      confirmedRevision: null;
    }>
  | Readonly<{
      state: "CONFIRMED";
      currentRevisionId: string;
      revisionVersion: number;
      authoritativeConfirmedRevisionId: string;
      pendingRevision: null;
      confirmedRevision: V2GroupOnlyRevisionReadModel;
    }>
  | Readonly<{
      state: "CORRECTION_PENDING";
      currentRevisionId: string;
      revisionVersion: number;
      authoritativeConfirmedRevisionId: string;
      pendingRevision: V2GroupOnlyRevisionReadModel;
      confirmedRevision: V2GroupOnlyRevisionReadModel;
    }>;

type ActiveRevisionSource = Readonly<{
  id: string;
  revisionNumber: number;
  status: string;
  resolutionKind: "PLAYED" | "FORFEIT";
  winnerEntryId: string | null;
  loserEntryId: string | null;
  score: Prisma.JsonValue;
  supersedesRevisionId: string | null;
  reason: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  reportedBy: Readonly<{
    id: string;
    nickname: string;
    avatarUrl: string | null;
  }>;
  verifiedBy: Readonly<{
    id: string;
    nickname: string;
    avatarUrl: string | null;
  }> | null;
}>;

type FixtureResultSource = Readonly<{
  id: string;
  status: "SCHEDULED" | "READY" | "COMPLETED" | "VOIDED";
  sideAEntryId: string | null;
  sideBEntryId: string | null;
  resultRevisions: readonly ActiveRevisionSource[];
}>;

type EntryResultSource = Readonly<{
  displayNameSnapshot: string;
}>;

export type V2GroupOnlyResultIntegrityFailure = (
  message: string,
  entityId: string,
) => never;

function iso(value: Date | null) {
  return value?.toISOString() ?? null;
}

function mapUser(user: ActiveRevisionSource["reportedBy"]): V2GroupOnlyRevisionUserDisplay {
  return {
    userId: user.id,
    nickname: user.nickname,
    avatarUrl: user.avatarUrl,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isCanonicalForfeitScore(value: unknown) {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.winnerScore === 1 &&
    value.loserScore === 0
  );
}

function mapRevision(
  source: ActiveRevisionSource,
  fixture: FixtureResultSource,
  entriesById: ReadonlyMap<string, EntryResultSource>,
  fail: V2GroupOnlyResultIntegrityFailure,
): V2GroupOnlyRevisionReadModel {
  if (
    (source.status !== "PENDING" && source.status !== "CONFIRMED") ||
    !Number.isSafeInteger(source.revisionNumber) ||
    source.revisionNumber < 1 ||
    source.winnerEntryId === null ||
    source.loserEntryId === null
  ) {
    fail("An active result revision has invalid identity or status.", source.id);
  }
  const fixtureEntryIds = new Set(
    [fixture.sideAEntryId, fixture.sideBEntryId].filter(
      (entryId): entryId is string => entryId !== null,
    ),
  );
  if (
    fixtureEntryIds.size !== 2 ||
    !fixtureEntryIds.has(source.winnerEntryId) ||
    !fixtureEntryIds.has(source.loserEntryId) ||
    source.winnerEntryId === source.loserEntryId
  ) {
    fail(
      "An active result revision does not identify the Fixture's exact two sides.",
      source.id,
    );
  }
  const winner = entriesById.get(source.winnerEntryId);
  const loser = entriesById.get(source.loserEntryId);
  if (!winner || !loser) {
    fail("An active result revision references a missing Entry.", source.id);
  }
  if (
    source.resolutionKind === "FORFEIT" &&
    (source.status !== "CONFIRMED" ||
      !source.reason ||
      !isCanonicalForfeitScore(source.score))
  ) {
    fail("A confirmed forfeit revision is malformed.", source.id);
  }
  if (source.status === "PENDING" && source.resolutionKind !== "PLAYED") {
    fail("A pending result revision must represent a played result.", source.id);
  }

  return {
    revisionId: source.id,
    revisionVersion: source.revisionNumber,
    status: source.status,
    resolutionKind: source.resolutionKind,
    winnerEntryId: source.winnerEntryId,
    loserEntryId: source.loserEntryId,
    winnerDisplayNameSnapshot: winner.displayNameSnapshot,
    loserDisplayNameSnapshot: loser.displayNameSnapshot,
    score: source.score,
    reporter: mapUser(source.reportedBy),
    verifier: source.verifiedBy ? mapUser(source.verifiedBy) : null,
    supersedesRevisionId: source.supersedesRevisionId,
    reason: source.reason,
    resolvedAt: iso(source.resolvedAt),
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  };
}

/**
 * Resolves the sole active V2 revision chain for a relational Fixture. The
 * caller supplies its read-model-specific integrity error so SINGLE keeps its
 * public error type while DOUBLE can fail closed with its own projection error.
 */
export function resolveV2GroupOnlyActiveResult(
  fixture: FixtureResultSource,
  entriesById: ReadonlyMap<string, EntryResultSource>,
  fail: V2GroupOnlyResultIntegrityFailure,
): V2GroupOnlyActiveResult {
  if (!Array.isArray(fixture.resultRevisions)) {
    fail("A Fixture is missing its active result revision relation.", fixture.id);
  }
  const active = fixture.resultRevisions.filter(
    (revision) => revision.status === "PENDING" || revision.status === "CONFIRMED",
  );
  const pendingSources = active.filter((revision) => revision.status === "PENDING");
  const confirmedSources = active.filter(
    (revision) => revision.status === "CONFIRMED",
  );
  if (pendingSources.length > 1 || confirmedSources.length > 1) {
    fail("A Fixture has more than one active revision of the same status.", fixture.id);
  }

  const pending = pendingSources[0]
    ? mapRevision(pendingSources[0], fixture, entriesById, fail)
    : null;
  const confirmed = confirmedSources[0]
    ? mapRevision(confirmedSources[0], fixture, entriesById, fail)
    : null;

  let result: V2GroupOnlyActiveResult;
  if (!pending && !confirmed) {
    result = {
      state: "NONE",
      currentRevisionId: null,
      revisionVersion: null,
      authoritativeConfirmedRevisionId: null,
      pendingRevision: null,
      confirmedRevision: null,
    };
  } else if (pending && !confirmed) {
    if (pending.supersedesRevisionId !== null) {
      fail("A pending correction has no current confirmed predecessor.", pending.revisionId);
    }
    result = {
      state: "PENDING",
      currentRevisionId: pending.revisionId,
      revisionVersion: pending.revisionVersion,
      authoritativeConfirmedRevisionId: null,
      pendingRevision: pending,
      confirmedRevision: null,
    };
  } else if (!pending && confirmed) {
    result = {
      state: "CONFIRMED",
      currentRevisionId: confirmed.revisionId,
      revisionVersion: confirmed.revisionVersion,
      authoritativeConfirmedRevisionId: confirmed.revisionId,
      pendingRevision: null,
      confirmedRevision: confirmed,
    };
  } else {
    if (
      !pending ||
      !confirmed ||
      confirmed.resolutionKind !== "PLAYED" ||
      pending.supersedesRevisionId !== confirmed.revisionId ||
      pending.revisionVersion <= confirmed.revisionVersion
    ) {
      fail(
        "The pending correction does not supersede the current played revision.",
        fixture.id,
      );
    }
    result = {
      state: "CORRECTION_PENDING",
      currentRevisionId: pending.revisionId,
      revisionVersion: pending.revisionVersion,
      authoritativeConfirmedRevisionId: confirmed.revisionId,
      pendingRevision: pending,
      confirmedRevision: confirmed,
    };
  }

  const lifecycleMatches =
    result.state === "NONE"
      ? fixture.status !== "COMPLETED"
      : result.state === "PENDING"
        ? fixture.status === "READY"
        : fixture.status === "COMPLETED";
  if (!lifecycleMatches) {
    fail(
      "The active result revision set does not match the Fixture lifecycle state.",
      fixture.id,
    );
  }
  return result;
}
