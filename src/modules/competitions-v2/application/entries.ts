import { Prisma, type PrismaClient } from "@prisma/client";

import {
  CompetitionDomainError,
  assertEngineCanWrite,
  assertEntryCanActivate,
  assertEntryMemberSnapshotMutationAllowed,
  assertEntryStatusTransition,
  assertSuccessorRosterCanBeCreated,
  createEntrySourceKey,
} from "../domain";
import type { EngineVersion, EntryKind, EntryStatus } from "../domain";
import {
  applyRegistrationSettlement,
  reverseRegistrationSettlement,
} from "./registration-settlements";
import type {
  ApplyRegistrationSettlementInput,
  RegistrationSettlementOrigin,
  ReverseRegistrationSettlementInput,
} from "./registration-settlements";

export type V2Actor = Readonly<{
  id: string;
  role: "user" | "admin";
}>;

export type V2CompetitionDatabase = Pick<PrismaClient, "$transaction">;
export type V2CompetitionTransaction = Prisma.TransactionClient;

/**
 * @internal Trusted composition seam for deterministic application tests.
 * Route/API adapters must omit this dependency and use the default atomic
 * registration settlement implementation; injecting a no-op would violate
 * the Entry/points invariant.
 */
export type V2EntrySettlementPort = Readonly<{
  apply(
    tx: V2CompetitionTransaction,
    input: ApplyRegistrationSettlementInput,
  ): Promise<unknown>;
  reverse(
    tx: V2CompetitionTransaction,
    input: ReverseRegistrationSettlementInput,
  ): Promise<unknown>;
}>;

const DEFAULT_ENTRY_SETTLEMENT_PORT: V2EntrySettlementPort = {
  apply: applyRegistrationSettlement,
  reverse: reverseRegistrationSettlement,
};

export type V2CompetitionApplicationErrorCode =
  | "MATCH_NOT_FOUND"
  | "ACTOR_NOT_ACTIVE"
  | "ACTOR_ROLE_STALE"
  | "FORBIDDEN"
  | "REGISTRATION_CLOSED"
  | "INVALID_INPUT"
  | "ENTRY_NOT_FOUND"
  | "ENTRY_SOURCE_NOT_FOUND"
  | "ENTRY_SOURCE_NOT_ACTIVE"
  | "ENTRY_KIND_MATCH_TYPE_MISMATCH"
  | "ENTRY_MEMBER_CONFLICT"
  | "ENTRY_VERSION_CONFLICT"
  | "ENTRY_ROSTER_CORRUPT"
  | "FIXTURE_NOT_FOUND"
  | "FIXTURE_CREATION_NOT_ALLOWED"
  | "FIXTURE_VERSION_CONFLICT"
  | "FIXTURE_KEY_CONFLICT"
  | "FIXTURE_ENTRY_INVALID"
  | "FIXTURE_LINEUP_INVALID"
  | "FIXTURE_LINEUP_FROZEN"
  | "FIXTURE_RESULT_REQUIRED"
  | "PENDING_RESULT_REQUIRES_REVIEW"
  | "FIXTURE_RESULT_MANAGED_STATUS"
  | "FIXTURE_STAGE_NOT_ALLOWED"
  | "FIXTURE_DEPENDENCY_INVALID"
  | "FIXTURE_DEPENDENCY_CONFLICT"
  | "FIXTURE_DEPENDENCY_CYCLE"
  | "CONCURRENT_WRITE_CONFLICT"
  | "PERSISTENCE_CONFLICT";

export class V2CompetitionApplicationError extends Error {
  readonly code: V2CompetitionApplicationErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: V2CompetitionApplicationErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "V2CompetitionApplicationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export type V2WriteContext = Readonly<{
  actor: Readonly<{
    id: string;
    role: "user" | "admin";
  }>;
  match: Readonly<{
    id: string;
    engineVersion: "LEGACY" | "V2";
    isQuickMatch: boolean;
    type: "single" | "double" | "team";
    status: "registration" | "ongoing" | "finished";
    format: "group_only" | "group_then_knockout";
    createdBy: string;
    createdAt: Date;
    registrationDeadline: Date;
    teamRegistrationStart: Date | null;
    teamRegistrationDeadline: Date | null;
    teamMinMembers: number | null;
    teamMaxMembers: number | null;
  }>;
  isManager: boolean;
}>;

function persistenceErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function postgresErrorCode(error: unknown) {
  if (
    !error ||
    typeof error !== "object" ||
    !("meta" in error) ||
    !error.meta ||
    typeof error.meta !== "object" ||
    !("code" in error.meta)
  ) {
    return null;
  }
  return typeof error.meta.code === "string" ? error.meta.code : null;
}

/**
 * Every V2 mutation uses one serializable interactive transaction. Optimistic
 * versions provide stable conflict reporting; database unique constraints are
 * the final guard for concurrent creates.
 */
export async function runV2Transaction<T>(
  db: V2CompetitionDatabase,
  operation: (tx: V2CompetitionTransaction) => Promise<T>,
) {
  try {
    return await db.$transaction(operation, {
      isolationLevel: "Serializable",
      maxWait: 5_000,
      timeout: 10_000,
    });
  } catch (error) {
    if (error instanceof V2CompetitionApplicationError) throw error;
    const code = persistenceErrorCode(error);
    const databaseCode = postgresErrorCode(error);
    if (
      code === "P2034" ||
      (code === "P2010" &&
        (databaseCode === "40001" || databaseCode === "40P01"))
    ) {
      throw new V2CompetitionApplicationError(
        "CONCURRENT_WRITE_CONFLICT",
        "The competition changed concurrently; reload and retry.",
        { persistenceCode: code, databaseCode },
      );
    }
    if (code === "P2002" || code === "P2003") {
      throw new V2CompetitionApplicationError(
        "PERSISTENCE_CONFLICT",
        "The competition write conflicts with an existing identity or relation.",
        { persistenceCode: code },
      );
    }
    throw error;
  }
}

