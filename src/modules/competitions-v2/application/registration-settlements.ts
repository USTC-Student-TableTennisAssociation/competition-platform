import {
  Prisma,
  type MatchEntryKind,
  type SettlementEffect,
  type SettlementEvent,
  type User,
} from "@prisma/client";

const MATCH_POINTS_REFERENCE_PREFIX = "match-points:";
const LEGACY_MATCH_POINTS_CAP = 5;
const LEGACY_REGISTRATION_REWARD = 1;
const INT32_MAX = 2_147_483_647;

export type RegistrationSettlementTransaction = Prisma.TransactionClient;

export type RegistrationSettlementOrigin = "STANDARD" | "ADMIN_BULK";

export type RegistrationSettlementErrorCode =
  | "INVALID_COMMAND"
  | "MATCH_ENTRY_NOT_FOUND"
  | "ENGINE_MISMATCH"
  | "INVALID_ENTRY_STATE"
  | "INVALID_ROSTER"
  | "SETTLEMENT_STATE_CONFLICT"
  | "AGGREGATE_INVARIANT_VIOLATION";

export class RegistrationSettlementError extends Error {
  readonly code: RegistrationSettlementErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: RegistrationSettlementErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "RegistrationSettlementError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export type RegistrationSettlementEventKind =
  | "REGISTRATION_APPLY"
  | "REGISTRATION_REVERSAL";

type RegistrationEntrySubject = Readonly<{
  id: string;
  matchId: string;
  kind: MatchEntryKind;
  status: string;
  rosterVersion: number;
  members: readonly Readonly<{
    id: string;
    entryId: string;
    matchId: string;
    userId: string;
    rosterVersion: number;
    status: string;
    effectiveUntil: Date | null;
  }>[];
  userIds: readonly string[];
}>;

type LockedRegistrationUser = Pick<User, "id" | "points">;

export type RegistrationSettlementEffectView = Pick<
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

export type RegistrationSettlementOutcome = Readonly<{
  event: SettlementEvent;
  effects: readonly RegistrationSettlementEffectView[];
  wasNoop: boolean;
}>;

export type ApplyRegistrationSettlementInput = Readonly<{
  matchId: string;
  matchEntryId: string;
  rosterVersion: number;
  origin: RegistrationSettlementOrigin;
  clock?: () => Date;
}>;

export type ReverseRegistrationSettlementInput = Readonly<{
  matchId: string;
  matchEntryId: string;
  rosterVersion: number;
  clock?: () => Date;
}>;

type LoadedRegistrationEvent = SettlementEvent & {
  effects: SettlementEffect[];
};

function fail(
  code: RegistrationSettlementErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new RegistrationSettlementError(code, message, details);
}

function assertStableIdentifier(value: string, name: string) {
  if (value.trim() !== "" && value === value.trim()) return;
  fail("INVALID_COMMAND", `${name} must be a non-empty stable identifier.`, {
    name,
  });
}

function assertRosterVersion(rosterVersion: number) {
  if (Number.isSafeInteger(rosterVersion) && rosterVersion >= 1) return;
  fail("INVALID_COMMAND", "rosterVersion must be a positive safe integer.", {
    rosterVersion,
  });
}

function assertOrigin(origin: RegistrationSettlementOrigin) {
  if (origin === "STANDARD" || origin === "ADMIN_BULK") return;
  fail("INVALID_COMMAND", "Unknown registration settlement origin.", {
    origin,
  });
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function encodeKeyPart(value: string) {
  return encodeURIComponent(value);
}

/**
 * The roster version is the activation-cycle identity. A later reactivation
 * must use a new version and therefore receives a distinct pair of events.
 */
export function createRegistrationSettlementIdempotencyKey(
  matchEntryId: string,
  rosterVersion: number,
  kind: RegistrationSettlementEventKind,
) {
  assertStableIdentifier(matchEntryId, "matchEntryId");
  assertRosterVersion(rosterVersion);
  if (kind !== "REGISTRATION_APPLY" && kind !== "REGISTRATION_REVERSAL") {
    fail("INVALID_COMMAND", "Unknown registration settlement event kind.", {
      kind,
    });
  }
  return `competition-v2:match-entry:${encodeKeyPart(matchEntryId)}:roster:${rosterVersion}:${kind}`;
}

function assertInt32NonNegative(
  value: number,
  name: string,
  details: Readonly<Record<string, unknown>>,
) {
  if (
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= INT32_MAX
  ) {
    return;
  }
  fail(
    "AGGREGATE_INVARIANT_VIOLATION",
    `${name} must be a non-negative PostgreSQL Int value.`,
    { ...details, value },
  );
}

/**
 * Contract: the caller already owns locks for Match and MatchEntry. This helper
 * deliberately starts with roster validation and then locks users in stable ID
 * order, so it can be composed into an Entry command without changing the
 * global Match -> Entry -> User lock order.
 */
async function loadRegistrationSubject(
  tx: RegistrationSettlementTransaction,
  input: Readonly<{
    matchId: string;
    matchEntryId: string;
    rosterVersion: number;
  }>,
): Promise<RegistrationEntrySubject> {
  const entry = await tx.matchEntry.findFirst({
    where: { id: input.matchEntryId, matchId: input.matchId },
    select: {
      id: true,
      matchId: true,
      kind: true,
      status: true,
      match: {
        select: { id: true, engineVersion: true, isQuickMatch: true },
      },
      members: {
        where: { rosterVersion: input.rosterVersion },
        orderBy: [{ userId: "asc" }, { slot: "asc" }],
        select: {
          id: true,
          entryId: true,
          matchId: true,
          userId: true,
          rosterVersion: true,
          status: true,
          effectiveUntil: true,
        },
      },
    },
  });

  if (entry === null) {
    fail(
      "MATCH_ENTRY_NOT_FOUND",
      "The registration settlement entry does not belong to the requested match.",
      input,
    );
  }
  if (entry.match.id !== input.matchId || entry.matchId !== input.matchId) {
    fail(
      "MATCH_ENTRY_NOT_FOUND",
      "The registration settlement entry has an inconsistent match identity.",
      input,
    );
  }
  if (entry.match.engineVersion !== "V2") {
    fail(
      "ENGINE_MISMATCH",
      "Registration settlement rejects a legacy match.",
      { matchId: input.matchId, engineVersion: entry.match.engineVersion },
    );
  }
  if (entry.match.isQuickMatch) {
    fail(
      "ENGINE_MISMATCH",
      "Registration settlement rejects quick matches.",
      {
        matchId: input.matchId,
        engineVersion: entry.match.engineVersion,
        isQuickMatch: true,
      },
    );
  }

  const userIds = entry.members.map((member) => member.userId);
  const expectedMemberCount =
    entry.kind === "INDIVIDUAL" ? 1 : entry.kind === "DOUBLES" ? 2 : null;
  const malformedMember = entry.members.find(
    (member) =>
      member.entryId !== entry.id ||
      member.matchId !== entry.matchId ||
      member.rosterVersion !== input.rosterVersion,
  );
  if (
    entry.members.length === 0 ||
    (expectedMemberCount !== null && entry.members.length !== expectedMemberCount) ||
    new Set(userIds).size !== userIds.length ||
    malformedMember !== undefined
  ) {
    fail(
      "INVALID_ROSTER",
      "The requested roster version is missing, duplicated, or incompatible with the entry kind.",
      {
        matchEntryId: entry.id,
        entryKind: entry.kind,
        rosterVersion: input.rosterVersion,
        memberCount: entry.members.length,
      },
    );
  }

  return {
    id: entry.id,
    matchId: entry.matchId,
    kind: entry.kind,
    status: entry.status,
    rosterVersion: input.rosterVersion,
    members: Object.freeze(entry.members),
    userIds: Object.freeze(uniqueSorted(userIds)),
  };
}

function assertRosterIsActive(subject: RegistrationEntrySubject) {
  const inactive = subject.members.find(
    (member) => member.status !== "ACTIVE" || member.effectiveUntil !== null,
  );
  if (subject.status === "ACTIVE" && inactive === undefined) return;
  fail(
    "INVALID_ENTRY_STATE",
    "A registration reward can be applied only to the active roster of an active entry.",
    {
      matchEntryId: subject.id,
      entryStatus: subject.status,
      rosterVersion: subject.rosterVersion,
      inactiveMemberId: inactive?.id ?? null,
    },
  );
}

async function lockAndLoadUsers(
  tx: RegistrationSettlementTransaction,
  userIds: readonly string[],
): Promise<readonly LockedRegistrationUser[]> {
  const sortedIds = uniqueSorted(userIds);
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
    select: { id: true, points: true },
  });
  if (users.length !== sortedIds.length) {
    const found = new Set(users.map((user) => user.id));
    fail("INVALID_ROSTER", "The registration roster references a missing user.", {
      missingUserIds: sortedIds.filter((userId) => !found.has(userId)),
    });
  }
  for (const user of users) {
    assertInt32NonNegative(user.points, "points", { userId: user.id });
  }
  return users;
}

