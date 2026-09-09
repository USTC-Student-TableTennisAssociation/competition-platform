import {
  Prisma,
  type MatchFixture,
  type PrismaClient,
  type ResultRevision,
  type UserRole,
} from "@prisma/client";

import {
  assertFixtureStatusTransition,
  assertResultRevisionStatusTransition,
} from "../domain";
import {
  V2_MAX_TEAM_SCORE_PER_FIXTURE,
  isCanonicalV2BestOfScoreText,
} from "../domain/group-standings";
import {
  advanceConfirmedV2KnockoutWinner,
  assertV2KnockoutCorrectionMayProceed,
  assertV2KnockoutResultMayStart,
  resolveV2KnockoutFixtureAdministratively,
} from "./knockout-advancement";
import { findV2GroupFixtureVoidBlock } from "./group-fixture-void-policy";
import { finishV2GroupOnlyMatchIfTerminal } from "./match-completion";
import { V2ResultApplicationError } from "./results-errors";
import {
  applyResultSettlement,
  assertFixtureLineupMatchesFrozenRoster,
  assertRosterKindMatchesMatchType,
  legacyCompatibleResultPointsPolicy,
  lockAndLoadResultUsers,
  resolveFrozenFixtureRoster,
  reverseResultSettlement,
  type FrozenFixtureRoster,
  type LockedResultUser,
  type ResultPointsPolicy,
  type ResultSettlementClock,
  type ResultSettlementTransaction,
} from "./settlements";

export type V2ResultDatabase = Pick<PrismaClient, "$transaction">;

export type ResultActorContext = Readonly<{
  actorId: string;
  role: UserRole;
}>;

type ResultCommandTarget = Readonly<{
  actor: ResultActorContext;
  matchId: string;
  fixtureId: string;
  expectedFixtureVersion: number;
  /** Optional server-side capability guard; never source this from a client. */
  requiredFixtureStage?: "GROUP" | "KNOCKOUT";
}>;

export type SubmitRevisionCommand = ResultCommandTarget &
  Readonly<{
    winnerEntryId: string;
    loserEntryId: string;
    score: Prisma.InputJsonValue;
    supersedesRevisionId?: string;
    reason?: string;
  }>;

export type V2PlayedCorrectionMode = "KEEP_WINNER" | "SWAP_WINNER";

export type SubmitCorrectionCommand = ResultCommandTarget &
  Readonly<{
    resultRevisionId: string;
    score: Prisma.InputJsonValue;
    /** Missing means SWAP_WINNER for compatibility with existing trusted callers. */
    correctionMode?: V2PlayedCorrectionMode;
    reason?: string;
  }>;

export type ConfirmRevisionCommand = ResultCommandTarget &
  Readonly<{ resultRevisionId: string }>;

export type RejectRevisionCommand = ResultCommandTarget &
  Readonly<{ resultRevisionId: string; reason?: string }>;

export type VoidRevisionCommand = ResultCommandTarget &
  Readonly<{ resultRevisionId: string; reason?: string }>;

export type ConfirmForfeitCommand = ResultCommandTarget &
  Readonly<{
    requiredFixtureStage: "GROUP" | "KNOCKOUT";
    winnerEntryId: string;
    loserEntryId: string;
    reason: string;
  }>;

export type CorrectForfeitCommand = ResultCommandTarget &
  Readonly<{
    requiredFixtureStage: "GROUP" | "KNOCKOUT";
    resultRevisionId: string;
    reason: string;
  }>;

export type V2ResultApplicationService = Readonly<{
  submitRevision(command: SubmitRevisionCommand): Promise<ResultRevision>;
  submitCorrection(command: SubmitCorrectionCommand): Promise<ResultRevision>;
  confirmRevision(command: ConfirmRevisionCommand): Promise<ResultRevision>;
  rejectRevision(command: RejectRevisionCommand): Promise<ResultRevision>;
  voidRevision(command: VoidRevisionCommand): Promise<ResultRevision>;
  confirmForfeit(command: ConfirmForfeitCommand): Promise<ResultRevision>;
  correctForfeit(command: CorrectForfeitCommand): Promise<ResultRevision>;
}>;

export type V2ResultApplicationServiceDependencies = Readonly<{
  db: V2ResultDatabase;
  pointsPolicy?: ResultPointsPolicy;
  clock?: ResultSettlementClock;
}>;

export function mapV2ResultPersistenceError(error: unknown): Error {
  if (error instanceof V2ResultApplicationError) return error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const databaseCode =
      typeof error.meta?.code === "string" ? error.meta.code : null;
    if (
      error.code === "P2034" ||
      (error.code === "P2010" &&
        (databaseCode === "40001" || databaseCode === "40P01"))
    ) {
      return new V2ResultApplicationError(
        "CONCURRENT_WRITE_CONFLICT",
        "The result changed concurrently; reload the fixture before retrying.",
        { prismaCode: error.code, databaseCode },
      );
    }
    return new V2ResultApplicationError(
      "PERSISTENCE_CONFLICT",
      error.code === "P2002"
        ? "A unique result or settlement record already exists."
        : error.code === "P2003"
          ? "A referenced result, fixture, entry, or user no longer exists."
          : "The result operation could not be persisted.",
      { prismaCode: error.code },
    );
  }
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return new V2ResultApplicationError(
      "PERSISTENCE_CONFLICT",
      "The result operation could not be persisted.",
    );
  }
  return error instanceof Error
    ? error
    : new V2ResultApplicationError(
        "PERSISTENCE_CONFLICT",
        "The result operation failed with an unknown persistence error.",
      );
}

type LockedFixture = Pick<
  MatchFixture,
  | "id"
  | "matchId"
  | "stage"
  | "bestOf"
  | "status"
  | "version"
  | "sideAEntryId"
  | "sideBEntryId"
  | "sideARosterVersion"
  | "sideBRosterVersion"
>;

type LockedAggregate = Readonly<{
  match: Readonly<{
    id: string;
    createdBy: string;
    engineVersion: "LEGACY" | "V2";
    isQuickMatch: boolean;
    type: "single" | "double" | "team";
    status: "registration" | "ongoing" | "finished";
    format: "group_only" | "group_then_knockout";
  }>;
  fixture: LockedFixture;
}>;

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

function assertTargetCommand(command: ResultCommandTarget) {
  assertStableIdentifier(command.actor.actorId, "actor.actorId");
  assertStableIdentifier(command.matchId, "matchId");
  assertStableIdentifier(command.fixtureId, "fixtureId");
  if (
    !Number.isSafeInteger(command.expectedFixtureVersion) ||
    command.expectedFixtureVersion < 0
  ) {
    fail(
      "INVALID_COMMAND",
      "expectedFixtureVersion must be a non-negative integer.",
      { expectedFixtureVersion: command.expectedFixtureVersion },
    );
  }
  if (
    command.requiredFixtureStage !== undefined &&
    command.requiredFixtureStage !== "GROUP" &&
    command.requiredFixtureStage !== "KNOCKOUT"
  ) {
    fail(
      "INVALID_COMMAND",
      "requiredFixtureStage must be a server-owned GROUP or KNOCKOUT capability.",
      { requiredFixtureStage: command.requiredFixtureStage },
    );
  }
}

function normalizeReason(reason: string | undefined) {
  if (reason === undefined) return undefined;
  const normalized = reason.trim();
  return normalized === "" ? undefined : normalized;
}

function normalizeRequiredReason(reason: string) {
  const normalized = reason.trim();
  if (normalized.length === 0 || normalized.length > 500) {
    fail("INVALID_COMMAND", "A forfeit requires a reason between 1 and 500 characters.");
  }
  return normalized;
}

function sampleResultClock(clock: ResultSettlementClock) {
  const sampled = clock();
  if (!(sampled instanceof Date) || !Number.isFinite(sampled.getTime())) {
    fail(
      "AGGREGATE_INVARIANT_VIOLATION",
      "The result service clock returned an invalid timestamp.",
    );
  }
  return new Date(sampled.getTime());
}

export function v2ForfeitAuditAction(
  matchType: "single" | "double" | "team",
  stage: "GROUP" | "KNOCKOUT" = "GROUP",
) {
  if (stage === "KNOCKOUT") {
    if (matchType === "single") return "v2_single_knockout_forfeit_confirm";
    if (matchType === "double") return "v2_double_knockout_forfeit_confirm";
    return "v2_team_knockout_forfeit_confirm";
  }
  if (matchType === "single") return "v2_single_group_forfeit_confirm";
  if (matchType === "double") return "v2_double_group_forfeit_confirm";
  return "v2_team_group_forfeit_confirm";
}

export function v2ForfeitCorrectionAuditAction(
  matchType: "single" | "double" | "team",
  stage: "GROUP" | "KNOCKOUT",
) {
  if (stage === "KNOCKOUT") {
    if (matchType === "single") return "v2_single_knockout_forfeit_correct";
    if (matchType === "double") return "v2_double_knockout_forfeit_correct";
    return "v2_team_knockout_forfeit_correct";
  }
  if (matchType === "single") return "v2_single_group_forfeit_correct";
  if (matchType === "double") return "v2_double_group_forfeit_correct";
  return "v2_team_group_forfeit_correct";
}

function forfeitCorrectionAuditDetails(input: Readonly<{
  matchId: string;
  fixtureId: string;
  stage: "GROUP" | "KNOCKOUT";
  supersedesRevisionId: string;
  previousWinnerEntryId: string;
  previousLoserEntryId: string;
  winnerEntryId: string;
  loserEntryId: string;
  reason: string;
}>) {
  return {
    matchId: input.matchId,
    fixtureId: input.fixtureId,
    stage: input.stage,
    supersedesRevisionId: input.supersedesRevisionId,
    previousWinnerEntryId: input.previousWinnerEntryId,
    previousLoserEntryId: input.previousLoserEntryId,
    winnerEntryId: input.winnerEntryId,
    loserEntryId: input.loserEntryId,
    reason: input.reason,
    resolutionKind: "FORFEIT",
  } as const;
}

