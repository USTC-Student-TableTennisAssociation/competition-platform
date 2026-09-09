export type V2StandingsMatchType = "single" | "double" | "team";

export type V2StandingsEntry = Readonly<{
  entryId: string;
  position: number;
  globalSeedRank: number;
  seedElo: number;
  eligible: boolean;
  ineligibilityReason?: string;
}>;

export type V2StandingsConfirmedRevision = Readonly<{
  revisionId: string;
  resolutionKind: "PLAYED" | "FORFEIT";
  winnerEntryId: string;
  loserEntryId: string;
  score: unknown;
}>;

export type V2StandingsFixture = Readonly<{
  fixtureId: string;
  status: "SCHEDULED" | "READY" | "COMPLETED" | "VOIDED";
  sideAEntryId: string;
  sideBEntryId: string;
  pendingRevisionIds: readonly string[];
  confirmedRevision: V2StandingsConfirmedRevision | null;
}>;

export type V2StandingsGroup = Readonly<{
  groupId: string;
  position: number;
  entries: readonly V2StandingsEntry[];
  fixtures: readonly V2StandingsFixture[];
}>;

export type EvaluateV2QualificationInput = Readonly<{
  matchType: V2StandingsMatchType;
  qualifiersPerGroup: number;
  groups: readonly V2StandingsGroup[];
}>;

export type V2QualificationStanding = Readonly<{
  groupId: string;
  entryId: string;
  rank: number;
  played: number;
  wins: number;
  losses: number;
  scoreFor: number;
  scoreAgainst: number;
  scoreDifferential: number;
  qualified: boolean;
  qualificationOrder: number | null;
  ineligibilityReason: string | null;
}>;

export type V2QualificationEvaluation = Readonly<{
  standings: readonly V2QualificationStanding[];
  qualificationCount: number;
  /** Stable, unhashed source material for the persisted SHA-256 fingerprint. */
  sourceFingerprintPayload: string;
}>;

export type V2GroupStandingsErrorCode =
  | "INVALID_INPUT"
  | "INTEGRITY_ERROR"
  | "QUALIFICATION_NOT_READY";

export class V2GroupStandingsError extends Error {
  readonly code: V2GroupStandingsErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: V2GroupStandingsErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "V2GroupStandingsError";
    this.code = code;
    this.details = details;
  }
}

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
export const V2_MAX_QUALIFICATION_ENTRY_COUNT = 1_024;
/**
 * One Entry can play at most 1,023 group opponents. Keeping every individual
 * score at or below this bound guarantees that persisted score totals and
 * differentials still fit PostgreSQL INTEGER at the supported 1,024-Entry
 * competition limit.
 */
export const V2_MAX_TEAM_SCORE_PER_FIXTURE = Math.floor(
  INT32_MAX / (V2_MAX_QUALIFICATION_ENTRY_COUNT - 1),
);

export function isCanonicalV2BestOfScoreText(
  value: unknown,
  bestOf: 3 | 5 | 7,
  winnerScore: number,
  loserScore: number,
) {
  return (
    value === `${winnerScore}:${loserScore}` ||
    value === `${winnerScore}:${loserScore}（${bestOf}局${winnerScore}胜）`
  );
}

function fail(
  code: V2GroupStandingsErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new V2GroupStandingsError(code, message, details);
}

function assertIdentifier(value: unknown, name: string): asserts value is string {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 191 &&
    value === value.trim()
  ) {
    return;
  }
  fail("INVALID_INPUT", `${name} must be a stable identifier.`, { name });
}

function assertPositiveInteger(value: unknown, name: string): asserts value is number {
  if (Number.isSafeInteger(value) && typeof value === "number" && value >= 1) {
    return;
  }
  fail("INVALID_INPUT", `${name} must be a positive integer.`, { name, value });
}

