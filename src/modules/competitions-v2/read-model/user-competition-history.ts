import { Prisma, type PrismaClient } from "@prisma/client";

import {
  buildAuthoritativeV2Result,
  HOME_V2_FIXTURE_SELECT,
  V2HomeUserCompetitionIntegrityError,
  type V2AuthoritativeResultSource,
} from "./home-user-competition";

const PROFILE_V2_FIXTURE_SELECT =
  Prisma.validator<Prisma.MatchFixtureSelect>()({
    ...HOME_V2_FIXTURE_SELECT,
    match: {
      select: {
        id: true,
        title: true,
        dateTime: true,
        engineVersion: true,
        isQuickMatch: true,
        type: true,
        format: true,
        teamMinMembers: true,
        teamMaxMembers: true,
      },
    },
  });

export type LegacyCompetitionHistorySource = Readonly<{
  id: string;
  matchId: string;
  confirmed: boolean;
  winnerTeamIds: readonly string[];
  loserTeamIds: readonly string[];
  score: unknown;
  resultVerifiedAt: Date | null;
  createdAt: Date;
  match: Readonly<{
    id: string;
    title: string;
    dateTime: Date;
    engineVersion: "LEGACY" | "V2";
  }>;
}>;

type ProfileV2FixtureSource = V2AuthoritativeResultSource["fixture"] &
  Readonly<{
    match: V2AuthoritativeResultSource["fixture"]["match"] &
      Readonly<{
        id: string;
        title: string;
        dateTime: Date;
      }>;
  }>;

export type V2CompetitionHistorySource = Omit<
  V2AuthoritativeResultSource,
  "fixture"
> &
  Readonly<{ fixture: ProfileV2FixtureSource }>;

export type UserCompetitionHistoryItem = Readonly<{
  id: string;
  matchId: string;
  matchTitle: string;
  matchDateTime: Date;
  opponentLabel: string;
  scoreText: string;
  isWin: boolean;
}>;

export type LegacyCompetitionHistoryOrder = "createdAt" | "verifiedAt";

type HistoryCandidate = Readonly<{
  item: UserCompetitionHistoryItem;
  occurredAt: Date;
  userEntryId: string | null;
}>;

function parseLegacyScoreText(score: unknown) {
  if (typeof score === "string") return score;
  if (
    typeof score === "object" &&
    score !== null &&
    !Array.isArray(score) &&
    "text" in score
  ) {
    return String(score.text ?? "");
  }
  return "";
}

function buildLegacyHistoryCandidate(
  result: LegacyCompetitionHistorySource,
  userId: string,
  opponentNames: ReadonlyMap<string, string>,
  order: LegacyCompetitionHistoryOrder,
): HistoryCandidate | null {
  if (
    !result.confirmed ||
    result.match.engineVersion !== "LEGACY" ||
    result.match.id !== result.matchId
  ) {
    return null;
  }

  const isWin = result.winnerTeamIds.includes(userId);
  const isLoss = result.loserTeamIds.includes(userId);
  if (isWin === isLoss) return null;

  const opponentIds = isWin ? result.loserTeamIds : result.winnerTeamIds;
  const opponentLabel =
    opponentIds.map((id) => opponentNames.get(id) ?? id).join(" / ") ||
    "未知对手";

  return {
    userEntryId: null,
    item: {
      id: result.id,
      matchId: result.matchId,
      matchTitle: result.match.title,
      matchDateTime: result.match.dateTime,
      opponentLabel,
      scoreText: parseLegacyScoreText(result.score),
      isWin,
    },
    occurredAt:
      order === "createdAt"
        ? result.createdAt
        : (result.resultVerifiedAt ?? result.createdAt),
  };
}

function buildV2HistoryCandidate(
  revision: V2CompetitionHistorySource,
  userId: string,
): HistoryCandidate | null {
  const authoritative = buildAuthoritativeV2Result(revision, userId);
  const match = revision.fixture.match;
  if (!authoritative) return null;
  if (match.id !== revision.matchId) {
    throw new V2HomeUserCompetitionIntegrityError(
      "A V2 history result is joined to the wrong Match.",
      revision.id,
    );
  }

  return {
    userEntryId: authoritative.userEntryId,
    item: {
      id: authoritative.id,
      matchId: authoritative.matchId,
      matchTitle: match.title,
      matchDateTime: match.dateTime,
      opponentLabel: authoritative.opponentLabel,
      scoreText: authoritative.scoreText,
      isWin: authoritative.isWin,
    },
    occurredAt: authoritative.occurredAt,
  };
}