async function loadNetPointTotals(
  tx: RegistrationSettlementTransaction,
  matchId: string,
  userIds: readonly string[],
) {
  const matchTotals = new Map(userIds.map((userId) => [userId, 0]));
  const registrationTotals = new Map(userIds.map((userId) => [userId, 0]));
  const matchPrefix = `${MATCH_POINTS_REFERENCE_PREFIX}${matchId}:`;
  const registrationPrefix = `${matchPrefix}register:`;
  const transactions = await tx.pointsTransaction.findMany({
    where: {
      userId: { in: [...userIds] },
      referenceId: { startsWith: matchPrefix },
    },
    select: { userId: true, amount: true, referenceId: true },
  });
  for (const transaction of transactions) {
    const matchTotal =
      (matchTotals.get(transaction.userId) ?? 0) + transaction.amount;
    if (!Number.isSafeInteger(matchTotal)) {
      fail(
        "AGGREGATE_INVARIANT_VIOLATION",
        "The match points ledger total is outside the safe integer range.",
        { matchId, userId: transaction.userId, total: matchTotal },
      );
    }
    matchTotals.set(transaction.userId, matchTotal);

    if (transaction.referenceId?.startsWith(registrationPrefix)) {
      const registrationTotal =
        (registrationTotals.get(transaction.userId) ?? 0) + transaction.amount;
      if (!Number.isSafeInteger(registrationTotal)) {
        fail(
          "AGGREGATE_INVARIANT_VIOLATION",
          "The registration points ledger total is outside the safe integer range.",
          { matchId, userId: transaction.userId, total: registrationTotal },
        );
      }
      registrationTotals.set(transaction.userId, registrationTotal);
    }
  }
  return { matchTotals, registrationTotals };
}

