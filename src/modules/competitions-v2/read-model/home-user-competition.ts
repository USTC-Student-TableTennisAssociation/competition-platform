import { Prisma, type PrismaClient } from "@prisma/client";

import { isMatchAllResultsFinished } from "../../../lib/match-status";
import {
  V2_MAX_TEAM_SCORE_PER_FIXTURE,
  isCanonicalV2BestOfScoreText,
} from "../domain/group-standings";

const MY_MATCH_LIMIT = 10;
const RECENT_RESULT_LIMIT = 4;
const RESULT_QUERY_LIMIT = RECENT_RESULT_LIMIT * 2;

export const HOME_V2_FIXTURE_SELECT =
  Prisma.validator<Prisma.MatchFixtureSelect>()({
    id: true,
    matchId: true,
    stage: true,
    status: true,
    groupKey: true,
    sideAEntryId: true,
    sideBEntryId: true,
    sideARosterVersion: true,
    sideBRosterVersion: true,
    completedAt: true,
    sideAEntry: {
      select: {
        id: true,
        kind: true,
        status: true,
        members: {
          orderBy: [
            { rosterVersion: "asc" },
            { slot: "asc" },
            { id: "asc" },
          ],
          select: {
            id: true,
            userId: true,
            displayNameSnapshot: true,
            role: true,
            status: true,
            slot: true,
            rosterVersion: true,
            effectiveFrom: true,
            effectiveUntil: true,
          },
        },
      },
    },
    sideBEntry: {
      select: {
        id: true,
        kind: true,
        status: true,
        members: {
          orderBy: [
            { rosterVersion: "asc" },
            { slot: "asc" },
            { id: "asc" },
          ],
          select: {
            id: true,
            userId: true,
            displayNameSnapshot: true,
            role: true,
            status: true,
            slot: true,
            rosterVersion: true,
            effectiveFrom: true,
            effectiveUntil: true,
          },
        },
      },
    },
    lineupMembers: {
      orderBy: [{ side: "asc" }, { position: "asc" }],
      select: {
        id: true,
        side: true,
        position: true,
        entryId: true,
        entryMember: {
          select: {
            id: true,
            userId: true,
            displayNameSnapshot: true,
            role: true,
            slot: true,
            rosterVersion: true,
          },
        },
      },
    },
    resultRevisions: {
      where: { status: { in: ["PENDING", "CONFIRMED"] } },
      orderBy: [{ revisionNumber: "desc" }, { id: "asc" }],
      select: {
        id: true,
        revisionNumber: true,
        status: true,
        resolutionKind: true,
        winnerEntryId: true,
        loserEntryId: true,
        score: true,
        reportedById: true,
        supersedesRevisionId: true,
        reason: true,
        resolvedAt: true,
        createdAt: true,
        settlementEvents: {
          orderBy: { id: "asc" },
          select: {
            id: true,
            kind: true,
            status: true,
            resultRevisionId: true,
            matchEntryId: true,
            reversesEventId: true,
            failureReason: true,
            appliedAt: true,
            effects: {
              orderBy: [{ userId: "asc" }, { id: "asc" }],
              select: {
                id: true,
                userId: true,
                eloBefore: true,
                eloAfter: true,
                eloDelta: true,
                pointsBefore: true,
                pointsAfter: true,
                pointsDelta: true,
                winsDelta: true,
                lossesDelta: true,
                matchesPlayedDelta: true,
              },
            },
          },
        },
      },
    },
    match: {
      select: {
        engineVersion: true,
        isQuickMatch: true,
        type: true,
        format: true,
        teamMinMembers: true,
        teamMaxMembers: true,
      },
    },
  });

type LegacyResultSource = Readonly<{
  winnerTeamIds: readonly string[];
  loserTeamIds: readonly string[];
  confirmed: boolean;
  score: unknown;
  createdAt: Date;
  resultVerifiedAt: Date | null;
}>;

type LegacyRegistrationSource = Readonly<{
  createdAt: Date;
  match: Readonly<{
    id: string;
    title: string;
    dateTime: Date;
    format: "group_only" | "group_then_knockout";
    status: "registration" | "ongoing" | "finished";
    engineVersion: "LEGACY" | "V2";
    isQuickMatch: boolean;
    type: "single" | "double" | "team";
    groupingGeneratedAt: Date | null;
    groupingResult: Readonly<{ payload: unknown }> | null;
    results: readonly LegacyResultSource[];
  }>;
}>;

type LegacyRecentResultSource = Readonly<{
  id: string;
  matchId: string;
  winnerTeamIds: readonly string[];
  loserTeamIds: readonly string[];
  score: unknown;
  resultVerifiedAt: Date | null;
  createdAt: Date;
  eloHistory: readonly Readonly<{
    eloBefore: number;
    eloAfter: number;
    delta: number;
  }>[];
}>;

export type V2LineupMemberSource = Readonly<{
  id: string;
  side: "SIDE_A" | "SIDE_B";
  position: number;
  entryId: string;
  entryMember: Readonly<{
    id: string;
    userId: string;
    displayNameSnapshot: string;
    role: "player" | "captain" | "substitute";
    slot: number;
    rosterVersion: number;
  }>;
}>;

export type V2EntryMemberSource = Readonly<{
  id: string;
  userId: string;
  displayNameSnapshot: string;
  role: "player" | "captain" | "substitute";
  status: "ACTIVE" | "WITHDRAWN" | "REMOVED" | "DISQUALIFIED" | "SUPERSEDED";
  slot: number;
  rosterVersion: number;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
}>;

export type V2SettlementEffectSource = Readonly<{
  id: string;
  userId: string;
  eloBefore: number | null;
  eloAfter: number | null;
  eloDelta: number | null;
  pointsBefore: number | null;
  pointsAfter: number | null;
  pointsDelta: number | null;
  winsDelta: number;
  lossesDelta: number;
  matchesPlayedDelta: number;
}>;

export type V2SettlementEventSource = Readonly<{
  id: string;
  kind:
    | "RESULT_APPLY"
    | "RESULT_REVERSAL"
    | "REGISTRATION_APPLY"
    | "REGISTRATION_REVERSAL";
  status: "PENDING" | "APPLIED" | "REVERSED" | "FAILED";
  resultRevisionId: string | null;
  matchEntryId: string | null;
  reversesEventId: string | null;
  failureReason: string | null;
  appliedAt: Date | null;
  effects: readonly V2SettlementEffectSource[];
}>;

export type V2ActiveRevisionSource = Readonly<{
  id: string;
  revisionNumber: number;
  status: "PENDING" | "CONFIRMED" | "REJECTED" | "VOIDED" | "SUPERSEDED";
  resolutionKind: "PLAYED" | "FORFEIT";
  winnerEntryId: string | null;
  loserEntryId: string | null;
  score: unknown;
  reportedById: string;
  supersedesRevisionId: string | null;
  reason: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  settlementEvents: readonly V2SettlementEventSource[];
}>;

type V2FixtureEntrySource = Readonly<{
  id: string;
  kind: "INDIVIDUAL" | "DOUBLES" | "TEAM";
  status: "DRAFT" | "ACTIVE" | "WITHDRAWN" | "DISQUALIFIED" | "ARCHIVED";
  members: readonly V2EntryMemberSource[];
}>;