export function buildUserCompetitionHistory(input: Readonly<{
  userId: string;
  legacyResults: readonly LegacyCompetitionHistorySource[];
  legacyOpponentNames: ReadonlyMap<string, string>;
  v2Revisions: readonly V2CompetitionHistorySource[];
  legacyOrder: LegacyCompetitionHistoryOrder;
  limit?: number;
}>): readonly UserCompetitionHistoryItem[] {
  if (input.userId.trim() === "" || input.userId !== input.userId.trim()) {
    throw new TypeError("userId must be a non-empty stable identifier.");
  }
  if (
    input.limit !== undefined &&
    (!Number.isSafeInteger(input.limit) || input.limit < 0)
  ) {
    throw new TypeError("limit must be a non-negative safe integer.");
  }

  const v2EntriesByMatch = new Map<string, string>();
  const v2Candidates = input.v2Revisions
    .map((revision) => buildV2HistoryCandidate(revision, input.userId))
    .filter((candidate): candidate is HistoryCandidate => candidate !== null)
    .map((candidate) => {
      const userEntryId = candidate.userEntryId;
      if (userEntryId === null) {
        throw new TypeError("A V2 history candidate must retain its frozen Entry.");
      }
      const prior = v2EntriesByMatch.get(candidate.item.matchId);
      if (prior !== undefined && prior !== userEntryId) {
        throw new V2HomeUserCompetitionIntegrityError(
          "A user's V2 history spans multiple Entries in one Match.",
          candidate.item.matchId,
        );
      }
      v2EntriesByMatch.set(candidate.item.matchId, userEntryId);
      return candidate;
    });
  const candidates = [
    ...input.legacyResults
      .map((result) =>
        buildLegacyHistoryCandidate(
          result,
          input.userId,
          input.legacyOpponentNames,
          input.legacyOrder,
        ),
      )
      .filter(
        (candidate): candidate is HistoryCandidate => candidate !== null,
      ),
    ...v2Candidates,
  ].sort(
    (left, right) =>
      right.occurredAt.getTime() - left.occurredAt.getTime() ||
      left.item.id.localeCompare(right.item.id),
  );

  return (input.limit === undefined
    ? candidates
    : candidates.slice(0, input.limit)
  ).map(({ item }) => item);
}

export function combineTermRegistrationCounts(input: Readonly<{
  legacyFormalRegistrations: number;
  v2ActivatedEntries: number;
}>) {
  if (
    !Number.isSafeInteger(input.legacyFormalRegistrations) ||
    input.legacyFormalRegistrations < 0 ||
    !Number.isSafeInteger(input.v2ActivatedEntries) ||
    input.v2ActivatedEntries < 0
  ) {
    throw new TypeError("registration counts must be non-negative integers.");
  }
  return input.legacyFormalRegistrations + input.v2ActivatedEntries;
}

type V2RegistrationEventSource = Readonly<{
  id: string;
  status: "APPLIED" | "REVERSED" | "PENDING" | "FAILED";
  appliedAt: Date | null;
  matchEntryId: string | null;
  metadata: unknown;
  effects: readonly Readonly<{ userId: string }>[];
  matchEntry: Readonly<{
    id: string;
    kind: "INDIVIDUAL" | "DOUBLES" | "TEAM";
    members: readonly Readonly<{ userId: string; rosterVersion: number }>[];
    match: Readonly<{
      engineVersion: "LEGACY" | "V2";
      isQuickMatch: boolean;
      type: "single" | "double" | "team";
      format: "group_only" | "group_then_knockout";
    }>;
  }> | null;
}>;

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function countV2TermRegistrationEntries(
  events: readonly V2RegistrationEventSource[],
  userId: string,
) {
  const entryIds = new Set<string>();
  for (const event of events) {
    const entry = event.matchEntry;
    if (
      (event.status !== "APPLIED" && event.status !== "REVERSED") ||
      event.appliedAt === null ||
      !Number.isFinite(event.appliedAt.getTime()) ||
      event.matchEntryId === null ||
      entry === null ||
      entry.id !== event.matchEntryId ||
      entry.match.engineVersion !== "V2" ||
      entry.match.isQuickMatch ||
      entry.kind !==
        (entry.match.type === "single"
          ? "INDIVIDUAL"
          : entry.match.type === "double"
            ? "DOUBLES"
            : "TEAM")
    ) {
      throw new Error(
        `V2 registration history integrity violation at event ${event.id}.`,
      );
    }
    const effectMatches = event.effects.filter(
      (effect) => effect.userId === userId,
    );
    if (effectMatches.length > 1) {
      throw new Error(
        `V2 registration history has duplicate user effects at event ${event.id}.`,
      );
    }
    let belongsToUser = effectMatches.length === 1;
    if (!belongsToUser) {
      const rosterVersion = isJsonObject(event.metadata)
        ? event.metadata.rosterVersion
        : null;
      if (
        typeof rosterVersion !== "number" ||
        !Number.isSafeInteger(rosterVersion) ||
        rosterVersion < 1
      ) {
        throw new Error(
          `V2 registration history lacks a frozen roster version at event ${event.id}.`,
        );
      }
      belongsToUser = entry.members.some(
        (member) =>
          member.userId === userId && member.rosterVersion === rosterVersion,
      );
    }
    if (belongsToUser) entryIds.add(entry.id);
  }
  return entryIds.size;
}