function hasExactJsonFields(
  actual: Prisma.JsonValue | null,
  expected: Readonly<Record<string, string>>,
) {
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index]) &&
    expectedKeys.every((key) => actual[key] === expected[key])
  );
}

function normalizePlayedCorrectionMode(
  mode: V2PlayedCorrectionMode | undefined,
): V2PlayedCorrectionMode {
  if (mode === undefined || mode === "SWAP_WINNER") return "SWAP_WINNER";
  if (mode === "KEEP_WINNER") return mode;
  fail(
    "INVALID_COMMAND",
    "correctionMode must be KEEP_WINNER or SWAP_WINNER.",
    { correctionMode: mode },
  );
}

/**
 * KNOCKOUT writes require an explicit server-owned boundary capability. This
 * keeps the generic service fail-closed even though advancement is available.
 */
export function assertV2ResultFixtureStageSupported(
  stage: "GROUP" | "KNOCKOUT" | "FREE_PLAY",
  requiredFixtureStage?: "GROUP" | "KNOCKOUT",
) {
  if (stage !== "KNOCKOUT" || requiredFixtureStage === "KNOCKOUT") return;
  fail(
    "INVALID_FIXTURE_STATE",
    "Knockout result writes require the server-owned KNOCKOUT capability.",
    { stage },
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

/** Validates only the legacy score fields used to determine a winner. */
export function assertCanonicalResultScore(
  matchType: "single" | "double" | "team",
  score: unknown,
) {
  if (score === null || typeof score !== "object" || Array.isArray(score)) {
    fail("INVALID_COMMAND", "A result score must be a JSON object.");
  }
  const value = score as Record<string, unknown>;
  const keys = Object.keys(value).sort().join("\u0000");
  const expectedKeys =
    matchType === "team"
      ? "loserScore\u0000winnerScore"
      : "bestOf\u0000loserScore\u0000winnerScore";
  const expectedKeysWithText = "bestOf\u0000loserScore\u0000text\u0000winnerScore";
  if (keys !== expectedKeys && (matchType === "team" || keys !== expectedKeysWithText)) {
    fail("INVALID_COMMAND", "A result score contains unsupported fields.", {
      matchType,
    });
  }
  const winnerScore = value.winnerScore;
  const loserScore = value.loserScore;

  if (matchType === "team") {
    if (
      isNonNegativeInteger(winnerScore) &&
      isNonNegativeInteger(loserScore) &&
      winnerScore <= V2_MAX_TEAM_SCORE_PER_FIXTURE &&
      loserScore <= V2_MAX_TEAM_SCORE_PER_FIXTURE &&
      winnerScore > loserScore
    ) {
      return;
    }
    fail(
      "INVALID_COMMAND",
      "A team score requires non-negative integer totals with winnerScore greater than loserScore.",
      { matchType },
    );
  }

  const bestOf = value.bestOf;
  if (bestOf !== 3 && bestOf !== 5 && bestOf !== 7) {
    fail("INVALID_COMMAND", "A singles/doubles score requires bestOf 3, 5, or 7.", {
      matchType,
    });
  }
  const winsNeeded = (bestOf + 1) / 2;
  if (
    winnerScore === winsNeeded &&
    isNonNegativeInteger(loserScore) &&
    loserScore < winsNeeded
  ) {
    if (
      "text" in value &&
      !isCanonicalV2BestOfScoreText(
        value.text,
        bestOf,
        winnerScore,
        loserScore,
      )
    ) {
      fail("INVALID_COMMAND", "The score text is not canonical.", {
        matchType,
      });
    }
    return;
  }
  fail(
    "INVALID_COMMAND",
    "The score is inconsistent with the declared singles/doubles winner.",
    { matchType, bestOf },
  );
}

export function assertPresetScore(matchType: "single" | "double" | "team", bestOf: number, score: unknown) {
  if (matchType === "team") return;
  if (!score || typeof score !== "object" || !("bestOf" in score) || score.bestOf !== bestOf) {
    fail("INVALID_COMMAND", "比分局制与组织者设置不一致，请刷新后按本场局制录分。", { bestOf });
  }
}

async function lockAggregate(
  tx: ResultSettlementTransaction,
  matchId: string,
  fixtureId: string,
  requiredFixtureStage?: "GROUP" | "KNOCKOUT",
): Promise<LockedAggregate> {
  const lockedMatches = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "Match"
    WHERE "id" = ${matchId}
    FOR UPDATE
  `);
  if (lockedMatches.length === 0) {
    fail("MATCH_NOT_FOUND", "The match does not exist.", { matchId });
  }

  const lockedFixtures = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "match_fixture"
    WHERE "id" = ${fixtureId} AND "match_id" = ${matchId}
    FOR UPDATE
  `);
  if (lockedFixtures.length === 0) {
    fail("FIXTURE_NOT_FOUND", "The fixture does not belong to this match.", {
      matchId,
      fixtureId,
    });
  }

  const [match, fixture] = await Promise.all([
    tx.match.findUnique({
      where: { id: matchId },
      select: {
        id: true,
        createdBy: true,
        engineVersion: true,
        isQuickMatch: true,
        type: true,
        status: true,
        format: true,
      },
    }),
    tx.matchFixture.findUnique({
      where: { id: fixtureId },
      select: {
        id: true,
        matchId: true,
        stage: true,
        bestOf: true,
        status: true,
        version: true,
        sideAEntryId: true,
        sideBEntryId: true,
        sideARosterVersion: true,
        sideBRosterVersion: true,
      },
    }),
  ]);
  if (match === null) {
    fail("MATCH_NOT_FOUND", "The locked match disappeared.", { matchId });
  }
  if (fixture === null || fixture.matchId !== match.id) {
    fail("FIXTURE_NOT_FOUND", "The locked fixture disappeared.", {
      matchId,
      fixtureId,
    });
  }
  if (match.engineVersion !== "V2") {
    fail("ENGINE_MISMATCH", "The V2 result service rejects legacy matches.", {
      matchId,
      engineVersion: match.engineVersion,
    });
  }
  if (match.isQuickMatch) {
    fail("ENGINE_MISMATCH", "The V2 result service rejects quick matches.", {
      matchId,
      engineVersion: match.engineVersion,
      isQuickMatch: true,
    });
  }
  assertV2ResultFixtureStageSupported(fixture.stage, requiredFixtureStage);
  if (
    requiredFixtureStage !== undefined &&
    fixture.stage !== requiredFixtureStage
  ) {
    fail(
      "INVALID_FIXTURE_STATE",
      `This result boundary accepts ${requiredFixtureStage} fixtures only.`,
      { fixtureId: fixture.id, stage: fixture.stage, requiredFixtureStage },
    );
  }
  return { match, fixture };
}

async function lockRevision(
  tx: ResultSettlementTransaction,
  target: Readonly<{
    resultRevisionId: string;
    matchId: string;
    fixtureId: string;
  }>,
) {
  assertStableIdentifier(target.resultRevisionId, "resultRevisionId");
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "result_revision"
    WHERE "id" = ${target.resultRevisionId}
    FOR UPDATE
  `);
  if (locked.length === 0) {
    fail("RESULT_REVISION_NOT_FOUND", "The result revision does not exist.", {
      resultRevisionId: target.resultRevisionId,
    });
  }

  const revision = await tx.resultRevision.findUnique({
    where: { id: target.resultRevisionId },
  });
  if (
    revision === null ||
    revision.matchId !== target.matchId ||
    revision.fixtureId !== target.fixtureId
  ) {
    fail(
      "RESULT_REVISION_NOT_FOUND",
      "The result revision does not belong to the requested fixture.",
      target,
    );
  }
  return revision;
}

async function assertForfeitHasNoSettlementEvents(
  tx: ResultSettlementTransaction,
  resultRevisionId: string,
) {
  const pollutedEvent = await tx.settlementEvent.findFirst({
    where: {
      resultRevisionId,
      kind: { in: ["RESULT_APPLY", "RESULT_REVERSAL"] },
    },
    select: { id: true, kind: true, status: true },
  });
  if (pollutedEvent === null) return;
  fail(
    "SETTLEMENT_STATE_CONFLICT",
    "A forfeit revision must not have result settlement events.",
    {
      resultRevisionId,
      settlementEventId: pollutedEvent.id,
      settlementEventKind: pollutedEvent.kind,
      settlementEventStatus: pollutedEvent.status,
    },
  );
}

function assertCanonicalForfeitScore(score: Prisma.JsonValue) {
  if (
    score !== null &&
    typeof score === "object" &&
    !Array.isArray(score) &&
    Object.keys(score).sort().join("\u0000") ===
      "loserScore\u0000winnerScore" &&
    score.winnerScore === 1 &&
    score.loserScore === 0
  ) {
    return;
  }
  fail(
    "AGGREGATE_INVARIANT_VIOLATION",
    "A forfeit revision must use the canonical 1:0 score.",
  );
}

function assertForfeitWinnerAvailable(
  roster: FrozenFixtureRoster,
  winnerEntryId: string,
  lockedUsers: readonly LockedResultUser[],
) {
  const winnerSide =
    roster.sideA.entryId === winnerEntryId
      ? roster.sideA
      : roster.sideB.entryId === winnerEntryId
        ? roster.sideB
        : null;
  if (winnerSide === null || winnerSide.status !== "ACTIVE") {
    fail(
      "INVALID_FIXTURE_PARTICIPANTS",
      "A forfeited fixture requires an active winning Entry.",
      {
        winnerEntryId,
        winnerEntryStatus: winnerSide?.status ?? null,
      },
    );
  }
  const lockedUsersById = new Map(lockedUsers.map((user) => [user.id, user]));
  const unavailableWinnerUserIds = winnerSide.userIds.filter((userId) => {
    const user = lockedUsersById.get(userId);
    return !user || user.isBanned || user.emailVerifiedAt === null;
  });
  if (unavailableWinnerUserIds.length === 0) return;
  fail(
    "PARTICIPANT_BANNED",
    "A forfeited fixture cannot advance an unavailable winning roster.",
    { unavailableWinnerUserIds },
  );
}

function assertAutomaticForfeitLoserUnavailable(
  roster: FrozenFixtureRoster,
  loserEntryId: string,
  lockedUsers: readonly LockedResultUser[],
) {
  const loserSide =
    roster.sideA.entryId === loserEntryId
      ? roster.sideA
      : roster.sideB.entryId === loserEntryId
        ? roster.sideB
        : null;
  if (loserSide === null) {
    fail(
      "INVALID_FIXTURE_PARTICIPANTS",
      "An automatic forfeit loser must be one exact fixture side.",
      { loserEntryId },
    );
  }
  const lockedUsersById = new Map(lockedUsers.map((user) => [user.id, user]));
  const rosterUnavailable = loserSide.userIds.some((userId) => {
    const user = lockedUsersById.get(userId);
    return !user || user.isBanned || user.emailVerifiedAt === null;
  });
  if (loserSide.status !== "ACTIVE" || rosterUnavailable) return;
  fail(
    "INVALID_FIXTURE_PARTICIPANTS",
    "An automatic forfeit requires an unavailable losing Entry.",
    { loserEntryId, loserEntryStatus: loserSide.status },
  );
}

/**
 * A qualification snapshot freezes every GROUP outcome used to seed the
 * knockout bracket. Once it exists, even a manager must not rewrite, reject,
 * or void that source history. KNOCKOUT revisions remain mutable under their
 * own downstream-advancement rules.
 */
async function assertQualificationSourceHistoryMutable(
  tx: ResultSettlementTransaction,
  aggregate: LockedAggregate,
) {
  if (
    aggregate.match.format !== "group_then_knockout" ||
    aggregate.fixture.stage !== "GROUP"
  ) {
    return;
  }
  const snapshot = await tx.matchQualificationSnapshot.findFirst({
    where: { matchId: aggregate.match.id },
    select: { id: true },
  });
  if (snapshot === null) return;
  fail(
    "INVALID_FIXTURE_STATE",
    "Group result history is frozen after qualification is published.",
    {
      matchId: aggregate.match.id,
      fixtureId: aggregate.fixture.id,
      qualificationSnapshotId: snapshot.id,
    },
  );
}

async function loadAndLockActorUsers(
  tx: ResultSettlementTransaction,
  actor: ResultActorContext,
  rosterUserIds: readonly string[] = [],
) {
  const actorExists = await tx.user.findUnique({
    where: { id: actor.actorId },
    select: { id: true },
  });
  if (actorExists === null) {
    fail("ACTOR_NOT_FOUND", "The acting user no longer exists.", {
      actorId: actor.actorId,
    });
  }

  const users = await lockAndLoadResultUsers(tx, [
    ...rosterUserIds,
    actor.actorId,
  ]);
  const lockedActor = users.find((user) => user.id === actor.actorId);
  if (lockedActor === undefined) {
    fail("ACTOR_NOT_FOUND", "The acting user could not be locked.", {
      actorId: actor.actorId,
    });
  }
  if (lockedActor.emailVerifiedAt === null) {
    fail(
      "ACTOR_NOT_ACTIVE",
      "An unverified user cannot perform result operations.",
      { actorId: actor.actorId },
    );
  }
  if (lockedActor.role !== actor.role) {
    fail(
      "ACTOR_ROLE_MISMATCH",
      "The supplied actor role is stale or does not match the database.",
      {
        actorId: actor.actorId,
        suppliedRole: actor.role,
        currentRole: lockedActor.role,
      },
    );
  }
  if (lockedActor.isBanned) {
    fail("ACTOR_BANNED", "A banned user cannot perform result operations.", {
      actorId: actor.actorId,
    });
  }
  return { users, actor: lockedActor };
}

function isManager(
  actor: Pick<LockedResultUser, "id" | "role">,
  match: Readonly<{ createdBy: string }>,
) {
  return actor.role === "admin" || actor.id === match.createdBy;
}

function rosterSideForUser(roster: FrozenFixtureRoster, userId: string) {
  if (roster.sideA.userIds.includes(userId)) return "SIDE_A" as const;
  if (roster.sideB.userIds.includes(userId)) return "SIDE_B" as const;
  return null;
}

export function assertResultActorCanSubmit(
  actor: Pick<LockedResultUser, "id" | "role">,
  match: Readonly<{ id: string; createdBy: string }>,
  roster: FrozenFixtureRoster,
  isCorrection: boolean,
) {
  const manager = isManager(actor, match);
  if (isCorrection) {
    if (manager) return;
    fail("FORBIDDEN", "Only the match owner or an admin can submit a correction.", {
      actorId: actor.id,
      matchId: match.id,
    });
  }
  if (manager) return;

  const actorSide = rosterSideForUser(roster, actor.id);
  if (
    (roster.sideA.kind === "INDIVIDUAL" ||
      roster.sideA.kind === "DOUBLES") &&
    actorSide !== null
  ) {
    return;
  }
  if (roster.sideA.kind === "TEAM" && actorSide !== null) {
    const side = actorSide === "SIDE_A" ? roster.sideA : roster.sideB;
    if (side.members.some(
      (member) => member.userId === actor.id && member.role === "captain",
    )) {
      return;
    }
  }

  const message =
    roster.sideA.kind === "TEAM"
        ? "Only a participating team captain can submit a team result."
        : "Only a frozen fixture participant can submit this result.";
  fail("FORBIDDEN", message, { actorId: actor.id, matchId: match.id });
}

export function assertResultActorCanConfirm(
  actor: Pick<LockedResultUser, "id" | "role">,
  match: Readonly<{ id: string; createdBy: string }>,
  roster: FrozenFixtureRoster,
  revision: Pick<ResultRevision, "reportedById">,
) {
  if (isManager(actor, match)) return;
  if (actor.id === revision.reportedById) {
    fail("FORBIDDEN", "A result reporter cannot confirm their own submission.", {
      actorId: actor.id,
    });
  }

  const actorSide = rosterSideForUser(roster, actor.id);
  if (actorSide === null) {
    fail("FORBIDDEN", "Only a fixture participant can confirm this result.", {
      actorId: actor.id,
    });
  }
  if (roster.sideA.kind !== "TEAM") return;

  const side = actorSide === "SIDE_A" ? roster.sideA : roster.sideB;
  const actorMember = side.members.find((member) => member.userId === actor.id);
  if (actorMember?.role === "captain") return;
  fail(
    "FORBIDDEN",
    "Only a participating team captain can confirm a team result.",
    { actorId: actor.id },
  );
}

function assertManager(
  actor: LockedResultUser,
  match: LockedAggregate["match"],
  action: string,
) {
  if (isManager(actor, match)) return;
  fail("FORBIDDEN", `Only the match owner or an admin can ${action}.`, {
    actorId: actor.id,
    matchId: match.id,
  });
}

function assertFixtureVersion(fixture: LockedFixture, expectedVersion: number) {
  if (fixture.version === expectedVersion) return;
  fail("STALE_FIXTURE_VERSION", "The fixture changed since it was read.", {
    fixtureId: fixture.id,
    expectedVersion,
    currentVersion: fixture.version,
  });
}

function assertWinnerAndLoser(
  fixture: LockedFixture,
  winnerEntryId: string,
  loserEntryId: string,
) {
  assertStableIdentifier(winnerEntryId, "winnerEntryId");
  assertStableIdentifier(loserEntryId, "loserEntryId");
  const valid =
    fixture.sideAEntryId !== null &&
    fixture.sideBEntryId !== null &&
    winnerEntryId !== loserEntryId &&
    new Set([winnerEntryId, loserEntryId]).size === 2 &&
    [winnerEntryId, loserEntryId].every(
      (entryId) =>
        entryId === fixture.sideAEntryId || entryId === fixture.sideBEntryId,
    );
  if (valid) return;
  fail(
    "INVALID_FIXTURE_PARTICIPANTS",
    "The winner and loser must be exactly the fixture's two entries.",
    { fixtureId: fixture.id, winnerEntryId, loserEntryId },
  );
}

export function assertInitialResultEntriesActive(roster: FrozenFixtureRoster) {
  const inactiveEntries = [roster.sideA, roster.sideB]
    .filter((side) => side.status !== "ACTIVE")
    .map((side) => ({ entryId: side.entryId, status: side.status }));
  if (inactiveEntries.length === 0) return;
  fail(
    "INVALID_FIXTURE_PARTICIPANTS",
    "An initial result requires both frozen fixture entries to remain active.",
    { inactiveEntries },
  );
}

export function assertCorrectionSwapsParticipants(
  previous: Readonly<{
    winnerEntryId: string | null;
    loserEntryId: string | null;
  }>,
  correction: Readonly<{ winnerEntryId: string; loserEntryId: string }>,
) {
  if (previous.winnerEntryId !== null && previous.loserEntryId !== null) {
    if (
      correction.winnerEntryId === previous.winnerEntryId &&
      correction.loserEntryId === previous.loserEntryId
    ) {
      return "KEEP_WINNER" as const;
    }
    if (
      correction.winnerEntryId === previous.loserEntryId &&
      correction.loserEntryId === previous.winnerEntryId
    ) {
      return "SWAP_WINNER" as const;
    }
  }
  fail(
    "INVALID_CORRECTION",
    "A played correction must keep or exactly swap its predecessor's winner and loser.",
  );
}

async function bumpFixtureVersion(
  tx: ResultSettlementTransaction,
  fixture: LockedFixture,
  expectedVersion: number,
  data: Readonly<{
    status?: "SCHEDULED" | "READY" | "COMPLETED" | "VOIDED";
    completedAt?: Date | null;
  }> = {},
) {
  const updated = await tx.matchFixture.updateMany({
    where: { id: fixture.id, matchId: fixture.matchId, version: expectedVersion },
    data: { ...data, version: { increment: 1 } },
  });
  if (updated.count === 1) return;
  fail("STALE_FIXTURE_VERSION", "The fixture version update lost a race.", {
    fixtureId: fixture.id,
    expectedVersion,
  });
}

async function updatePendingRevision(
  tx: ResultSettlementTransaction,
  revisionId: string,
  data: Prisma.ResultRevisionUncheckedUpdateManyInput,
) {
  const updated = await tx.resultRevision.updateMany({
    where: { id: revisionId, status: "PENDING" },
    data,
  });
  if (updated.count === 1) return;
  fail(
    "INVALID_RESULT_REVISION_STATE",
    "The pending result revision changed concurrently.",
    { resultRevisionId: revisionId },
  );
}

async function submitRevisionInTransaction(
  tx: ResultSettlementTransaction,
  command: SubmitRevisionCommand,
  clock: ResultSettlementClock,
) {
  assertTargetCommand(command);
  const aggregate = await lockAggregate(
    tx,
    command.matchId,
    command.fixtureId,
    command.requiredFixtureStage,
  );
  const now = sampleResultClock(clock);
  await assertQualificationSourceHistoryMutable(tx, aggregate);
  assertFixtureVersion(aggregate.fixture, command.expectedFixtureVersion);
  assertWinnerAndLoser(
    aggregate.fixture,
    command.winnerEntryId,
    command.loserEntryId,
  );
  assertCanonicalResultScore(aggregate.match.type, command.score);
  assertPresetScore(aggregate.match.type, aggregate.fixture.bestOf, command.score);

  const supersedesRevisionId = command.supersedesRevisionId;
  const isCorrection = supersedesRevisionId !== undefined;
  let supersededRevision: ResultRevision | null = null;
  if (supersedesRevisionId === undefined) {
    if (aggregate.fixture.status !== "READY") {
      fail(
        "INVALID_FIXTURE_STATE",
        "An initial result can be submitted only for a ready fixture.",
        { fixtureId: aggregate.fixture.id, status: aggregate.fixture.status },
      );
    }
  } else {
    assertStableIdentifier(supersedesRevisionId, "supersedesRevisionId");
    if (aggregate.fixture.status !== "COMPLETED") {
      fail(
        "INVALID_FIXTURE_STATE",
        "A correction can be submitted only for a completed fixture.",
        { fixtureId: aggregate.fixture.id, status: aggregate.fixture.status },
      );
    }
    supersededRevision = await lockRevision(tx, {
      resultRevisionId: supersedesRevisionId,
      matchId: command.matchId,
      fixtureId: command.fixtureId,
    });
    if (supersededRevision.status !== "CONFIRMED") {
      fail(
        "INVALID_CORRECTION",
        "A correction must point to the fixture's current confirmed revision.",
        {
          supersedesRevisionId,
          status: supersededRevision.status,
        },
      );
    }
    if (supersededRevision.resolutionKind !== "PLAYED") {
      fail(
        "INVALID_CORRECTION",
        "A forfeit is an adjudication and cannot be corrected as a played score.",
        {
          supersedesRevisionId,
          resolutionKind: supersededRevision.resolutionKind,
        },
      );
    }
    assertCorrectionSwapsParticipants(supersededRevision, command);
  }

  if (aggregate.fixture.stage === "KNOCKOUT") {
    if (isCorrection) {
      await assertV2KnockoutCorrectionMayProceed(
        tx,
        aggregate.match,
        aggregate.fixture.id,
      );
    } else {
      await assertV2KnockoutResultMayStart(
        tx,
        aggregate.match,
        aggregate.fixture.id,
      );
    }
  }

  const roster = await resolveFrozenFixtureRoster(tx, aggregate.fixture);
  assertRosterKindMatchesMatchType(aggregate.match.type, roster);
  if (!isCorrection) {
    assertInitialResultEntriesActive(roster);
  }
  await assertFixtureLineupMatchesFrozenRoster(tx, aggregate.fixture, roster);
  const locked = await loadAndLockActorUsers(
    tx,
    command.actor,
    roster.allUserIds,
  );
  const rosterUserIds = new Set(roster.allUserIds);
  const bannedRosterUserIds = locked.users
    .filter((user) => rosterUserIds.has(user.id) && user.isBanned)
    .map((user) => user.id);
  if (bannedRosterUserIds.length > 0) {
    fail(
      "PARTICIPANT_BANNED",
      "A result cannot be submitted for a roster containing a banned user.",
      { bannedUserIds: bannedRosterUserIds },
    );
  }
  assertResultActorCanSubmit(
    locked.actor,
    aggregate.match,
    roster,
    isCorrection,
  );

  const existingPending = await tx.resultRevision.findFirst({
    where: { fixtureId: command.fixtureId, status: "PENDING" },
    select: { id: true },
  });
  if (existingPending !== null) {
    fail(
      "INVALID_RESULT_REVISION_STATE",
      "The fixture already has a pending result revision.",
      { fixtureId: command.fixtureId, pendingRevisionId: existingPending.id },
    );
  }

  const maximum = await tx.resultRevision.aggregate({
    where: { fixtureId: command.fixtureId },
    _max: { revisionNumber: true },
  });
  const revisionNumber = (maximum._max.revisionNumber ?? 0) + 1;
  const revision = await tx.resultRevision.create({
    data: {
      matchId: command.matchId,
      fixtureId: command.fixtureId,
      revisionNumber,
      status: "PENDING",
      winnerEntryId: command.winnerEntryId,
      loserEntryId: command.loserEntryId,
      score: command.score,
      reportedById: command.actor.actorId,
      supersedesRevisionId: supersededRevision?.id,
      reason: normalizeReason(command.reason),
      createdAt: now,
    },
  });
  await bumpFixtureVersion(
    tx,
    aggregate.fixture,
    command.expectedFixtureVersion,
  );
  return revision;
}

type ForfeitAuthorization = "MANAGER" | "AUTOMATIC_UNAVAILABLE";

async function confirmForfeitKernel(
  tx: ResultSettlementTransaction,
  command: ConfirmForfeitCommand,
  clock: ResultSettlementClock,
  authorization: ForfeitAuthorization,
) {
  assertTargetCommand(command);
  const reason = normalizeRequiredReason(command.reason);
  const aggregate = await lockAggregate(
    tx,
    command.matchId,
    command.fixtureId,
    command.requiredFixtureStage,
  );
  const now = sampleResultClock(clock);
  assertWinnerAndLoser(
    aggregate.fixture,
    command.winnerEntryId,
    command.loserEntryId,
  );

  const roster = await resolveFrozenFixtureRoster(tx, aggregate.fixture);
  assertRosterKindMatchesMatchType(aggregate.match.type, roster);
  await assertFixtureLineupMatchesFrozenRoster(tx, aggregate.fixture, roster);
  const locked = await loadAndLockActorUsers(
    tx,
    command.actor,
    roster.allUserIds,
  );
  assertForfeitWinnerAvailable(roster, command.winnerEntryId, locked.users);
  if (authorization === "MANAGER") {
    assertManager(locked.actor, aggregate.match, "confirm a fixture forfeit");
  } else {
    assertAutomaticForfeitLoserUnavailable(
      roster,
      command.loserEntryId,
      locked.users,
    );
  }

  const activeRevisions = await tx.resultRevision.findMany({
    where: {
      matchId: command.matchId,
      fixtureId: command.fixtureId,
      status: { in: ["PENDING", "CONFIRMED"] },
    },
    orderBy: [{ revisionNumber: "asc" }, { id: "asc" }],
  });
  if (activeRevisions.length === 1) {
    const existing = activeRevisions[0];
    if (
      aggregate.fixture.status === "COMPLETED" &&
      existing.status === "CONFIRMED" &&
      existing.resolutionKind === "FORFEIT" &&
      existing.winnerEntryId === command.winnerEntryId &&
      existing.loserEntryId === command.loserEntryId &&
      existing.reason === reason
    ) {
      await assertForfeitHasNoSettlementEvents(tx, existing.id);
      if (aggregate.fixture.stage === "KNOCKOUT") {
        const advancementInput = {
          match: aggregate.match,
          fixtureId: aggregate.fixture.id,
          winnerEntryId: command.winnerEntryId,
        };
        if (authorization === "MANAGER") {
          await advanceAndReconcileV2KnockoutWinner(tx, {
            ...advancementInput,
            actor: command.actor,
            now,
          });
        } else {
          await advanceConfirmedV2KnockoutWinner(tx, advancementInput);
        }
      }
      return existing;
    }
  }
  if (activeRevisions.length > 0) {
    fail(
      "INVALID_RESULT_REVISION_STATE",
      "A fixture with an active result cannot be adjudicated as a forfeit.",
      {
        fixtureId: aggregate.fixture.id,
        activeRevisionIds: activeRevisions.map((revision) => revision.id),
      },
    );
  }
  await assertQualificationSourceHistoryMutable(tx, aggregate);
  assertFixtureVersion(aggregate.fixture, command.expectedFixtureVersion);
  if (
    aggregate.match.status !== "ongoing" ||
    aggregate.fixture.status !== "READY"
  ) {
    fail(
      "INVALID_FIXTURE_STATE",
      "A forfeit can be confirmed only for a ready fixture in an ongoing match.",
      {
        matchStatus: aggregate.match.status,
        fixtureStatus: aggregate.fixture.status,
      },
    );
  }
  if (aggregate.fixture.stage === "KNOCKOUT") {
    await assertV2KnockoutResultMayStart(
      tx,
      aggregate.match,
      aggregate.fixture.id,
    );
  }

  const maximum = await tx.resultRevision.aggregate({
    where: { fixtureId: command.fixtureId },
    _max: { revisionNumber: true },
  });
  const revision = await tx.resultRevision.create({
    data: {
      matchId: command.matchId,
      fixtureId: command.fixtureId,
      revisionNumber: (maximum._max.revisionNumber ?? 0) + 1,
      status: "CONFIRMED",
      resolutionKind: "FORFEIT",
      winnerEntryId: command.winnerEntryId,
      loserEntryId: command.loserEntryId,
      score: { winnerScore: 1, loserScore: 0 },
      reportedById: locked.actor.id,
      verifiedById: locked.actor.id,
      reason,
      resolvedAt: now,
    },
  });
  await bumpFixtureVersion(
    tx,
    aggregate.fixture,
    command.expectedFixtureVersion,
    { status: "COMPLETED", completedAt: now },
  );
  await tx.auditLog.create({
    data: {
      actorId: locked.actor.id,
      action: v2ForfeitAuditAction(
        aggregate.match.type,
        aggregate.fixture.stage === "KNOCKOUT" ? "KNOCKOUT" : "GROUP",
      ),
      entityType: "ResultRevision",
      entityId: revision.id,
      details: {
        matchId: aggregate.match.id,
        fixtureId: aggregate.fixture.id,
        stage: aggregate.fixture.stage,
        winnerEntryId: command.winnerEntryId,
        loserEntryId: command.loserEntryId,
        resolutionKind: "FORFEIT",
        ...(authorization === "AUTOMATIC_UNAVAILABLE"
          ? { automatic: true, authorization: "ENTRY_UNAVAILABLE" }
          : {}),
      },
    },
  });
  if (aggregate.fixture.stage === "KNOCKOUT") {
    const advancementInput = {
      match: aggregate.match,
      fixtureId: aggregate.fixture.id,
      winnerEntryId: command.winnerEntryId,
    };
    if (authorization === "MANAGER") {
      await advanceAndReconcileV2KnockoutWinner(tx, {
        ...advancementInput,
        actor: command.actor,
        now,
      });
    } else {
      await advanceConfirmedV2KnockoutWinner(tx, advancementInput);
    }
  }
  await finishV2GroupOnlyMatchIfTerminal(tx, aggregate.match);
  return revision;
}

/** @internal Trusted composition seam for an already-open V2 transaction. */
export async function confirmForfeitInTransaction(
  tx: ResultSettlementTransaction,
  command: ConfirmForfeitCommand,
  clock: ResultSettlementClock,
) {
  return confirmForfeitKernel(tx, command, clock, "MANAGER");
}

const MAX_KNOCKOUT_RECONCILIATION_STEPS = 1_023;

/**
 * A disqualified Entry can already occupy a later-round side while the other
 * feeder is unresolved. Once that feeder becomes authoritative, this closes
 * every newly decidable fixture in the same transaction instead of leaving a
 * READY bracket dead end for a second manual command.
 */
async function reconcileUnavailableV2KnockoutFixtures(
  tx: ResultSettlementTransaction,
  input: Readonly<{
    match: LockedAggregate["match"];
    actor: ResultActorContext;
    reason: string;
    now: Date;
  }>,
) {
  for (
    let iteration = 0;
    iteration < MAX_KNOCKOUT_RECONCILIATION_STEPS;
    iteration += 1
  ) {
    const fixtures = await tx.matchFixture.findMany({
      where: {
        matchId: input.match.id,
        stage: "KNOCKOUT",
        status: { in: ["SCHEDULED", "READY"] },
      },
      orderBy: [{ roundNumber: "asc" }, { position: "asc" }, { id: "asc" }],
      select: {
        id: true,
        status: true,
        version: true,
        sideAEntryId: true,
        sideBEntryId: true,
        sideAEntry: { select: { status: true } },
        sideBEntry: { select: { status: true } },
        resultRevisions: {
          where: { status: { in: ["PENDING", "CONFIRMED"] } },
          select: { id: true },
        },
        incomingDependencies: {
          orderBy: { targetSide: "asc" },
          select: {
            targetSide: true,
            sourceQualificationStandingId: true,
            sourceFixture: {
              select: {
                status: true,
                administrativeResolution: { select: { kind: true } },
              },
            },
          },
        },
      },
    });
    let progressed = false;
    for (const fixture of fixtures) {
      if (fixture.resultRevisions.length > 0) continue;
      if (
        (fixture.sideAEntryId !== null && fixture.sideAEntry === null) ||
        (fixture.sideBEntryId !== null && fixture.sideBEntry === null)
      ) {
        fail(
          "AGGREGATE_INVARIANT_VIOLATION",
          "A knockout fixture points to a missing Entry.",
          { fixtureId: fixture.id },
        );
      }
      const sideAAvailable = fixture.sideAEntry?.status === "ACTIVE";
      const sideBAvailable = fixture.sideBEntry?.status === "ACTIVE";
      const dependencies = new Map(
        fixture.incomingDependencies.map((dependency) => [
          dependency.targetSide,
          dependency,
        ]),
      );
      const sideIsTerminalEmpty = (side: "SIDE_A" | "SIDE_B") => {
        const entryId =
          side === "SIDE_A" ? fixture.sideAEntryId : fixture.sideBEntryId;
        if (entryId !== null) return false;
        const dependency = dependencies.get(side);
        return Boolean(
          dependency &&
            dependency.sourceQualificationStandingId === null &&
            dependency.sourceFixture?.status === "VOIDED" &&
            dependency.sourceFixture.administrativeResolution?.kind ===
              "NO_CONTEST",
        );
      };
      const sideAEmpty = sideIsTerminalEmpty("SIDE_A");
      const sideBEmpty = sideIsTerminalEmpty("SIDE_B");
      const bothPopulated =
        fixture.sideAEntryId !== null && fixture.sideBEntryId !== null;

      if (bothPopulated && sideAAvailable !== sideBAvailable) {
        const winnerEntryId = sideAAvailable
          ? fixture.sideAEntryId!
          : fixture.sideBEntryId!;
        const loserEntryId = sideAAvailable
          ? fixture.sideBEntryId!
          : fixture.sideAEntryId!;
        await confirmForfeitKernel(
          tx,
          {
            actor: input.actor,
            matchId: input.match.id,
            fixtureId: fixture.id,
            expectedFixtureVersion: fixture.version,
            requiredFixtureStage: "KNOCKOUT",
            winnerEntryId,
            loserEntryId,
            reason: input.reason,
          },
          () => input.now,
          "AUTOMATIC_UNAVAILABLE",
        );
        progressed = true;
        break;
      }

      let kind: "NO_CONTEST" | "ADMIN_BYE" | null = null;
      if (bothPopulated && !sideAAvailable && !sideBAvailable) {
        kind = "NO_CONTEST";
      } else if (fixture.sideAEntryId !== null && sideBEmpty) {
        kind = sideAAvailable ? "ADMIN_BYE" : "NO_CONTEST";
      } else if (fixture.sideBEntryId !== null && sideAEmpty) {
        kind = sideBAvailable ? "ADMIN_BYE" : "NO_CONTEST";
      } else if (
        fixture.sideAEntryId === null &&
        fixture.sideBEntryId === null &&
        sideAEmpty &&
        sideBEmpty
      ) {
        kind = "NO_CONTEST";
      }
      if (kind === null) continue;
      await resolveV2KnockoutFixtureAdministratively(tx, {
        match: input.match,
        actorId: input.actor.actorId,
        fixtureId: fixture.id,
        kind,
        reason: input.reason,
        clock: () => input.now,
      });
      progressed = true;
      break;
    }
    if (!progressed) return;
  }
  fail(
    "AGGREGATE_INVARIANT_VIOLATION",
    "Knockout unavailability reconciliation did not converge.",
    { matchId: input.match.id },
  );
}

async function advanceAndReconcileV2KnockoutWinner(
  tx: ResultSettlementTransaction,
  input: Readonly<{
    match: LockedAggregate["match"];
    actor: ResultActorContext;
    fixtureId: string;
    winnerEntryId: string;
    now: Date;
  }>,
) {
  const advancement = await advanceConfirmedV2KnockoutWinner(tx, {
    match: input.match,
    fixtureId: input.fixtureId,
    winnerEntryId: input.winnerEntryId,
  });
  await reconcileUnavailableV2KnockoutFixtures(tx, {
    match: input.match,
    actor: input.actor,
    reason: "赛程一方已被取消资格，系统按既定规则自动判定",
    now: input.now,
  });
  return advancement;
}

async function correctForfeitInTransaction(
  tx: ResultSettlementTransaction,
  command: CorrectForfeitCommand,
  clock: ResultSettlementClock,
) {
  assertTargetCommand(command);
  assertStableIdentifier(command.resultRevisionId, "resultRevisionId");
  const reason = normalizeRequiredReason(command.reason);
  const aggregate = await lockAggregate(
    tx,
    command.matchId,
    command.fixtureId,
    command.requiredFixtureStage,
  );
  const now = sampleResultClock(clock);
  const authoritative = await lockRevision(tx, {
    resultRevisionId: command.resultRevisionId,
    matchId: command.matchId,
    fixtureId: command.fixtureId,
  });
  if (
    authoritative.resolutionKind !== "FORFEIT" ||
    authoritative.winnerEntryId === null ||
    authoritative.loserEntryId === null
  ) {
    fail(
      "INVALID_CORRECTION",
      "A forfeit correction must target an authoritative forfeit revision.",
      {
        resultRevisionId: authoritative.id,
        resolutionKind: authoritative.resolutionKind,
      },
    );
  }
  assertWinnerAndLoser(
    aggregate.fixture,
    authoritative.winnerEntryId,
    authoritative.loserEntryId,
  );
  assertCanonicalForfeitScore(authoritative.score);

  const roster = await resolveFrozenFixtureRoster(tx, aggregate.fixture);
  assertRosterKindMatchesMatchType(aggregate.match.type, roster);
  await assertFixtureLineupMatchesFrozenRoster(tx, aggregate.fixture, roster);
  const locked = await loadAndLockActorUsers(
    tx,
    command.actor,
    roster.allUserIds,
  );
  assertManager(locked.actor, aggregate.match, "correct a fixture forfeit");

  const [successors, activeRevisions] = await Promise.all([
    tx.resultRevision.findMany({
      where: {
        matchId: command.matchId,
        fixtureId: command.fixtureId,
        supersedesRevisionId: authoritative.id,
      },
      orderBy: [{ revisionNumber: "asc" }, { id: "asc" }],
    }),
    tx.resultRevision.findMany({
      where: {
        matchId: command.matchId,
        fixtureId: command.fixtureId,
        status: { in: ["PENDING", "CONFIRMED"] },
      },
      orderBy: [{ revisionNumber: "asc" }, { id: "asc" }],
    }),
  ]);
  const winnerEntryId = authoritative.loserEntryId;
  const loserEntryId = authoritative.winnerEntryId;
  const stage =
    aggregate.fixture.stage === "KNOCKOUT" ? "KNOCKOUT" : "GROUP";
  const auditAction = v2ForfeitCorrectionAuditAction(
    aggregate.match.type,
    stage,
  );
  const auditDetails = forfeitCorrectionAuditDetails({
    matchId: aggregate.match.id,
    fixtureId: aggregate.fixture.id,
    stage,
    previousWinnerEntryId: authoritative.winnerEntryId,
    previousLoserEntryId: authoritative.loserEntryId,
    winnerEntryId,
    loserEntryId,
    supersedesRevisionId: authoritative.id,
    reason,
  });

  if (authoritative.status === "SUPERSEDED") {
    const successor = successors[0] ?? null;
    const expectedReplayVersion = command.expectedFixtureVersion + 1;
    if (
      successors.length !== 1 ||
      successor === null ||
      successor.status !== "CONFIRMED" ||
      successor.resolutionKind !== "FORFEIT" ||
      successor.supersedesRevisionId !== authoritative.id ||
      successor.revisionNumber !== authoritative.revisionNumber + 1 ||
      successor.winnerEntryId !== winnerEntryId ||
      successor.loserEntryId !== loserEntryId ||
      successor.reportedById !== locked.actor.id ||
      successor.verifiedById !== locked.actor.id ||
      successor.reason !== reason ||
      successor.resolvedAt === null ||
      successor.createdAt.getTime() !== successor.resolvedAt.getTime() ||
      aggregate.fixture.status !== "COMPLETED" ||
      !Number.isSafeInteger(expectedReplayVersion) ||
      aggregate.fixture.version !== expectedReplayVersion ||
      activeRevisions.length !== 1 ||
      activeRevisions[0]?.id !== successor.id
    ) {
      fail(
        "INVALID_CORRECTION",
        "The forfeit correction retry does not match the persisted successor.",
        { resultRevisionId: authoritative.id },
      );
    }
    assertCanonicalForfeitScore(successor.score);
    await assertForfeitHasNoSettlementEvents(tx, authoritative.id);
    await assertForfeitHasNoSettlementEvents(tx, successor.id);
    const audits = await tx.auditLog.findMany({
      where: {
        action: auditAction,
        entityType: "ResultRevision",
        entityId: successor.id,
      },
      select: { actorId: true, details: true, createdAt: true },
    });
    if (
      audits.length !== 1 ||
      audits[0]?.actorId !== locked.actor.id ||
      audits[0].createdAt.getTime() !== successor.resolvedAt.getTime() ||
      !hasExactJsonFields(audits[0].details, auditDetails)
    ) {
      fail(
        "AGGREGATE_INVARIANT_VIOLATION",
        "The persisted forfeit correction audit is missing or inconsistent.",
        { resultRevisionId: successor.id },
      );
    }
    if (aggregate.fixture.stage === "KNOCKOUT") {
      await advanceAndReconcileV2KnockoutWinner(tx, {
        match: aggregate.match,
        actor: command.actor,
        fixtureId: aggregate.fixture.id,
        winnerEntryId,
        now,
      });
    }
    return successor;
  }

  if (
    authoritative.status !== "CONFIRMED" ||
    successors.length !== 0 ||
    aggregate.fixture.status !== "COMPLETED" ||
    activeRevisions.length !== 1 ||
    activeRevisions[0]?.id !== authoritative.id
  ) {
    fail(
      "INVALID_CORRECTION",
      "A forfeit correction must replace the fixture's sole confirmed authoritative forfeit.",
      {
        resultRevisionId: authoritative.id,
        status: authoritative.status,
        successorCount: successors.length,
        activeRevisionIds: activeRevisions.map((revision) => revision.id),
      },
    );
  }
  await assertForfeitHasNoSettlementEvents(tx, authoritative.id);
  await assertQualificationSourceHistoryMutable(tx, aggregate);
  assertFixtureVersion(aggregate.fixture, command.expectedFixtureVersion);
  assertForfeitWinnerAvailable(roster, winnerEntryId, locked.users);
  if (aggregate.fixture.stage === "KNOCKOUT") {
    await assertV2KnockoutCorrectionMayProceed(
      tx,
      aggregate.match,
      aggregate.fixture.id,
    );
  }

  assertResultRevisionStatusTransition(authoritative.status, "SUPERSEDED");
  const superseded = await tx.resultRevision.updateMany({
    where: { id: authoritative.id, status: "CONFIRMED" },
    data: { status: "SUPERSEDED" },
  });
  if (superseded.count !== 1) {
    fail(
      "INVALID_CORRECTION",
      "The forfeit revision changed before it could be superseded.",
      { resultRevisionId: authoritative.id },
    );
  }

  const maximum = await tx.resultRevision.aggregate({
    where: { fixtureId: command.fixtureId },
    _max: { revisionNumber: true },
  });
  if (maximum._max.revisionNumber !== authoritative.revisionNumber) {
    fail(
      "AGGREGATE_INVARIANT_VIOLATION",
      "The authoritative forfeit is not the fixture's latest revision.",
      {
        resultRevisionId: authoritative.id,
        authoritativeRevisionNumber: authoritative.revisionNumber,
        maximumRevisionNumber: maximum._max.revisionNumber,
      },
    );
  }
  const successor = await tx.resultRevision.create({
    data: {
      matchId: command.matchId,
      fixtureId: command.fixtureId,
      revisionNumber: authoritative.revisionNumber + 1,
      status: "CONFIRMED",
      resolutionKind: "FORFEIT",
      winnerEntryId,
      loserEntryId,
      score: { winnerScore: 1, loserScore: 0 },
      reportedById: locked.actor.id,
      verifiedById: locked.actor.id,
      supersedesRevisionId: authoritative.id,
      reason,
      resolvedAt: now,
      createdAt: now,
    },
  });
  await bumpFixtureVersion(
    tx,
    aggregate.fixture,
    command.expectedFixtureVersion,
  );
  await tx.auditLog.create({
    data: {
      actorId: locked.actor.id,
      action: auditAction,
      entityType: "ResultRevision",
      entityId: successor.id,
      details: auditDetails,
      createdAt: now,
    },
  });
  if (aggregate.fixture.stage === "KNOCKOUT") {
    await advanceAndReconcileV2KnockoutWinner(tx, {
      match: aggregate.match,
      actor: command.actor,
      fixtureId: aggregate.fixture.id,
      winnerEntryId,
      now,
    });
  }
  await finishV2GroupOnlyMatchIfTerminal(tx, aggregate.match);
  return successor;
}

/**
 * Creates the first correction shape without trusting client-selected
 * participants. The predecessor is locked and must still be the fixture's
 * sole CONFIRMED revision; submitRevision then performs the normal manager,
 * score, roster, pending-revision, and optimistic-version checks in the same
 * SERIALIZABLE transaction.
 */
async function submitCorrectionInTransaction(
  tx: ResultSettlementTransaction,
  command: SubmitCorrectionCommand,
  clock: ResultSettlementClock,
) {
  assertTargetCommand(command);
  assertStableIdentifier(command.resultRevisionId, "resultRevisionId");
  const correctionMode = normalizePlayedCorrectionMode(command.correctionMode);
  const aggregate = await lockAggregate(
    tx,
    command.matchId,
    command.fixtureId,
    command.requiredFixtureStage,
  );
  const now = sampleResultClock(clock);
  assertFixtureVersion(aggregate.fixture, command.expectedFixtureVersion);
  if (aggregate.fixture.status !== "COMPLETED") {
    fail(
      "INVALID_FIXTURE_STATE",
      "A correction can be submitted only for a completed fixture.",
      { fixtureId: aggregate.fixture.id, status: aggregate.fixture.status },
    );
  }

  const authoritative = await lockRevision(tx, {
    resultRevisionId: command.resultRevisionId,
    matchId: command.matchId,
    fixtureId: command.fixtureId,
  });
  if (
    authoritative.status !== "CONFIRMED" ||
    authoritative.winnerEntryId === null ||
    authoritative.loserEntryId === null
  ) {
    fail(
      "INVALID_CORRECTION",
      "A correction must target the fixture's current confirmed revision.",
      {
        resultRevisionId: authoritative.id,
        status: authoritative.status,
      },
    );
  }
  if (authoritative.resolutionKind !== "PLAYED") {
    fail(
      "INVALID_CORRECTION",
      "A forfeit is an adjudication and cannot be corrected as a played score.",
      {
        resultRevisionId: authoritative.id,
        resolutionKind: authoritative.resolutionKind,
      },
    );
  }

  const winnerEntryId =
    correctionMode === "KEEP_WINNER"
      ? authoritative.winnerEntryId
      : authoritative.loserEntryId;
  const loserEntryId =
    correctionMode === "KEEP_WINNER"
      ? authoritative.loserEntryId
      : authoritative.winnerEntryId;

  return submitRevisionInTransaction(
    tx,
    {
      actor: command.actor,
      matchId: command.matchId,
      fixtureId: command.fixtureId,
      expectedFixtureVersion: command.expectedFixtureVersion,
      requiredFixtureStage: command.requiredFixtureStage,
      winnerEntryId,
      loserEntryId,
      score: command.score,
      supersedesRevisionId: authoritative.id,
      ...(command.reason === undefined ? {} : { reason: command.reason }),
    },
    () => now,
  );
}

async function confirmRevisionInTransaction(
  tx: ResultSettlementTransaction,
  command: ConfirmRevisionCommand,
  dependencies: Pick<V2ResultApplicationServiceDependencies, "pointsPolicy">,
  clock: ResultSettlementClock,
) {
  assertTargetCommand(command);
  const aggregate = await lockAggregate(
    tx,
    command.matchId,
    command.fixtureId,
    command.requiredFixtureStage,
  );
  const now = sampleResultClock(clock);
  const revision = await lockRevision(tx, {
    resultRevisionId: command.resultRevisionId,
    matchId: command.matchId,
    fixtureId: command.fixtureId,
  });
  const previous =
    revision.supersedesRevisionId === null
      ? null
      : await lockRevision(tx, {
          resultRevisionId: revision.supersedesRevisionId,
          matchId: command.matchId,
          fixtureId: command.fixtureId,
        });
  const roster = await resolveFrozenFixtureRoster(tx, aggregate.fixture);
  assertRosterKindMatchesMatchType(aggregate.match.type, roster);
  if (
    revision.status === "PENDING" &&
    revision.supersedesRevisionId === null
  ) {
    assertInitialResultEntriesActive(roster);
  }
  await assertFixtureLineupMatchesFrozenRoster(tx, aggregate.fixture, roster);
  const locked = await loadAndLockActorUsers(
    tx,
    command.actor,
    roster.allUserIds,
  );
  if (previous === null) {
    assertResultActorCanConfirm(locked.actor, aggregate.match, roster, revision);
  } else {
    assertManager(locked.actor, aggregate.match, "confirm a result correction");
  }

  if (revision.status === "CONFIRMED") {
    if (revision.resolutionKind === "FORFEIT") {
      if (previous !== null) {
        fail(
          "INVALID_CORRECTION",
          "A forfeit revision cannot supersede another result revision.",
          { resultRevisionId: revision.id },
        );
      }
      await assertForfeitHasNoSettlementEvents(tx, revision.id);
      if (
        aggregate.fixture.stage === "KNOCKOUT" &&
        revision.winnerEntryId !== null
      ) {
        await advanceAndReconcileV2KnockoutWinner(tx, {
          match: aggregate.match,
          actor: command.actor,
          fixtureId: aggregate.fixture.id,
          winnerEntryId: revision.winnerEntryId,
          now,
        });
      }
      if (aggregate.fixture.status === "COMPLETED") {
        await finishV2GroupOnlyMatchIfTerminal(tx, aggregate.match);
      }
      return tx.resultRevision.findUniqueOrThrow({ where: { id: revision.id } });
    }
    if (previous !== null) {
      if (previous.status !== "SUPERSEDED") {
        fail(
          "INVALID_CORRECTION",
          "A confirmed correction requires a superseded predecessor.",
          { resultRevisionId: revision.id, previousStatus: previous.status },
        );
      }
      await reverseResultSettlement(tx, {
        resultRevisionId: previous.id,
        pointsPolicy: dependencies.pointsPolicy,
        clock: () => now,
      });
    }
    await applyResultSettlement(tx, {
      resultRevisionId: revision.id,
      pointsPolicy: dependencies.pointsPolicy,
      clock: () => now,
    });
    if (
      aggregate.fixture.stage === "KNOCKOUT" &&
      revision.winnerEntryId !== null
    ) {
      await advanceAndReconcileV2KnockoutWinner(tx, {
        match: aggregate.match,
        actor: command.actor,
        fixtureId: aggregate.fixture.id,
        winnerEntryId: revision.winnerEntryId,
        now,
      });
    }
    if (previous === null && aggregate.fixture.status === "COMPLETED") {
      await finishV2GroupOnlyMatchIfTerminal(tx, aggregate.match);
    }
    return tx.resultRevision.findUniqueOrThrow({ where: { id: revision.id } });
  }
  if (revision.resolutionKind !== "PLAYED") {
    fail(
      "INVALID_RESULT_REVISION_STATE",
      "A forfeit must be confirmed atomically through the dedicated adjudication command.",
      {
        resultRevisionId: revision.id,
        resolutionKind: revision.resolutionKind,
      },
    );
  }
  await assertQualificationSourceHistoryMutable(tx, aggregate);
  if (revision.status !== "PENDING") {
    fail(
      "INVALID_RESULT_REVISION_STATE",
      "Only a pending result revision can be confirmed.",
      { resultRevisionId: revision.id, status: revision.status },
    );
  }
  assertFixtureVersion(aggregate.fixture, command.expectedFixtureVersion);
  assertWinnerAndLoser(
    aggregate.fixture,
    revision.winnerEntryId ?? "",
    revision.loserEntryId ?? "",
  );
  assertCanonicalResultScore(aggregate.match.type, revision.score);
  assertPresetScore(aggregate.match.type, aggregate.fixture.bestOf, revision.score);
  assertResultRevisionStatusTransition(revision.status, "CONFIRMED");
  if (aggregate.fixture.stage === "KNOCKOUT") {
    if (revision.supersedesRevisionId === null) {
      await assertV2KnockoutResultMayStart(
        tx,
        aggregate.match,
        aggregate.fixture.id,
      );
    } else {
      await assertV2KnockoutCorrectionMayProceed(
        tx,
        aggregate.match,
        aggregate.fixture.id,
      );
    }
  }

  if (revision.supersedesRevisionId === null) {
    if (aggregate.fixture.status !== "READY") {
      fail(
        "INVALID_FIXTURE_STATE",
        "An initial result can be confirmed only while its fixture is ready.",
        { fixtureId: aggregate.fixture.id, status: aggregate.fixture.status },
      );
    }
    assertFixtureStatusTransition(aggregate.fixture.status, "COMPLETED");
    await updatePendingRevision(tx, revision.id, {
      status: "CONFIRMED",
      verifiedById: command.actor.actorId,
      resolvedAt: now,
    });
    await applyResultSettlement(tx, {
      resultRevisionId: revision.id,
      pointsPolicy: dependencies.pointsPolicy,
      clock: () => now,
    });
    await bumpFixtureVersion(
      tx,
      aggregate.fixture,
      command.expectedFixtureVersion,
      { status: "COMPLETED", completedAt: now },
    );
    if (aggregate.fixture.stage === "KNOCKOUT") {
      await advanceAndReconcileV2KnockoutWinner(tx, {
        match: aggregate.match,
        actor: command.actor,
        fixtureId: aggregate.fixture.id,
        winnerEntryId: revision.winnerEntryId!,
        now,
      });
    }
    await finishV2GroupOnlyMatchIfTerminal(tx, aggregate.match);
  } else {
    if (aggregate.fixture.status !== "COMPLETED") {
      fail(
        "INVALID_FIXTURE_STATE",
        "A correction can be confirmed only while the fixture remains completed.",
        { fixtureId: aggregate.fixture.id, status: aggregate.fixture.status },
      );
    }
    if (previous === null) {
      fail(
        "INVALID_CORRECTION",
        "The correction is missing its predecessor revision.",
        { resultRevisionId: revision.id },
      );
    }
    if (previous.status !== "CONFIRMED") {
      fail(
        "INVALID_CORRECTION",
        "The correction no longer points to the current confirmed revision.",
        { resultRevisionId: revision.id, previousStatus: previous.status },
      );
    }
    assertResultRevisionStatusTransition(previous.status, "SUPERSEDED");
    const superseded = await tx.resultRevision.updateMany({
      where: { id: previous.id, status: "CONFIRMED" },
      data: { status: "SUPERSEDED" },
    });
    if (superseded.count !== 1) {
      fail(
        "INVALID_CORRECTION",
        "The confirmed revision changed before it could be superseded.",
        { resultRevisionId: previous.id },
      );
    }
    await reverseResultSettlement(tx, {
      resultRevisionId: previous.id,
      pointsPolicy: dependencies.pointsPolicy,
      clock: () => now,
    });
    await updatePendingRevision(tx, revision.id, {
      status: "CONFIRMED",
      verifiedById: command.actor.actorId,
      resolvedAt: now,
    });
    await applyResultSettlement(tx, {
      resultRevisionId: revision.id,
      pointsPolicy: dependencies.pointsPolicy,
      clock: () => now,
    });
    await bumpFixtureVersion(
      tx,
      aggregate.fixture,
      command.expectedFixtureVersion,
    );
    if (aggregate.fixture.stage === "KNOCKOUT") {
      await advanceAndReconcileV2KnockoutWinner(tx, {
        match: aggregate.match,
        actor: command.actor,
        fixtureId: aggregate.fixture.id,
        winnerEntryId: revision.winnerEntryId!,
        now,
      });
    }
  }

  return tx.resultRevision.findUniqueOrThrow({ where: { id: revision.id } });
}

async function rejectRevisionInTransaction(
  tx: ResultSettlementTransaction,
  command: RejectRevisionCommand,
  clock: ResultSettlementClock,
) {
  assertTargetCommand(command);
  const aggregate = await lockAggregate(
    tx,
    command.matchId,
    command.fixtureId,
    command.requiredFixtureStage,
  );
  const now = sampleResultClock(clock);
  const revision = await lockRevision(tx, {
    resultRevisionId: command.resultRevisionId,
    matchId: command.matchId,
    fixtureId: command.fixtureId,
  });
  const locked = await loadAndLockActorUsers(tx, command.actor);
  assertManager(locked.actor, aggregate.match, "reject a result revision");
  if (revision.status === "REJECTED") return revision;
  await assertQualificationSourceHistoryMutable(tx, aggregate);
  if (revision.status !== "PENDING") {
    fail(
      "INVALID_RESULT_REVISION_STATE",
      "Only a pending result revision can be rejected.",
      { resultRevisionId: revision.id, status: revision.status },
    );
  }
  assertFixtureVersion(aggregate.fixture, command.expectedFixtureVersion);
  assertResultRevisionStatusTransition(revision.status, "REJECTED");
  await updatePendingRevision(tx, revision.id, {
    status: "REJECTED",
    verifiedById: command.actor.actorId,
    reason: normalizeReason(command.reason) ?? revision.reason,
    resolvedAt: now,
  });
  await bumpFixtureVersion(
    tx,
    aggregate.fixture,
    command.expectedFixtureVersion,
  );
  return tx.resultRevision.findUniqueOrThrow({ where: { id: revision.id } });
}

async function voidRevisionInTransaction(
  tx: ResultSettlementTransaction,
  command: VoidRevisionCommand,
  dependencies: Pick<V2ResultApplicationServiceDependencies, "pointsPolicy">,
  clock: ResultSettlementClock,
) {
  assertTargetCommand(command);
  const aggregate = await lockAggregate(
    tx,
    command.matchId,
    command.fixtureId,
    command.requiredFixtureStage,
  );
  const now = sampleResultClock(clock);
  const revision = await lockRevision(tx, {
    resultRevisionId: command.resultRevisionId,
    matchId: command.matchId,
    fixtureId: command.fixtureId,
  });
  const locked = await loadAndLockActorUsers(tx, command.actor);
  assertManager(locked.actor, aggregate.match, "void a result revision");

  if (aggregate.fixture.stage === "KNOCKOUT") {
    fail(
      "INVALID_FIXTURE_STATE",
      "Knockout revisions cannot be voided because VOIDED never advances a bracket; reject a pending submission, correct a confirmed winner, or record an explicit forfeit instead.",
      { fixtureId: aggregate.fixture.id, resultRevisionId: revision.id },
    );
  }

  if (revision.status === "VOIDED") {
    if (revision.resolutionKind === "FORFEIT") {
      await assertForfeitHasNoSettlementEvents(tx, revision.id);
    }
    const application = await tx.settlementEvent.findFirst({
      where: {
        resultRevisionId: revision.id,
        kind: "RESULT_APPLY",
      },
      select: { id: true },
    });
    if (application !== null) {
      await reverseResultSettlement(tx, {
        resultRevisionId: revision.id,
        pointsPolicy: dependencies.pointsPolicy,
        clock: () => now,
      });
    }
    if (aggregate.fixture.status === "VOIDED") {
      await finishV2GroupOnlyMatchIfTerminal(tx, aggregate.match);
    }
    return tx.resultRevision.findUniqueOrThrow({ where: { id: revision.id } });
  }
  await assertQualificationSourceHistoryMutable(tx, aggregate);
  if (revision.status !== "PENDING" && revision.status !== "CONFIRMED") {
    fail(
      "INVALID_RESULT_REVISION_STATE",
      "Only a pending or confirmed result revision can be voided.",
      { resultRevisionId: revision.id, status: revision.status },
    );
  }
  if (revision.resolutionKind === "FORFEIT") {
    await assertForfeitHasNoSettlementEvents(tx, revision.id);
    if (revision.status !== "CONFIRMED") {
      fail(
        "INVALID_RESULT_REVISION_STATE",
        "Only an atomically confirmed forfeit can be voided.",
        { resultRevisionId: revision.id, status: revision.status },
      );
    }
  }
  assertFixtureVersion(aggregate.fixture, command.expectedFixtureVersion);

  if (revision.status === "CONFIRMED") {
    const qualificationBlock = await findV2GroupFixtureVoidBlock(tx, {
      matchId: aggregate.match.id,
      format: aggregate.match.format,
      stage: aggregate.fixture.stage,
      sideAEntryId: aggregate.fixture.sideAEntryId,
      sideBEntryId: aggregate.fixture.sideBEntryId,
    });
    if (qualificationBlock !== null) {
      fail(
        "INVALID_FIXTURE_STATE",
        qualificationBlock.reason === "ACTIVE_PAIRING"
          ? "A confirmed group result between two active Entries cannot be voided before knockout qualification; submit a correction instead."
          : "The group-stage fixture has invalid participant identities and cannot be voided safely.",
        {
          fixtureId: aggregate.fixture.id,
          format: aggregate.match.format,
          ...qualificationBlock,
        },
      );
    }
    const pendingSuccessor = await tx.resultRevision.findFirst({
      where: {
        supersedesRevisionId: revision.id,
        status: "PENDING",
      },
      select: { id: true },
    });
    if (pendingSuccessor !== null) {
      fail(
        "INVALID_CORRECTION",
        "Void the pending correction before voiding its confirmed predecessor.",
        {
          resultRevisionId: revision.id,
          pendingSuccessorId: pendingSuccessor.id,
        },
      );
    }
  }

  assertResultRevisionStatusTransition(revision.status, "VOIDED");
  const changed = await tx.resultRevision.updateMany({
    where: { id: revision.id, status: revision.status },
    data: {
      status: "VOIDED",
      verifiedById: command.actor.actorId,
      reason: normalizeReason(command.reason) ?? revision.reason,
      resolvedAt: now,
    },
  });
  if (changed.count !== 1) {
    fail(
      "INVALID_RESULT_REVISION_STATE",
      "The result revision changed before it could be voided.",
      { resultRevisionId: revision.id },
    );
  }

  if (revision.status === "CONFIRMED") {
    if (revision.resolutionKind === "PLAYED") {
      await reverseResultSettlement(tx, {
        resultRevisionId: revision.id,
        pointsPolicy: dependencies.pointsPolicy,
        clock: () => now,
      });
    }
    assertFixtureStatusTransition(aggregate.fixture.status, "VOIDED");
    await bumpFixtureVersion(
      tx,
      aggregate.fixture,
      command.expectedFixtureVersion,
      { status: "VOIDED" },
    );
    await finishV2GroupOnlyMatchIfTerminal(tx, aggregate.match);
  } else {
    await bumpFixtureVersion(
      tx,
      aggregate.fixture,
      command.expectedFixtureVersion,
    );
  }
  return tx.resultRevision.findUniqueOrThrow({ where: { id: revision.id } });
}

/**
 * Creates a framework-independent V2 result service. All writes run at
 * SERIALIZABLE isolation and every command re-checks the actor, match engine,
 * fixture version, authorization, and frozen roster inside that transaction.
 */
export function createV2ResultApplicationService(
  dependencies: V2ResultApplicationServiceDependencies,
): V2ResultApplicationService {
  const clock = dependencies.clock ?? (() => new Date());
  const pointsPolicy =
    dependencies.pointsPolicy ?? legacyCompatibleResultPointsPolicy;
  const inTransaction = async <T>(
    operation: (
      tx: ResultSettlementTransaction,
      clock: ResultSettlementClock,
    ) => Promise<T>,
  ) => {
    try {
      return await dependencies.db.$transaction(
        (tx) => operation(tx, clock),
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      throw mapV2ResultPersistenceError(error);
    }
  };

  return Object.freeze({
    submitRevision: (command) =>
      inTransaction((tx, resultClock) =>
        submitRevisionInTransaction(tx, command, resultClock),
      ),
    submitCorrection: (command) =>
      inTransaction((tx, resultClock) =>
        submitCorrectionInTransaction(tx, command, resultClock),
      ),
    confirmRevision: (command) =>
      inTransaction((tx, resultClock) =>
        confirmRevisionInTransaction(
          tx,
          command,
          { pointsPolicy },
          resultClock,
        ),
      ),
    rejectRevision: (command) =>
      inTransaction((tx, resultClock) =>
        rejectRevisionInTransaction(tx, command, resultClock),
      ),
    voidRevision: (command) =>
      inTransaction((tx, resultClock) =>
        voidRevisionInTransaction(
          tx,
          command,
          { pointsPolicy },
          resultClock,
        ),
      ),
    confirmForfeit: (command) =>
      inTransaction((tx, resultClock) =>
        confirmForfeitInTransaction(tx, command, resultClock),
      ),
    correctForfeit: (command) =>
      inTransaction((tx, resultClock) =>
        correctForfeitInTransaction(tx, command, resultClock),
      ),
  });
}


/** Marks physical play without changing score state; roster replacements must preserve it. */
export async function startCompetitionFixture(
  db: V2ResultDatabase,
  command: ResultCommandTarget,
) {
  assertTargetCommand(command);
  try {
    return await db.$transaction(async tx => {
      const aggregate = await lockAggregate(tx, command.matchId, command.fixtureId, command.requiredFixtureStage);
      assertFixtureVersion(aggregate.fixture, command.expectedFixtureVersion);
      if (aggregate.match.status === "finished" || aggregate.fixture.status !== "READY") {
        fail("INVALID_FIXTURE_STATE", "只有待比赛的场次可以开始。");
      }
      await assertQualificationSourceHistoryMutable(tx, aggregate);
      if (aggregate.fixture.stage === "KNOCKOUT") {
        await assertV2KnockoutResultMayStart(tx, aggregate.match, aggregate.fixture.id);
      }
      const roster = await resolveFrozenFixtureRoster(tx, aggregate.fixture);
      assertRosterKindMatchesMatchType(aggregate.match.type, roster);
      assertInitialResultEntriesActive(roster);
      await assertFixtureLineupMatchesFrozenRoster(tx, aggregate.fixture, roster);
      const locked = await loadAndLockActorUsers(tx, command.actor, roster.allUserIds);
      assertResultActorCanSubmit(locked.actor, aggregate.match, roster, false);
      if (locked.users.some(user => roster.allUserIds.includes(user.id) && (user.isBanned || !user.emailVerifiedAt))) {
        fail("PARTICIPANT_BANNED", "参赛成员当前无法比赛。");
      }
      const existing = await tx.matchFixture.findUniqueOrThrow({ where: { id: command.fixtureId }, select: { startedAt: true, resultRevisions: { select: { id: true }, take: 1 } } });
      if (existing.startedAt) return { startedAt: existing.startedAt };
      if (existing.resultRevisions.length) fail("INVALID_FIXTURE_STATE", "本场已有报分记录，请先处理成绩。");
      const startedAt = new Date();
      await tx.matchFixture.update({ where: { id: command.fixtureId }, data: { startedAt, version: { increment: 1 } } });
      await tx.auditLog.create({ data: { actorId: command.actor.actorId, action: "competition_fixture_start", entityType: "MatchFixture", entityId: command.fixtureId, details: { matchId: command.matchId } } });
      return { startedAt };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) { throw mapV2ResultPersistenceError(error); }
}
