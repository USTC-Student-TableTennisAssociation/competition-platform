import {
  isCanonicalV2BestOfScoreText,
  V2_MAX_TEAM_SCORE_PER_FIXTURE,
} from "../domain/group-standings";

export type V2CertificateEligibility =
  | Readonly<{
      state: "ELIGIBLE";
      matchId: string;
      userId: string;
      entryId: string;
      qualifyingRevisionIds: readonly string[];
    }>
  | Readonly<{
      state: "INELIGIBLE";
      code:
        | "NOT_ACTIVE_ENTRY"
        | "NO_CONFIRMED_FIXTURE"
        | "PENDING_RESULT"
        | "INCOMPLETE_ACTIVE_OPPONENT_FIXTURES";
      reason: string;
    }>
  | Readonly<{
      state: "UNSUPPORTED";
      code: "ENGINE_OR_FORMAT";
      reason: string;
    }>
  | Readonly<{
      state: "INTEGRITY_ERROR";
      code: "CORRUPT_COMPETITION";
      entityId: string;
      reason: string;
    }>;

export type V2CertificateEntryMemberSnapshot = Readonly<{
  id: string;
  matchId: string;
  entryId: string;
  userId: string;
  role: "player" | "captain" | "substitute";
  status: "ACTIVE" | "WITHDRAWN" | "REMOVED" | "DISQUALIFIED" | "SUPERSEDED";
  slot: number;
  rosterVersion: number;
  effectiveUntil: Date | null;
}>;

export type V2CertificateEntrySnapshot = Readonly<{
  id: string;
  kind: "INDIVIDUAL" | "DOUBLES" | "TEAM";
  status: "DRAFT" | "ACTIVE" | "WITHDRAWN" | "DISQUALIFIED" | "ARCHIVED";
  version: number;
  members: readonly V2CertificateEntryMemberSnapshot[];
}>;

export type V2CertificateRevisionSnapshot = Readonly<{
  id: string;
  matchId: string;
  fixtureId: string;
  revisionNumber: number;
  status: "PENDING" | "CONFIRMED" | "REJECTED" | "VOIDED" | "SUPERSEDED";
  resolutionKind: "PLAYED" | "FORFEIT";
  winnerEntryId: string | null;
  loserEntryId: string | null;
  score: unknown;
  reason: string | null;
  verifiedById: string | null;
  supersedesRevisionId: string | null;
  resolvedAt: Date | null;
  settlementEvents: readonly Readonly<{
    id: string;
    kind: "RESULT_APPLY" | "RESULT_REVERSAL" | "REGISTRATION_APPLY" | "REGISTRATION_REVERSAL";
    status: "PENDING" | "APPLIED" | "REVERSED" | "FAILED";
    resultRevisionId: string | null;
    matchEntryId: string | null;
    reversesEventId: string | null;
    failureReason: string | null;
    appliedAt: Date | null;
    effects: readonly Readonly<{ userId: string }>[];
  }>[];
}>;

export type V2CertificateFixtureSnapshot = Readonly<{
  id: string;
  matchId: string;
  fixtureKey: string;
  stage: "GROUP" | "KNOCKOUT" | "FREE_PLAY";
  status: "SCHEDULED" | "READY" | "COMPLETED" | "VOIDED";
  groupId: string | null;
  groupKey: string | null;
  roundNumber: number | null;
  position: number | null;
  sideAEntryId: string | null;
  sideBEntryId: string | null;
  sideARosterVersion: number | null;
  sideBRosterVersion: number | null;
  completedAt: Date | null;
  lineupMembers: readonly Readonly<{
    id: string;
    matchId: string;
    fixtureId: string;
    entryId: string;
    entryMemberId: string;
    side: "SIDE_A" | "SIDE_B";
    position: number;
  }>[];
  resultRevisions: readonly V2CertificateRevisionSnapshot[];
}>;

export type V2CertificateGroupingSnapshot = Readonly<{
  id: string;
  matchId: string;
  v2SchemaVersion: number | null;
  seedMethod: "MIN_DIFF" | "SNAKE" | null;
  standingsPolicyVersion: number | null;
  qualifiersPerGroup: number | null;
  bracketPolicyVersion: number | null;
  createdAt: Date;
  qualificationSnapshot: Readonly<{
    id: string;
    matchId: string;
    groupingId: string;
  }> | null;
}>;

export type V2CertificateGroupSnapshot = Readonly<{
  id: string;
  matchId: string;
  groupingId: string;
  groupKey: string;
  position: number;
  entries: readonly Readonly<{
    id: string;
    matchId: string;
    groupId: string;
    entryId: string;
    position: number;
    globalSeedRank: number;
    entryVersion: number;
    rosterVersion: number;
  }>[];
}>;

export type V2CertificateFixtureDependencySnapshot = Readonly<{
  id: string;
  matchId: string;
  sourceFixtureId: string | null;
  sourceOutcome: "WINNER" | "LOSER" | null;
  sourceQualificationStandingId: string | null;
  targetFixtureId: string;
  targetSide: "SIDE_A" | "SIDE_B";
}>;