export type V2FixtureSource = Readonly<{
  id: string;
  matchId: string;
  stage: "GROUP" | "KNOCKOUT" | "FREE_PLAY";
  status: "SCHEDULED" | "READY" | "COMPLETED" | "VOIDED";
  groupKey: string | null;
  sideAEntryId: string | null;
  sideBEntryId: string | null;
  sideARosterVersion: number | null;
  sideBRosterVersion: number | null;
  completedAt: Date | null;
  sideAEntry: V2FixtureEntrySource | null;
  sideBEntry: V2FixtureEntrySource | null;
  lineupMembers: readonly V2LineupMemberSource[];
  resultRevisions: readonly V2ActiveRevisionSource[];
  match: Readonly<{
    engineVersion: "LEGACY" | "V2";
    isQuickMatch: boolean;
    type: "single" | "double" | "team";
    format: "group_only" | "group_then_knockout";
    teamMinMembers: number | null;
    teamMaxMembers: number | null;
  }>;
}>;

type V2EntrySource = Readonly<{
  id: string;
  kind: "INDIVIDUAL" | "DOUBLES" | "TEAM";
  status: "DRAFT" | "ACTIVE" | "WITHDRAWN" | "DISQUALIFIED" | "ARCHIVED";
  createdAt: Date;
  members: readonly V2EntryMemberSource[];
  match: Readonly<{
    id: string;
    title: string;
    dateTime: Date;
    status: "registration" | "ongoing" | "finished";
    engineVersion: "LEGACY" | "V2";
    isQuickMatch: boolean;
    type: "single" | "double" | "team";
    format: "group_only" | "group_then_knockout";
    groupingGeneratedAt: Date | null;
    teamMinMembers: number | null;
    teamMaxMembers: number | null;
    qualificationSnapshots: readonly Readonly<{ id: string }>[];
    fixtures: readonly V2FixtureSource[];
  }>;
}>;

export type V2AuthoritativeResultSource = Omit<
  V2ActiveRevisionSource,
  "settlementEvents"
> &
  Readonly<{
    matchId: string;
    fixture: V2FixtureSource &
      Readonly<{
        match: Readonly<{
          engineVersion: "LEGACY" | "V2";
          isQuickMatch: boolean;
          type: "single" | "double" | "team";
          format: "group_only" | "group_then_knockout";
          teamMinMembers: number | null;
          teamMaxMembers: number | null;
        }>;
      }>;
  }>;

type V2RecentRevisionSource = V2AuthoritativeResultSource;

type V2PendingRevisionSource = Omit<
  V2ActiveRevisionSource,
  "settlementEvents"
> &
  Readonly<{
    fixture: V2FixtureSource &
      Readonly<{
        match: Readonly<{
          engineVersion: "LEGACY" | "V2";
          isQuickMatch: boolean;
          type: "single" | "double" | "team";
          format: "group_only" | "group_then_knockout";
          teamMinMembers: number | null;
          teamMaxMembers: number | null;
        }>;
      }>;
  }>;

export type HomeUserMatchItem = Readonly<{
  id: string;
  title: string;
  status: "registration" | "ongoing" | "finished";
  dateTime: Date;
  phase: string;
  confirmedCount: number;
  pendingCount: number;
}>;

export type HomeUserRecentResultItem = Readonly<{
  id: string;
  matchId: string;
  opponentLabel: string;
  isWin: boolean;
  eloDelta: number | null;
}>;

export type HomeUserCompetitionProjection = Readonly<{
  myMatches: readonly HomeUserMatchItem[];
  recentResults: readonly HomeUserRecentResultItem[];
  pendingResultCount: number;
  legacyMatchesToFinish: readonly string[];
}>;

type GroupingPayload = Readonly<{
  groups?: readonly Readonly<{
    players: readonly Readonly<{ id: string }>[];
  }>[];
}> | null;

function resultIncludesUser(result: LegacyResultSource, userId: string) {
  return (
    result.winnerTeamIds.includes(userId) || result.loserTeamIds.includes(userId)
  );
}

function legacyStageLabel(input: Readonly<{
  status: "registration" | "ongoing" | "finished";
  format: "group_only" | "group_then_knockout";
  groupingPayload: GroupingPayload;
  userId: string;
  results: readonly LegacyResultSource[];
}>) {
  const { status, format, groupingPayload, userId, results } = input;

  if (status === "registration") return "等待开赛";
  if (status === "finished") return "比赛已结束";
  if (!groupingPayload?.groups) return "等待分组";

  const group = groupingPayload.groups.find((item) =>
    item.players.some((player) => player.id === userId),
  );
  if (!group) return "等待编排赛程";

  const opponents = group.players.filter((player) => player.id !== userId);
  const done = opponents.filter((opponent) =>
    results.some(
      (result) =>
        result.confirmed &&
        resultIncludesUser(result, userId) &&
        resultIncludesUser(result, opponent.id),
    ),
  ).length;

  if (done >= opponents.length && format === "group_then_knockout") {
    return `小组赛 ${done}/${opponents.length}，等待淘汰赛`;
  }
  return `小组赛 ${done}/${opponents.length}`;
}

function parseLegacyScoreText(score: unknown) {
  if (typeof score === "string") return score;
  if (typeof score === "object" && score !== null && !Array.isArray(score)) {
    if ("text" in score && score.text) return String(score.text);
    if ("myScore" in score && "opponentScore" in score) {
      return `${String(score.myScore)}:${String(score.opponentScore)}`;
    }
  }
  return "";
}

type V2MatchType = "single" | "double" | "team";
type V2EntryKind = "INDIVIDUAL" | "DOUBLES" | "TEAM";

export class V2HomeUserCompetitionIntegrityError extends Error {
  readonly entityId: string;

  constructor(message: string, entityId: string) {
    super(message);
    this.name = "V2HomeUserCompetitionIntegrityError";
    this.entityId = entityId;
  }
}