function assertInt32(value: unknown, name: string): asserts value is number {
  if (
    Number.isSafeInteger(value) &&
    typeof value === "number" &&
    value >= INT32_MIN &&
    value <= INT32_MAX
  ) {
    return;
  }
  fail("INVALID_INPUT", `${name} must fit a PostgreSQL integer.`, { name, value });
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function pairKey(left: string, right: string) {
  return left < right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function compareIdentifiers(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalPlayedScore(
  matchType: V2StandingsMatchType,
  score: unknown,
): Readonly<{ winnerScore: number; loserScore: number }> {
  if (score === null || typeof score !== "object" || Array.isArray(score)) {
    fail("INTEGRITY_ERROR", "A played result has an invalid score payload.");
  }
  const value = score as Record<string, unknown>;
  const keys = Object.keys(value).sort().join("\u0000");
  const expectedKeys =
    matchType === "team"
      ? "loserScore\u0000winnerScore"
      : "bestOf\u0000loserScore\u0000winnerScore";
  const expectedKeysWithText = "bestOf\u0000loserScore\u0000text\u0000winnerScore";
  if (keys !== expectedKeys && (matchType === "team" || keys !== expectedKeysWithText)) {
    fail("INTEGRITY_ERROR", "A played result has an unsupported score shape.");
  }
  const winnerScore = value.winnerScore;
  const loserScore = value.loserScore;
  if (
    !Number.isSafeInteger(winnerScore) ||
    typeof winnerScore !== "number" ||
    winnerScore < 0 ||
    winnerScore >
      (matchType === "team" ? V2_MAX_TEAM_SCORE_PER_FIXTURE : INT32_MAX) ||
    !Number.isSafeInteger(loserScore) ||
    typeof loserScore !== "number" ||
    loserScore < 0 ||
    loserScore >
      (matchType === "team" ? V2_MAX_TEAM_SCORE_PER_FIXTURE : INT32_MAX)
  ) {
    fail("INTEGRITY_ERROR", "A played result has invalid score totals.");
  }
  if (matchType === "team") {
    if (winnerScore > loserScore) return { winnerScore, loserScore };
    fail("INTEGRITY_ERROR", "A played team result does not identify a winning score.");
  }
  const bestOf = value.bestOf;
  if (bestOf !== 3 && bestOf !== 5 && bestOf !== 7) {
    fail("INTEGRITY_ERROR", "A played result has an invalid best-of value.");
  }
  const winsNeeded = (bestOf + 1) / 2;
  if (winnerScore === winsNeeded && loserScore < winsNeeded) {
    if (
      "text" in value &&
      !isCanonicalV2BestOfScoreText(
        value.text,
        bestOf,
        winnerScore,
        loserScore,
      )
    ) {
      fail("INTEGRITY_ERROR", "A played result has a non-canonical score label.");
    }
    return { winnerScore, loserScore };
  }
  fail("INTEGRITY_ERROR", "A played result score contradicts its winner.");
}

type MutableStanding = {
  groupId: string;
  entry: V2StandingsEntry;
  played: number;
  wins: number;
  losses: number;
  scoreFor: bigint;
  scoreAgainst: bigint;
};

function toDatabaseInteger(value: bigint, name: string, entryId: string) {
  if (value < BigInt(INT32_MIN) || value > BigInt(INT32_MAX)) {
    fail("INTEGRITY_ERROR", `${name} exceeds the database integer range.`, {
      entryId,
    });
  }
  return Number(value);
}

function normalizeReason(entry: V2StandingsEntry) {
  if (entry.eligible) {
    if (entry.ineligibilityReason !== undefined) {
      fail(
        "INTEGRITY_ERROR",
        "An eligible Entry cannot carry an ineligibility reason.",
        { entryId: entry.entryId },
      );
    }
    return null;
  }
  const reason = entry.ineligibilityReason?.trim();
  if (!reason || reason.length > 500) {
    fail(
      "INTEGRITY_ERROR",
      "An ineligible Entry requires a bounded reason.",
      { entryId: entry.entryId },
    );
  }
  return reason;
}

function validateRevision(
  fixture: V2StandingsFixture,
  matchType: V2StandingsMatchType,
) {
  const revision = fixture.confirmedRevision;
  if (!revision) {
    fail(
      "QUALIFICATION_NOT_READY",
      "Every eligible pairing requires a current confirmed result.",
      { fixtureId: fixture.fixtureId },
    );
  }
  assertIdentifier(revision.revisionId, "revisionId");
  if (
    revision.winnerEntryId === revision.loserEntryId ||
    pairKey(revision.winnerEntryId, revision.loserEntryId) !==
      pairKey(fixture.sideAEntryId, fixture.sideBEntryId)
  ) {
    fail("INTEGRITY_ERROR", "A confirmed result does not match its fixture sides.", {
      fixtureId: fixture.fixtureId,
      revisionId: revision.revisionId,
    });
  }
  if (revision.resolutionKind === "FORFEIT") {
    return { revision, winnerScore: 1, loserScore: 0 } as const;
  }
  if (revision.resolutionKind !== "PLAYED") {
    fail("INTEGRITY_ERROR", "A confirmed result has an unknown resolution kind.", {
      fixtureId: fixture.fixtureId,
    });
  }
  return { revision, ...canonicalPlayedScore(matchType, revision.score) } as const;
}

/**
 * Evaluates one immutable qualification snapshot from relational group facts.
 *
 * Ineligible Entries remain in the snapshot for auditability, but matches
 * involving them do not affect an eligible Entry's ranking. Every active
 * pairing must have a sole current CONFIRMED result and no PENDING revision.
 * FORFEIT counts as a deterministic 1:0 competition win/loss. The later
 * settlement layer deliberately keeps global Elo/points/stat deltas at zero.
 */
export function evaluateV2GroupQualification(
  input: EvaluateV2QualificationInput,
): V2QualificationEvaluation {
  if (
    input.matchType !== "single" &&
    input.matchType !== "double" &&
    input.matchType !== "team"
  ) {
    fail("INVALID_INPUT", "The match type is not supported.");
  }
  assertPositiveInteger(input.qualifiersPerGroup, "qualifiersPerGroup");
  if (!Array.isArray(input.groups) || input.groups.length === 0) {
    fail("INVALID_INPUT", "At least one published group is required.");
  }

  const sortedGroups = [...input.groups].sort(
    (left, right) => left.position - right.position || compareIdentifiers(left.groupId, right.groupId),
  );
  const groupIds = new Set<string>();
  const allEntryIds = new Set<string>();
  const allGlobalSeedRanks = new Set<number>();
  const allFixtureIds = new Set<string>();
  const qualifiedByRankAndGroup: Array<{
    groupPosition: number;
    rank: number;
    standing: V2QualificationStanding;
  }> = [];
  const allStandings: V2QualificationStanding[] = [];
  const fingerprintFixtures: unknown[] = [];

  for (let groupIndex = 0; groupIndex < sortedGroups.length; groupIndex += 1) {
    const group = sortedGroups[groupIndex];
    assertIdentifier(group.groupId, "groupId");
    assertPositiveInteger(group.position, "group.position");
    if (group.position !== groupIndex + 1 || groupIds.has(group.groupId)) {
      fail("INTEGRITY_ERROR", "Published group positions and IDs must be unique and contiguous.", {
        groupId: group.groupId,
      });
    }
    groupIds.add(group.groupId);
    if (!Array.isArray(group.entries) || group.entries.length < 2) {
      fail("INTEGRITY_ERROR", "Every published group requires at least two Entries.", {
        groupId: group.groupId,
      });
    }
    const entries = [...group.entries].sort(
      (left, right) => left.position - right.position || compareIdentifiers(left.entryId, right.entryId),
    );
    const entriesById = new Map<string, V2StandingsEntry>();
    const reasonByEntryId = new Map<string, string | null>();
    for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
      const entry = entries[entryIndex];
      assertIdentifier(entry.entryId, "entryId");
      assertPositiveInteger(entry.position, "entry.position");
      assertPositiveInteger(entry.globalSeedRank, "entry.globalSeedRank");
      assertInt32(entry.seedElo, "entry.seedElo");
      if (allEntryIds.size >= V2_MAX_QUALIFICATION_ENTRY_COUNT) {
        fail("INTEGRITY_ERROR", "The competition exceeds the supported Entry limit.", {
          entryLimit: V2_MAX_QUALIFICATION_ENTRY_COUNT,
        });
      }
      if (
        entry.position !== entryIndex + 1 ||
        entriesById.has(entry.entryId) ||
        allEntryIds.has(entry.entryId)
      ) {
        fail("INTEGRITY_ERROR", "Each Entry must occupy one unique group position.", {
          groupId: group.groupId,
          entryId: entry.entryId,
        });
      }
      if (allGlobalSeedRanks.has(entry.globalSeedRank)) {
        fail("INTEGRITY_ERROR", "Published global seed ranks must be unique.", {
          groupId: group.groupId,
          entryId: entry.entryId,
          globalSeedRank: entry.globalSeedRank,
        });
      }
      entriesById.set(entry.entryId, entry);
      allEntryIds.add(entry.entryId);
      allGlobalSeedRanks.add(entry.globalSeedRank);
      reasonByEntryId.set(entry.entryId, normalizeReason(entry));
    }
    const eligibleEntries = entries.filter((entry) => entry.eligible);
    if (eligibleEntries.length < input.qualifiersPerGroup) {
      fail(
        "QUALIFICATION_NOT_READY",
        "A group does not contain enough eligible Entries for the configured qualifiers.",
        {
          groupId: group.groupId,
          eligibleCount: eligibleEntries.length,
          qualifiersPerGroup: input.qualifiersPerGroup,
        },
      );
    }

    const expectedPairCount = (entries.length * (entries.length - 1)) / 2;
    if (!Array.isArray(group.fixtures) || group.fixtures.length !== expectedPairCount) {
      fail("INTEGRITY_ERROR", "The group does not contain a complete round-robin fixture set.", {
        groupId: group.groupId,
        expectedFixtureCount: expectedPairCount,
        actualFixtureCount: group.fixtures?.length,
      });
    }
    const fixturesByPair = new Map<string, V2StandingsFixture>();
    for (const fixture of group.fixtures) {
      assertIdentifier(fixture.fixtureId, "fixtureId");
      assertIdentifier(fixture.sideAEntryId, "sideAEntryId");
      assertIdentifier(fixture.sideBEntryId, "sideBEntryId");
      if (
        fixture.status !== "SCHEDULED" &&
        fixture.status !== "READY" &&
        fixture.status !== "COMPLETED" &&
        fixture.status !== "VOIDED"
      ) {
        fail("INTEGRITY_ERROR", "A group fixture has an unknown status.", {
          groupId: group.groupId,
          fixtureId: fixture.fixtureId,
          status: fixture.status,
        });
      }
      if (
        fixture.sideAEntryId === fixture.sideBEntryId ||
        !entriesById.has(fixture.sideAEntryId) ||
        !entriesById.has(fixture.sideBEntryId) ||
        allFixtureIds.has(fixture.fixtureId)
      ) {
        fail("INTEGRITY_ERROR", "A group fixture has invalid or duplicate identities.", {
          groupId: group.groupId,
          fixtureId: fixture.fixtureId,
        });
      }
      allFixtureIds.add(fixture.fixtureId);
      const key = pairKey(fixture.sideAEntryId, fixture.sideBEntryId);
      if (fixturesByPair.has(key)) {
        fail("INTEGRITY_ERROR", "A group contains duplicate fixtures for one pairing.", {
          groupId: group.groupId,
          fixtureId: fixture.fixtureId,
        });
      }
      fixturesByPair.set(key, fixture);
      if (!Array.isArray(fixture.pendingRevisionIds)) {
        fail("INTEGRITY_ERROR", "A fixture pending revision set is invalid.", {
          fixtureId: fixture.fixtureId,
        });
      }
      const pendingIds = new Set<string>();
      for (const revisionId of fixture.pendingRevisionIds) {
        assertIdentifier(revisionId, "pendingRevisionId");
        if (pendingIds.has(revisionId)) {
          fail("INTEGRITY_ERROR", "A fixture contains duplicate pending revision identities.", {
            fixtureId: fixture.fixtureId,
          });
        }
        pendingIds.add(revisionId);
      }
      if (pendingIds.size > 0) {
        fail(
          "QUALIFICATION_NOT_READY",
          "Qualification cannot freeze while a result revision is pending.",
          { fixtureId: fixture.fixtureId, pendingRevisionIds: [...pendingIds].sort() },
        );
      }
      if (
        fixture.status !== "SCHEDULED" &&
        fixture.status !== "READY" &&
        fixture.status !== "COMPLETED" &&
        fixture.status !== "VOIDED"
      ) {
        fail("INTEGRITY_ERROR", "A group fixture has an unknown status.", {
          fixtureId: fixture.fixtureId,
          status: fixture.status,
        });
      }
      if (fixture.status === "SCHEDULED" || fixture.status === "READY") {
        fail("QUALIFICATION_NOT_READY", "Every group fixture must be terminal.", {
          fixtureId: fixture.fixtureId,
          status: fixture.status,
        });
      }
      const sideAEligible = entriesById.get(fixture.sideAEntryId)!.eligible;
      const sideBEligible = entriesById.get(fixture.sideBEntryId)!.eligible;
      if (sideAEligible && sideBEligible) {
        if (fixture.status !== "COMPLETED") {
          fail(
            "QUALIFICATION_NOT_READY",
            "A fixture between eligible Entries must be completed.",
            { fixtureId: fixture.fixtureId, status: fixture.status },
          );
        }
        validateRevision(fixture, input.matchType);
      } else if (fixture.status === "VOIDED" && fixture.confirmedRevision !== null) {
        fail(
          "INTEGRITY_ERROR",
          "A voided fixture cannot retain a current confirmed revision.",
          { fixtureId: fixture.fixtureId },
        );
      } else if (fixture.status === "COMPLETED") {
        validateRevision(fixture, input.matchType);
      }
      fingerprintFixtures.push({
        groupId: group.groupId,
        fixtureId: fixture.fixtureId,
        status: fixture.status,
        sideAEntryId: fixture.sideAEntryId,
        sideBEntryId: fixture.sideBEntryId,
        confirmedRevision: fixture.confirmedRevision,
      });
    }
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        if (!fixturesByPair.has(pairKey(entries[left].entryId, entries[right].entryId))) {
          fail("INTEGRITY_ERROR", "The group is missing a published pairing.", {
            groupId: group.groupId,
            leftEntryId: entries[left].entryId,
            rightEntryId: entries[right].entryId,
          });
        }
      }
    }

    const mutableById = new Map<string, MutableStanding>(
      eligibleEntries.map((entry) => [
        entry.entryId,
        {
          groupId: group.groupId,
          entry,
          played: 0,
          wins: 0,
          losses: 0,
          scoreFor: BigInt(0),
          scoreAgainst: BigInt(0),
        },
      ]),
    );
    for (const fixture of group.fixtures) {
      const winner = fixture.confirmedRevision?.winnerEntryId;
      const loser = fixture.confirmedRevision?.loserEntryId;
      if (!winner || !loser || !mutableById.has(winner) || !mutableById.has(loser)) {
        continue;
      }
      const resolved = validateRevision(fixture, input.matchType);
      const winnerStanding = mutableById.get(winner)!;
      const loserStanding = mutableById.get(loser)!;
      winnerStanding.played += 1;
      winnerStanding.wins += 1;
      loserStanding.played += 1;
      loserStanding.losses += 1;
      winnerStanding.scoreFor += BigInt(resolved.winnerScore);
      winnerStanding.scoreAgainst += BigInt(resolved.loserScore);
      loserStanding.scoreFor += BigInt(resolved.loserScore);
      loserStanding.scoreAgainst += BigInt(resolved.winnerScore);
    }
    const rankedEligible = [...mutableById.values()].sort((left, right) => {
      const leftDiff = left.scoreFor - left.scoreAgainst;
      const rightDiff = right.scoreFor - right.scoreAgainst;
      return (
        right.wins - left.wins ||
        (rightDiff > leftDiff ? 1 : rightDiff < leftDiff ? -1 : 0) ||
        (right.scoreFor > left.scoreFor ? 1 : right.scoreFor < left.scoreFor ? -1 : 0) ||
        right.entry.seedElo - left.entry.seedElo ||
        compareIdentifiers(left.entry.entryId, right.entry.entryId)
      );
    });
    const groupStandings: V2QualificationStanding[] = rankedEligible.map(
      (standing, index) => {
        const scoreFor = toDatabaseInteger(
          standing.scoreFor,
          "scoreFor",
          standing.entry.entryId,
        );
        const scoreAgainst = toDatabaseInteger(
          standing.scoreAgainst,
          "scoreAgainst",
          standing.entry.entryId,
        );
        const scoreDifferential = toDatabaseInteger(
          standing.scoreFor - standing.scoreAgainst,
          "scoreDifferential",
          standing.entry.entryId,
        );
        const qualified = index < input.qualifiersPerGroup;
        const row: V2QualificationStanding = {
          groupId: group.groupId,
          entryId: standing.entry.entryId,
          rank: index + 1,
          played: standing.played,
          wins: standing.wins,
          losses: standing.losses,
          scoreFor,
          scoreAgainst,
          scoreDifferential,
          qualified,
          qualificationOrder: null,
          ineligibilityReason: null,
        };
        if (qualified) {
          qualifiedByRankAndGroup.push({
            groupPosition: group.position,
            rank: row.rank,
            standing: row,
          });
        }
        return row;
      },
    );
    const ineligibleRows = entries
      .filter((entry) => !entry.eligible)
      .sort(
        (left, right) => left.position - right.position || compareIdentifiers(left.entryId, right.entryId),
      )
      .map<V2QualificationStanding>((entry, index) => ({
        groupId: group.groupId,
        entryId: entry.entryId,
        rank: rankedEligible.length + index + 1,
        played: 0,
        wins: 0,
        losses: 0,
        scoreFor: 0,
        scoreAgainst: 0,
        scoreDifferential: 0,
        qualified: false,
        qualificationOrder: null,
        ineligibilityReason: reasonByEntryId.get(entry.entryId)!,
      }));
    allStandings.push(...groupStandings, ...ineligibleRows);
  }

  const orderedSeedRanks = [...allGlobalSeedRanks].sort((left, right) => left - right);
  if (orderedSeedRanks.some((rank, index) => rank !== index + 1)) {
    fail("INTEGRITY_ERROR", "Published global seed ranks must be contiguous.", {
      globalSeedRanks: orderedSeedRanks,
    });
  }
  qualifiedByRankAndGroup.sort(
    (left, right) =>
      left.rank - right.rank ||
      left.groupPosition - right.groupPosition ||
      compareIdentifiers(left.standing.entryId, right.standing.entryId),
  );
  const qualificationOrderByEntryId = new Map(
    qualifiedByRankAndGroup.map((item, index) => [item.standing.entryId, index + 1]),
  );
  const standings = allStandings.map((standing) => ({
    ...standing,
    qualificationOrder: standing.qualified
      ? qualificationOrderByEntryId.get(standing.entryId)!
      : null,
  }));
  fingerprintFixtures.sort((left, right) => {
    const leftValue = left as { fixtureId: string };
    const rightValue = right as { fixtureId: string };
    return compareIdentifiers(leftValue.fixtureId, rightValue.fixtureId);
  });
  return {
    standings,
    qualificationCount: qualifiedByRankAndGroup.length,
    sourceFingerprintPayload: stableJson({
      policyVersion: 1,
      matchType: input.matchType,
      qualifiersPerGroup: input.qualifiersPerGroup,
      entries: sortedGroups.flatMap((group) =>
        [...group.entries]
          .sort((left, right) => left.position - right.position)
          .map((entry) => ({
            groupId: group.groupId,
            entryId: entry.entryId,
            position: entry.position,
            globalSeedRank: entry.globalSeedRank,
            seedElo: entry.seedElo,
            eligible: entry.eligible,
            ineligibilityReason: entry.eligible
              ? null
              : entry.ineligibilityReason?.trim(),
          })),
      ),
      fixtures: fingerprintFixtures,
    }),
  };
}