function pointsProjectionReference(
  matchId: string,
  matchEntryId: string,
  rosterVersion: number,
  kind: RegistrationSettlementEventKind,
  userId: string,
) {
  return `${MATCH_POINTS_REFERENCE_PREFIX}${matchId}:register:v2:${matchEntryId}:${rosterVersion}:${kind}:${userId}`;
}

function metadataRecord(metadata: Prisma.JsonValue | null) {
  if (
    metadata !== null &&
    typeof metadata === "object" &&
    !Array.isArray(metadata)
  ) {
    return metadata as Prisma.JsonObject;
  }
  return null;
}

function validateEventMetadata(
  event: SettlementEvent,
  subject: RegistrationEntrySubject,
) {
  const metadata = metadataRecord(event.metadata);
  if (
    metadata?.schemaVersion === 1 &&
    metadata.matchId === subject.matchId &&
    metadata.entryKind === subject.kind &&
    metadata.rosterVersion === subject.rosterVersion &&
    (metadata.origin === "STANDARD" || metadata.origin === "ADMIN_BULK")
  ) {
    return metadata.origin as RegistrationSettlementOrigin;
  }
  fail(
    "SETTLEMENT_STATE_CONFLICT",
    "The registration settlement metadata does not identify the requested activation cycle.",
    { eventId: event.id, matchEntryId: subject.id },
  );
}

function validateEventSubject(
  event: SettlementEvent,
  subject: RegistrationEntrySubject,
  expected: Readonly<{
    kind: RegistrationSettlementEventKind;
    reversesEventId: string | null;
    allowedStatuses: readonly SettlementEvent["status"][];
  }>,
) {
  if (
    event.kind === expected.kind &&
    event.matchEntryId === subject.id &&
    event.resultRevisionId === null &&
    event.reversesEventId === expected.reversesEventId &&
    expected.allowedStatuses.includes(event.status)
  ) {
    return;
  }
  fail(
    "SETTLEMENT_STATE_CONFLICT",
    "A registration settlement event has an invalid subject, kind, status, or reversal parent.",
    {
      eventId: event.id,
      expectedKind: expected.kind,
      actualKind: event.kind,
      status: event.status,
      matchEntryId: subject.id,
    },
  );
}