export type UserCompetitionHistoryDatabase = Pick<PrismaClient, "$transaction">;

/**
 * Reads profile history from each engine's authoritative result store. Legacy
 * quick matches remain visible as before; formal V2 SINGLE group-only history
 * is reconstructed from the frozen fixture lineup and current CONFIRMED
 * revision only.
 */
export async function getUserCompetitionHistory(
  db: UserCompetitionHistoryDatabase,
  userId: string,
  options: Readonly<{
    legacyOrder: LegacyCompetitionHistoryOrder;
    limit?: number;
  }>,
): Promise<readonly UserCompetitionHistoryItem[]> {
  if (userId.trim() === "" || userId !== userId.trim()) {
    throw new TypeError("userId must be a non-empty stable identifier.");
  }
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) || options.limit < 0)
  ) {
    throw new TypeError("limit must be a non-negative safe integer.");
  }
  if (options.limit === 0) return [];

  const queryLimit =
    options.limit === undefined ? undefined : options.limit * 2;

  return db.$transaction(
    async (tx) => {
      const legacyResults = await tx.matchResult.findMany({
        where: {
          confirmed: true,
          OR: [
            { winnerTeamIds: { has: userId } },
            { loserTeamIds: { has: userId } },
          ],
          match: { engineVersion: "LEGACY" },
        },
        orderBy:
          options.legacyOrder === "createdAt"
            ? [{ createdAt: "desc" }, { id: "asc" }]
            : [
                { resultVerifiedAt: { sort: "desc", nulls: "last" } },
                { createdAt: "desc" },
                { id: "asc" },
              ],
        take: queryLimit,
        select: {
          id: true,
          matchId: true,
          confirmed: true,
          winnerTeamIds: true,
          loserTeamIds: true,
          score: true,
          resultVerifiedAt: true,
          createdAt: true,
          match: {
            select: {
              id: true,
              title: true,
              dateTime: true,
              engineVersion: true,
            },
          },
        },
      });

      const legacyOpponentIds = Array.from(
        new Set(
          legacyResults.flatMap((result) => {
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

      const v2Revisions = await tx.resultRevision.findMany({
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
        take: queryLimit,
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
          fixture: { select: PROFILE_V2_FIXTURE_SELECT },
        },
      });

      return buildUserCompetitionHistory({
        userId,
        legacyResults,
        legacyOpponentNames: new Map(
          legacyOpponentRows.map((user) => [user.id, user.nickname] as const),
        ),
        v2Revisions,
        legacyOrder: options.legacyOrder,
        limit: options.limit,
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/** Counts each engine once; a V2 registration begins only when Entry activates. */
export async function getTermRegistrationCount(
  db: UserCompetitionHistoryDatabase,
  userId: string,
  termStart: Date,
) {
  if (userId.trim() === "" || userId !== userId.trim()) {
    throw new TypeError("userId must be a non-empty stable identifier.");
  }
  if (!Number.isFinite(termStart.getTime())) {
    throw new TypeError("termStart must be a valid date.");
  }

  return db.$transaction(
    async (tx) => {
      const legacyFormalRegistrations = await tx.registration.count({
        where: {
          userId,
          createdAt: { gte: termStart },
          match: { engineVersion: "LEGACY", isQuickMatch: false },
        },
      });
      const v2ActivationEvents = await tx.settlementEvent.findMany({
        where: {
          kind: "REGISTRATION_APPLY",
          status: { in: ["APPLIED", "REVERSED"] },
          appliedAt: { gte: termStart },
          matchEntry: {
            is: {
              match: { engineVersion: "V2", isQuickMatch: false },
            },
          },
          OR: [
            { effects: { some: { userId } } },
            { matchEntry: { is: { members: { some: { userId } } } } },
          ],
        },
        orderBy: [{ appliedAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          status: true,
          appliedAt: true,
          matchEntryId: true,
          metadata: true,
          effects: {
            where: { userId },
            orderBy: { id: "asc" },
            select: { userId: true },
          },
          matchEntry: {
            select: {
              id: true,
              kind: true,
              members: {
                where: { userId },
                orderBy: [
                  { rosterVersion: "asc" },
                  { slot: "asc" },
                  { id: "asc" },
                ],
                select: { userId: true, rosterVersion: true },
              },
              match: {
                select: {
                  engineVersion: true,
                  isQuickMatch: true,
                  type: true,
                  format: true,
                },
              },
            },
          },
        },
      });

      return combineTermRegistrationCounts({
        legacyFormalRegistrations,
        v2ActivatedEntries: countV2TermRegistrationEntries(
          v2ActivationEvents,
          userId,
        ),
      });
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