/** Reloads both authorization and match-engine state inside the write transaction. */
export async function loadV2WriteContext(
  tx: V2CompetitionTransaction,
  matchId: string,
  actorInput: V2Actor,
): Promise<V2WriteContext> {
  const lockedMatch = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "Match" WHERE "id" = ${matchId} FOR UPDATE`,
  );
  if (lockedMatch.length === 0) {
    throw new V2CompetitionApplicationError(
      "MATCH_NOT_FOUND",
      "The match does not exist.",
      { matchId },
    );
  }

  const lockedActor = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${actorInput.id} FOR UPDATE`,
  );
  if (lockedActor.length === 0) {
    throw new V2CompetitionApplicationError(
      "ACTOR_NOT_ACTIVE",
      "The actor is missing, banned, or not verified.",
      { actorId: actorInput.id },
    );
  }

  const actor = await tx.user.findUnique({
    where: { id: actorInput.id },
    select: {
      id: true,
      role: true,
      isBanned: true,
      emailVerifiedAt: true,
    },
  });
  if (!actor || actor.isBanned || !actor.emailVerifiedAt) {
    throw new V2CompetitionApplicationError(
      "ACTOR_NOT_ACTIVE",
      "The actor is missing, banned, or not verified.",
      { actorId: actorInput.id },
    );
  }
  if (actor.role !== actorInput.role) {
    throw new V2CompetitionApplicationError(
      "ACTOR_ROLE_STALE",
      "The supplied actor role no longer matches the database.",
      { actorId: actorInput.id },
    );
  }

  const match = await tx.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      engineVersion: true,
      isQuickMatch: true,
      type: true,
      status: true,
      format: true,
      createdBy: true,
      createdAt: true,
      registrationDeadline: true,
      teamRegistrationStart: true,
      teamRegistrationDeadline: true,
      teamMinMembers: true,
      teamMaxMembers: true,
    },
  });
  if (!match) {
    throw new V2CompetitionApplicationError(
      "MATCH_NOT_FOUND",
      "The match does not exist.",
      { matchId },
    );
  }

  assertEngineCanWrite(match.engineVersion as EngineVersion, "V2");
  if (match.isQuickMatch) {
    throw new CompetitionDomainError(
      "ENGINE_WRITE_MISMATCH",
      "V2 cannot write a quick match; quick matches remain legacy-owned.",
      {
        matchId: match.id,
        matchEngineVersion: match.engineVersion,
        writerEngineVersion: "V2",
        isQuickMatch: true,
      },
    );
  }
  return {
    actor: { id: actor.id, role: actor.role },
    match,
    isManager: actor.role === "admin" || match.createdBy === actor.id,
  };
}

export function assertV2Manager(context: V2WriteContext) {
  if (context.isManager) return;
  throw new V2CompetitionApplicationError(
    "FORBIDDEN",
    "Only the match creator or an administrator can manage fixtures.",
    { actorId: context.actor.id, matchId: context.match.id },
  );
}

type RegistrationMutationPolicy = Readonly<{
  adminOverride?: boolean;
  overrideReason?: string;
}>;

async function assertRegistrationMutationAllowed(
  tx: V2CompetitionTransaction,
  context: V2WriteContext,
  policy: RegistrationMutationPolicy,
  operation: string,
  entityId: string,
) {
  if (policy.adminOverride === true) {
    if (context.actor.role !== "admin") {
      throw new V2CompetitionApplicationError(
        "FORBIDDEN",
        "Only a platform administrator can request a registration override.",
        { matchId: context.match.id, operation },
      );
    }
    await recordAdminOverride(tx, context, policy, operation, entityId);
    return;
  }

  const now = new Date();
  const opensAt =
    context.match.type === "team"
      ? context.match.teamRegistrationStart ?? context.match.createdAt
      : context.match.createdAt;
  const closesAt =
    context.match.type === "team"
      ? context.match.teamRegistrationDeadline ??
        context.match.registrationDeadline
      : context.match.registrationDeadline;
  const isOpen =
    context.match.status === "registration" &&
    now >= opensAt &&
    now < closesAt;
  if (isOpen) return;
  throw new V2CompetitionApplicationError(
    "REGISTRATION_CLOSED",
    "This registration operation is outside its configured window.",
    { matchId: context.match.id, operation, opensAt, closesAt },
  );
}

async function recordAdminOverride(
  tx: V2CompetitionTransaction,
  context: V2WriteContext,
  policy: RegistrationMutationPolicy,
  operation: string,
  entityId: string,
) {
  if (policy.adminOverride !== true || context.actor.role !== "admin") {
    throw new V2CompetitionApplicationError(
      "FORBIDDEN",
      "This operation requires an explicit platform-administrator override.",
      { matchId: context.match.id, operation },
    );
  }
  const reason = policy.overrideReason?.trim() ?? "";
  if (!reason) {
    throw new V2CompetitionApplicationError(
      "INVALID_INPUT",
      "An administrator override requires a non-empty reason.",
      { matchId: context.match.id, operation },
    );
  }
  await tx.auditLog.create({
    data: {
      actorId: context.actor.id,
      action: `v2_${operation}_admin_override`,
      entityType: entityId === context.match.id ? "Match" : "MatchEntry",
      entityId,
      details: { matchId: context.match.id, reason },
    },
  });
}

export type V2EntryMemberSnapshot = Readonly<{
  userId: string;
  displayNameSnapshot: string;
  role: "player" | "captain" | "substitute";
}>;

export type V2ResolvedEntrySource = Readonly<{
  displayNameSnapshot: string;
  ownerId: string;
  members: readonly V2EntryMemberSnapshot[];
}>;

function expectedEntryKind(matchType: V2WriteContext["match"]["type"]): EntryKind {
  if (matchType === "single") return "INDIVIDUAL";
  if (matchType === "double") return "DOUBLES";
  return "TEAM";
}

function assertKindMatchesMatch(
  matchType: V2WriteContext["match"]["type"],
  kind: EntryKind,
) {
  const expected = expectedEntryKind(matchType);
  if (kind === expected) return;
  throw new V2CompetitionApplicationError(
    "ENTRY_KIND_MATCH_TYPE_MISMATCH",
    `A ${matchType} match requires ${expected} entries.`,
    { matchType, kind, expected },
  );
}

function assertStableIdentifier(value: string, name: string) {
  if (value.trim() !== "" && value === value.trim()) return;
  throw new V2CompetitionApplicationError(
    "INVALID_INPUT",
    `${name} must be a non-empty stable identifier.`,
    { name },
  );
}

function assertMemberAccountsActive(source: V2ResolvedEntrySource) {
  if (source.members.length > 0) return;
  throw new V2CompetitionApplicationError(
    "ENTRY_SOURCE_NOT_ACTIVE",
    "The entry source has no eligible members.",
  );
}