function validateEffectShape(
  effect: SettlementEffect,
  eventId: string,
  allowedPointDeltas: readonly number[],
) {
  const validPoints =
    effect.pointsBefore !== null &&
    effect.pointsAfter !== null &&
    effect.pointsDelta !== null &&
    effect.pointsAfter - effect.pointsBefore === effect.pointsDelta &&
    allowedPointDeltas.includes(effect.pointsDelta);
  if (
    effect.eventId === eventId &&
    effect.eloBefore === null &&
    effect.eloAfter === null &&
    effect.eloDelta === null &&
    validPoints &&
    effect.winsDelta === 0 &&
    effect.lossesDelta === 0 &&
    effect.matchesPlayedDelta === 0
  ) {
    return;
  }
  fail(
    "SETTLEMENT_STATE_CONFLICT",
    "A registration settlement effect is incomplete or changes a non-points aggregate.",
    {
      eventId,
      effectId: effect.id,
      userId: effect.userId,
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
  );
}

function validateEventEffects(
  event: LoadedRegistrationEvent,
  subject: RegistrationEntrySubject,
  allowedPointDeltas: readonly number[],
) {
  const effectUserIds = event.effects.map((effect) => effect.userId);
  if (
    event.effects.length !== subject.userIds.length ||
    new Set(effectUserIds).size !== effectUserIds.length ||
    subject.userIds.some((userId) => !effectUserIds.includes(userId))
  ) {
    fail(
      "SETTLEMENT_STATE_CONFLICT",
      "The registration event does not contain exactly one effect per roster member.",
      { eventId: event.id, matchEntryId: subject.id },
    );
  }
  for (const effect of event.effects) {
    validateEffectShape(effect, event.id, allowedPointDeltas);
  }
}

async function loadEventByKey(
  tx: RegistrationSettlementTransaction,
  idempotencyKey: string,
): Promise<LoadedRegistrationEvent | null> {
  return tx.settlementEvent.findUnique({
    where: { idempotencyKey },
    include: { effects: { orderBy: { userId: "asc" } } },
  });
}

function existingOutcome(
  event: LoadedRegistrationEvent,
): RegistrationSettlementOutcome {
  return { event, effects: event.effects, wasNoop: true };
}

type PointMutation = Readonly<{
  user: LockedRegistrationUser;
  pointsDelta: number;
}>;

async function persistPointEffects(
  tx: RegistrationSettlementTransaction,
  input: Readonly<{
    eventId: string;
    matchId: string;
    matchEntryId: string;
    rosterVersion: number;
    kind: RegistrationSettlementEventKind;
    mutations: readonly PointMutation[];
  }>,
) {
  const effects: RegistrationSettlementEffectView[] = [];
  for (const mutation of [...input.mutations].sort((left, right) =>
    left.user.id.localeCompare(right.user.id),
  )) {
    const pointsAfter = mutation.user.points + mutation.pointsDelta;
    assertInt32NonNegative(pointsAfter, "points", {
      userId: mutation.user.id,
      eventId: input.eventId,
    });

    if (mutation.pointsDelta !== 0) {
      await tx.user.update({
        where: { id: mutation.user.id },
        data: { points: pointsAfter },
      });
    }

    const effect = await tx.settlementEffect.create({
      data: {
        eventId: input.eventId,
        userId: mutation.user.id,
        eloBefore: null,
        eloAfter: null,
        eloDelta: null,
        pointsBefore: mutation.user.points,
        pointsAfter,
        pointsDelta: mutation.pointsDelta,
        winsDelta: 0,
        lossesDelta: 0,
        matchesPlayedDelta: 0,
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
    effects.push(effect);

    if (mutation.pointsDelta !== 0) {
      await tx.pointsTransaction.create({
        data: {
          userId: mutation.user.id,
          amount: mutation.pointsDelta,
          balanceAfter: pointsAfter,
          type: mutation.pointsDelta > 0 ? "earn" : "refund",
          reason:
            input.kind === "REGISTRATION_APPLY"
              ? "比赛报名奖励（V2）"
              : "比赛报名取消退款（V2）",
          referenceId: pointsProjectionReference(
            input.matchId,
            input.matchEntryId,
            input.rosterVersion,
            input.kind,
            mutation.user.id,
          ),
        },
      });
    }
  }
  return effects;
}

/**
 * Records the registration activation and its per-user compatibility reward.
 * The caller must invoke this inside the same transaction that activates the
 * Entry and after the new roster version has become ACTIVE.
 */
export async function applyRegistrationSettlement(
  tx: RegistrationSettlementTransaction,
  input: ApplyRegistrationSettlementInput,
): Promise<RegistrationSettlementOutcome> {
  assertStableIdentifier(input.matchId, "matchId");
  assertStableIdentifier(input.matchEntryId, "matchEntryId");
  assertRosterVersion(input.rosterVersion);
  assertOrigin(input.origin);

  const subject = await loadRegistrationSubject(tx, input);
  const idempotencyKey = createRegistrationSettlementIdempotencyKey(
    subject.id,
    subject.rosterVersion,
    "REGISTRATION_APPLY",
  );
  const existing = await loadEventByKey(tx, idempotencyKey);
  if (existing !== null) {
    validateEventSubject(existing, subject, {
      kind: "REGISTRATION_APPLY",
      reversesEventId: null,
      allowedStatuses: ["APPLIED"],
    });
    const recordedOrigin = validateEventMetadata(existing, subject);
    if (recordedOrigin !== input.origin) {
      fail(
        "SETTLEMENT_STATE_CONFLICT",
        "An idempotent registration retry changed its reward origin.",
        { eventId: existing.id, recordedOrigin, requestedOrigin: input.origin },
      );
    }
    validateEventEffects(existing, subject, [0, 1]);
    return existingOutcome(existing);
  }

  assertRosterIsActive(subject);
  const users = await lockAndLoadUsers(tx, subject.userIds);
  const { matchTotals, registrationTotals } = await loadNetPointTotals(
    tx,
    subject.matchId,
    subject.userIds,
  );
  const rewardEligible =
    input.origin === "STANDARD" && subject.kind !== "TEAM";
  const mutations = users.map((user): PointMutation => {
    const netMatchPoints = matchTotals.get(user.id) ?? 0;
    const netRegistrationPoints = registrationTotals.get(user.id) ?? 0;
    const pointsDelta = rewardEligible
      ? Math.max(
          0,
          Math.min(
            LEGACY_REGISTRATION_REWARD - netRegistrationPoints,
            LEGACY_MATCH_POINTS_CAP - netMatchPoints,
          ),
        )
      : 0;
    return { user, pointsDelta };
  });
  const now = (input.clock ?? (() => new Date()))();
  const event = await tx.settlementEvent.create({
    data: {
      idempotencyKey,
      kind: "REGISTRATION_APPLY",
      status: "PENDING",
      resultRevisionId: null,
      matchEntryId: subject.id,
      reversesEventId: null,
      metadata: {
        schemaVersion: 1,
        matchId: subject.matchId,
        entryKind: subject.kind,
        rosterVersion: subject.rosterVersion,
        origin: input.origin,
        rewardPerEligibleMember: LEGACY_REGISTRATION_REWARD,
        matchPointsCap: LEGACY_MATCH_POINTS_CAP,
      },
    },
  });
  const effects = await persistPointEffects(tx, {
    eventId: event.id,
    matchId: subject.matchId,
    matchEntryId: subject.id,
    rosterVersion: subject.rosterVersion,
    kind: "REGISTRATION_APPLY",
    mutations,
  });
  const appliedEvent = await tx.settlementEvent.update({
    where: { id: event.id },
    data: { status: "APPLIED", appliedAt: now },
  });
  return { event: appliedEvent, effects, wasNoop: false };
}

/**
 * Reverses only the reward recorded for this activation cycle. Spending after
 * registration is never undone beyond the current balance; any unrecovered
 * amount remains explicit in event metadata.
 */
export async function reverseRegistrationSettlement(
  tx: RegistrationSettlementTransaction,
  input: ReverseRegistrationSettlementInput,
): Promise<RegistrationSettlementOutcome> {
  assertStableIdentifier(input.matchId, "matchId");
  assertStableIdentifier(input.matchEntryId, "matchEntryId");
  assertRosterVersion(input.rosterVersion);

  const subject = await loadRegistrationSubject(tx, input);
  const applicationKey = createRegistrationSettlementIdempotencyKey(
    subject.id,
    subject.rosterVersion,
    "REGISTRATION_APPLY",
  );
  const reversalKey = createRegistrationSettlementIdempotencyKey(
    subject.id,
    subject.rosterVersion,
    "REGISTRATION_REVERSAL",
  );
  const [application, existingReversal] = await Promise.all([
    loadEventByKey(tx, applicationKey),
    loadEventByKey(tx, reversalKey),
  ]);
  if (application === null) {
    fail(
      "SETTLEMENT_STATE_CONFLICT",
      "A registration reversal requires its activation event.",
      { matchEntryId: subject.id, rosterVersion: subject.rosterVersion },
    );
  }

  const origin = validateEventMetadata(application, subject);
  validateEventEffects(application, subject, [0, 1]);
  if (existingReversal !== null) {
    validateEventSubject(application, subject, {
      kind: "REGISTRATION_APPLY",
      reversesEventId: null,
      allowedStatuses: ["REVERSED"],
    });
    validateEventSubject(existingReversal, subject, {
      kind: "REGISTRATION_REVERSAL",
      reversesEventId: application.id,
      allowedStatuses: ["APPLIED"],
    });
    const reversalOrigin = validateEventMetadata(existingReversal, subject);
    if (reversalOrigin !== origin) {
      fail(
        "SETTLEMENT_STATE_CONFLICT",
        "A registration reversal changed its activation origin.",
        { eventId: existingReversal.id },
      );
    }
    validateEventEffects(existingReversal, subject, [-1, 0]);
    return existingOutcome(existingReversal);
  }

  validateEventSubject(application, subject, {
    kind: "REGISTRATION_APPLY",
    reversesEventId: null,
    allowedStatuses: ["APPLIED"],
  });
  const users = await lockAndLoadUsers(tx, subject.userIds);
  const originalEffects = new Map(
    application.effects.map((effect) => [effect.userId, effect]),
  );
  const unrecoveredPoints: Array<{ userId: string; amount: number }> = [];
  const mutations = users.map((user): PointMutation => {
    const original = originalEffects.get(user.id);
    if (original?.pointsDelta === null || original === undefined) {
      fail(
        "SETTLEMENT_STATE_CONFLICT",
        "The registration application is missing a roster member effect.",
        { eventId: application.id, userId: user.id },
      );
    }
    const originalAward = original.pointsDelta;
    const deduction = Math.min(originalAward, user.points);
    const unrecovered = originalAward - deduction;
    if (unrecovered > 0) {
      unrecoveredPoints.push({ userId: user.id, amount: unrecovered });
    }
    return { user, pointsDelta: deduction === 0 ? 0 : -deduction };
  });
  const now = (input.clock ?? (() => new Date()))();
  const event = await tx.settlementEvent.create({
    data: {
      idempotencyKey: reversalKey,
      kind: "REGISTRATION_REVERSAL",
      status: "PENDING",
      resultRevisionId: null,
      matchEntryId: subject.id,
      reversesEventId: application.id,
      metadata: {
        schemaVersion: 1,
        matchId: subject.matchId,
        entryKind: subject.kind,
        rosterVersion: subject.rosterVersion,
        origin,
        unrecoveredPoints,
        unrecoveredPointsTotal: unrecoveredPoints.reduce(
          (total, item) => total + item.amount,
          0,
        ),
      },
    },
  });
  const effects = await persistPointEffects(tx, {
    eventId: event.id,
    matchId: subject.matchId,
    matchEntryId: subject.id,
    rosterVersion: subject.rosterVersion,
    kind: "REGISTRATION_REVERSAL",
    mutations,
  });
  await tx.settlementEvent.update({
    where: { id: application.id },
    data: { status: "REVERSED" },
  });
  const appliedEvent = await tx.settlementEvent.update({
    where: { id: event.id },
    data: { status: "APPLIED", appliedAt: now },
  });
  return { event: appliedEvent, effects, wasNoop: false };
}