export type V2CertificateCompetitionSnapshot = Readonly<{
  match: Readonly<{
    id: string;
    engineVersion: "LEGACY" | "V2";
    isQuickMatch: boolean;
    type: "single" | "double" | "team";
    format: "group_only" | "group_then_knockout";
    groupingGeneratedAt: Date | null;
    teamMinMembers: number | null;
    teamMaxMembers: number | null;
  }>;
  grouping: V2CertificateGroupingSnapshot | null;
  groups: readonly V2CertificateGroupSnapshot[];
  entries: readonly V2CertificateEntrySnapshot[];
  fixtures: readonly V2CertificateFixtureSnapshot[];
  fixtureDependencies: readonly V2CertificateFixtureDependencySnapshot[];
}>;

type MatchType = V2CertificateCompetitionSnapshot["match"]["type"];
type FixtureSide = "SIDE_A" | "SIDE_B";
type Revision = V2CertificateRevisionSnapshot;
type ResultEvent = Revision["settlementEvents"][number];

type ValidatedEntry = Readonly<{
  source: V2CertificateEntrySnapshot;
  rosters: ReadonlyMap<number, readonly V2CertificateEntryMemberSnapshot[]>;
  currentRosterVersion: number | null;
  currentMembers: readonly V2CertificateEntryMemberSnapshot[];
}>;

type ValidatedFixture = Readonly<{
  fixture: V2CertificateFixtureSnapshot;
  sideAUserIds: readonly string[];
  sideBUserIds: readonly string[];
  lineupUserIds: ReadonlySet<string>;
  pending: Revision | null;
  confirmed: Revision | null;
}>;

type EntryValidation = Readonly<{
  entriesById: ReadonlyMap<string, ValidatedEntry>;
  currentEntryIdByUserId: ReadonlyMap<string, string>;
}>;

const CORRUPT_REASON = "比赛数据状态异常，暂不能导出参赛证明，请联系管理员。";
const MAX_TEAM_MEMBERS = 50;