async function resolveEntrySource(
  tx: V2CompetitionTransaction,
  matchId: string,
  kind: EntryKind,
  sourceId: string,
): Promise<V2ResolvedEntrySource> {
  if (kind === "INDIVIDUAL") {
    const user = await tx.user.findUnique({
      where: { id: sourceId },
      select: {
        id: true,
        nickname: true,
        isBanned: true,
        emailVerifiedAt: true,
      },
    });
    if (!user) {
      throw new V2CompetitionApplicationError(
        "ENTRY_SOURCE_NOT_FOUND",
        "The source user does not exist.",
        { kind, sourceId },
      );
    }
    if (user.isBanned || !user.emailVerifiedAt) {
      throw new V2CompetitionApplicationError(
        "ENTRY_SOURCE_NOT_ACTIVE",
        "The source user is banned or unverified.",
        { kind, sourceId },
      );
    }
    return {
      displayNameSnapshot: user.nickname,
      ownerId: user.id,
      members: [
        {
          userId: user.id,
          displayNameSnapshot: user.nickname,
          role: "player",
        },
      ],
    };
  }

  if (kind === "DOUBLES") {
    const team = await tx.matchDoublesTeam.findFirst({
      where: { id: sourceId, matchId },
      select: {
        id: true,
        createdById: true,
        members: {
          orderBy: { slot: "asc" },
          select: {
            user: {
              select: {
                id: true,
                nickname: true,
                isBanned: true,
                emailVerifiedAt: true,
              },
            },
          },
        },
      },
    });
    if (!team) {
      throw new V2CompetitionApplicationError(
        "ENTRY_SOURCE_NOT_FOUND",
        "The doubles source does not belong to this match.",
        { kind, sourceId, matchId },
      );
    }
    if (
      team.members.some(
        ({ user }) => user.isBanned || !user.emailVerifiedAt,
      )
    ) {
      throw new V2CompetitionApplicationError(
        "ENTRY_SOURCE_NOT_ACTIVE",
        "The doubles source contains a banned or unverified member.",
        { kind, sourceId },
      );
    }
    const members = team.members.map(({ user }) => ({
      userId: user.id,
      displayNameSnapshot: user.nickname,
      role: "player" as const,
    }));
    return {
      displayNameSnapshot: members
        .map((member) => member.displayNameSnapshot)
        .join(" / "),
      ownerId: team.createdById,
      members,
    };
  }

  const team = await tx.matchTeam.findFirst({
    where: { id: sourceId, matchId },
    select: {
      id: true,
      name: true,
      captainId: true,
      members: {
        orderBy: { joinedAt: "asc" },
        select: {
          user: {
            select: {
              id: true,
              nickname: true,
              isBanned: true,
              emailVerifiedAt: true,
            },
          },
        },
      },
    },
  });
  if (!team) {
    throw new V2CompetitionApplicationError(
      "ENTRY_SOURCE_NOT_FOUND",
      "The team source does not belong to this match.",
      { kind, sourceId, matchId },
    );
  }
  if (
    team.members.some(({ user }) => user.isBanned || !user.emailVerifiedAt)
  ) {
    throw new V2CompetitionApplicationError(
      "ENTRY_SOURCE_NOT_ACTIVE",
      "The team source contains a banned or unverified member.",
      { kind, sourceId },
    );
  }
  const members = team.members.map(({ user }) => ({
    userId: user.id,
    displayNameSnapshot: user.nickname,
    role: user.id === team.captainId ? ("captain" as const) : ("player" as const),
  }));
  if (!members.some((member) => member.userId === team.captainId)) {
    throw new V2CompetitionApplicationError(
      "ENTRY_SOURCE_NOT_ACTIVE",
      "The team captain must belong to the source team's current roster.",
      { kind, sourceId, captainId: team.captainId },
    );
  }
  return {
    displayNameSnapshot: team.name,
    ownerId: team.captainId,
    members,
  };
}

function assertActorParticipates(
  context: V2WriteContext,
  kind: EntryKind,
  source: V2ResolvedEntrySource,
  policy: RegistrationMutationPolicy,
): RegistrationSettlementOrigin {
  const permitted =
    kind === "TEAM"
      ? source.ownerId === context.actor.id
      : source.members.some((member) => member.userId === context.actor.id);
  if (permitted) return "STANDARD";
  if (context.actor.role === "admin" && policy.adminOverride === true) {
    return "ADMIN_BULK";
  }
  throw new V2CompetitionApplicationError(
    "FORBIDDEN",
    "An individual must register themselves, either doubles partner may register, and only a team captain may register a team; an administrator acting for them must use an audited override.",
    { actorId: context.actor.id, matchId: context.match.id },
  );
}

function assertNoActiveMemberConflict(
  conflict: { userId: string; entryId: string } | null,
) {
  if (!conflict) return;
  throw new V2CompetitionApplicationError(
    "ENTRY_MEMBER_CONFLICT",
    "A member already belongs to another active entry in this match.",
    { userId: conflict.userId, entryId: conflict.entryId },
  );
}

export type CreateV2EntryInput = Readonly<{
  actor: V2Actor;
  matchId: string;
  kind: EntryKind;
  sourceId: string;
  status?: "DRAFT" | "ACTIVE";
  seed?: number | null;
  metadata?: Prisma.InputJsonValue;
  adminOverride?: boolean;
  overrideReason?: string;
}>;

export type V2EntryWriteResult = Readonly<{
  id: string;
  matchId: string;
  kind: EntryKind;
  status: EntryStatus;
  version: number;
  rosterVersion: number;
  created: boolean;
}>;

export type CreateV2EntryKernelInput = Readonly<{
  match: Pick<
    V2WriteContext["match"],
    "id" | "type" | "teamMinMembers" | "teamMaxMembers"
  >;
  command: Pick<
    CreateV2EntryInput,
    "kind" | "sourceId" | "status" | "seed" | "metadata"
  >;
  source: V2ResolvedEntrySource;
  settlementOrigin: RegistrationSettlementOrigin;
}>;

/**
 * @internal Trusted Entry persistence kernel. The caller must already own the
 * Match aggregate lock and must have authoritatively resolved and validated the
 * source snapshot. It deliberately never starts a transaction or performs
 * authorization, which lets a larger Match-first aggregate command compose the
 * Entry row, roster snapshot, and registration settlement atomically.
 */
export async function createV2EntryKernel(
  tx: V2CompetitionTransaction,
  input: CreateV2EntryKernelInput,
  settlementPort: V2EntrySettlementPort = DEFAULT_ENTRY_SETTLEMENT_PORT,
): Promise<V2EntryWriteResult> {
  assertStableIdentifier(input.match.id, "matchId");
  assertStableIdentifier(input.command.sourceId, "sourceId");
  assertKindMatchesMatch(input.match.type, input.command.kind);
  assertMemberAccountsActive(input.source);

  const sourceKey = createEntrySourceKey(
    input.command.kind,
    input.command.sourceId,
  );
  const existing = await tx.matchEntry.findUnique({
    where: {
      matchId_sourceKey: { matchId: input.match.id, sourceKey },
    },
    select: {
      id: true,
      matchId: true,
      kind: true,
      status: true,
      version: true,
      members: {
        orderBy: { rosterVersion: "desc" },
        take: 1,
        select: { rosterVersion: true },
      },
    },
  });
  if (existing) {
    return {
      id: existing.id,
      matchId: existing.matchId,
      kind: existing.kind,
      status: existing.status,
      version: existing.version,
      rosterVersion: existing.members[0]?.rosterVersion ?? 1,
      created: false,
    };
  }

  const status = input.command.status ?? "DRAFT";
  assertEntryCanActivate({
    kind: input.command.kind,
    memberIds: input.source.members.map((member) => member.userId),
    minimumTeamMembers:
      status === "ACTIVE"
        ? input.match.teamMinMembers ?? undefined
        : input.command.kind === "TEAM"
          ? 1
          : undefined,
    maximumTeamMembers: input.match.teamMaxMembers ?? undefined,
  });

  const conflict = await tx.matchEntryMember.findFirst({
    where: {
      matchId: input.match.id,
      userId: { in: input.source.members.map((member) => member.userId) },
      status: "ACTIVE",
      effectiveUntil: null,
    },
    select: { userId: true, entryId: true },
  });
  assertNoActiveMemberConflict(conflict);

  const created = await tx.matchEntry.create({
    data: {
      matchId: input.match.id,
      kind: input.command.kind,
      status,
      sourceKey,
      sourceUserId:
        input.command.kind === "INDIVIDUAL" ? input.command.sourceId : null,
      sourceDoublesTeamId:
        input.command.kind === "DOUBLES" ? input.command.sourceId : null,
      sourceMatchTeamId:
        input.command.kind === "TEAM" ? input.command.sourceId : null,
      displayNameSnapshot: input.source.displayNameSnapshot,
      seed: input.command.seed,
      ...(input.command.metadata === undefined
        ? {}
        : { metadata: input.command.metadata }),
      members: {
        create: input.source.members.map((member, index) => ({
          userId: member.userId,
          displayNameSnapshot: member.displayNameSnapshot,
          role: member.role,
          status: "ACTIVE",
          slot: index + 1,
          rosterVersion: 1,
        })),
      },
    },
    select: {
      id: true,
      matchId: true,
      kind: true,
      status: true,
      version: true,
    },
  });

  if (status === "ACTIVE") {
    await settlementPort.apply(tx, {
      matchId: input.match.id,
      matchEntryId: created.id,
      rosterVersion: 1,
      origin: input.settlementOrigin,
    });
  }

  return { ...created, rosterVersion: 1, created: true };
}

