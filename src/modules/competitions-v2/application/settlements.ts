import {
  Prisma,
  type MatchEntryKind,
  type MatchEntryStatus,
  type MatchFixture,
  type RegistrationRole,
  type ResultRevision,
  type SettlementEffect,
  type SettlementEvent,
  type User,
} from "@prisma/client";

import {
  settleSinglesElo,
  settleTeamElo,
  type EloDelta,
} from "../../../lib/elo";
import {
  decideSettlementEvent,
  type ResultSettlementEventKind,
} from "../domain";
import { V2ResultApplicationError } from "./results-errors";

const MATCH_POINTS_REFERENCE_PREFIX = "match-points:";
const LEGACY_MATCH_POINTS_CAP = 5;
const LEGACY_RESULT_WIN_REWARD = 1;
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

export type ResultSettlementTransaction = Prisma.TransactionClient;

/**
 * The point rule remains an injected, synchronous function so this slice does
 * not silently fork the legacy reward policy. The adapter must derive its
 * answer only from these locked values and must not perform I/O.
 */
export type ResultPointsPolicy = Readonly<{
  calculateWinnerAward(input: Readonly<{
    userId: string;
    matchId: string;
    resultRevisionId: string;
    currentBalance: number;
    netMatchPoints: number;
  }>): number;
  calculateWinnerReversal(input: Readonly<{
    userId: string;
    matchId: string;
    resultRevisionId: string;
    currentBalance: number;
    netMatchPoints: number;
    originalAward: number;
  }>): number;
}>;

export const legacyCompatibleResultPointsPolicy: ResultPointsPolicy =
  Object.freeze({
    calculateWinnerAward(input) {
      return Math.max(
        0,
        Math.min(
          LEGACY_RESULT_WIN_REWARD,
          LEGACY_MATCH_POINTS_CAP - input.netMatchPoints,
        ),
      );
    },
    calculateWinnerReversal(input) {
      const deduction = Math.min(
        input.originalAward,
        Math.max(0, input.currentBalance),
      );
      return deduction === 0 ? 0 : -deduction;
    },
  });

export type ResultSettlementClock = () => Date;

type SettlementFixture = Pick<
  MatchFixture,
  | "id"
  | "matchId"
  | "sideAEntryId"
  | "sideBEntryId"
  | "sideARosterVersion"
  | "sideBRosterVersion"
>;

type SettlementRevision = Pick<
  ResultRevision,
  | "id"
  | "matchId"
  | "fixtureId"
  | "status"
  | "resolutionKind"
  | "winnerEntryId"
  | "loserEntryId"
  | "supersedesRevisionId"
>;

export type ResultEloAlgorithmInput = Readonly<{
  userId: string;
  eloRating: number;
  matchesPlayed: number;
}>;

export type FrozenRosterSide = Readonly<{
  entryId: string;
  kind: MatchEntryKind;
  status: MatchEntryStatus;
  rosterVersion: number;
  members: readonly Readonly<{
    userId: string;
    role: RegistrationRole;
  }>[];
  userIds: readonly string[];
}>;

export type FrozenFixtureRoster = Readonly<{
  sideA: FrozenRosterSide;
  sideB: FrozenRosterSide;
  allUserIds: readonly string[];
}>;

export type LockedResultUser = Pick<
  User,
  | "id"
  | "role"
  | "isBanned"
  | "emailVerifiedAt"
  | "eloRating"
  | "points"
  | "wins"
  | "losses"
  | "matchesPlayed"
>;

export type SettlementEffectView = Pick<
  SettlementEffect,
  | "id"
  | "eventId"
  | "userId"
  | "eloBefore"
  | "eloAfter"
  | "eloDelta"
  | "pointsBefore"
  | "pointsAfter"
  | "pointsDelta"
  | "winsDelta"
  | "lossesDelta"
  | "matchesPlayedDelta"
>;

export type ResultSettlementOutcome = Readonly<{
  event: SettlementEvent;
  effects: readonly SettlementEffectView[];
  wasNoop: boolean;
}>;

export type ApplyResultSettlementInput = Readonly<{
  resultRevisionId: string;
  pointsPolicy?: ResultPointsPolicy;
  clock?: ResultSettlementClock;
}>;

export type ReverseResultSettlementInput = ApplyResultSettlementInput;

function fail(
  code: ConstructorParameters<typeof V2ResultApplicationError>[0],
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new V2ResultApplicationError(code, message, details);
}

function assertStableIdentifier(value: string, name: string) {
  if (value.trim() !== "" && value === value.trim()) return;
  fail("INVALID_COMMAND", `${name} must be a non-empty stable identifier.`, {
    name,
  });
}

function assertInt32(value: number, name: string, details = {}) {
  if (
    Number.isSafeInteger(value) &&
    value >= INT32_MIN &&
    value <= INT32_MAX
  ) {
    return;
  }
  fail("AGGREGATE_INVARIANT_VIOLATION", `${name} exceeds PostgreSQL Int range.`, {
    ...details,
    value,
  });
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isResultEventKind(
  kind: SettlementEvent["kind"],
): kind is ResultSettlementEventKind {
  return kind === "RESULT_APPLY" || kind === "RESULT_REVERSAL";
}

function assertResultEventSubject(
  event: Pick<SettlementEvent, "id" | "kind" | "resultRevisionId" | "matchEntryId">,
  resultRevisionId: string,
) {
  if (
    isResultEventKind(event.kind) &&
    event.resultRevisionId === resultRevisionId &&
    event.matchEntryId === null
  ) {
    return;
  }
  fail(
    "SETTLEMENT_STATE_CONFLICT",
    "A result settlement event has an invalid or ambiguous subject.",
    { eventId: event.id, resultRevisionId, kind: event.kind },
  );
}

async function lockResultRevision(
  tx: ResultSettlementTransaction,
  resultRevisionId: string,
) {
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "result_revision"
    WHERE "id" = ${resultRevisionId}
    FOR UPDATE
  `);
}

async function lockResultEvents(
  tx: ResultSettlementTransaction,
  resultRevisionId: string,
) {
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "settlement_event"
    WHERE "result_revision_id" = ${resultRevisionId}
      AND "kind" IN ('RESULT_APPLY', 'RESULT_REVERSAL')
    ORDER BY "id"
    FOR UPDATE
  `);
}