function integrity(message: string, entityId: string): never {
  throw new V2HomeUserCompetitionIntegrityError(message, entityId);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

export function parseV2ScoreText(
  matchType: V2MatchType,
  resolutionKind: "PLAYED" | "FORFEIT",
  score: unknown,
  reason: string | null = null,
) {
  if (!isRecord(score)) return null;
  if (resolutionKind === "FORFEIT") {
    return hasExactKeys(score, ["winnerScore", "loserScore"]) &&
      score.winnerScore === 1 &&
      score.loserScore === 0 &&
      typeof reason === "string" &&
      reason.trim() === reason &&
      reason.length > 0 &&
      reason.length <= 500
      ? "弃权/1:0"
      : null;
  }

  const winnerScore = score.winnerScore;
  const loserScore = score.loserScore;
  if (
    typeof winnerScore !== "number" ||
    typeof loserScore !== "number" ||
    !Number.isSafeInteger(winnerScore) ||
    !Number.isSafeInteger(loserScore)
  ) {
    return null;
  }
  if (matchType === "team") {
    return hasExactKeys(score, ["winnerScore", "loserScore"]) &&
      winnerScore >= 0 &&
      loserScore >= 0 &&
      winnerScore <= V2_MAX_TEAM_SCORE_PER_FIXTURE &&
      loserScore <= V2_MAX_TEAM_SCORE_PER_FIXTURE &&
      winnerScore > loserScore
      ? `${winnerScore}:${loserScore}`
      : null;
  }

  const bestOf = score.bestOf;
  if (
    (bestOf !== 3 && bestOf !== 5 && bestOf !== 7) ||
    (!hasExactKeys(score, ["bestOf", "winnerScore", "loserScore"]) &&
      !hasExactKeys(score, ["bestOf", "winnerScore", "loserScore", "text"]))
  ) {
    return null;
  }
  const winsNeeded = (bestOf + 1) / 2;
  if (
    winnerScore !== winsNeeded ||
    loserScore < 0 ||
    loserScore >= winsNeeded ||
    ("text" in score &&
      !isCanonicalV2BestOfScoreText(
        score.text,
        bestOf,
        winnerScore,
        loserScore,
      ))
  ) {
    return null;
  }
  return `${winnerScore}:${loserScore}`;
}

function expectedEntryKind(matchType: V2MatchType): V2EntryKind {
  return matchType === "single"
    ? "INDIVIDUAL"
    : matchType === "double"
      ? "DOUBLES"
      : "TEAM";
}

type RosterContext = Readonly<{
  matchType: V2MatchType;
  teamMinMembers: number | null;
  teamMaxMembers: number | null;
}>;

function validateRosterSnapshot(
  entry: V2FixtureEntrySource | V2EntrySource,
  rosterVersion: number,
  context: RosterContext,
) {
  const members = entry.members
    .filter((member) => member.rosterVersion === rosterVersion)
    .sort((left, right) => left.slot - right.slot || left.id.localeCompare(right.id));
  const expectedCount =
    context.matchType === "single" ? 1 : context.matchType === "double" ? 2 : null;
  const validTeamBounds =
    context.matchType === "team"
      ? context.teamMinMembers !== null &&
      context.teamMaxMembers !== null &&
      Number.isSafeInteger(context.teamMinMembers) &&
      Number.isSafeInteger(context.teamMaxMembers) &&
      context.teamMinMembers > 0 &&
      context.teamMaxMembers >= context.teamMinMembers &&
      members.length >= context.teamMinMembers &&
      members.length <= context.teamMaxMembers
      : context.teamMinMembers === null && context.teamMaxMembers === null;
  if (
    entry.kind !== expectedEntryKind(context.matchType) ||
    !Number.isSafeInteger(rosterVersion) ||
    rosterVersion < 1 ||
    members.length === 0 ||
    (expectedCount !== null && members.length !== expectedCount) ||
    !validTeamBounds ||
    new Set(members.map((member) => member.id)).size !== members.length ||
    new Set(members.map((member) => member.userId)).size !== members.length ||
    members.some(
      (member, index) =>
        member.slot !== index + 1 ||
        member.displayNameSnapshot.trim() === "" ||
        member.displayNameSnapshot !== member.displayNameSnapshot.trim(),
    ) ||
    (context.matchType !== "team" &&
      members.some((member) => member.role !== "player")) ||
    (context.matchType === "team" &&
      members.filter((member) => member.role === "captain").length !== 1)
  ) {
    integrity("A V2 Entry roster snapshot is incomplete or incompatible.", entry.id);
  }
  return members;
}

type ResolvedV2FixtureSide = Readonly<{
  side: "SIDE_A" | "SIDE_B";
  entryId: string;
  entryStatus: V2FixtureEntrySource["status"];
  rosterVersion: number;
  members: readonly V2LineupMemberSource[];
  userIds: readonly string[];
}>;

function resolveFixtureSide(
  fixture: V2FixtureSource,
  side: "SIDE_A" | "SIDE_B",
  context: RosterContext,
): ResolvedV2FixtureSide | null {
  const entryId =
    side === "SIDE_A" ? fixture.sideAEntryId : fixture.sideBEntryId;
  const rosterVersion =
    side === "SIDE_A"
      ? fixture.sideARosterVersion
      : fixture.sideBRosterVersion;
  const entry = side === "SIDE_A" ? fixture.sideAEntry : fixture.sideBEntry;
  const lineup = fixture.lineupMembers
    .filter((member) => member.side === side)
    .sort(
      (left, right) =>
        left.position - right.position || left.id.localeCompare(right.id),
    );
  if (entryId === null && rosterVersion === null && entry === null) {
    if (lineup.length !== 0) {
      integrity("An unresolved V2 Fixture side retains lineup members.", fixture.id);
    }
    return null;
  }
  if (entryId === null || rosterVersion === null || entry === null) {
    integrity("A V2 Fixture side is only partially resolved.", fixture.id);
  }
  if (entry.id !== entryId) {
    integrity("A V2 Fixture side references the wrong Entry.", fixture.id);
  }
  const roster = validateRosterSnapshot(entry, rosterVersion, context);
  if (
    lineup.length !== roster.length ||
    lineup.some((member, index) => {
      const expected = roster[index];
      return (
        member.position !== index + 1 ||
        member.entryId !== entryId ||
        member.entryMember.id !== expected.id ||
        member.entryMember.userId !== expected.userId ||
        member.entryMember.displayNameSnapshot !==
          expected.displayNameSnapshot ||
        member.entryMember.role !== expected.role ||
        member.entryMember.slot !== expected.slot ||
        member.entryMember.rosterVersion !== rosterVersion
      );
    })
  ) {
    integrity("A V2 Fixture lineup is not its complete frozen roster.", fixture.id);
  }
  return {
    side,
    entryId,
    entryStatus: entry.status,
    rosterVersion,
    members: lineup,
    userIds: roster.map((member) => member.userId),
  };
}

function assertRevisionParticipants(
  revision: V2ActiveRevisionSource,
  fixture: V2FixtureSource,
) {
  if (
    revision.winnerEntryId === null ||
    revision.loserEntryId === null ||
    revision.winnerEntryId === revision.loserEntryId ||
    new Set([revision.winnerEntryId, revision.loserEntryId]).size !== 2 ||
    ![revision.winnerEntryId, revision.loserEntryId].every(
      (entryId) =>
        entryId === fixture.sideAEntryId || entryId === fixture.sideBEntryId,
    )
  ) {
    integrity("An active V2 result does not match both Fixture sides.", revision.id);
  }
}

function validateConfirmedSettlement(
  revision: V2ActiveRevisionSource,
  winnerUserIds: readonly string[],
  loserUserIds: readonly string[],
) {
  if (revision.resolutionKind === "FORFEIT") {
    if (revision.settlementEvents.length !== 0) {
      integrity("A V2 FORFEIT result has settlement residue.", revision.id);
    }
    return null;
  }
  const event =
    revision.settlementEvents.length === 1
      ? revision.settlementEvents[0]
      : null;
  if (
    event === null ||
    event.kind !== "RESULT_APPLY" ||
    event.status !== "APPLIED" ||
    event.resultRevisionId !== revision.id ||
    event.matchEntryId !== null ||
    event.reversesEventId !== null ||
    event.failureReason !== null ||
    event.appliedAt === null ||
    !Number.isFinite(event.appliedAt.getTime())
  ) {
    integrity(
      "A confirmed V2 PLAYED result requires one applied result settlement.",
      revision.id,
    );
  }
  const expectedUserIds = [...winnerUserIds, ...loserUserIds];
  const expected = [...new Set(expectedUserIds)].sort((left, right) =>
    left.localeCompare(right),
  );
  const effects = [...event.effects].sort(
    (left, right) =>
      left.userId.localeCompare(right.userId) || left.id.localeCompare(right.id),
  );
  if (
    expected.length !== expectedUserIds.length ||
    effects.length !== expected.length ||
    new Set(effects.map((effect) => effect.id)).size !== effects.length ||
    new Set(effects.map((effect) => effect.userId)).size !== effects.length ||
    effects.some((effect, index) => {
      const isWinner = winnerUserIds.includes(effect.userId);
      return (
        effect.userId !== expected[index] ||
        effect.eloBefore === null ||
        effect.eloAfter === null ||
        effect.eloDelta === null ||
        effect.pointsBefore === null ||
        effect.pointsAfter === null ||
        effect.pointsDelta === null ||
        !Number.isSafeInteger(effect.eloBefore) ||
        !Number.isSafeInteger(effect.eloAfter) ||
        !Number.isSafeInteger(effect.eloDelta) ||
        !Number.isSafeInteger(effect.pointsBefore) ||
        !Number.isSafeInteger(effect.pointsAfter) ||
        !Number.isSafeInteger(effect.pointsDelta) ||
        !Number.isSafeInteger(effect.winsDelta) ||
        !Number.isSafeInteger(effect.lossesDelta) ||
        !Number.isSafeInteger(effect.matchesPlayedDelta) ||
        effect.eloAfter - effect.eloBefore !== effect.eloDelta ||
        effect.pointsAfter - effect.pointsBefore !== effect.pointsDelta ||
        effect.pointsBefore < 0 ||
        effect.pointsAfter < 0 ||
        effect.pointsDelta < 0 ||
        effect.winsDelta !== (isWinner ? 1 : 0) ||
        effect.lossesDelta !== (isWinner ? 0 : 1) ||
        effect.matchesPlayedDelta !== 1
      );
    })
  ) {
    integrity(
      "A V2 PLAYED settlement does not contain one exact effect per frozen member.",
      revision.id,
    );
  }
  return new Map(
    effects.map((effect) => [effect.userId, effect.eloDelta as number] as const),
  );
}

export type ResolvedV2Fixture = Readonly<{
  sideA: ResolvedV2FixtureSide | null;
  sideB: ResolvedV2FixtureSide | null;
  pending: V2ActiveRevisionSource | null;
  confirmed: V2ActiveRevisionSource | null;
  confirmedScoreText: string | null;
  confirmedEloDeltas: ReadonlyMap<string, number> | null;
}>;

export function resolveV2Fixture(
  fixture: V2FixtureSource,
  context: RosterContext,
): ResolvedV2Fixture {
  if (
    fixture.stage === "FREE_PLAY" ||
    (fixture.stage === "GROUP" &&
      (fixture.groupKey === null || fixture.groupKey.trim() === "")) ||
    (fixture.stage === "KNOCKOUT" && fixture.groupKey !== null)
  ) {
    integrity("A V2 Fixture has an unsupported stage/group shape.", fixture.id);
  }
  const sideA = resolveFixtureSide(fixture, "SIDE_A", context);
  const sideB = resolveFixtureSide(fixture, "SIDE_B", context);
  if (
    fixture.stage === "GROUP" &&
    (sideA === null || sideB === null)
  ) {
    integrity("A GROUP Fixture must have two frozen sides.", fixture.id);
  }
  if (
    sideA !== null &&
    sideB !== null &&
    (sideA.entryId === sideB.entryId ||
      sideA.userIds.some((userId) => sideB.userIds.includes(userId)))
  ) {
    integrity("A V2 Fixture has overlapping sides.", fixture.id);
  }

  const pending = fixture.resultRevisions.filter(
    (revision) => revision.status === "PENDING",
  );
  const confirmed = fixture.resultRevisions.filter(
    (revision) => revision.status === "CONFIRMED",
  );
  if (
    pending.length > 1 ||
    confirmed.length > 1 ||
    fixture.resultRevisions.length !== pending.length + confirmed.length
  ) {
    integrity("A V2 Fixture has an ambiguous active result set.", fixture.id);
  }
  if (
    (pending.length > 0 || confirmed.length > 0) &&
    (sideA === null || sideB === null)
  ) {
    integrity("An unresolved V2 Fixture has an active result.", fixture.id);
  }
  for (const revision of [...pending, ...confirmed]) {
    assertRevisionParticipants(revision, fixture);
    if (
      !Number.isSafeInteger(revision.revisionNumber) ||
      revision.revisionNumber < 1 ||
      revision.reportedById.trim() === "" ||
      revision.reportedById !== revision.reportedById.trim() ||
      !Number.isFinite(revision.createdAt.getTime()) ||
      parseV2ScoreText(
        context.matchType,
        revision.resolutionKind,
        revision.score,
        revision.reason,
      ) === null ||
      (revision.status === "PENDING" &&
        (revision.resolutionKind !== "PLAYED" ||
          revision.resolvedAt !== null ||
          revision.settlementEvents.length !== 0)) ||
      (revision.status === "CONFIRMED" &&
        (revision.resolvedAt === null ||
          !Number.isFinite(revision.resolvedAt.getTime())))
    ) {
      integrity("An active V2 result revision is malformed.", revision.id);
    }
  }

  const activePending = pending[0] ?? null;
  const activeConfirmed = confirmed[0] ?? null;
  if (
    (activePending !== null &&
      activePending.supersedesRevisionId !== null &&
      activeConfirmed === null) ||
    (activePending !== null &&
      activeConfirmed !== null &&
      (activePending.supersedesRevisionId !== activeConfirmed.id ||
        activePending.revisionNumber <= activeConfirmed.revisionNumber))
  ) {
    integrity("A pending V2 correction has no authoritative predecessor.", fixture.id);
  }

  const bothSidesResolved = sideA !== null && sideB !== null;
  const lifecycleIsValid =
    fixture.status === "SCHEDULED"
      ? activePending === null &&
        activeConfirmed === null &&
        fixture.completedAt === null &&
        !bothSidesResolved
      : fixture.status === "READY"
        ? bothSidesResolved &&
          activeConfirmed === null &&
          (activePending === null ||
            activePending.supersedesRevisionId === null) &&
          fixture.completedAt === null
        : fixture.status === "COMPLETED"
          ? bothSidesResolved &&
            activeConfirmed !== null &&
            fixture.completedAt !== null &&
            Number.isFinite(fixture.completedAt.getTime())
          : fixture.stage === "GROUP" &&
            bothSidesResolved &&
            activePending === null &&
            activeConfirmed === null;
  if (!lifecycleIsValid) {
    integrity("A V2 Fixture/result lifecycle is inconsistent.", fixture.id);
  }

  const confirmedScoreText = activeConfirmed
    ? parseV2ScoreText(
        context.matchType,
        activeConfirmed.resolutionKind,
        activeConfirmed.score,
        activeConfirmed.reason,
      )
    : null;
  const confirmedEloDeltas = activeConfirmed
    ? validateConfirmedSettlement(
        activeConfirmed,
        activeConfirmed.winnerEntryId === sideA?.entryId
          ? (sideA?.userIds ?? [])
          : (sideB?.userIds ?? []),
        activeConfirmed.loserEntryId === sideA?.entryId
          ? (sideA?.userIds ?? [])
          : (sideB?.userIds ?? []),
      )
    : null;
  return {
    sideA,
    sideB,
    pending: activePending,
    confirmed: activeConfirmed,
    confirmedScoreText,
    confirmedEloDeltas,
  };
}

function buildLegacyMatchItem(
  registration: LegacyRegistrationSource,
  userId: string,
): HomeUserMatchItem | null {
  const match = registration.match;
  if (match.engineVersion !== "LEGACY" || match.isQuickMatch) return null;
  return {
    id: match.id,
    title: match.title,
    status: match.status,
    dateTime: match.dateTime,
    phase: legacyStageLabel({
      status: match.status,
      format: match.format,
      groupingPayload: (match.groupingResult?.payload ?? null) as GroupingPayload,
      userId,
      results: match.results,
    }),
    confirmedCount: match.results.filter(
      (result) => result.confirmed && resultIncludesUser(result, userId),
    ).length,
    pendingCount: match.results.filter(
      (result) => !result.confirmed && resultIncludesUser(result, userId),
    ).length,
  };
}

type CurrentV2Membership = Readonly<{
  participatedAt: Date;
  rosterVersion: number;
}>;

function resolveCurrentV2Membership(
  entry: V2EntrySource,
  userId: string,
  context: RosterContext,
): CurrentV2Membership | null {
  if (entry.status !== "ACTIVE") return null;
  const currentMembers = entry.members.filter(
    (member) => member.status === "ACTIVE" && member.effectiveUntil === null,
  );
  const userMembers = currentMembers.filter((member) => member.userId === userId);
  if (userMembers.length === 0) return null;
  if (userMembers.length !== 1) {
    integrity("A user occupies multiple slots in a current V2 Entry.", entry.id);
  }
  const rosterVersions = new Set(
    currentMembers.map((member) => member.rosterVersion),
  );
  const highestRosterVersion = Math.max(
    0,
    ...entry.members.map((member) => member.rosterVersion),
  );
  if (rosterVersions.size !== 1) {
    integrity("A current V2 Entry spans multiple roster versions.", entry.id);
  }
  const rosterVersion = [...rosterVersions][0];
  const roster = validateRosterSnapshot(entry, rosterVersion, context);
  if (
    rosterVersion !== highestRosterVersion ||
    roster.length !== currentMembers.length ||
    roster.some(
      (member) => member.status !== "ACTIVE" || member.effectiveUntil !== null,
    ) ||
    currentMembers.some(
      (member) => !Number.isFinite(member.effectiveFrom.getTime()),
    )
  ) {
    integrity("A V2 Entry does not have one complete current roster.", entry.id);
  }
  return {
    participatedAt: userMembers[0].effectiveFrom,
    rosterVersion,
  };
}

type ResolvedFixtureWithSource = Readonly<{
  fixture: V2FixtureSource;
  resolved: ResolvedV2Fixture;
}>;

function assertCompleteGroupTopology(
  fixtures: readonly ResolvedFixtureWithSource[],
  matchId: string,
) {
  const groupFixtures = fixtures.filter(({ fixture }) => fixture.stage === "GROUP");
  const byGroup = new Map<string, ResolvedFixtureWithSource[]>();
  for (const item of groupFixtures) {
    const key = item.fixture.groupKey;
    if (
      key === null ||
      key.trim() !== key ||
      key === "" ||
      item.fixture.status === "SCHEDULED" ||
      item.resolved.sideA === null ||
      item.resolved.sideB === null
    ) {
      integrity("A published V2 GROUP Fixture is malformed.", item.fixture.id);
    }
    const existing = byGroup.get(key) ?? [];
    existing.push(item);
    byGroup.set(key, existing);
  }
  if (groupFixtures.length === 0) {
    integrity("A grouped V2 Match has no GROUP Fixtures.", matchId);
  }

  const entryGroups = new Map<string, string>();
  for (const [groupKey, group] of byGroup) {
    const entryIds = new Set<string>();
    const pairs = new Set<string>();
    for (const { fixture, resolved } of group) {
      const sideA = resolved.sideA;
      const sideB = resolved.sideB;
      if (sideA === null || sideB === null) {
        integrity("A GROUP Fixture has an unresolved side.", fixture.id);
      }
      for (const entryId of [sideA.entryId, sideB.entryId]) {
        const priorGroup = entryGroups.get(entryId);
        if (priorGroup !== undefined && priorGroup !== groupKey) {
          integrity("A V2 Entry appears in multiple groups.", matchId);
        }
        entryGroups.set(entryId, groupKey);
        entryIds.add(entryId);
      }
      const pair = [sideA.entryId, sideB.entryId].sort().join("\u0000");
      if (pairs.has(pair)) {
        integrity("A V2 group contains a duplicate Fixture pair.", fixture.id);
      }
      pairs.add(pair);
    }
    const expectedFixtureCount = (entryIds.size * (entryIds.size - 1)) / 2;
    if (pairs.size !== expectedFixtureCount) {
      integrity("A V2 group is not a complete single round robin.", matchId);
    }
  }
}

function buildV2MatchItem(
  entry: V2EntrySource,
  userId: string,
): Readonly<{
  entryId: string;
  item: HomeUserMatchItem;
  participatedAt: Date;
}> | null {
  const match = entry.match;
  if (match.engineVersion !== "V2" || match.isQuickMatch) return null;
  const context: RosterContext = {
    matchType: match.type,
    teamMinMembers: match.teamMinMembers,
    teamMaxMembers: match.teamMaxMembers,
  };
  const membership = resolveCurrentV2Membership(entry, userId, context);
  if (membership === null) return null;
  if (entry.kind !== expectedEntryKind(match.type)) {
    integrity("A current V2 Entry kind does not match its Match type.", entry.id);
  }
  if (
    !Number.isFinite(match.dateTime.getTime()) ||
    (match.groupingGeneratedAt !== null &&
      !Number.isFinite(match.groupingGeneratedAt.getTime())) ||
    match.qualificationSnapshots.length > 1 ||
    new Set(match.qualificationSnapshots.map((snapshot) => snapshot.id)).size !==
      match.qualificationSnapshots.length ||
    match.qualificationSnapshots.some(
      (snapshot) => snapshot.id.trim() === "" || snapshot.id !== snapshot.id.trim(),
    )
  ) {
    integrity("A V2 Match projection contains malformed authority fields.", match.id);
  }
  if (
    new Set(match.fixtures.map((fixture) => fixture.id)).size !==
    match.fixtures.length
  ) {
    integrity("A V2 Match contains duplicate Fixture rows.", match.id);
  }
  for (const fixture of match.fixtures) {
    if (
      fixture.matchId !== match.id ||
      fixture.match.engineVersion !== "V2" ||
      fixture.match.isQuickMatch ||
      fixture.match.type !== match.type ||
      fixture.match.format !== match.format ||
      fixture.match.teamMinMembers !== match.teamMinMembers ||
      fixture.match.teamMaxMembers !== match.teamMaxMembers
    ) {
      integrity("A V2 Fixture is attached to incompatible Match facts.", fixture.id);
    }
  }

  const hasMaterializedStage =
    match.fixtures.length > 0 || match.qualificationSnapshots.length > 0;
  if (
    (match.groupingGeneratedAt === null && hasMaterializedStage) ||
    (match.groupingGeneratedAt !== null && match.fixtures.length === 0) ||
    (match.status === "registration" && match.groupingGeneratedAt !== null) ||
    (match.status === "finished" && match.groupingGeneratedAt === null)
  ) {
    integrity("A V2 Match has a partially materialized stage graph.", match.id);
  }

  const resolvedFixtures = match.fixtures.map(
    (fixture): ResolvedFixtureWithSource => ({
      fixture,
      resolved: resolveV2Fixture(fixture, context),
    }),
  );
  const groupFixtures = resolvedFixtures.filter(
    ({ fixture }) => fixture.stage === "GROUP",
  );
  const knockoutFixtures = resolvedFixtures.filter(
    ({ fixture }) => fixture.stage === "KNOCKOUT",
  );
  if (match.groupingGeneratedAt !== null) {
    assertCompleteGroupTopology(resolvedFixtures, match.id);
  }

  const allGroupsTerminal =
    groupFixtures.length > 0 &&
    groupFixtures.every(({ fixture }) =>
      fixture.status === "COMPLETED" || fixture.status === "VOIDED",
    );
  const hasQualificationSnapshot = match.qualificationSnapshots.length === 1;
  if (
    (match.format === "group_only" &&
      (knockoutFixtures.length > 0 || hasQualificationSnapshot)) ||
    (match.format === "group_then_knockout" &&
      ((hasQualificationSnapshot && knockoutFixtures.length === 0) ||
        (!hasQualificationSnapshot && knockoutFixtures.length > 0) ||
        (hasQualificationSnapshot && !allGroupsTerminal)))
  ) {
    integrity("A V2 Match has an illegal GROUP/KNOCKOUT stage combination.", match.id);
  }
  const allFixturesTerminal =
    resolvedFixtures.length > 0 &&
    resolvedFixtures.every(({ fixture }) =>
      fixture.status === "COMPLETED" || fixture.status === "VOIDED",
    );
  if (
    match.status === "finished" &&
    (!allFixturesTerminal ||
      (match.format === "group_then_knockout" &&
        (!hasQualificationSnapshot || knockoutFixtures.length === 0)))
  ) {
    integrity("A finished V2 Match retains an unfinished stage graph.", match.id);
  }

  const userEntryIds = new Set<string>();
  const relevant = resolvedFixtures.filter(({ resolved }) => {
    for (const side of [resolved.sideA, resolved.sideB]) {
      if (side?.userIds.includes(userId)) userEntryIds.add(side.entryId);
    }
    const ownSide =
      resolved.sideA?.entryId === entry.id
        ? resolved.sideA
        : resolved.sideB?.entryId === entry.id
          ? resolved.sideB
          : null;
    return ownSide?.userIds.includes(userId) ?? false;
  });
  if (userEntryIds.size > 1 || [...userEntryIds].some((id) => id !== entry.id)) {
    integrity("A user is frozen into multiple Entries in one V2 Match.", match.id);
  }
  if (
    match.groupingGeneratedAt !== null &&
    !resolvedFixtures.some(
      ({ resolved }) =>
        resolved.sideA?.entryId === entry.id || resolved.sideB?.entryId === entry.id,
    )
  ) {
    integrity("A current V2 Entry is missing from the published grouping.", match.id);
  }

  const confirmedCount = relevant.filter(
    ({ resolved }) => resolved.confirmed !== null,
  ).length;
  const pendingCount = relevant.filter(
    ({ resolved }) => resolved.pending !== null,
  ).length;
  const relevantGroups = relevant.filter(
    ({ fixture }) => fixture.stage === "GROUP",
  );
  const relevantKnockout = relevant.filter(
    ({ fixture }) => fixture.stage === "KNOCKOUT",
  );
  const groupDone = relevantGroups.filter(({ fixture }) =>
    fixture.status === "COMPLETED" || fixture.status === "VOIDED",
  ).length;
  const knockoutDone = relevantKnockout.filter(({ fixture }) =>
    fixture.status === "COMPLETED" || fixture.status === "VOIDED",
  ).length;
  if (
    match.status === "ongoing" &&
    allFixturesTerminal &&
    (match.format === "group_only" || hasQualificationSnapshot)
  ) {
    integrity("A terminal V2 Match has not reached finished status.", match.id);
  }
  const phase =
    match.status === "registration"
      ? "等待开赛"
      : match.status === "finished"
        ? "比赛已结束"
        : match.groupingGeneratedAt === null
          ? "等待分组"
          : match.format === "group_then_knockout" &&
              !hasQualificationSnapshot &&
              allGroupsTerminal
            ? "等待淘汰签表"
            : match.format === "group_then_knockout" &&
                hasQualificationSnapshot
              ? relevantKnockout.length === 0
                ? "淘汰赛"
                : `淘汰赛 ${knockoutDone}/${relevantKnockout.length}`
              : `小组赛 ${groupDone}/${relevantGroups.length}`;

  return {
    entryId: entry.id,
    item: {
      id: match.id,
      title: match.title,
      status: match.status,
      dateTime: match.dateTime,
      phase,
      confirmedCount,
      pendingCount,
    },
    participatedAt: membership.participatedAt,
  };
}

function buildLegacyRecentResult(
  result: LegacyRecentResultSource,
  userId: string,
  opponentNames: ReadonlyMap<string, string>,
) {
  const isWin = result.winnerTeamIds.includes(userId);
  const isLoss = result.loserTeamIds.includes(userId);
  if (isWin === isLoss) return null;
  const opponentTeamIds = isWin ? result.loserTeamIds : result.winnerTeamIds;
  const opponentLabel =
    opponentTeamIds.map((id) => opponentNames.get(id) ?? id).join(" / ") ||
    "未知对手";
  const scoreText = parseLegacyScoreText(result.score);
  const history = result.eloHistory.length === 1 ? result.eloHistory[0] : null;
  const eloDelta =
    history &&
    history.eloAfter - history.eloBefore === history.delta
      ? history.delta
      : null;

  return {
    item: {
      id: result.id,
      matchId: result.matchId,
      opponentLabel: scoreText
        ? `${opponentLabel} · ${scoreText}`
        : opponentLabel,
      isWin,
      eloDelta,
    } satisfies HomeUserRecentResultItem,
    occurredAt: result.resultVerifiedAt ?? result.createdAt,
  };
}

function isFormalV2Fixture(
  fixture:
    | V2AuthoritativeResultSource["fixture"]
    | V2PendingRevisionSource["fixture"],
) {
  const match = fixture.match;
  return (
    match.engineVersion === "V2" &&
    !match.isQuickMatch &&
    (fixture.stage === "GROUP" || fixture.stage === "KNOCKOUT")
  );
}

export type AuthoritativeV2Result = Readonly<{
  id: string;
  matchId: string;
  userEntryId: string;
  opponentLabel: string;
  scoreText: string;
  isWin: boolean;
  resolutionKind: "PLAYED" | "FORFEIT";
  eloDelta: number | null;
  occurredAt: Date;
}>;

function stableRosterLabel(side: ResolvedV2FixtureSide) {
  return [...new Set(side.members.map((member) => member.entryMember.displayNameSnapshot))].join(
    " / ",
  );
}

export function buildAuthoritativeV2Result(
  revision: V2AuthoritativeResultSource,
  userId: string,
): AuthoritativeV2Result | null {
  if (
    revision.status !== "CONFIRMED" ||
    revision.resolvedAt === null ||
    !isFormalV2Fixture(revision.fixture)
  ) {
    return null;
  }
  const context: RosterContext = {
    matchType: revision.fixture.match.type,
    teamMinMembers: revision.fixture.match.teamMinMembers,
    teamMaxMembers: revision.fixture.match.teamMaxMembers,
  };
  const resolved = resolveV2Fixture(revision.fixture, context);
  const confirmed = resolved.confirmed;
  if (
    revision.fixture.matchId !== revision.matchId ||
    confirmed === null ||
    confirmed.id !== revision.id ||
    confirmed.revisionNumber !== revision.revisionNumber ||
    confirmed.resolutionKind !== revision.resolutionKind ||
    confirmed.winnerEntryId !== revision.winnerEntryId ||
    confirmed.loserEntryId !== revision.loserEntryId ||
    confirmed.reportedById !== revision.reportedById ||
    confirmed.supersedesRevisionId !== revision.supersedesRevisionId ||
    confirmed.reason !== revision.reason ||
    confirmed.resolvedAt?.getTime() !== revision.resolvedAt.getTime()
  ) {
    integrity("A V2 result query does not point at the current authority.", revision.id);
  }

  const userSide =
    resolved.sideA?.userIds.includes(userId)
      ? resolved.sideA
      : resolved.sideB?.userIds.includes(userId)
        ? resolved.sideB
        : null;
  if (!userSide) return null;
  const opponent = userSide.side === "SIDE_A" ? resolved.sideB : resolved.sideA;
  if (opponent === null) {
    integrity("A confirmed V2 result has an unresolved opponent.", revision.id);
  }
  const isWin = revision.winnerEntryId === userSide.entryId;
  const isLoss = revision.loserEntryId === userSide.entryId;
  if (isWin === isLoss) {
    integrity("A V2 result cannot orient the frozen user side.", revision.id);
  }

  const scoreText = resolved.confirmedScoreText;
  if (scoreText === null) {
    integrity("A confirmed V2 result has no canonical score.", revision.id);
  }
  const eloDelta =
    revision.resolutionKind === "FORFEIT"
      ? null
      : (resolved.confirmedEloDeltas?.get(userId) ?? null);
  if (revision.resolutionKind === "PLAYED" && eloDelta === null) {
    integrity("A PLAYED V2 result lacks the user's applied effect.", revision.id);
  }
  return {
    id: revision.id,
    matchId: revision.matchId,
    userEntryId: userSide.entryId,
    opponentLabel: stableRosterLabel(opponent),
    scoreText,
    isWin,
    resolutionKind: revision.resolutionKind,
    eloDelta,
    occurredAt: revision.resolvedAt,
  };
}

/** @deprecated Prefer the type-generic V2 authority projection. */
export const buildAuthoritativeV2SingleResult = buildAuthoritativeV2Result;
export type AuthoritativeV2SingleResult = AuthoritativeV2Result;

function buildV2RecentResult(
  revision: V2RecentRevisionSource,
  userId: string,
) {
  const authoritative = buildAuthoritativeV2Result(revision, userId);
  if (!authoritative) return null;

  return {
    userEntryId: authoritative.userEntryId,
    item: {
      id: revision.id,
      matchId: revision.matchId,
      opponentLabel: `${authoritative.opponentLabel} · ${authoritative.scoreText}`,
      isWin: authoritative.isWin,
      eloDelta: authoritative.eloDelta,
    } satisfies HomeUserRecentResultItem,
    occurredAt: authoritative.occurredAt,
  };
}

function actionableV2PendingEntryId(
  revision: V2PendingRevisionSource,
  userId: string,
) {
  if (
    revision.status !== "PENDING" ||
    revision.reportedById === userId ||
    revision.supersedesRevisionId !== null ||
    !isFormalV2Fixture(revision.fixture) ||
    revision.fixture.sideAEntry?.status !== "ACTIVE" ||
    revision.fixture.sideBEntry?.status !== "ACTIVE"
  ) {
    return null;
  }
  const resolved = resolveV2Fixture(revision.fixture, {
    matchType: revision.fixture.match.type,
    teamMinMembers: revision.fixture.match.teamMinMembers,
    teamMaxMembers: revision.fixture.match.teamMaxMembers,
  });
  if (resolved.pending?.id !== revision.id) {
    integrity("A V2 pending-result query is not the active initial revision.", revision.id);
  }
  const sideAIncludesUser = resolved.sideA?.userIds.includes(userId) ?? false;
  const sideBIncludesUser = resolved.sideB?.userIds.includes(userId) ?? false;
  if (sideAIncludesUser === sideBIncludesUser) return null;
  return sideAIncludesUser
    ? (resolved.sideA?.entryId ?? null)
    : (resolved.sideB?.entryId ?? null);
}

export function buildHomeUserCompetitionProjection(input: Readonly<{
  userId: string;
  legacyRegistrations: readonly LegacyRegistrationSource[];
  v2Entries: readonly V2EntrySource[];
  legacyRecentResults: readonly LegacyRecentResultSource[];
  legacyOpponentNames: ReadonlyMap<string, string>;
  v2RecentRevisions: readonly V2RecentRevisionSource[];
  legacyPendingResultCount: number;
  v2PendingRevisions: readonly V2PendingRevisionSource[];
}>): HomeUserCompetitionProjection {
  if (input.userId.trim() === "" || input.userId !== input.userId.trim()) {
    throw new TypeError("userId must be a non-empty stable identifier.");
  }

  const legacyMatches = input.legacyRegistrations
    .map((registration) => ({
      item: buildLegacyMatchItem(registration, input.userId),
      participatedAt: registration.createdAt,
    }))
    .filter(
      (
        value,
      ): value is Readonly<{
        item: HomeUserMatchItem;
        participatedAt: Date;
      }> => value.item !== null,
    );
  const v2MatchesByMatch = new Map<
    string,
    NonNullable<ReturnType<typeof buildV2MatchItem>>
  >();
  for (const entry of input.v2Entries) {
    const built = buildV2MatchItem(entry, input.userId);
    if (built === null) continue;
    const prior = v2MatchesByMatch.get(built.item.id);
    if (prior !== undefined && prior.entryId !== built.entryId) {
      integrity(
        "A user has multiple current Entries in one V2 Match.",
        built.item.id,
      );
    }
    if (
      prior === undefined ||
      built.participatedAt.getTime() > prior.participatedAt.getTime()
    ) {
      v2MatchesByMatch.set(built.item.id, built);
    }
  }
  const v2Matches = [...v2MatchesByMatch.values()];
  const myMatches = [...legacyMatches, ...v2Matches]
    .sort(
      (left, right) =>
        Number(left.item.status === "finished") - Number(right.item.status === "finished") ||
        Number(right.item.pendingCount > 0) - Number(left.item.pendingCount > 0) ||
        Number(right.item.status === "ongoing") - Number(left.item.status === "ongoing") ||
        right.participatedAt.getTime() - left.participatedAt.getTime() ||
        left.item.id.localeCompare(right.item.id),
    )
    .slice(0, MY_MATCH_LIMIT)
    .map(({ item }) => item);

  const v2RecentEntriesByMatch = new Map<string, string>();
  const v2RecentResults = input.v2RecentRevisions
    .map((revision) => buildV2RecentResult(revision, input.userId))
    .filter((result): result is NonNullable<typeof result> => result !== null)
    .map((result) => {
      const prior = v2RecentEntriesByMatch.get(result.item.matchId);
      if (prior !== undefined && prior !== result.userEntryId) {
        integrity(
          "A user's V2 history spans multiple Entries in one Match.",
          result.item.matchId,
        );
      }
      v2RecentEntriesByMatch.set(result.item.matchId, result.userEntryId);
      return result;
    });
  const recentResults = [
    ...input.legacyRecentResults
      .map((result) =>
        buildLegacyRecentResult(
          result,
          input.userId,
          input.legacyOpponentNames,
        ),
      )
      .filter((result): result is NonNullable<typeof result> => result !== null),
    ...v2RecentResults,
  ]
    .sort(
      (left, right) =>
        right.occurredAt.getTime() - left.occurredAt.getTime() ||
        left.item.id.localeCompare(right.item.id),
    )
    .slice(0, RECENT_RESULT_LIMIT)
    .map(({ item }) => item);

  const legacyMatchesToFinish = input.legacyRegistrations
    .filter(
      ({ match }) =>
        match.engineVersion === "LEGACY" &&
        match.status === "ongoing" &&
        isMatchAllResultsFinished({
          format: match.format,
          groupingGeneratedAt: match.groupingGeneratedAt,
          groupingResult: match.groupingResult,
          results: match.results.map((result) => ({
            ...result,
            winnerTeamIds: [...result.winnerTeamIds],
            loserTeamIds: [...result.loserTeamIds],
          })),
        }),
    )
    .map(({ match }) => match.id)
    .sort((left, right) => left.localeCompare(right));

  const pendingEntriesByMatch = new Map<string, string>();
  let actionableV2PendingCount = 0;
  for (const revision of input.v2PendingRevisions) {
    const entryId = actionableV2PendingEntryId(revision, input.userId);
    if (entryId === null) continue;
    const matchId = revision.fixture.matchId;
    const prior = pendingEntriesByMatch.get(matchId);
    if (prior !== undefined && prior !== entryId) {
      integrity("A user has pending results for multiple Entries.", matchId);
    }
    pendingEntriesByMatch.set(matchId, entryId);
    actionableV2PendingCount += 1;
  }

  return {
    myMatches,
    recentResults,
    pendingResultCount:
      input.legacyPendingResultCount + actionableV2PendingCount,
    legacyMatchesToFinish,
  };
}

export type HomeUserCompetitionDatabase = Pick<PrismaClient, "$transaction">;

/**
 * One side-effect-free, repeatable snapshot for the home user's competition
 * context. Legacy facts remain legacy-owned; the supported V2 slice never
 * falls back to Registration, MatchGrouping, MatchResult, or positional ELO
 * history inference.
 */
export async function getHomeUserCompetitionProjection(
  db: HomeUserCompetitionDatabase,
  userId: string,
): Promise<HomeUserCompetitionProjection> {
  if (userId.trim() === "" || userId !== userId.trim()) {
    throw new TypeError("userId must be a non-empty stable identifier.");
  }

  return db.$transaction(
    async (tx) => {
      const legacyRegistrations = await tx.registration.findMany({
        where: {
          userId,
          match: { engineVersion: "LEGACY", isQuickMatch: false },
        },
        orderBy: { createdAt: "desc" },
        take: MY_MATCH_LIMIT,
        select: {
          createdAt: true,
          match: {
            select: {
              id: true,
              title: true,
              dateTime: true,
              format: true,
              status: true,
              engineVersion: true,
              isQuickMatch: true,
              type: true,
              groupingGeneratedAt: true,
              groupingResult: { select: { payload: true } },
              results: {
                select: {
                  winnerTeamIds: true,
                  loserTeamIds: true,
                  confirmed: true,
                  score: true,
                  createdAt: true,
                  resultVerifiedAt: true,
                },
              },
            },
          },
        },
      });

      const v2Entries = await tx.matchEntry.findMany({
        where: {
          status: "ACTIVE",
          members: {
            some: { userId, status: "ACTIVE", effectiveUntil: null },
          },
          match: {
            engineVersion: "V2",
            isQuickMatch: false,
          },
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          kind: true,
          status: true,
          createdAt: true,
          members: {
            orderBy: [
              { rosterVersion: "asc" },
              { slot: "asc" },
              { id: "asc" },
            ],
            select: {
              id: true,
              userId: true,
              displayNameSnapshot: true,
              role: true,
              status: true,
              slot: true,
              rosterVersion: true,
              effectiveFrom: true,
              effectiveUntil: true,
            },
          },
          match: {
            select: {
              id: true,
              title: true,
              dateTime: true,
              status: true,
              engineVersion: true,
              isQuickMatch: true,
              type: true,
              format: true,
              groupingGeneratedAt: true,
              teamMinMembers: true,
              teamMaxMembers: true,
              qualificationSnapshots: {
                orderBy: { id: "asc" },
                select: { id: true },
              },
              fixtures: {
                select: HOME_V2_FIXTURE_SELECT,
              },
            },
          },
        },
      });

      const legacyRecentResults = await tx.matchResult.findMany({
        where: {
          confirmed: true,
          OR: [
            { winnerTeamIds: { has: userId } },
            { loserTeamIds: { has: userId } },
          ],
          match: { engineVersion: "LEGACY", isQuickMatch: false },
        },
        orderBy: { resultVerifiedAt: "desc" },
        take: RESULT_QUERY_LIMIT,
        select: {
          id: true,
          matchId: true,
          winnerTeamIds: true,
          loserTeamIds: true,
          score: true,
          resultVerifiedAt: true,
          createdAt: true,
          eloHistory: {
            where: { userId },
            orderBy: { createdAt: "desc" },
            take: 2,
            select: { eloBefore: true, eloAfter: true, delta: true },
          },
        },
      });
      const legacyOpponentIds = Array.from(
        new Set(
          legacyRecentResults.flatMap((result) => {
            const isWin = result.winnerTeamIds.includes(userId);
            return isWin ? result.loserTeamIds : result.winnerTeamIds;
          }),
        ),
      );
      const legacyOpponentRows =
        legacyOpponentIds.length === 0
          ? []
          : await tx.user.findMany({
              where: { id: { in: legacyOpponentIds } },
              select: { id: true, nickname: true },
            });

      const v2RecentRevisions = await tx.resultRevision.findMany({
        where: {
          status: "CONFIRMED",
          fixture: {
            match: {
              engineVersion: "V2",
              isQuickMatch: false,
            },
            lineupMembers: { some: { entryMember: { userId } } },
          },
        },
        orderBy: [{ resolvedAt: "desc" }, { id: "asc" }],
        take: RESULT_QUERY_LIMIT,
        select: {
          id: true,
          matchId: true,
          revisionNumber: true,
          status: true,
          resolutionKind: true,
          winnerEntryId: true,
          loserEntryId: true,
          score: true,
          reportedById: true,
          supersedesRevisionId: true,
          reason: true,
          resolvedAt: true,
          createdAt: true,
          fixture: {
            select: HOME_V2_FIXTURE_SELECT,
          },
        },
      });

      const legacyPendingResultCount = 0;
      const v2PendingRevisions = await tx.resultRevision.findMany({
        where: {
          status: "PENDING",
          reportedById: { not: userId },
          supersedesRevisionId: null,
          fixture: {
            match: {
              engineVersion: "V2",
              isQuickMatch: false,
            },
            lineupMembers: { some: { entryMember: { userId } } },
          },
        },
        select: {
          id: true,
          revisionNumber: true,
          status: true,
          resolutionKind: true,
          winnerEntryId: true,
          loserEntryId: true,
          score: true,
          reportedById: true,
          supersedesRevisionId: true,
          reason: true,
          resolvedAt: true,
          createdAt: true,
          fixture: {
            select: HOME_V2_FIXTURE_SELECT,
          },
        },
      });

      return buildHomeUserCompetitionProjection({
        userId,
        legacyRegistrations: legacyRegistrations.map(item => ({ ...item, match: { ...item.match, status: "finished" as const } })),
        v2Entries,
        legacyRecentResults,
        legacyOpponentNames: new Map(
          legacyOpponentRows.map((user) => [user.id, user.nickname] as const),
        ),
        v2RecentRevisions,
        legacyPendingResultCount,
        v2PendingRevisions,
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