/**
 * Transaction-aware form of createV2Entry. It preserves the public command's
 * authorization and registration-window semantics but never opens a nested
 * transaction. Call it only at a Match-first point in an existing transaction.
 */
export async function createV2EntryInTransaction(
  tx: V2CompetitionTransaction,
  input: CreateV2EntryInput,
  settlementPort: V2EntrySettlementPort = DEFAULT_ENTRY_SETTLEMENT_PORT,
): Promise<V2EntryWriteResult> {
  assertStableIdentifier(input.matchId, "matchId");
  assertStableIdentifier(input.sourceId, "sourceId");
  if (
    input.seed !== undefined &&
    input.seed !== null &&
    (!Number.isInteger(input.seed) || input.seed < 1)
  ) {
    throw new V2CompetitionApplicationError(
      "INVALID_INPUT",
      "seed must be a positive integer when supplied.",
      { seed: input.seed },
    );
  }
  const context = await loadV2WriteContext(tx, input.matchId, input.actor);
  await assertRegistrationMutationAllowed(
    tx,
    context,
    input,
    "entry_create",
    input.matchId,
  );
  assertKindMatchesMatch(context.match.type, input.kind);
  const source = await resolveEntrySource(
    tx,
    input.matchId,
    input.kind,
    input.sourceId,
  );
  assertMemberAccountsActive(source);
  const settlementOrigin = assertActorParticipates(
    context,
    input.kind,
    source,
    input,
  );

  return createV2EntryKernel(
    tx,
    {
      match: context.match,
      command: input,
      source,
      settlementOrigin,
    },
    settlementPort,
  );
}

/**
 * Creates an Entry and, when ACTIVE, applies registration settlement in the
 * same transaction. Production adapters must call the two-argument form; the
 * optional port is only for trusted composition tests.
 */
export async function createV2Entry(
  db: V2CompetitionDatabase,
  input: CreateV2EntryInput,
  settlementPort: V2EntrySettlementPort = DEFAULT_ENTRY_SETTLEMENT_PORT,
): Promise<V2EntryWriteResult> {
  assertStableIdentifier(input.matchId, "matchId");
  assertStableIdentifier(input.sourceId, "sourceId");
  if (
    input.seed !== undefined &&
    input.seed !== null &&
    (!Number.isInteger(input.seed) || input.seed < 1)
  ) {
    throw new V2CompetitionApplicationError(
      "INVALID_INPUT",
      "seed must be a positive integer when supplied.",
      { seed: input.seed },
    );
  }

  return runV2Transaction(db, (tx) =>
    createV2EntryInTransaction(tx, input, settlementPort),
  );
}

export type TransitionV2EntryStatusInput = Readonly<{
  actor: V2Actor;
  matchId: string;
  entryId: string;
  expectedVersion: number;
  to: EntryStatus;
  adminOverride?: boolean;
  overrideReason?: string;
}>;

export type V2EntryStatusTransitionKernelEntry = Readonly<{
  id: string;
  kind: EntryKind;
  status: EntryStatus;
  version: number;
  members: readonly Readonly<{
    userId: string;
    displayNameSnapshot: string;
    role: "player" | "captain" | "substitute";
    status: "ACTIVE" | "WITHDRAWN" | "REMOVED" | "DISQUALIFIED" | "SUPERSEDED";
    effectiveUntil: Date | null;
    rosterVersion: number;
  }>[];
}>;

export type TransitionV2EntryStatusKernelInput = Readonly<{
  matchId: string;
  entry: V2EntryStatusTransitionKernelEntry;
  expectedVersion: number;
  to: EntryStatus;
  activationSource?: V2ResolvedEntrySource;
  activationOrigin?: RegistrationSettlementOrigin;
  /** Force a fresh activation-cycle identity even if a DRAFT retained a roster. */
  forceSuccessorActivationRoster?: boolean;
  displayNameSnapshot?: string;
}>;

/**
 * @internal Trusted status/roster/settlement kernel. Authorization, registration
 * windows, source eligibility, and fixture policy belong to the caller. The
 * caller must hold the Match and Entry/member locks and must lock all affected
 * users before invoking the default settlement port.
 */