export async function lockAndLoadResultUsers(
  tx: ResultSettlementTransaction,
  userIds: readonly string[],
): Promise<readonly LockedResultUser[]> {
  const sortedIds = uniqueSorted(userIds);
  if (sortedIds.length === 0) {
    fail("INVALID_FIXTURE_ROSTER", "A result operation requires at least one user.");
  }

  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "User"
    WHERE "id" IN (${Prisma.join(sortedIds)})
    ORDER BY "id"
    FOR UPDATE
  `);

  const users = await tx.user.findMany({
    where: { id: { in: sortedIds } },
    orderBy: { id: "asc" },
    select: {
      id: true,
      role: true,
      isBanned: true,
      emailVerifiedAt: true,
      eloRating: true,
      points: true,
      wins: true,
      losses: true,
      matchesPlayed: true,
    },
  });

  if (users.length !== sortedIds.length) {
    const foundIds = new Set(users.map((user) => user.id));
    fail("INVALID_FIXTURE_ROSTER", "The fixture roster references a missing user.", {
      missingUserIds: sortedIds.filter((id) => !foundIds.has(id)),
    });
  }

  return users;
}

/**
 * Resolves the whole roster version frozen on the fixture. The lineup table is
 * intentionally not used here: it records who was fielded, while legacy ELO,
 * wins, losses, matches played, and points settle every member of the frozen
 * doubles/team competitor.
 */
export async function resolveFrozenFixtureRoster(
  tx: ResultSettlementTransaction,
  fixture: SettlementFixture,
): Promise<FrozenFixtureRoster> {
  const {
    sideAEntryId,
    sideBEntryId,
    sideARosterVersion,
    sideBRosterVersion,
  } = fixture;

  if (
    sideAEntryId === null ||
    sideBEntryId === null ||
    sideARosterVersion === null ||
    sideBRosterVersion === null ||
    sideAEntryId === sideBEntryId ||
    !Number.isInteger(sideARosterVersion) ||
    sideARosterVersion < 1 ||
    !Number.isInteger(sideBRosterVersion) ||
    sideBRosterVersion < 1
  ) {
    fail(
      "INVALID_FIXTURE_ROSTER",
      "The fixture does not pin two distinct entries and positive roster versions.",
      { fixtureId: fixture.id },
    );
  }

  const [members, entries] = await Promise.all([
    tx.matchEntryMember.findMany({
      where: {
        matchId: fixture.matchId,
        OR: [
          { entryId: sideAEntryId, rosterVersion: sideARosterVersion },
          { entryId: sideBEntryId, rosterVersion: sideBRosterVersion },
        ],
      },
      orderBy: [{ entryId: "asc" }, { slot: "asc" }, { userId: "asc" }],
      select: {
        entryId: true,
        rosterVersion: true,
        userId: true,
        role: true,
      },
    }),
    tx.matchEntry.findMany({
      where: {
        matchId: fixture.matchId,
        id: { in: [sideAEntryId, sideBEntryId] },
      },
      select: { id: true, kind: true, status: true },
    }),
  ]);

  const sideAEntry = entries.find((entry) => entry.id === sideAEntryId);
  const sideBEntry = entries.find((entry) => entry.id === sideBEntryId);
  if (
    sideAEntry === undefined ||
    sideBEntry === undefined ||
    sideAEntry.kind !== sideBEntry.kind
  ) {
    fail(
      "INVALID_FIXTURE_ROSTER",
      "Both fixture entries must exist and use the same competitor kind.",
      { fixtureId: fixture.id },
    );
  }

  const sideAMembers = members
    .filter(
      (member) =>
        member.entryId === sideAEntryId &&
        member.rosterVersion === sideARosterVersion,
    )
    .map((member) => ({ userId: member.userId, role: member.role }));
  const sideBMembers = members
    .filter(
      (member) =>
        member.entryId === sideBEntryId &&
        member.rosterVersion === sideBRosterVersion,
    )
    .map((member) => ({ userId: member.userId, role: member.role }));
  const sideAUserIds = sideAMembers.map((member) => member.userId);
  const sideBUserIds = sideBMembers.map((member) => member.userId);

  if (sideAUserIds.length === 0 || sideBUserIds.length === 0) {
    fail(
      "INVALID_FIXTURE_ROSTER",
      "Each fixture side must resolve to a non-empty frozen roster.",
      {
        fixtureId: fixture.id,
        sideARosterVersion,
        sideBRosterVersion,
      },
    );
  }

  const allUserIds = [...sideAUserIds, ...sideBUserIds];
  if (new Set(allUserIds).size !== allUserIds.length) {
    fail(
      "INVALID_FIXTURE_ROSTER",
      "The same user cannot appear on both fixture sides or twice in one roster.",
      { fixtureId: fixture.id },
    );
  }

  return {
    sideA: {
      entryId: sideAEntryId,
      kind: sideAEntry.kind,
      status: sideAEntry.status,
      rosterVersion: sideARosterVersion,
      members: Object.freeze(sideAMembers),
      userIds: Object.freeze(sideAUserIds),
    },
    sideB: {
      entryId: sideBEntryId,
      kind: sideBEntry.kind,
      status: sideBEntry.status,
      rosterVersion: sideBRosterVersion,
      members: Object.freeze(sideBMembers),
      userIds: Object.freeze(sideBUserIds),
    },
    allUserIds: Object.freeze(uniqueSorted(allUserIds)),
  };
}

/**
 * Verifies the actual fielded lineup without using it as the settlement roster.
 * The first V2 release settles the complete frozen competitor, so each side's
 * lineup must be an exact permutation of the roster version pinned to the
 * fixture. A partial TEAM lineup would otherwise award ELO/points/stats to
 * users who were not represented by the recorded lineup.
 */
export async function assertFixtureLineupMatchesFrozenRoster(
  tx: ResultSettlementTransaction,
  fixture: SettlementFixture,
  roster: FrozenFixtureRoster,
) {
  const lineup = await tx.matchFixtureLineupMember.findMany({
    where: { fixtureId: fixture.id, matchId: fixture.matchId },
    orderBy: [{ side: "asc" }, { position: "asc" }],
    select: {
      side: true,
      position: true,
      entryId: true,
      entryMember: {
        select: { userId: true, rosterVersion: true },
      },
    },
  });
  const sideALineup = lineup.filter((member) => member.side === "SIDE_A");
  const sideBLineup = lineup.filter((member) => member.side === "SIDE_B");
  const sideACount = sideALineup.length;
  const sideBCount = sideBLineup.length;
  const invalid = lineup.find((member) => {
    const expected = member.side === "SIDE_A" ? roster.sideA : roster.sideB;
    return (
      member.entryId !== expected.entryId ||
      member.entryMember.rosterVersion !== expected.rosterVersion ||
      !expected.userIds.includes(member.entryMember.userId)
    );
  });
  const hasExactSide = (
    actual: typeof sideALineup,
    expected: FrozenRosterSide,
  ) => {
    const actualUserIds = actual.map((member) => member.entryMember.userId);
    const expectedUserIds = new Set(expected.userIds);
    return (
      actual.length === expected.userIds.length &&
      new Set(actualUserIds).size === actual.length &&
      actualUserIds.every((userId) => expectedUserIds.has(userId)) &&
      actual.every((member, index) => member.position === index + 1)
    );
  };
  const sideAExact = hasExactSide(sideALineup, roster.sideA);
  const sideBExact = hasExactSide(sideBLineup, roster.sideB);
  if (sideAExact && sideBExact && invalid === undefined) return;

  fail(
    "INVALID_FIXTURE_ROSTER",
    "Both fixture sides need a complete lineup matching their pinned roster version.",
    {
      fixtureId: fixture.id,
      sideACount,
      sideBCount,
      expectedSideACount: roster.sideA.userIds.length,
      expectedSideBCount: roster.sideB.userIds.length,
      sideAExact,
      sideBExact,
      hasInvalidLineupMember: invalid !== undefined,
    },
  );
}

export function assertRosterKindMatchesMatchType(
  matchType: "single" | "double" | "team",
  roster: FrozenFixtureRoster,
) {
  const expectedKind =
    matchType === "single"
      ? "INDIVIDUAL"
      : matchType === "double"
        ? "DOUBLES"
        : "TEAM";
  if (
    roster.sideA.kind === expectedKind &&
    roster.sideB.kind === expectedKind
  ) {
    return;
  }
  fail(
    "INVALID_FIXTURE_ROSTER",
    "The fixture entry kind does not match the match type.",
    {
      matchType,
      sideAKind: roster.sideA.kind,
      sideBKind: roster.sideB.kind,
    },
  );
}

function assertRevisionMatchesFixture(
  revision: SettlementRevision,
  fixture: SettlementFixture,
) {
  const validSides =
    fixture.sideAEntryId !== null &&
    fixture.sideBEntryId !== null &&
    revision.winnerEntryId !== null &&
    revision.loserEntryId !== null &&
    revision.winnerEntryId !== revision.loserEntryId &&
    new Set([revision.winnerEntryId, revision.loserEntryId]).size === 2 &&
    [revision.winnerEntryId, revision.loserEntryId].every(
      (entryId) =>
        entryId === fixture.sideAEntryId || entryId === fixture.sideBEntryId,
    );

  if (
    revision.matchId === fixture.matchId &&
    revision.fixtureId === fixture.id &&
    validSides
  ) {
    return;
  }
  fail(
    "INVALID_RESULT_REVISION",
    "The result winner and loser must be exactly the fixture's two entries.",
    { resultRevisionId: revision.id, fixtureId: fixture.id },
  );
}

async function loadSettlementSubject(
  tx: ResultSettlementTransaction,
  resultRevisionId: string,
) {
  await lockResultRevision(tx, resultRevisionId);

  const revision = await tx.resultRevision.findUnique({
    where: { id: resultRevisionId },
    select: {
      id: true,
      matchId: true,
      fixtureId: true,
      status: true,
      resolutionKind: true,
      winnerEntryId: true,
      loserEntryId: true,
      supersedesRevisionId: true,
      fixture: {
        select: {
          id: true,
          matchId: true,
          sideAEntryId: true,
          sideBEntryId: true,
          sideARosterVersion: true,
          sideBRosterVersion: true,
        },
      },
    },
  });
  if (revision === null) {
    fail("RESULT_REVISION_NOT_FOUND", "The result revision does not exist.", {
      resultRevisionId,
    });
  }

  const match = await tx.match.findUnique({
    where: { id: revision.matchId },
    select: {
      id: true,
      engineVersion: true,
      isQuickMatch: true,
      type: true,
    },
  });
  if (match === null) {
    fail("MATCH_NOT_FOUND", "The result revision's match does not exist.", {
      resultRevisionId,
    });
  }
  if (match.engineVersion !== "V2") {
    fail("ENGINE_MISMATCH", "The V2 settlement service rejects legacy matches.", {
      matchId: match.id,
      engineVersion: match.engineVersion,
    });
  }
  if (match.isQuickMatch) {
    fail("ENGINE_MISMATCH", "Result settlement rejects quick matches.", {
      matchId: match.id,
      engineVersion: match.engineVersion,
      isQuickMatch: true,
    });
  }

  if (revision.resolutionKind !== "PLAYED") {
    fail(
      "SETTLEMENT_STATE_CONFLICT",
      "A forfeit determines competition progression but never changes ELO, points, or win/loss statistics.",
      {
        resultRevisionId: revision.id,
        resolutionKind: revision.resolutionKind,
      },
    );
  }

  assertRevisionMatchesFixture(revision, revision.fixture);
  const roster = await resolveFrozenFixtureRoster(tx, revision.fixture);
  assertRosterKindMatchesMatchType(match.type, roster);
  await lockResultEvents(tx, resultRevisionId);

  return { revision, fixture: revision.fixture, roster };
}

function participantSides(
  revision: SettlementRevision,
  roster: FrozenFixtureRoster,
) {
  if (
    revision.winnerEntryId === null ||
    revision.loserEntryId === null
  ) {
    fail("INVALID_RESULT_REVISION", "A settled result requires both competitors.", {
      resultRevisionId: revision.id,
    });
  }

  const winner =
    revision.winnerEntryId === roster.sideA.entryId
      ? roster.sideA
      : revision.winnerEntryId === roster.sideB.entryId
        ? roster.sideB
        : null;
  const loser =
    revision.loserEntryId === roster.sideA.entryId
      ? roster.sideA
      : revision.loserEntryId === roster.sideB.entryId
        ? roster.sideB
        : null;

  if (winner === null || loser === null || winner.entryId === loser.entryId) {
    fail(
      "INVALID_RESULT_REVISION",
      "The revision participants do not resolve to the frozen fixture roster.",
      { resultRevisionId: revision.id },
    );
  }
  return { winner, loser };
}

async function loadResultEvents(
  tx: ResultSettlementTransaction,
  resultRevisionId: string,
) {
  const events = await tx.settlementEvent.findMany({
    where: {
      resultRevisionId,
      kind: { in: ["RESULT_APPLY", "RESULT_REVERSAL"] },
    },
    orderBy: { id: "asc" },
    include: { effects: { orderBy: { userId: "asc" } } },
  });
  for (const event of events) {
    assertResultEventSubject(event, resultRevisionId);
  }
  return events;
}

function parseAlgorithmInputs(
  metadata: Prisma.JsonValue | null,
  expectedUserIds: readonly string[],
) {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail(
      "SETTLEMENT_STATE_CONFLICT",
      "The predecessor settlement is missing its ELO algorithm inputs.",
    );
  }
  const rawInputs = metadata.algorithmInputs;
  if (!Array.isArray(rawInputs)) {
    fail(
      "SETTLEMENT_STATE_CONFLICT",
      "The predecessor settlement has invalid ELO algorithm input metadata.",
    );
  }

  const parsed = new Map<string, ResultEloAlgorithmInput>();
  for (const rawInput of rawInputs) {
    if (
      rawInput === null ||
      typeof rawInput !== "object" ||
      Array.isArray(rawInput)
    ) {
      fail(
        "SETTLEMENT_STATE_CONFLICT",
        "An ELO algorithm input metadata row is malformed.",
      );
    }
    const userId = rawInput.userId;
    const eloRating = rawInput.eloRating;
    const matchesPlayed = rawInput.matchesPlayed;
    if (
      typeof userId !== "string" ||
      userId.trim() === "" ||
      !Number.isSafeInteger(eloRating) ||
      !Number.isSafeInteger(matchesPlayed) ||
      typeof eloRating !== "number" ||
      typeof matchesPlayed !== "number" ||
      matchesPlayed < 0 ||
      parsed.has(userId)
    ) {
      fail(
        "SETTLEMENT_STATE_CONFLICT",
        "An ELO algorithm input metadata row is invalid or duplicated.",
        { userId: typeof userId === "string" ? userId : null },
      );
    }
    parsed.set(userId, { userId, eloRating, matchesPlayed });
  }

  const expected = uniqueSorted(expectedUserIds);
  if (
    parsed.size !== expected.length ||
    expected.some((userId) => !parsed.has(userId))
  ) {
    fail(
      "SETTLEMENT_STATE_CONFLICT",
      "The ELO algorithm input metadata does not match the frozen roster.",
      { expectedUserIds: expected, actualUserIds: uniqueSorted([...parsed.keys()]) },
    );
  }
  return parsed;
}

export function calculateSameWinnerCorrectionReapplyAward(
  originalAward: number,
  reversalDelta: number,
) {
  if (
    Number.isInteger(originalAward) &&
    Number.isInteger(reversalDelta) &&
    originalAward >= 0 &&
    reversalDelta <= 0 &&
    -reversalDelta <= originalAward
  ) {
    return reversalDelta === 0 ? 0 : -reversalDelta;
  }
  fail(
    "SETTLEMENT_STATE_CONFLICT",
    "A same-winner correction found an invalid predecessor point reversal.",
    { originalAward, reversalDelta },
  );
}

async function loadCorrectionAlgorithmInputs(
  tx: ResultSettlementTransaction,
  revision: SettlementRevision,
  roster: FrozenFixtureRoster,
) {
  if (revision.supersedesRevisionId === null) return null;
  await lockResultRevision(tx, revision.supersedesRevisionId);
  await lockResultEvents(tx, revision.supersedesRevisionId);

  const predecessor = await tx.resultRevision.findUnique({
    where: { id: revision.supersedesRevisionId },
    select: {
      id: true,
      matchId: true,
      fixtureId: true,
      status: true,
      resolutionKind: true,
      winnerEntryId: true,
      loserEntryId: true,
      supersedesRevisionId: true,
    },
  });
  const keepsWinner =
    predecessor !== null &&
    revision.winnerEntryId === predecessor.winnerEntryId &&
    revision.loserEntryId === predecessor.loserEntryId;
  const swapsWinner =
    predecessor !== null &&
    revision.winnerEntryId === predecessor.loserEntryId &&
    revision.loserEntryId === predecessor.winnerEntryId;
  if (
    predecessor === null ||
    predecessor.matchId !== revision.matchId ||
    predecessor.fixtureId !== revision.fixtureId ||
    predecessor.status !== "SUPERSEDED" ||
    predecessor.resolutionKind !== "PLAYED" ||
    (!keepsWinner && !swapsWinner)
  ) {
    fail(
      "INVALID_CORRECTION",
      "A result correction must keep or exactly swap its played predecessor.",
      { resultRevisionId: revision.id },
    );
  }

  const application = await tx.settlementEvent.findFirst({
    where: {
      resultRevisionId: predecessor.id,
      kind: "RESULT_APPLY",
    },
    include: { effects: { orderBy: { userId: "asc" } } },
  });
  if (application === null || application.status !== "REVERSED") {
    fail(
      "SETTLEMENT_STATE_CONFLICT",
      "The predecessor result must be fully reversed before applying its correction.",
      {
        resultRevisionId: revision.id,
        predecessorId: predecessor.id,
        applicationStatus: application?.status ?? null,
      },
    );
  }
  assertResultEventSubject(application, predecessor.id);
  const algorithmInputs = parseAlgorithmInputs(
    application.metadata,
    roster.allUserIds,
  );
  if (!keepsWinner) {
    return {
      mode: "SWAP_WINNER" as const,
      algorithmInputs,
      sameWinnerReapplyPoints: null,
    };
  }

  const reversal = await tx.settlementEvent.findFirst({
    where: {
      resultRevisionId: predecessor.id,
      kind: "RESULT_REVERSAL",
      reversesEventId: application.id,
    },
    include: { effects: { orderBy: { userId: "asc" } } },
  });
  if (reversal === null || reversal.status !== "APPLIED") {
    fail(
      "SETTLEMENT_STATE_CONFLICT",
      "A same-winner correction requires its predecessor's applied reversal.",
      {
        resultRevisionId: revision.id,
        predecessorId: predecessor.id,
        reversalStatus: reversal?.status ?? null,
      },
    );
  }
  assertResultEventSubject(reversal, predecessor.id);

  const originalEffects = new Map(
    application.effects.map((effect) => [effect.userId, effect]),
  );
  const reversalEffects = new Map(
    reversal.effects.map((effect) => [effect.userId, effect]),
  );
  const expectedUserIds = uniqueSorted(roster.allUserIds);
  if (
    originalEffects.size !== expectedUserIds.length ||
    reversalEffects.size !== expectedUserIds.length ||
    expectedUserIds.some(
      (userId) => !originalEffects.has(userId) || !reversalEffects.has(userId),
    )
  ) {
    fail(
      "SETTLEMENT_STATE_CONFLICT",
      "A same-winner correction requires complete predecessor settlement effects.",
      { resultRevisionId: revision.id, predecessorId: predecessor.id },
    );
  }

  const sameWinnerReapplyPoints = new Map<string, number>();
  for (const userId of expectedUserIds) {
    const original = originalEffects.get(userId)!;
    const reversed = reversalEffects.get(userId)!;
    if (
      original.eloDelta === null ||
      original.pointsDelta === null ||
      reversed.eloDelta === null ||
      reversed.pointsDelta === null ||
      reversed.eloDelta !== -original.eloDelta ||
      reversed.winsDelta !== -original.winsDelta ||
      reversed.lossesDelta !== -original.lossesDelta ||
      reversed.matchesPlayedDelta !== -original.matchesPlayedDelta ||
      original.pointsDelta < 0
    ) {
      fail(
        "SETTLEMENT_STATE_CONFLICT",
        "A same-winner correction found inconsistent predecessor reversal effects.",
        { resultRevisionId: revision.id, predecessorId: predecessor.id, userId },
      );
    }
    sameWinnerReapplyPoints.set(
      userId,
      calculateSameWinnerCorrectionReapplyAward(
        original.pointsDelta,
        reversed.pointsDelta,
      ),
    );
  }
  return {
    mode: "KEEP_WINNER" as const,
    algorithmInputs,
    sameWinnerReapplyPoints,
  };
}

async function loadNetMatchPoints(
  tx: ResultSettlementTransaction,
  matchId: string,
  userIds: readonly string[],
) {
  const totals = new Map(userIds.map((userId) => [userId, 0]));
  const transactions = await tx.pointsTransaction.findMany({
    where: {
      userId: { in: [...userIds] },
      referenceId: { startsWith: `${MATCH_POINTS_REFERENCE_PREFIX}${matchId}:` },
    },
    select: { userId: true, amount: true },
  });
  for (const transaction of transactions) {
    totals.set(
      transaction.userId,
      (totals.get(transaction.userId) ?? 0) + transaction.amount,
    );
  }
  return totals;
}

function validateAwardFromPolicy(
  award: number,
  input: Readonly<{ userId: string; netMatchPoints: number }>,
) {
  const maximum = Math.max(
    0,
    Math.min(
      LEGACY_RESULT_WIN_REWARD,
      LEGACY_MATCH_POINTS_CAP - input.netMatchPoints,
    ),
  );
  if (Number.isInteger(award) && award === maximum) return;
  fail(
    "POINTS_POLICY_VIOLATION",
    "The points policy must return the exact legacy-compatible result reward.",
    { ...input, award, maximum },
  );
}

function validateReversalFromPolicy(
  reversal: number,
  input: Readonly<{
    userId: string;
    currentBalance: number;
    originalAward: number;
  }>,
) {
  const expected = -Math.min(
    input.originalAward,
    Math.max(0, input.currentBalance),
  );
  if (Number.isInteger(reversal) && reversal === expected) return;
  fail(
    "POINTS_POLICY_VIOLATION",
    "The points reversal must preserve the legacy non-negative-balance rule.",
    { ...input, reversal, expected },
  );
}

export function calculateResultEloDeltas(
  winnerUserIds: readonly string[],
  loserUserIds: readonly string[],
  inputs: ReadonlyMap<string, ResultEloAlgorithmInput>,
) {
  const toEloPlayer = (userId: string) => {
    const input = inputs.get(userId);
    if (input === undefined) {
      fail("INVALID_FIXTURE_ROSTER", "An ELO algorithm input is missing.", {
        userId,
      });
    }
    return {
      userId,
      eloRating: input.eloRating,
      matchesPlayed: input.matchesPlayed,
    };
  };
  const winners = winnerUserIds.map(toEloPlayer);
  const losers = loserUserIds.map(toEloPlayer);
  return winners.length === 1 && losers.length === 1
    ? settleSinglesElo(winners[0], losers[0])
    : settleTeamElo(winners, losers);
}

function pointsProjectionReference(
  matchId: string,
  resultRevisionId: string,
  kind: ResultSettlementEventKind,
  userId: string,
) {
  return `${MATCH_POINTS_REFERENCE_PREFIX}${matchId}:v2:${resultRevisionId}:${kind}:${userId}`;
}

type EffectMutation = Readonly<{
  user: LockedResultUser;
  eloBefore: number;
  eloAfter: number;
  eloDelta: number;
  pointsBefore: number;
  pointsAfter: number;
  pointsDelta: number;
  winsDelta: number;
  lossesDelta: number;
  matchesPlayedDelta: number;
}>;

function assertEffectMutation(effect: EffectMutation) {
  const values = [
    [effect.eloAfter, "eloRating"],
    [effect.pointsAfter, "points"],
    [effect.user.wins + effect.winsDelta, "wins"],
    [effect.user.losses + effect.lossesDelta, "losses"],
    [
      effect.user.matchesPlayed + effect.matchesPlayedDelta,
      "matchesPlayed",
    ],
  ] as const;
  for (const [value, name] of values) {
    assertInt32(value, name, { userId: effect.user.id });
  }
  if (
    effect.pointsAfter < 0 ||
    effect.user.wins + effect.winsDelta < 0 ||
    effect.user.losses + effect.lossesDelta < 0 ||
    effect.user.matchesPlayed + effect.matchesPlayedDelta < 0 ||
    effect.matchesPlayedDelta !== effect.winsDelta + effect.lossesDelta
  ) {
    fail(
      "AGGREGATE_INVARIANT_VIOLATION",
      "A settlement would create an invalid user aggregate.",
      { userId: effect.user.id },
    );
  }
}

async function persistEffectMutations(
  tx: ResultSettlementTransaction,
  input: Readonly<{
    eventId: string;
    matchId: string;
    resultRevisionId: string;
    kind: ResultSettlementEventKind;
    effects: readonly EffectMutation[];
  }>,
) {
  const persisted: SettlementEffectView[] = [];
  for (const effect of [...input.effects].sort((left, right) =>
    left.user.id.localeCompare(right.user.id),
  )) {
    assertEffectMutation(effect);
    const wins = effect.user.wins + effect.winsDelta;
    const losses = effect.user.losses + effect.lossesDelta;
    const matchesPlayed =
      effect.user.matchesPlayed + effect.matchesPlayedDelta;

    await tx.user.update({
      where: { id: effect.user.id },
      data: {
        eloRating: effect.eloAfter,
        points: effect.pointsAfter,
        wins,
        losses,
        matchesPlayed,
      },
    });

    const saved = await tx.settlementEffect.create({
      data: {
        eventId: input.eventId,
        userId: effect.user.id,
        eloBefore: effect.eloBefore,
        eloAfter: effect.eloAfter,
        eloDelta: effect.eloDelta,
        pointsBefore: effect.pointsBefore,
        pointsAfter: effect.pointsAfter,
        pointsDelta: effect.pointsDelta,
        winsDelta: effect.winsDelta,
        lossesDelta: effect.lossesDelta,
        matchesPlayedDelta: effect.matchesPlayedDelta,
      },
      select: {
        id: true,
        eventId: true,
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
    });
    persisted.push(saved);

    await tx.eloHistory.create({
      data: {
        userId: effect.user.id,
        matchId: input.matchId,
        eloBefore: effect.eloBefore,
        eloAfter: effect.eloAfter,
        delta: effect.eloDelta,
      },
    });

    if (effect.pointsDelta !== 0) {
      await tx.pointsTransaction.create({
        data: {
          userId: effect.user.id,
          amount: effect.pointsDelta,
          balanceAfter: effect.pointsAfter,
          type: effect.pointsDelta > 0 ? "earn" : "refund",
          reason:
            input.kind === "RESULT_APPLY"
              ? "比赛胜利奖励（V2）"
              : "比赛赛果冲正（V2）",
          referenceId: pointsProjectionReference(
            input.matchId,
            input.resultRevisionId,
            input.kind,
            effect.user.id,
          ),
        },
      });
    }
  }
  return persisted;
}

function eventKinds(events: readonly SettlementEvent[]) {
  return events
    .map((event) => event.kind)
    .filter(isResultEventKind);
}

function existingOutcome(
  event: SettlementEvent & { effects: SettlementEffect[] },
): ResultSettlementOutcome {
  if (event.status !== "APPLIED") {
    fail(
      "SETTLEMENT_STATE_CONFLICT",
      "An idempotent settlement retry found a non-applied event.",
      { eventId: event.id, status: event.status },
    );
  }
  return { event, effects: event.effects, wasNoop: true };
}

export async function applyResultSettlement(
  tx: ResultSettlementTransaction,
  input: ApplyResultSettlementInput,
): Promise<ResultSettlementOutcome> {
  assertStableIdentifier(input.resultRevisionId, "resultRevisionId");
  const now = (input.clock ?? (() => new Date()))();
  const pointsPolicy = input.pointsPolicy ?? legacyCompatibleResultPointsPolicy;
  const { revision, roster } = await loadSettlementSubject(
    tx,
    input.resultRevisionId,
  );
  const events = await loadResultEvents(tx, revision.id);
  const decision = decideSettlementEvent({
    resultRevisionId: revision.id,
    eventKind: "RESULT_APPLY",
    revisionStatus: revision.status,
    recordedEventKinds: eventKinds(events),
  });
  const existing = events.find((event) => event.kind === "RESULT_APPLY");
  if (decision.action === "NOOP") {
    if (existing === undefined) {
      fail(
        "SETTLEMENT_STATE_CONFLICT",
        "The settlement decision references a missing application event.",
        { resultRevisionId: revision.id },
      );
    }
    return existingOutcome(existing);
  }
  if (revision.status !== "CONFIRMED") {
    fail(
      "INVALID_RESULT_REVISION_STATE",
      "Only a confirmed result revision can be applied.",
      { resultRevisionId: revision.id, status: revision.status },
    );
  }

  const sides = participantSides(revision, roster);
  const correctionContext = await loadCorrectionAlgorithmInputs(
    tx,
    revision,
    roster,
  );
  const lockedUsers = await lockAndLoadResultUsers(tx, roster.allUserIds);
  if (lockedUsers.some((user) => user.isBanned)) {
    fail(
      "PARTICIPANT_BANNED",
      "A result containing a currently banned roster member cannot be applied.",
      {
        resultRevisionId: revision.id,
        bannedUserIds: lockedUsers
          .filter((user) => user.isBanned)
          .map((user) => user.id),
      },
    );
  }

  const algorithmInputs =
    correctionContext?.algorithmInputs ??
    new Map<string, ResultEloAlgorithmInput>(
      lockedUsers.map((user) => [
        user.id,
        {
          userId: user.id,
          eloRating: user.eloRating,
          matchesPlayed: user.matchesPlayed,
        },
      ]),
    );
  const eloDeltas = calculateResultEloDeltas(
    sides.winner.userIds,
    sides.loser.userIds,
    algorithmInputs,
  );
  const eloByUserId = new Map<string, EloDelta>(
    eloDeltas.map((delta) => [delta.userId, delta]),
  );
  if (eloByUserId.size !== roster.allUserIds.length) {
    fail(
      "AGGREGATE_INVARIANT_VIOLATION",
      "The ELO algorithm did not return exactly one effect per roster member.",
      { resultRevisionId: revision.id },
    );
  }

  const netMatchPoints = await loadNetMatchPoints(
    tx,
    revision.matchId,
    roster.allUserIds,
  );
  const winnerIds = new Set(sides.winner.userIds);
  const mutations = lockedUsers.map((user): EffectMutation => {
    const elo = eloByUserId.get(user.id);
    if (elo === undefined) {
      fail("AGGREGATE_INVARIANT_VIOLATION", "A roster member has no ELO effect.", {
        userId: user.id,
        resultRevisionId: revision.id,
      });
    }
    const netPoints = netMatchPoints.get(user.id) ?? 0;
    const sameWinnerReapply = correctionContext?.sameWinnerReapplyPoints;
    let pointsDelta = 0;
    if (winnerIds.has(user.id)) {
      if (sameWinnerReapply !== null && sameWinnerReapply !== undefined) {
        const recoveredAward = sameWinnerReapply.get(user.id);
        if (
          recoveredAward === undefined ||
          !Number.isInteger(recoveredAward) ||
          recoveredAward < 0 ||
          recoveredAward > LEGACY_RESULT_WIN_REWARD
        ) {
          fail(
            "SETTLEMENT_STATE_CONFLICT",
            "A same-winner correction has an invalid recovered point award.",
            { resultRevisionId: revision.id, userId: user.id },
          );
        }
        pointsDelta = recoveredAward;
      } else {
        pointsDelta = pointsPolicy.calculateWinnerAward({
          userId: user.id,
          matchId: revision.matchId,
          resultRevisionId: revision.id,
          currentBalance: user.points,
          netMatchPoints: netPoints,
        });
        validateAwardFromPolicy(pointsDelta, {
          userId: user.id,
          netMatchPoints: netPoints,
        });
      }
    } else if (
      sameWinnerReapply !== null &&
      sameWinnerReapply !== undefined &&
      sameWinnerReapply.get(user.id) !== 0
    ) {
      fail(
        "SETTLEMENT_STATE_CONFLICT",
        "A same-winner correction cannot reapply points to a losing roster member.",
        { resultRevisionId: revision.id, userId: user.id },
      );
    }

    return {
      user,
      eloBefore: user.eloRating,
      eloAfter: user.eloRating + elo.delta,
      eloDelta: elo.delta,
      pointsBefore: user.points,
      pointsAfter: user.points + pointsDelta,
      pointsDelta,
      winsDelta: winnerIds.has(user.id) ? 1 : 0,
      lossesDelta: winnerIds.has(user.id) ? 0 : 1,
      matchesPlayedDelta: 1,
    };
  });

  const pendingEvent = await tx.settlementEvent.create({
    data: {
      idempotencyKey: decision.idempotencyKey,
      kind: "RESULT_APPLY",
      status: "PENDING",
      resultRevisionId: revision.id,
      metadata: {
        schemaVersion: 1,
        rosterSource: "FIXTURE_ROSTER_VERSION",
        sideARosterVersion: roster.sideA.rosterVersion,
        sideBRosterVersion: roster.sideB.rosterVersion,
        algorithmInputs: [...algorithmInputs.values()]
          .sort((left, right) => left.userId.localeCompare(right.userId))
          .map((algorithmInput) => ({ ...algorithmInput })),
        ...(correctionContext === null
          ? {}
          : { correctionMode: correctionContext.mode }),
      },
    },
  });
  assertResultEventSubject(pendingEvent, revision.id);

  const effects = await persistEffectMutations(tx, {
    eventId: pendingEvent.id,
    matchId: revision.matchId,
    resultRevisionId: revision.id,
    kind: "RESULT_APPLY",
    effects: mutations,
  });
  const event = await tx.settlementEvent.update({
    where: { id: pendingEvent.id },
    data: { status: "APPLIED", appliedAt: now },
  });
  return { event, effects, wasNoop: false };
}

export async function reverseResultSettlement(
  tx: ResultSettlementTransaction,
  input: ReverseResultSettlementInput,
): Promise<ResultSettlementOutcome> {
  assertStableIdentifier(input.resultRevisionId, "resultRevisionId");
  const now = (input.clock ?? (() => new Date()))();
  const pointsPolicy = input.pointsPolicy ?? legacyCompatibleResultPointsPolicy;
  const { revision, roster } = await loadSettlementSubject(
    tx,
    input.resultRevisionId,
  );
  const events = await loadResultEvents(tx, revision.id);
  const decision = decideSettlementEvent({
    resultRevisionId: revision.id,
    eventKind: "RESULT_REVERSAL",
    revisionStatus: revision.status,
    recordedEventKinds: eventKinds(events),
  });
  const existingReversal = events.find(
    (event) => event.kind === "RESULT_REVERSAL",
  );
  if (decision.action === "NOOP") {
    if (existingReversal === undefined) {
      fail(
        "SETTLEMENT_STATE_CONFLICT",
        "The settlement decision references a missing reversal event.",
        { resultRevisionId: revision.id },
      );
    }
    return existingOutcome(existingReversal);
  }

  const application = events.find((event) => event.kind === "RESULT_APPLY");
  if (application === undefined || application.status !== "APPLIED") {
    fail(
      "SETTLEMENT_STATE_CONFLICT",
      "A reversal requires one fully applied result event.",
      {
        resultRevisionId: revision.id,
        applicationStatus: application?.status ?? null,
      },
    );
  }
  assertResultEventSubject(application, revision.id);

  const lockedUsers = await lockAndLoadResultUsers(tx, roster.allUserIds);
  const originalEffectMap = new Map(
    application.effects.map((effect) => [effect.userId, effect]),
  );
  if (
    originalEffectMap.size !== roster.allUserIds.length ||
    roster.allUserIds.some((userId) => !originalEffectMap.has(userId))
  ) {
    fail(
      "SETTLEMENT_STATE_CONFLICT",
      "The applied event does not contain exactly one effect per frozen roster member.",
      { eventId: application.id, resultRevisionId: revision.id },
    );
  }

  const netMatchPoints = await loadNetMatchPoints(
    tx,
    revision.matchId,
    roster.allUserIds,
  );
  const unrecoveredPoints: Array<{ userId: string; amount: number }> = [];
  const mutations = lockedUsers.map((user): EffectMutation => {
    const original = originalEffectMap.get(user.id);
    if (
      original === undefined ||
      original.eloBefore === null ||
      original.eloAfter === null ||
      original.eloDelta === null ||
      original.pointsBefore === null ||
      original.pointsAfter === null ||
      original.pointsDelta === null ||
      original.eloDelta !== original.eloAfter - original.eloBefore ||
      original.pointsDelta !== original.pointsAfter - original.pointsBefore
    ) {
      fail(
        "SETTLEMENT_STATE_CONFLICT",
        "The original result effect is incomplete or internally inconsistent.",
        { eventId: application.id, userId: user.id },
      );
    }
    if (original.pointsDelta < 0) {
      fail(
        "SETTLEMENT_STATE_CONFLICT",
        "A result application cannot contain a negative point award.",
        { eventId: application.id, userId: user.id },
      );
    }

    const originalAward = original.pointsDelta;
    const pointsDelta = pointsPolicy.calculateWinnerReversal({
      userId: user.id,
      matchId: revision.matchId,
      resultRevisionId: revision.id,
      currentBalance: user.points,
      netMatchPoints: netMatchPoints.get(user.id) ?? 0,
      originalAward,
    });
    validateReversalFromPolicy(pointsDelta, {
      userId: user.id,
      currentBalance: user.points,
      originalAward,
    });
    const unrecovered = originalAward + pointsDelta;
    if (unrecovered > 0) {
      unrecoveredPoints.push({ userId: user.id, amount: unrecovered });
    }

    return {
      user,
      eloBefore: user.eloRating,
      eloAfter: user.eloRating - original.eloDelta,
      eloDelta: -original.eloDelta,
      pointsBefore: user.points,
      pointsAfter: user.points + pointsDelta,
      pointsDelta,
      winsDelta: -original.winsDelta,
      lossesDelta: -original.lossesDelta,
      matchesPlayedDelta: -original.matchesPlayedDelta,
    };
  });

  const pendingEvent = await tx.settlementEvent.create({
    data: {
      idempotencyKey: decision.idempotencyKey,
      kind: "RESULT_REVERSAL",
      status: "PENDING",
      resultRevisionId: revision.id,
      reversesEventId: application.id,
      metadata: {
        schemaVersion: 1,
        unrecoveredPoints,
      },
    },
  });
  assertResultEventSubject(pendingEvent, revision.id);

  const effects = await persistEffectMutations(tx, {
    eventId: pendingEvent.id,
    matchId: revision.matchId,
    resultRevisionId: revision.id,
    kind: "RESULT_REVERSAL",
    effects: mutations,
  });
  await tx.settlementEvent.update({
    where: { id: application.id },
    data: { status: "REVERSED" },
  });
  const event = await tx.settlementEvent.update({
    where: { id: pendingEvent.id },
    data: { status: "APPLIED", appliedAt: now },
  });
  return { event, effects, wasNoop: false };
}