function integrity(entityId: string): V2CertificateEligibility {
  return {
    state: "INTEGRITY_ERROR",
    code: "CORRUPT_COMPETITION",
    entityId,
    reason: CORRUPT_REASON,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function isCanonicalPlayedScore(score: unknown, matchType: MatchType) {
  if (!isRecord(score)) return false;
  const winnerScore = score.winnerScore;
  const loserScore = score.loserScore;
  if (matchType === "team") {
    return (
      hasExactKeys(score, ["winnerScore", "loserScore"]) &&
      isNonNegativeSafeInteger(winnerScore) &&
      isNonNegativeSafeInteger(loserScore) &&
      winnerScore <= V2_MAX_TEAM_SCORE_PER_FIXTURE &&
      loserScore <= V2_MAX_TEAM_SCORE_PER_FIXTURE &&
      winnerScore > loserScore
    );
  }

  const hasScoreOnly = hasExactKeys(score, ["bestOf", "winnerScore", "loserScore"]);
  const hasCanonicalText = hasExactKeys(score, [
    "bestOf",
    "winnerScore",
    "loserScore",
    "text",
  ]);
  if (!hasScoreOnly && !hasCanonicalText) return false;
  const bestOf = score.bestOf;
  if (
    (bestOf !== 3 && bestOf !== 5 && bestOf !== 7) ||
    !isNonNegativeSafeInteger(winnerScore) ||
    !isNonNegativeSafeInteger(loserScore)
  ) {
    return false;
  }
  const winsNeeded = (bestOf + 1) / 2;
  if (winnerScore !== winsNeeded || loserScore >= winsNeeded) return false;
  return !hasCanonicalText ||
    isCanonicalV2BestOfScoreText(score.text, bestOf, winnerScore, loserScore);
}

function pairKey(left: string, right: string) {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function targetSideKey(fixtureId: string, side: FixtureSide) {
  return `${fixtureId}\u0000${side}`;
}

function sameStringSet(actual: readonly string[], expected: readonly string[]) {
  return (
    actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((value) => actual.includes(value))
  );
}

function expectedEntryKind(matchType: MatchType) {
  return matchType === "single"
    ? "INDIVIDUAL"
    : matchType === "double"
      ? "DOUBLES"
      : "TEAM";
}

function rosterIsValid(
  members: readonly V2CertificateEntryMemberSnapshot[],
  matchType: MatchType,
  teamMinimum: number | null,
  teamMaximum: number | null,
) {
  const expectedCount = matchType === "single" ? 1 : matchType === "double" ? 2 : null;
  if (
    members.length === 0 ||
    (expectedCount !== null && members.length !== expectedCount) ||
    (matchType === "team" &&
      (teamMinimum === null ||
        teamMaximum === null ||
        members.length < teamMinimum ||
        members.length > teamMaximum)) ||
    new Set(members.map((member) => member.id)).size !== members.length ||
    new Set(members.map((member) => member.userId)).size !== members.length ||
    members.some((member, index) => member.slot !== index + 1) ||
    (matchType !== "team" && members.some((member) => member.role !== "player")) ||
    (matchType === "team" &&
      members.filter((member) => member.role === "captain").length !== 1)
  ) {
    return false;
  }
  return true;
}

function validateEntries(
  snapshot: V2CertificateCompetitionSnapshot,
): EntryValidation | V2CertificateEligibility {
  const { match } = snapshot;
  const teamSettingsValid =
    match.type === "team"
      ? Number.isSafeInteger(match.teamMinMembers) &&
        match.teamMinMembers !== null &&
        match.teamMinMembers >= 1 &&
        Number.isSafeInteger(match.teamMaxMembers) &&
        match.teamMaxMembers !== null &&
        match.teamMaxMembers >= match.teamMinMembers &&
        match.teamMaxMembers <= MAX_TEAM_MEMBERS
      : match.teamMinMembers === null && match.teamMaxMembers === null;
  if (!teamSettingsValid) return integrity(match.id);

  const entriesById = new Map<string, ValidatedEntry>();
  const memberIds = new Set<string>();
  const currentEntryIdByUserId = new Map<string, string>();
  for (const entry of snapshot.entries) {
    if (
      entriesById.has(entry.id) ||
      entry.kind !== expectedEntryKind(match.type) ||
      !Number.isSafeInteger(entry.version) ||
      entry.version < 0
    ) {
      return integrity(entry.id);
    }

    const rosters = new Map<number, V2CertificateEntryMemberSnapshot[]>();
    for (const member of entry.members) {
      if (
        memberIds.has(member.id) ||
        member.matchId !== match.id ||
        member.entryId !== entry.id ||
        !Number.isSafeInteger(member.slot) ||
        member.slot < 1 ||
        !Number.isSafeInteger(member.rosterVersion) ||
        member.rosterVersion < 1 ||
        (member.status === "ACTIVE") !== (member.effectiveUntil === null)
      ) {
        return integrity(member.id);
      }
      memberIds.add(member.id);
      const roster = rosters.get(member.rosterVersion) ?? [];
      roster.push(member);
      rosters.set(member.rosterVersion, roster);
    }

    for (const [rosterVersion, unordered] of rosters) {
      const roster = [...unordered].sort(
        (left, right) => left.slot - right.slot || left.id.localeCompare(right.id),
      );
      if (
        !rosterIsValid(
          roster,
          match.type,
          match.teamMinMembers,
          match.teamMaxMembers,
        )
      ) {
        return integrity(`${entry.id}:${rosterVersion}`);
      }
      rosters.set(rosterVersion, roster);
    }

    const currentMembers = entry.members
      .filter((member) => member.status === "ACTIVE" && member.effectiveUntil === null)
      .sort((left, right) => left.slot - right.slot || left.id.localeCompare(right.id));
    const currentVersions = new Set(currentMembers.map((member) => member.rosterVersion));
    const currentRosterVersion = currentVersions.size === 1
      ? currentMembers[0]?.rosterVersion ?? null
      : null;
    const latestRosterVersion = Math.max(0, ...rosters.keys());

    if (entry.status === "ACTIVE") {
      if (
        currentRosterVersion === null ||
        currentRosterVersion !== latestRosterVersion ||
        !rosterIsValid(
          currentMembers,
          match.type,
          match.teamMinMembers,
          match.teamMaxMembers,
        ) ||
        currentMembers.length !== rosters.get(currentRosterVersion)?.length
      ) {
        return integrity(entry.id);
      }
      for (const member of currentMembers) {
        if (currentEntryIdByUserId.has(member.userId)) return integrity(member.userId);
        currentEntryIdByUserId.set(member.userId, entry.id);
      }
    } else if (entry.status === "DRAFT") {
      if (
        currentMembers.length !== 0 &&
        (currentRosterVersion === null ||
          currentRosterVersion !== latestRosterVersion ||
          currentMembers.length !== rosters.get(currentRosterVersion)?.length)
      ) {
        return integrity(entry.id);
      }
    } else if (currentMembers.length !== 0) {
      return integrity(entry.id);
    }

    entriesById.set(entry.id, {
      source: entry,
      rosters,
      currentRosterVersion,
      currentMembers,
    });
  }

  return { entriesById, currentEntryIdByUserId };
}

function eventEffectsMatchRoster(event: ResultEvent, rosterUserIds: readonly string[]) {
  return sameStringSet(
    event.effects.map((effect) => effect.userId),
    rosterUserIds,
  );
}

function validateResultEvents(
  revision: Revision,
  rosterUserIds: readonly string[],
): Readonly<{ hasReversedSettlement: boolean }> | null {
  if (
    revision.settlementEvents.some(
      (event) =>
        (event.kind !== "RESULT_APPLY" && event.kind !== "RESULT_REVERSAL") ||
        event.resultRevisionId !== revision.id ||
        event.matchEntryId !== null ||
        event.failureReason !== null ||
        ((event.status === "APPLIED" || event.status === "REVERSED") &&
          !isValidDate(event.appliedAt)),
    ) ||
    new Set(revision.settlementEvents.map((event) => event.id)).size !==
      revision.settlementEvents.length
  ) {
    return null;
  }
  const applications = revision.settlementEvents.filter(
    (event) => event.kind === "RESULT_APPLY",
  );
  const reversals = revision.settlementEvents.filter(
    (event) => event.kind === "RESULT_REVERSAL",
  );
  if (applications.length > 1 || reversals.length > 1) return null;

  if (revision.resolutionKind === "FORFEIT") {
    return applications.length === 0 && reversals.length === 0
      ? { hasReversedSettlement: false }
      : null;
  }

  const application = applications[0] ?? null;
  const reversal = reversals[0] ?? null;
  if (revision.status === "CONFIRMED") {
    return application !== null &&
      application.status === "APPLIED" &&
      application.reversesEventId === null &&
      application.appliedAt !== null &&
      eventEffectsMatchRoster(application, rosterUserIds) &&
      reversal === null
      ? { hasReversedSettlement: false }
      : null;
  }
  if (revision.status === "SUPERSEDED") {
    return application !== null &&
      application.status === "REVERSED" &&
      application.reversesEventId === null &&
      application.appliedAt !== null &&
      eventEffectsMatchRoster(application, rosterUserIds) &&
      reversal !== null &&
      reversal.status === "APPLIED" &&
      reversal.reversesEventId === application.id &&
      reversal.appliedAt !== null &&
      eventEffectsMatchRoster(reversal, rosterUserIds)
      ? { hasReversedSettlement: true }
      : null;
  }
  if (revision.status === "VOIDED") {
    if (application === null && reversal === null) {
      return { hasReversedSettlement: false };
    }
    return application !== null &&
      application.status === "REVERSED" &&
      application.reversesEventId === null &&
      application.appliedAt !== null &&
      eventEffectsMatchRoster(application, rosterUserIds) &&
      reversal !== null &&
      reversal.status === "APPLIED" &&
      reversal.reversesEventId === application.id &&
      reversal.appliedAt !== null &&
      eventEffectsMatchRoster(reversal, rosterUserIds)
      ? { hasReversedSettlement: true }
      : null;
  }
  return application === null && reversal === null
    ? { hasReversedSettlement: false }
    : null;
}

function validateRevisionHistory(
  fixture: V2CertificateFixtureSnapshot,
  rosterUserIds: readonly string[],
  matchType: MatchType,
): Readonly<{ pending: Revision | null; confirmed: Revision | null }> | null {
  const revisionsById = new Map<string, Revision>();
  const revisionNumbers = new Set<number>();
  const settlementState = new Map<string, Readonly<{ hasReversedSettlement: boolean }>>();
  const sideIds = [fixture.sideAEntryId, fixture.sideBEntryId];
  for (const revision of fixture.resultRevisions) {
    if (
      revisionsById.has(revision.id) ||
      revisionNumbers.has(revision.revisionNumber) ||
      revision.matchId !== fixture.matchId ||
      revision.fixtureId !== fixture.id ||
      !Number.isSafeInteger(revision.revisionNumber) ||
      revision.revisionNumber < 1 ||
      revision.winnerEntryId === null ||
      revision.loserEntryId === null ||
      revision.winnerEntryId === revision.loserEntryId ||
      !sideIds.includes(revision.winnerEntryId) ||
      !sideIds.includes(revision.loserEntryId) ||
      (revision.status === "PENDING") !== (revision.resolvedAt === null) ||
      (revision.status === "PENDING") !== (revision.verifiedById === null) ||
      (revision.status !== "PENDING" && revision.verifiedById === null) ||
      (revision.resolvedAt !== null && !isValidDate(revision.resolvedAt)) ||
      (revision.resolutionKind === "PLAYED" &&
        !isCanonicalPlayedScore(revision.score, matchType)) ||
      (revision.resolutionKind === "FORFEIT" &&
        ((revision.status !== "CONFIRMED" &&
            revision.status !== "SUPERSEDED" &&
            revision.status !== "VOIDED") ||
          revision.reason === null ||
          revision.reason.trim() === ""))
    ) {
      return null;
    }
    const events = validateResultEvents(revision, rosterUserIds);
    if (!events) return null;
    revisionsById.set(revision.id, revision);
    revisionNumbers.add(revision.revisionNumber);
    settlementState.set(revision.id, events);
  }
  for (let number = 1; number <= revisionNumbers.size; number += 1) {
    if (!revisionNumbers.has(number)) return null;
  }

  for (const revision of fixture.resultRevisions) {
    if (revision.supersedesRevisionId === null) continue;
    const predecessor = revisionsById.get(revision.supersedesRevisionId);
    if (
      !predecessor ||
      predecessor.revisionNumber >= revision.revisionNumber ||
      predecessor.resolutionKind !== revision.resolutionKind ||
      predecessor.status === "PENDING" ||
      predecessor.status === "REJECTED"
    ) {
      return null;
    }
  }

  const pending = fixture.resultRevisions.filter((revision) => revision.status === "PENDING");
  const confirmed = fixture.resultRevisions.filter(
    (revision) => revision.status === "CONFIRMED",
  );
  if (pending.length > 1 || confirmed.length > 1) return null;
  const currentPending = pending[0] ?? null;
  const currentConfirmed = confirmed[0] ?? null;
  const effectiveVoided = fixture.resultRevisions.filter(
    (revision) =>
      revision.status === "VOIDED" &&
      (revision.resolutionKind === "FORFEIT" ||
        settlementState.get(revision.id)?.hasReversedSettlement === true),
  );

  let authoritativeHead: Revision | null = null;
  if (fixture.status === "COMPLETED") {
    authoritativeHead = currentConfirmed;
  } else if (fixture.status === "VOIDED" && fixture.completedAt !== null) {
    if (effectiveVoided.length !== 1) return null;
    authoritativeHead = effectiveVoided[0];
  } else if (effectiveVoided.length !== 0) {
    return null;
  }

  const authoritativeChain = new Set<string>();
  let current = authoritativeHead;
  while (current !== null) {
    if (authoritativeChain.has(current.id)) return null;
    authoritativeChain.add(current.id);
    if (current.supersedesRevisionId === null) break;
    const predecessor = revisionsById.get(current.supersedesRevisionId);
    if (
      !predecessor ||
      predecessor.status !== "SUPERSEDED" ||
      predecessor.resolutionKind !== current.resolutionKind
    ) {
      return null;
    }
    if (
      current.resolutionKind === "FORFEIT" &&
      (current.revisionNumber !== predecessor.revisionNumber + 1 ||
        current.winnerEntryId !== predecessor.loserEntryId ||
        current.loserEntryId !== predecessor.winnerEntryId)
    ) {
      return null;
    }
    current = predecessor;
  }
  if (
    fixture.resultRevisions.some(
      (revision) =>
        revision.status === "SUPERSEDED" && !authoritativeChain.has(revision.id),
    )
  ) {
    return null;
  }
  for (const revision of fixture.resultRevisions) {
    if (authoritativeChain.has(revision.id)) continue;
    if (revision.supersedesRevisionId === null) {
      if (
        revision.status === "SUPERSEDED" ||
        revision.status === "CONFIRMED" ||
        (revision.status === "VOIDED" &&
          (revision.resolutionKind === "FORFEIT" ||
            settlementState.get(revision.id)?.hasReversedSettlement === true))
      ) {
        return null;
      }
      continue;
    }
    if (!authoritativeChain.has(revision.supersedesRevisionId)) return null;
    const isDiscardedBranch =
      revision.status === "REJECTED" ||
      (revision.status === "VOIDED" &&
        revision.resolutionKind === "PLAYED" &&
        settlementState.get(revision.id)?.hasReversedSettlement === false);
    if (revision.status !== "PENDING" && !isDiscardedBranch) return null;
  }

  if (fixture.status === "SCHEDULED") {
    if (fixture.resultRevisions.length !== 0) return null;
  } else if (fixture.status === "READY") {
    if (
      currentConfirmed !== null ||
      (currentPending !== null && currentPending.supersedesRevisionId !== null)
    ) {
      return null;
    }
  } else if (fixture.status === "COMPLETED") {
    if (
      currentConfirmed === null ||
      (currentPending !== null &&
        (currentConfirmed.resolutionKind !== "PLAYED" ||
          currentPending.supersedesRevisionId !== currentConfirmed.id))
    ) {
      return null;
    }
  } else if (
    currentPending !== null ||
    currentConfirmed !== null ||
    (fixture.completedAt === null && effectiveVoided.length !== 0)
  ) {
    return null;
  }

  if (
    currentPending !== null &&
    currentPending.supersedesRevisionId !== null &&
    currentPending.supersedesRevisionId !== currentConfirmed?.id
  ) {
    return null;
  }

  return { pending: currentPending, confirmed: currentConfirmed };
}

function resolveFixtureSide(
  snapshot: V2CertificateCompetitionSnapshot,
  fixture: V2CertificateFixtureSnapshot,
  side: FixtureSide,
  entriesById: ReadonlyMap<string, ValidatedEntry>,
): readonly string[] | null {
  const entryId = side === "SIDE_A" ? fixture.sideAEntryId : fixture.sideBEntryId;
  const rosterVersion = side === "SIDE_A"
    ? fixture.sideARosterVersion
    : fixture.sideBRosterVersion;
  const lineup = fixture.lineupMembers.filter((member) => member.side === side);
  if (entryId === null || rosterVersion === null) {
    return entryId === null && rosterVersion === null && lineup.length === 0 ? [] : null;
  }
  if (!Number.isSafeInteger(rosterVersion) || rosterVersion < 1) return null;
  const entry = entriesById.get(entryId);
  const roster = entry?.rosters.get(rosterVersion);
  if (!entry || !roster) return null;
  if (
    lineup.length !== roster.length ||
    lineup.some(
      (member, index) =>
        member.matchId !== snapshot.match.id ||
        member.fixtureId !== fixture.id ||
        member.entryId !== entryId ||
        member.entryMemberId !== roster[index]?.id ||
        member.position !== roster[index]?.slot,
    )
  ) {
    return null;
  }
  return roster.map((member) => member.userId);
}

function validateFixture(
  snapshot: V2CertificateCompetitionSnapshot,
  fixture: V2CertificateFixtureSnapshot,
  entriesById: ReadonlyMap<string, ValidatedEntry>,
): ValidatedFixture | V2CertificateEligibility {
  const isGroup = fixture.stage === "GROUP";
  const isKnockout = fixture.stage === "KNOCKOUT";
  if (
    fixture.matchId !== snapshot.match.id ||
    fixture.fixtureKey.trim() === "" ||
    (!isGroup && !isKnockout) ||
    (isGroup &&
      (fixture.groupId === null ||
        fixture.groupKey === null ||
        fixture.groupKey.trim() === "" ||
        fixture.roundNumber !== null ||
        fixture.position !== null)) ||
    (isKnockout &&
      (fixture.groupId !== null ||
        fixture.groupKey !== null ||
        !Number.isSafeInteger(fixture.roundNumber) ||
        (fixture.roundNumber ?? 0) < 1 ||
        !Number.isSafeInteger(fixture.position) ||
        (fixture.position ?? 0) < 1 ||
        fixture.status === "VOIDED")) ||
    (isKnockout &&
      fixture.resultRevisions.some((revision) => revision.status === "VOIDED")) ||
    (fixture.status === "COMPLETED" && fixture.completedAt === null) ||
    (fixture.completedAt !== null && !isValidDate(fixture.completedAt)) ||
    ((fixture.status === "SCHEDULED" || fixture.status === "READY") &&
      fixture.completedAt !== null) ||
    new Set(fixture.lineupMembers.map((member) => member.id)).size !==
      fixture.lineupMembers.length
  ) {
    return integrity(fixture.id);
  }

  const sideAUserIds = resolveFixtureSide(snapshot, fixture, "SIDE_A", entriesById);
  const sideBUserIds = resolveFixtureSide(snapshot, fixture, "SIDE_B", entriesById);
  if (
    sideAUserIds === null ||
    sideBUserIds === null ||
    (isGroup && (sideAUserIds.length === 0 || sideBUserIds.length === 0)) ||
    (fixture.sideAEntryId !== null && fixture.sideAEntryId === fixture.sideBEntryId) ||
    new Set([...sideAUserIds, ...sideBUserIds]).size !==
      sideAUserIds.length + sideBUserIds.length ||
    (isKnockout &&
      fixture.status === "SCHEDULED" &&
      sideAUserIds.length > 0 &&
      sideBUserIds.length > 0) ||
    ((fixture.status === "READY" || fixture.status === "COMPLETED") &&
      (sideAUserIds.length === 0 || sideBUserIds.length === 0)) ||
    (fixture.resultRevisions.length > 0 &&
      (sideAUserIds.length === 0 || sideBUserIds.length === 0))
  ) {
    return integrity(fixture.id);
  }

  const revisions = validateRevisionHistory(
    fixture,
    [...sideAUserIds, ...sideBUserIds],
    snapshot.match.type,
  );
  if (!revisions) return integrity(fixture.id);
  return {
    fixture,
    sideAUserIds,
    sideBUserIds,
    lineupUserIds: new Set([...sideAUserIds, ...sideBUserIds]),
    ...revisions,
  };
}

function validateKnockoutPublicationShell(
  snapshot: V2CertificateCompetitionSnapshot,
  knockoutFixtures: readonly V2CertificateFixtureSnapshot[],
) {
  const qualification = snapshot.grouping?.qualificationSnapshot ?? null;
  if (snapshot.match.format === "group_only") {
    return qualification === null &&
      knockoutFixtures.length === 0 &&
      snapshot.fixtureDependencies.length === 0;
  }
  const hasAny =
    qualification !== null ||
    knockoutFixtures.length > 0 ||
    snapshot.fixtureDependencies.length > 0;
  if (!hasAny) return true;
  if (
    qualification === null ||
    qualification.matchId !== snapshot.match.id ||
    qualification.groupingId !== snapshot.grouping?.id ||
    knockoutFixtures.length === 0 ||
    snapshot.fixtureDependencies.length === 0
  ) {
    return false;
  }

  const fixturesById = new Set(knockoutFixtures.map((fixture) => fixture.id));
  const targetSides = new Set<string>();
  for (const dependency of snapshot.fixtureDependencies) {
    const key = targetSideKey(dependency.targetFixtureId, dependency.targetSide);
    const sourceKinds = Number(dependency.sourceFixtureId !== null) +
      Number(dependency.sourceQualificationStandingId !== null);
    if (
      dependency.matchId !== snapshot.match.id ||
      !fixturesById.has(dependency.targetFixtureId) ||
      targetSides.has(key) ||
      sourceKinds !== 1 ||
      (dependency.sourceFixtureId !== null &&
        (!fixturesById.has(dependency.sourceFixtureId) ||
          dependency.sourceFixtureId === dependency.targetFixtureId ||
          dependency.sourceOutcome !== "WINNER" ||
          dependency.sourceQualificationStandingId !== null)) ||
      (dependency.sourceQualificationStandingId !== null &&
        (dependency.sourceFixtureId !== null || dependency.sourceOutcome !== null))
    ) {
      return false;
    }
    targetSides.add(key);
  }
  return knockoutFixtures.every(
    (fixture) =>
      targetSides.has(targetSideKey(fixture.id, "SIDE_A")) &&
      targetSides.has(targetSideKey(fixture.id, "SIDE_B")),
  );
}

/**
 * Pure, fail-closed certificate policy for all six formal V2 competition cells.
 * Ownership comes only from current EntryMember rows and participation evidence
 * comes only from the exact frozen Fixture lineup.
 */
export function evaluateV2CertificateEligibility(
  snapshot: V2CertificateCompetitionSnapshot,
  userId: string,
): V2CertificateEligibility {
  const { match } = snapshot;
  if (
    match.engineVersion !== "V2" ||
    match.isQuickMatch ||
    (match.type !== "single" && match.type !== "double" && match.type !== "team") ||
    (match.format !== "group_only" && match.format !== "group_then_knockout")
  ) {
    return {
      state: "UNSUPPORTED",
      code: "ENGINE_OR_FORMAT",
      reason: "当前比赛类型暂不支持导出参赛证明。",
    };
  }

  const entryValidation = validateEntries(snapshot);
  if ("state" in entryValidation) return entryValidation;
  const ownEntryId = entryValidation.currentEntryIdByUserId.get(userId);
  if (!ownEntryId) {
    return {
      state: "INELIGIBLE",
      code: "NOT_ACTIVE_ENTRY",
      reason: "你当前不属于本次比赛的有效参赛阵容，无法导出参赛证明。",
    };
  }
  const ownEntry = entryValidation.entriesById.get(ownEntryId)!;

  const groupFixtures = snapshot.fixtures.filter((fixture) => fixture.stage === "GROUP");
  const knockoutFixtures = snapshot.fixtures.filter(
    (fixture) => fixture.stage === "KNOCKOUT",
  );
  if (snapshot.fixtures.length !== groupFixtures.length + knockoutFixtures.length) {
    return integrity(match.id);
  }

  const grouping = snapshot.grouping;
  if (!grouping) {
    if (
      match.groupingGeneratedAt !== null ||
      snapshot.groups.length !== 0 ||
      snapshot.fixtures.length !== 0 ||
      snapshot.fixtureDependencies.length !== 0
    ) {
      return integrity(match.id);
    }
    return {
      state: "INELIGIBLE",
      code: "NO_CONFIRMED_FIXTURE",
      reason: "至少完成 1 场非弃权确认对局后才可导出参赛证明。",
    };
  }
  if (
    grouping.matchId !== match.id ||
    !isValidDate(match.groupingGeneratedAt) ||
    !isValidDate(grouping.createdAt) ||
    grouping.createdAt.getTime() !== match.groupingGeneratedAt.getTime() ||
    grouping.v2SchemaVersion !== 1 ||
    (grouping.seedMethod !== "MIN_DIFF" && grouping.seedMethod !== "SNAKE") ||
    grouping.standingsPolicyVersion !== 1 ||
    (match.format === "group_only"
      ? grouping.qualifiersPerGroup !== null || grouping.bracketPolicyVersion !== null
      : !Number.isSafeInteger(grouping.qualifiersPerGroup) ||
        (grouping.qualifiersPerGroup ?? 0) < 1 ||
        grouping.bracketPolicyVersion !== 1) ||
    snapshot.groups.length === 0
  ) {
    return integrity(grouping.id);
  }
  if (!validateKnockoutPublicationShell(snapshot, knockoutFixtures)) {
    return integrity(grouping.qualificationSnapshot?.id ?? grouping.id);
  }

  const seenGroupIds = new Set<string>();
  const seenGroupedEntries = new Set<string>();
  const seenGlobalRanks = new Set<number>();
  const membershipByEntryId = new Map<
    string,
    Readonly<{
      groupId: string;
      groupKey: string;
      position: number;
      rosterVersion: number;
    }>
  >();
  const groupEntryIds = new Map<string, readonly string[]>();
  for (const [groupIndex, group] of snapshot.groups.entries()) {
    const expectedPosition = groupIndex + 1;
    const expectedKey = `group:${String(expectedPosition).padStart(4, "0")}`;
    if (
      seenGroupIds.has(group.id) ||
      group.matchId !== match.id ||
      group.groupingId !== grouping.id ||
      group.position !== expectedPosition ||
      group.groupKey !== expectedKey ||
      group.entries.length < 2
    ) {
      return integrity(group.id);
    }
    seenGroupIds.add(group.id);
    const ids: string[] = [];
    for (const [membershipIndex, membership] of group.entries.entries()) {
      const entry = entryValidation.entriesById.get(membership.entryId);
      if (
        membership.matchId !== match.id ||
        membership.groupId !== group.id ||
        membership.position !== membershipIndex + 1 ||
        !Number.isSafeInteger(membership.globalSeedRank) ||
        membership.globalSeedRank < 1 ||
        seenGlobalRanks.has(membership.globalSeedRank) ||
        !Number.isSafeInteger(membership.entryVersion) ||
        membership.entryVersion < 0 ||
        !Number.isSafeInteger(membership.rosterVersion) ||
        membership.rosterVersion < 1 ||
        !entry ||
        entry.source.status === "DRAFT" ||
        membership.entryVersion > entry.source.version ||
        !entry.rosters.has(membership.rosterVersion) ||
        seenGroupedEntries.has(membership.entryId)
      ) {
        return integrity(membership.id);
      }
      seenGlobalRanks.add(membership.globalSeedRank);
      seenGroupedEntries.add(membership.entryId);
      ids.push(membership.entryId);
      membershipByEntryId.set(membership.entryId, {
        groupId: group.id,
        groupKey: group.groupKey,
        position: membership.position,
        rosterVersion: membership.rosterVersion,
      });
    }
    groupEntryIds.set(group.id, ids);
  }
  if (
    [...seenGlobalRanks].some((rank) => rank > seenGlobalRanks.size) ||
    [...entryValidation.entriesById.values()].some(
      (entry) => entry.source.status === "ACTIVE" && !seenGroupedEntries.has(entry.source.id),
    )
  ) {
    return integrity(match.id);
  }

  const validatedFixtures: ValidatedFixture[] = [];
  const fixturesByGroupId = new Map<string, ValidatedFixture[]>();
  const seenFixtureIds = new Set<string>();
  const seenFixtureKeys = new Set<string>();
  for (const fixture of snapshot.fixtures) {
    if (seenFixtureIds.has(fixture.id) || seenFixtureKeys.has(fixture.fixtureKey)) {
      return integrity(fixture.id);
    }
    seenFixtureIds.add(fixture.id);
    seenFixtureKeys.add(fixture.fixtureKey);
    const validated = validateFixture(snapshot, fixture, entryValidation.entriesById);
    if ("state" in validated) return validated;
    validatedFixtures.push(validated);
    if (fixture.stage !== "GROUP") continue;

    const groupId = fixture.groupId!;
    const group = snapshot.groups.find((candidate) => candidate.id === groupId);
    const sideA = membershipByEntryId.get(fixture.sideAEntryId!);
    const sideB = membershipByEntryId.get(fixture.sideBEntryId!);
    if (
      !group ||
      fixture.groupKey !== group.groupKey ||
      !sideA ||
      !sideB ||
      sideA.groupId !== groupId ||
      sideB.groupId !== groupId ||
      sideA.position >= sideB.position ||
      fixture.fixtureKey !==
        `${group.groupKey}:pair:${String(sideA.position).padStart(4, "0")}-${String(
          sideB.position,
        ).padStart(4, "0")}` ||
      // Group membership records the original seed roster; substitutions can
      // advance individual fixtures to a newer, independently validated roster.
      sideA.rosterVersion > fixture.sideARosterVersion! ||
      sideB.rosterVersion > fixture.sideBRosterVersion!
    ) {
      return integrity(fixture.id);
    }
    const fixtures = fixturesByGroupId.get(groupId) ?? [];
    fixtures.push(validated);
    fixturesByGroupId.set(groupId, fixtures);
  }

  for (const group of snapshot.groups) {
    const entryIds = groupEntryIds.get(group.id)!;
    const fixtures = fixturesByGroupId.get(group.id) ?? [];
    const expectedCount = (entryIds.length * (entryIds.length - 1)) / 2;
    const seenPairs = new Set<string>();
    for (const { fixture } of fixtures) {
      const key = pairKey(fixture.sideAEntryId!, fixture.sideBEntryId!);
      if (seenPairs.has(key)) return integrity(fixture.id);
      seenPairs.add(key);
    }
    if (fixtures.length !== expectedCount || seenPairs.size !== expectedCount) {
      return integrity(group.id);
    }
    for (let left = 0; left < entryIds.length; left += 1) {
      for (let right = left + 1; right < entryIds.length; right += 1) {
        if (!seenPairs.has(pairKey(entryIds[left], entryIds[right]))) {
          return integrity(group.id);
        }
      }
    }
  }

  const ownMembership = membershipByEntryId.get(ownEntry.source.id);
  if (!ownMembership) return integrity(ownEntry.source.id);
  const ownGroupFixtures = fixturesByGroupId.get(ownMembership.groupId) ?? [];
  const ownEntryFixtures = ownGroupFixtures.filter(
    ({ fixture }) =>
      fixture.sideAEntryId === ownEntry.source.id ||
      fixture.sideBEntryId === ownEntry.source.id,
  );
  const personallyRelatedFixtures = validatedFixtures.filter((fixture) =>
    fixture.lineupUserIds.has(userId),
  );

  if (personallyRelatedFixtures.some((fixture) => fixture.pending !== null)) {
    return {
      state: "INELIGIBLE",
      code: "PENDING_RESULT",
      reason: "你还有未确认的比赛结果，请先完成确认。",
    };
  }

  const qualifyingRevisionIds = personallyRelatedFixtures.flatMap(({ fixture, confirmed }) =>
    fixture.status === "COMPLETED" &&
    confirmed?.resolutionKind === "PLAYED"
      ? [confirmed.id]
      : [],
  );
  if (qualifyingRevisionIds.length === 0) {
    return {
      state: "INELIGIBLE",
      code: "NO_CONFIRMED_FIXTURE",
      reason: "至少完成 1 场非弃权确认对局后才可导出参赛证明。",
    };
  }

  const incompleteActiveOpponent = ownEntryFixtures.some(({ fixture, confirmed }) => {
    const opponentEntryId = fixture.sideAEntryId === ownEntry.source.id
      ? fixture.sideBEntryId!
      : fixture.sideAEntryId!;
    return (
      entryValidation.entriesById.get(opponentEntryId)?.source.status === "ACTIVE" &&
      (fixture.status !== "COMPLETED" || confirmed === null)
    );
  });
  if (incompleteActiveOpponent) {
    return {
      state: "INELIGIBLE",
      code: "INCOMPLETE_ACTIVE_OPPONENT_FIXTURES",
      reason: "你与当前有效同组对手之间还有未完成的对局，暂不能导出参赛证明。",
    };
  }

  return {
    state: "ELIGIBLE",
    matchId: match.id,
    userId,
    entryId: ownEntry.source.id,
    qualifyingRevisionIds,
  };
}

/** Compatibility export retained for the first SINGLE + group_only slice. */
export const evaluateV2SingleCertificateEligibility =
  evaluateV2CertificateEligibility;