export async function transitionV2EntryStatusKernel(
  tx: V2CompetitionTransaction,
  input: TransitionV2EntryStatusKernelInput,
  settlementPort: V2EntrySettlementPort = DEFAULT_ENTRY_SETTLEMENT_PORT,
) {
  if (input.entry.version !== input.expectedVersion) {
    throw new V2CompetitionApplicationError(
      "ENTRY_VERSION_CONFLICT",
      "The entry changed after it was read.",
      {
        expectedVersion: input.expectedVersion,
        actualVersion: input.entry.version,
      },
    );
  }
  if (
    input.displayNameSnapshot !== undefined &&
    (input.displayNameSnapshot.trim() === "" ||
      input.displayNameSnapshot !== input.displayNameSnapshot.trim())
  ) {
    throw new V2CompetitionApplicationError(
      "INVALID_INPUT",
      "displayNameSnapshot must be a non-empty normalized value.",
      { entryId: input.entry.id },
    );
  }

  const activeMembers = input.entry.members.filter(
    (member) => member.status === "ACTIVE" && member.effectiveUntil === null,
  );
  const isRegistrationCancellation =
    input.entry.status === "ACTIVE" && input.to === "DRAFT";
  const isActivation =
    input.entry.status === "DRAFT" && input.to === "ACTIVE";
  if (!isRegistrationCancellation) {
    assertEntryStatusTransition(input.entry.status, input.to);
  }
  if (input.entry.status === input.to) {
    return {
      id: input.entry.id,
      status: input.entry.status,
      version: input.entry.version,
    };
  }

  const leavesActive = input.entry.status === "ACTIVE" && input.to !== "ACTIVE";
  let departingRosterVersion: number | null = null;
  if (leavesActive) {
    const currentRosterVersions = new Set(
      activeMembers.map((member) => member.rosterVersion),
    );
    if (activeMembers.length === 0 || currentRosterVersions.size !== 1) {
      throw new V2CompetitionApplicationError(
        "ENTRY_ROSTER_CORRUPT",
        "An active entry must have exactly one current roster version before it can leave ACTIVE.",
        {
          entryId: input.entry.id,
          rosterVersions: [...currentRosterVersions],
        },
      );
    }
    departingRosterVersion = activeMembers[0].rosterVersion;
  }

  if (isActivation && !input.activationSource) {
    throw new V2CompetitionApplicationError(
      "ENTRY_ROSTER_CORRUPT",
      "An Entry activation requires an authoritative source roster.",
      { entryId: input.entry.id },
    );
  }

  const now = new Date();
  const timestampData =
    input.to === "WITHDRAWN"
      ? { withdrawnAt: now }
      : input.to === "DISQUALIFIED"
        ? { disqualifiedAt: now }
        : input.to === "ARCHIVED"
          ? { archivedAt: now }
          : {};
  const updated = await tx.matchEntry.updateMany({
    where: {
      id: input.entry.id,
      matchId: input.matchId,
      version: input.expectedVersion,
    },
    data: {
      status: input.to,
      version: { increment: 1 },
      ...timestampData,
      ...(input.displayNameSnapshot === undefined
        ? {}
        : { displayNameSnapshot: input.displayNameSnapshot }),
    },
  });
  if (updated.count !== 1) {
    throw new V2CompetitionApplicationError(
      "ENTRY_VERSION_CONFLICT",
      "The entry changed concurrently.",
      { expectedVersion: input.expectedVersion },
    );
  }

  const closingStatus = isRegistrationCancellation
    ? "REMOVED"
    : input.to === "WITHDRAWN"
      ? "WITHDRAWN"
      : input.to === "DISQUALIFIED"
        ? "DISQUALIFIED"
        : input.to === "ARCHIVED"
          ? "REMOVED"
          : null;
  if (closingStatus) {
    await tx.matchEntryMember.updateMany({
      where: {
        entryId: input.entry.id,
        matchId: input.matchId,
        status: "ACTIVE",
        effectiveUntil: null,
      },
      data: {
        status: closingStatus,
        effectiveUntil: now,
        endReason: isRegistrationCancellation
          ? "REGISTRATION_CANCELLED"
          : `ENTRY_${input.to}`,
      },
    });
  }

  let activationRosterVersion: number | null = null;
  if (isActivation && input.activationSource) {
    const mustCreateRoster =
      activeMembers.length === 0 ||
      input.forceSuccessorActivationRoster === true;
    if (mustCreateRoster) {
      if (activeMembers.length > 0) {
        const nextIds = new Set(
          input.activationSource.members.map((member) => member.userId),
        );
        const continuingIds = activeMembers
          .map((member) => member.userId)
          .filter((userId) => nextIds.has(userId));
        const removedIds = activeMembers
          .map((member) => member.userId)
          .filter((userId) => !nextIds.has(userId));
        if (continuingIds.length > 0) {
          await tx.matchEntryMember.updateMany({
            where: {
              entryId: input.entry.id,
              matchId: input.matchId,
              userId: { in: continuingIds },
              status: "ACTIVE",
              effectiveUntil: null,
            },
            data: {
              status: "SUPERSEDED",
              effectiveUntil: now,
              endReason: "ROSTER_VERSION_SUPERSEDED",
            },
          });
        }
        if (removedIds.length > 0) {
          await tx.matchEntryMember.updateMany({
            where: {
              entryId: input.entry.id,
              matchId: input.matchId,
              userId: { in: removedIds },
              status: "ACTIVE",
              effectiveUntil: null,
            },
            data: {
              status: "REMOVED",
              effectiveUntil: now,
              endReason: "ROSTER_REPLACED",
            },
          });
        }
      }
      const lastRosterVersion = input.entry.members.reduce(
        (maximum, member) => Math.max(maximum, member.rosterVersion),
        0,
      );
      activationRosterVersion = lastRosterVersion + 1;
      await tx.matchEntryMember.createMany({
        data: input.activationSource.members.map((member, index) => ({
          matchId: input.matchId,
          entryId: input.entry.id,
          userId: member.userId,
          displayNameSnapshot: member.displayNameSnapshot,
          role: member.role,
          status: "ACTIVE" as const,
          slot: index + 1,
          rosterVersion: activationRosterVersion!,
          effectiveFrom: now,
        })),
      });
    } else {
      const currentRosterVersions = new Set(
        activeMembers.map((member) => member.rosterVersion),
      );
      if (currentRosterVersions.size !== 1) {
        throw new V2CompetitionApplicationError(
          "ENTRY_ROSTER_CORRUPT",
          "The draft entry has more than one current roster version.",
          {
            entryId: input.entry.id,
            rosterVersions: [...currentRosterVersions],
          },
        );
      }
      activationRosterVersion = activeMembers[0].rosterVersion;
    }
  }

  if (isActivation) {
    if (
      input.activationOrigin === undefined ||
      activationRosterVersion === null
    ) {
      throw new V2CompetitionApplicationError(
        "ENTRY_ROSTER_CORRUPT",
        "The activated entry does not have a settlement roster version.",
        { entryId: input.entry.id },
      );
    }
    await settlementPort.apply(tx, {
      matchId: input.matchId,
      matchEntryId: input.entry.id,
      rosterVersion: activationRosterVersion,
      origin: input.activationOrigin,
    });
  } else if (leavesActive && departingRosterVersion !== null) {
    await settlementPort.reverse(tx, {
      matchId: input.matchId,
      matchEntryId: input.entry.id,
      rosterVersion: departingRosterVersion,
    });
  }

  return {
    id: input.entry.id,
    status: input.to,
    version: input.entry.version + 1,
  };
}

/**
 * Changes Entry state together with its registration apply/reversal event.
 * Production adapters must call the two-argument form; the optional port is
 * only for trusted composition tests.
 */
export async function transitionV2EntryStatusInTransaction(
  tx: V2CompetitionTransaction,
  input: TransitionV2EntryStatusInput,
  settlementPort: V2EntrySettlementPort = DEFAULT_ENTRY_SETTLEMENT_PORT,
) {
    const context = await loadV2WriteContext(tx, input.matchId, input.actor);
    const entry = await tx.matchEntry.findFirst({
      where: { id: input.entryId, matchId: input.matchId },
      select: {
        id: true,
        kind: true,
        status: true,
        version: true,
        sourceUserId: true,
        sourceDoublesTeamId: true,
        sourceMatchTeamId: true,
        members: {
          orderBy: [{ rosterVersion: "desc" }, { slot: "asc" }],
          select: {
            userId: true,
            displayNameSnapshot: true,
            role: true,
            status: true,
            effectiveUntil: true,
            rosterVersion: true,
          },
        },
      },
    });
    if (!entry) {
      throw new V2CompetitionApplicationError(
        "ENTRY_NOT_FOUND",
        "The entry does not belong to this match.",
        { matchId: input.matchId, entryId: input.entryId },
      );
    }
    if (entry.version !== input.expectedVersion) {
      throw new V2CompetitionApplicationError(
        "ENTRY_VERSION_CONFLICT",
        "The entry changed after it was read.",
        { expectedVersion: input.expectedVersion, actualVersion: entry.version },
      );
    }

    const activeMembers = entry.members.filter(
      (member) => member.status === "ACTIVE" && member.effectiveUntil === null,
    );
    const actorIsActiveMember = activeMembers.some(
      (member) => member.userId === context.actor.id,
    );
    const isRegistrationCancellation =
      entry.status === "ACTIVE" && input.to === "DRAFT";
    const isActivation = entry.status === "DRAFT" && input.to === "ACTIVE";
    const hasFixture =
      isRegistrationCancellation || isActivation
        ? (await tx.matchFixture.count({
            where: {
              matchId: input.matchId,
              OR: [{ sideAEntryId: entry.id }, { sideBEntryId: entry.id }],
            },
          })) > 0
        : false;

    if (isRegistrationCancellation || isActivation) {
      await assertRegistrationMutationAllowed(
        tx,
        context,
        input,
        isActivation ? "entry_activate" : "entry_cancel_registration",
        entry.id,
      );
    }

    let activationSource: V2ResolvedEntrySource | null = null;
    let activationOrigin: RegistrationSettlementOrigin | null = null;
    if (isActivation) {
      if (hasFixture) {
        throw new V2CompetitionApplicationError(
          "FORBIDDEN",
          "An entry cannot be reactivated after a fixture has referenced it.",
          { entryId: entry.id },
        );
      }
      const sourceId =
        entry.kind === "INDIVIDUAL"
          ? entry.sourceUserId
          : entry.kind === "DOUBLES"
            ? entry.sourceDoublesTeamId
            : entry.sourceMatchTeamId;
      if (!sourceId) {
        throw new V2CompetitionApplicationError(
          "ENTRY_SOURCE_NOT_FOUND",
          "The entry source no longer exists and cannot be reactivated.",
          { entryId: entry.id, kind: entry.kind },
        );
      }
      activationSource = await resolveEntrySource(
        tx,
        input.matchId,
        entry.kind,
        sourceId,
      );
      activationOrigin = assertActorParticipates(
        context,
        entry.kind,
        activationSource,
        input,
      );
      assertEntryCanActivate({
        kind: entry.kind,
        memberIds: activationSource.members.map((member) => member.userId),
        minimumTeamMembers: context.match.teamMinMembers ?? undefined,
        maximumTeamMembers: context.match.teamMaxMembers ?? undefined,
      });
      if (
        activeMembers.length > 0 &&
        !sameMemberSet(
          activeMembers.map((member) => member.userId),
          activationSource.members.map((member) => member.userId),
        )
      ) {
        throw new V2CompetitionApplicationError(
          "ENTRY_ROSTER_CORRUPT",
          "The draft entry roster no longer matches its active source registration.",
          { entryId: entry.id },
        );
      }
      const conflict = await tx.matchEntryMember.findFirst({
        where: {
          matchId: input.matchId,
          entryId: { not: entry.id },
          userId: {
            in: activationSource.members.map((member) => member.userId),
          },
          status: "ACTIVE",
          effectiveUntil: null,
        },
        select: { userId: true, entryId: true },
      });
      assertNoActiveMemberConflict(conflict);
    } else if (input.to === "WITHDRAWN" || isRegistrationCancellation) {
      let actorCanWithdrawEntry = actorIsActiveMember;
      if (entry.kind === "TEAM" && entry.sourceMatchTeamId) {
        const sourceTeam = await tx.matchTeam.findFirst({
          where: {
            id: entry.sourceMatchTeamId,
            matchId: input.matchId,
          },
          select: { captainId: true },
        });
        actorCanWithdrawEntry = sourceTeam?.captainId === context.actor.id;
      } else if (entry.kind === "TEAM") {
        actorCanWithdrawEntry = false;
      }

      if (
        !actorCanWithdrawEntry &&
        context.actor.role === "admin" &&
        input.adminOverride === true &&
        !isRegistrationCancellation
      ) {
        await recordAdminOverride(
          tx,
          context,
          input,
          "entry_withdraw",
          entry.id,
        );
      } else if (
        !actorCanWithdrawEntry &&
        !(
          context.actor.role === "admin" &&
          input.adminOverride === true &&
          isRegistrationCancellation
        )
      ) {
        throw new V2CompetitionApplicationError(
          "FORBIDDEN",
          "Only an entry participant, or a team captain for team entries, can cancel or withdraw it.",
          { actorId: context.actor.id, entryId: input.entryId, to: input.to },
        );
      }
    } else if (!context.isManager) {
      throw new V2CompetitionApplicationError(
        "FORBIDDEN",
        "Only the match creator or an administrator can apply this entry status.",
        { actorId: context.actor.id, entryId: input.entryId, to: input.to },
      );
    }

    if (isRegistrationCancellation && hasFixture) {
      throw new V2CompetitionApplicationError(
        "FORBIDDEN",
        "Registration cancellation is forbidden after the first fixture exists.",
        { entryId: entry.id },
      );
    }

    return transitionV2EntryStatusKernel(
      tx,
      {
        matchId: input.matchId,
        entry,
        expectedVersion: input.expectedVersion,
        to: input.to,
        ...(activationSource === null ? {} : { activationSource }),
        ...(activationOrigin === null ? {} : { activationOrigin }),
      },
      settlementPort,
    );
}

export async function transitionV2EntryStatus(
  db: V2CompetitionDatabase,
  input: TransitionV2EntryStatusInput,
  settlementPort: V2EntrySettlementPort = DEFAULT_ENTRY_SETTLEMENT_PORT,
) {
  return runV2Transaction(db, (tx) =>
    transitionV2EntryStatusInTransaction(tx, input, settlementPort),
  );
}

export type ReplaceV2EntryRosterInput = Readonly<{
  actor: V2Actor;
  matchId: string;
  entryId: string;
  expectedVersion: number;
  memberIds: readonly string[];
  adminOverride?: boolean;
  overrideReason?: string;
}>;

function sameMemberSet(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((value) => expected.has(value));
}

export type ReplaceV2EntryRosterKernelInput = Readonly<{
  matchId: string;
  entry: Readonly<{
    id: string;
    kind: EntryKind;
    status: EntryStatus;
    version: number;
    members: readonly Readonly<{
      userId: string;
      role: "player" | "captain" | "substitute";
      rosterVersion: number;
    }>[];
  }>;
  expectedVersion: number;
  members: readonly V2EntryMemberSnapshot[];
  settlementOrigin: RegistrationSettlementOrigin;
  displayNameSnapshot?: string;
}>;

/**
 * @internal Trusted successor-roster kernel. It assumes source, size, account,
 * fixture, and permission policy were checked after the caller obtained the
 * Match/Entry locks. It owns the optimistic write, immutable roster successor,
 * and registration settlement as one transaction fragment.
 */
export async function replaceV2EntryRosterKernel(
  tx: V2CompetitionTransaction,
  input: ReplaceV2EntryRosterKernelInput,
  settlementPort: V2EntrySettlementPort = DEFAULT_ENTRY_SETTLEMENT_PORT,
) {
  if (input.entry.version !== input.expectedVersion) {
    throw new V2CompetitionApplicationError(
      "ENTRY_VERSION_CONFLICT",
      "The entry changed after it was read.",
      {
        expectedVersion: input.expectedVersion,
        actualVersion: input.entry.version,
      },
    );
  }
  if (input.entry.kind !== "TEAM" && input.entry.kind !== "DOUBLES") {
    throw new V2CompetitionApplicationError(
      "FORBIDDEN",
      "Only doubles and team rosters can be versioned.",
      { entryId: input.entry.id, kind: input.entry.kind },
    );
  }
  if (
    input.displayNameSnapshot !== undefined &&
    (input.displayNameSnapshot.trim() === "" ||
      input.displayNameSnapshot !== input.displayNameSnapshot.trim())
  ) {
    throw new V2CompetitionApplicationError(
      "INVALID_INPUT",
      "displayNameSnapshot must be a non-empty normalized value.",
      { entryId: input.entry.id },
    );
  }
  const memberIds = input.members.map((member) => member.userId);
  if (
    input.members.length === 0 ||
    new Set(memberIds).size !== input.members.length
  ) {
    throw new V2CompetitionApplicationError(
      "ENTRY_ROSTER_CORRUPT",
      "A successor roster must contain distinct members.",
      { entryId: input.entry.id, memberCount: input.members.length },
    );
  }

  const conflict = await tx.matchEntryMember.findFirst({
    where: {
      matchId: input.matchId,
      entryId: { not: input.entry.id },
      userId: { in: memberIds },
      status: "ACTIVE",
      effectiveUntil: null,
    },
    select: { userId: true, entryId: true },
  });
  assertNoActiveMemberConflict(conflict);

  const rosterVersions = new Set(
    input.entry.members.map((member) => member.rosterVersion),
  );
  if (rosterVersions.size !== 1 || input.entry.members.length === 0) {
    throw new V2CompetitionApplicationError(
      "ENTRY_ROSTER_CORRUPT",
      "The current roster is empty or spans multiple versions.",
      { entryId: input.entry.id, rosterVersions: [...rosterVersions] },
    );
  }
  const currentRosterVersion = input.entry.members[0].rosterVersion;
  const nextRosterVersion = currentRosterVersion + 1;
  const now = new Date();

  const updated = await tx.matchEntry.updateMany({
    where: {
      id: input.entry.id,
      matchId: input.matchId,
      version: input.expectedVersion,
    },
    data: {
      version: { increment: 1 },
      ...(input.displayNameSnapshot === undefined
        ? {}
        : { displayNameSnapshot: input.displayNameSnapshot }),
    },
  });
  if (updated.count !== 1) {
    throw new V2CompetitionApplicationError(
      "ENTRY_VERSION_CONFLICT",
      "The entry changed concurrently.",
      { expectedVersion: input.expectedVersion },
    );
  }

  const nextMemberSet = new Set(memberIds);
  const continuingIds = input.entry.members
    .map((member) => member.userId)
    .filter((userId) => nextMemberSet.has(userId));
  const removedIds = input.entry.members
    .map((member) => member.userId)
    .filter((userId) => !nextMemberSet.has(userId));
  if (continuingIds.length > 0) {
    await tx.matchEntryMember.updateMany({
      where: {
        entryId: input.entry.id,
        matchId: input.matchId,
        userId: { in: continuingIds },
        status: "ACTIVE",
        effectiveUntil: null,
      },
      data: {
        status: "SUPERSEDED",
        effectiveUntil: now,
        endReason: "ROSTER_VERSION_SUPERSEDED",
      },
    });
  }
  if (removedIds.length > 0) {
    await tx.matchEntryMember.updateMany({
      where: {
        entryId: input.entry.id,
        matchId: input.matchId,
        userId: { in: removedIds },
        status: "ACTIVE",
        effectiveUntil: null,
      },
      data: {
        status: "REMOVED",
        effectiveUntil: now,
        endReason: "ROSTER_REPLACED",
      },
    });
  }

  await tx.matchEntryMember.createMany({
    data: input.members.map((member, index) => ({
      matchId: input.matchId,
      entryId: input.entry.id,
      userId: member.userId,
      displayNameSnapshot: member.displayNameSnapshot,
      role: member.role,
      status: "ACTIVE" as const,
      slot: index + 1,
      rosterVersion: nextRosterVersion,
      effectiveFrom: now,
    })),
  });

  if (input.entry.status === "ACTIVE") {
    await settlementPort.apply(tx, {
      matchId: input.matchId,
      matchEntryId: input.entry.id,
      rosterVersion: nextRosterVersion,
      origin: input.settlementOrigin,
    });
  }

  return {
    id: input.entry.id,
    status: input.entry.status,
    version: input.entry.version + 1,
    rosterVersion: nextRosterVersion,
    memberCount: input.members.length,
  };
}

/** @internal Trusted name-snapshot synchronization under an Entry lock. */
export async function synchronizeV2EntryDisplayNameKernel(
  tx: V2CompetitionTransaction,
  input: Readonly<{
    matchId: string;
    entryId: string;
    expectedVersion: number;
    displayNameSnapshot: string;
  }>,
) {
  if (
    input.displayNameSnapshot.trim() === "" ||
    input.displayNameSnapshot !== input.displayNameSnapshot.trim()
  ) {
    throw new V2CompetitionApplicationError(
      "INVALID_INPUT",
      "displayNameSnapshot must be a non-empty normalized value.",
      { entryId: input.entryId },
    );
  }
  const updated = await tx.matchEntry.updateMany({
    where: {
      id: input.entryId,
      matchId: input.matchId,
      version: input.expectedVersion,
    },
    data: {
      displayNameSnapshot: input.displayNameSnapshot,
      version: { increment: 1 },
    },
  });
  if (updated.count !== 1) {
    throw new V2CompetitionApplicationError(
      "ENTRY_VERSION_CONFLICT",
      "The entry changed concurrently.",
      { expectedVersion: input.expectedVersion },
    );
  }
  return {
    id: input.entryId,
    version: input.expectedVersion + 1,
    displayNameSnapshot: input.displayNameSnapshot,
  };
}

/**
 * Replaces a team roster and, for an ACTIVE Entry, records the successor
 * roster's registration activation in the same transaction. Production
 * adapters must call the two-argument form; the optional port is only for
 * trusted composition tests.
 */
export async function replaceV2EntryRosterInTransaction(
  tx: V2CompetitionTransaction,
  input: ReplaceV2EntryRosterInput,
  settlementPort: V2EntrySettlementPort = DEFAULT_ENTRY_SETTLEMENT_PORT,
) {
    const context = await loadV2WriteContext(tx, input.matchId, input.actor);
    const entry = await tx.matchEntry.findFirst({
      where: { id: input.entryId, matchId: input.matchId },
      select: {
        id: true,
        kind: true,
        status: true,
        version: true,
        sourceMatchTeamId: true,
        members: {
          where: { status: "ACTIVE", effectiveUntil: null },
          orderBy: { slot: "asc" },
          select: {
            userId: true,
            role: true,
            rosterVersion: true,
          },
        },
      },
    });
    if (!entry) {
      throw new V2CompetitionApplicationError(
        "ENTRY_NOT_FOUND",
        "The entry does not belong to this match.",
        { matchId: input.matchId, entryId: input.entryId },
      );
    }
    if (entry.version !== input.expectedVersion) {
      throw new V2CompetitionApplicationError(
        "ENTRY_VERSION_CONFLICT",
        "The entry changed after it was read.",
        { expectedVersion: input.expectedVersion, actualVersion: entry.version },
      );
    }
    if (entry.kind !== "TEAM") {
      throw new V2CompetitionApplicationError(
        "FORBIDDEN",
        "A doubles substitution must create a new entry; only team rosters can be versioned.",
        { entryId: entry.id, kind: entry.kind },
      );
    }

    const sourceTeam = entry.sourceMatchTeamId
      ? await tx.matchTeam.findFirst({
          where: { id: entry.sourceMatchTeamId, matchId: input.matchId },
          select: {
            captainId: true,
            members: { select: { userId: true } },
          },
        })
      : null;
    const sourceCaptainId = sourceTeam?.captainId ?? null;
    const actorIsSourceCaptain = sourceCaptainId === context.actor.id;

    const hasFixture =
      (await tx.matchFixture.count({
        where: {
          matchId: input.matchId,
          OR: [{ sideAEntryId: entry.id }, { sideBEntryId: entry.id }],
        },
      })) > 0;
    if (hasFixture) {
      assertSuccessorRosterCanBeCreated({
        kind: entry.kind,
        status: entry.status,
        hasFixture,
      });
      if (context.actor.role !== "admin") {
        throw new V2CompetitionApplicationError(
          "FORBIDDEN",
          "Only a platform administrator can add a post-fixture roster version.",
          { entryId: entry.id },
        );
      }
      await recordAdminOverride(
        tx,
        context,
        input,
        "entry_roster_successor",
        entry.id,
      );
    } else {
      assertEntryMemberSnapshotMutationAllowed({
        status: entry.status,
        hasFixture,
      });
      if (
        context.actor.role === "admin" &&
        !actorIsSourceCaptain &&
        input.adminOverride !== true
      ) {
        throw new V2CompetitionApplicationError(
          "FORBIDDEN",
          "An administrator acting for the source-team captain must use an audited override.",
          { actorId: context.actor.id, entryId: entry.id },
        );
      }
      await assertRegistrationMutationAllowed(
        tx,
        context,
        input,
        "entry_roster_replace",
        entry.id,
      );
    }

    if (context.actor.role !== "admin") {
      if (!entry.sourceMatchTeamId || !sourceTeam) {
        throw new V2CompetitionApplicationError(
          "FORBIDDEN",
          "This entry has no editable source team.",
          { entryId: entry.id },
        );
      }
      if (!actorIsSourceCaptain) {
        throw new V2CompetitionApplicationError(
          "FORBIDDEN",
          "Only the source-team captain can synchronize a pre-fixture roster.",
          { entryId: entry.id },
        );
      }
      if (
        !sameMemberSet(
          sourceTeam.members.map((member) => member.userId),
          input.memberIds,
        )
      ) {
        throw new V2CompetitionApplicationError(
          "FORBIDDEN",
          "A captain can synchronize only the source team's current members.",
          { entryId: entry.id },
        );
      }
    }

    assertEntryCanActivate({
      kind: entry.kind,
      memberIds: input.memberIds,
      minimumTeamMembers:
        entry.status === "ACTIVE"
          ? context.match.teamMinMembers ?? undefined
          : 1,
      maximumTeamMembers: context.match.teamMaxMembers ?? undefined,
    });

    const users = await tx.user.findMany({
      where: { id: { in: [...input.memberIds] } },
      select: {
        id: true,
        nickname: true,
        isBanned: true,
        emailVerifiedAt: true,
      },
    });
    if (
      users.length !== input.memberIds.length ||
      users.some((user) => user.isBanned || !user.emailVerifiedAt)
    ) {
      throw new V2CompetitionApplicationError(
        "ENTRY_SOURCE_NOT_ACTIVE",
        "Every roster member must exist, be verified, and not be banned.",
        { entryId: entry.id },
      );
    }

    const usersById = new Map(users.map((user) => [user.id, user]));
    const previousRoleById = new Map(
      entry.members.map((member) => [member.userId, member.role]),
    );
    const nextMembers = input.memberIds.map((userId) => {
      const user = usersById.get(userId);
      if (!user) {
        throw new V2CompetitionApplicationError(
          "ENTRY_SOURCE_NOT_ACTIVE",
          "A roster member disappeared during validation.",
          { userId },
        );
      }
      return {
        userId,
        displayNameSnapshot: user.nickname,
        role:
          userId === sourceCaptainId
            ? ("captain" as const)
            : previousRoleById.get(userId) ?? ("player" as const),
      };
    });

    return replaceV2EntryRosterKernel(
      tx,
      {
        matchId: input.matchId,
        entry,
        expectedVersion: input.expectedVersion,
        members: nextMembers,
        settlementOrigin:
          context.actor.id === sourceCaptainId ? "STANDARD" : "ADMIN_BULK",
      },
      settlementPort,
    );
}

export async function replaceV2EntryRoster(
  db: V2CompetitionDatabase,
  input: ReplaceV2EntryRosterInput,
  settlementPort: V2EntrySettlementPort = DEFAULT_ENTRY_SETTLEMENT_PORT,
) {
  return runV2Transaction(db, (tx) =>
    replaceV2EntryRosterInTransaction(tx, input, settlementPort),
  );
}
