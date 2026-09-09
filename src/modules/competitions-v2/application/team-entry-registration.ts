import { Prisma } from "@prisma/client";

import {
  lockTeamSourceMatch,
  lockTeamSourceRows,
  type LockedTeamSourceMatch,
  type LockedTeamSourceMember,
} from "../../../lib/server/match/team-source";
import { lockUsersForUpdate } from "../../../lib/server/user/lock-users";
import { assertEngineCanWrite, assertEntryCanActivate } from "../domain";
import {
  V2CompetitionApplicationError,
  createV2EntryKernel,
  replaceV2EntryRosterKernel,
  runV2Transaction,
  synchronizeV2EntryDisplayNameKernel,
  transitionV2EntryStatusKernel,
  type V2CompetitionDatabase,
  type V2CompetitionTransaction,
  type V2EntryMemberSnapshot,
  type V2EntrySettlementPort,
  type V2ResolvedEntrySource,
} from "./entries";
import {
  applyRegistrationSettlement,
  reverseRegistrationSettlement,
} from "./registration-settlements";

const DEFAULT_TEAM_MIN_MEMBERS = 3;
const DEFAULT_TEAM_MAX_MEMBERS = 6;
const LOCK_CONTEXT_BRAND = Symbol("V2TeamEntryRegistrationLockContext");
const DEFAULT_TEAM_ENTRY_SETTLEMENT_PORT: V2EntrySettlementPort = {
  apply: applyRegistrationSettlement,
  reverse: reverseRegistrationSettlement,
};

type TeamRegistrationSettlementOrigin = "STANDARD" | "ADMIN_BULK";

export type LockV2TeamEntryRegistrationInput = Readonly<{
  matchId: string;
  teamId: string;
  /** Other source teams mutated by the same command (for example, a
   * cancelled membership removed while joining another team). */
  additionalTeamIds?: readonly string[];
  /**
   * Users affected by the enclosing source mutation but not necessarily in the
   * pre-mutation source roster (for example, a joining member).
   */
  additionalUserIds?: readonly string[];
  settlementOrigin?: TeamRegistrationSettlementOrigin;
}>;

export type LockV2TeamEntryRegistrationCreationInput = Readonly<{
  matchId: string;
  /** The application-generated identity that will be inserted later in this
   * same transaction. The Match row is the range mutex while it is absent. */
  teamId: string;
  additionalUserIds: readonly string[];
  settlementOrigin?: TeamRegistrationSettlementOrigin;
}>;

/**
 * An unforgeable, transaction-bound capability proving that the shared lock
 * protocol was executed. The transaction identity check also prevents a token
 * from being carried into a different interactive transaction.
 */
export type V2LockedTeamEntryRegistrationContext = Readonly<{
  readonly [LOCK_CONTEXT_BRAND]: true;
  readonly tx: V2CompetitionTransaction;
  readonly match: LockedTeamSourceMatch;
  readonly teamId: string;
  readonly lockedTeamIds: readonly string[];
  readonly lockedSourceMembers: readonly LockedTeamSourceMember[];
  readonly lockedUserIds: readonly string[];
  readonly settlementOrigin: TeamRegistrationSettlementOrigin;
}>;

export type V2TeamEntryRegistrationAction =
  | "NOOP_DRAFT_SOURCE"
  | "NOOP_ALREADY_SYNCHRONIZED"
  | "NOOP_CANCELLED_SOURCE_WITHOUT_ENTRY"
  | "CREATED_ACTIVE"
  | "REPLACED_ACTIVE_ROSTER"
  | "DEACTIVATED_TO_DRAFT"
  | "REACTIVATED"
  | "SYNCHRONIZED_NAME";

export type V2TeamEntryRegistrationResult = Readonly<{
  matchId: string;
  teamId: string;
  entryId: string | null;
  status: "DRAFT" | "ACTIVE" | null;
  version: number | null;
  rosterVersion: number | null;
  action: V2TeamEntryRegistrationAction;
}>;

type LockedEntryMemberRow = Readonly<{
  id: string;
  userId: string;
}>;

async function lockV2EntryRows(
  tx: V2CompetitionTransaction,
  matchId: string,
) {
  const entries = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM match_entry
    WHERE match_id = ${matchId}
    ORDER BY id
    FOR UPDATE
  `);
  const members = await tx.$queryRaw<LockedEntryMemberRow[]>(Prisma.sql`
    SELECT id, user_id AS "userId"
    FROM match_entry_member
    WHERE match_id = ${matchId}
    ORDER BY id
    FOR UPDATE
  `);
  return { entries, members };
}

function createLockContext(input: {
  tx: V2CompetitionTransaction;
  match: LockedTeamSourceMatch;
  teamId: string;
  lockedTeamIds: readonly string[];
  lockedSourceMembers: readonly LockedTeamSourceMember[];
  lockedUserIds: readonly string[];
  settlementOrigin: TeamRegistrationSettlementOrigin;
}): V2LockedTeamEntryRegistrationContext {
  return Object.freeze({
    [LOCK_CONTEXT_BRAND]: true as const,
    tx: input.tx,
    match: input.match,
    teamId: input.teamId,
    lockedTeamIds: Object.freeze([...input.lockedTeamIds]),
    lockedSourceMembers: Object.freeze([...input.lockedSourceMembers]),
    lockedUserIds: Object.freeze([...input.lockedUserIds]),
    settlementOrigin: input.settlementOrigin,
  });
}

function assertStableIdentifier(value: string, name: string) {
  if (value.trim() !== "" && value === value.trim()) return;
  throw new V2CompetitionApplicationError(
    "INVALID_INPUT",
    `${name} must be a non-empty stable identifier.`,
    { name },
  );
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function assertSettlementOrigin(
  origin: TeamRegistrationSettlementOrigin,
) {
  if (origin === "STANDARD" || origin === "ADMIN_BULK") return;
  throw new V2CompetitionApplicationError(
    "INVALID_INPUT",
    "Unknown team registration settlement origin.",
    { origin },
  );
}

/**
 * Locks one TEAM source aggregate in the only supported order:
 * Match -> MatchTeam/member -> every MatchEntry/member in the Match -> Users.
 *
 * Locking all Entries in the already Match-locked competition is intentionally
 * coarse. It makes the active-member conflict check and future source-action
 * composition deterministic without attempting a users-before-entries lock.
 */
export async function lockV2TeamEntryRegistrationContext(
  tx: V2CompetitionTransaction,
  input: LockV2TeamEntryRegistrationInput,
): Promise<V2LockedTeamEntryRegistrationContext> {
  assertStableIdentifier(input.matchId, "matchId");
  assertStableIdentifier(input.teamId, "teamId");
  for (const teamId of input.additionalTeamIds ?? []) {
    assertStableIdentifier(teamId, "additionalTeamId");
  }
  for (const userId of input.additionalUserIds ?? []) {
    assertStableIdentifier(userId, "additionalUserId");
  }
  const settlementOrigin = input.settlementOrigin ?? "STANDARD";
  assertSettlementOrigin(settlementOrigin);

  const lockedMatch = await lockTeamSourceMatch(tx, input.matchId);
  if (!lockedMatch.ok) {
    throw new V2CompetitionApplicationError(
      lockedMatch.error.includes("不存在") ? "MATCH_NOT_FOUND" : "INVALID_INPUT",
      "The requested TEAM source match is missing or invalid.",
      { matchId: input.matchId },
    );
  }
  assertEngineCanWrite(lockedMatch.match.engineVersion, "V2");

  const lockedSource = await lockTeamSourceRows(tx, {
    matchId: input.matchId,
    teamIds: [input.teamId, ...(input.additionalTeamIds ?? [])],
  });
  if (!lockedSource.teamIds.includes(input.teamId)) {
    throw new V2CompetitionApplicationError(
      "ENTRY_SOURCE_NOT_FOUND",
      "The team source does not belong to the requested match.",
      { matchId: input.matchId, teamId: input.teamId },
    );
  }

  const lockedSourceTeams = await tx.matchTeam.findMany({
    where: { id: { in: lockedSource.teamIds }, matchId: input.matchId },
    select: { captainId: true },
  });
  const lockedEntries = await lockV2EntryRows(tx, input.matchId);

  const source = await tx.matchTeam.findFirst({
    where: { id: input.teamId, matchId: input.matchId },
    select: {
      captainId: true,
      members: {
        orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
        select: { userId: true },
      },
    },
  });
  if (!source) {
    throw new V2CompetitionApplicationError(
      "ENTRY_SOURCE_NOT_FOUND",
      "The locked team source disappeared.",
      { matchId: input.matchId, teamId: input.teamId },
    );
  }

  const lockedUserIds = uniqueSorted([
    source.captainId,
    ...lockedSourceTeams.map((team) => team.captainId),
    ...source.members.map((member) => member.userId),
    ...lockedSource.members.map((member) => member.userId),
    ...lockedEntries.members.map((member) => member.userId),
    ...(input.additionalUserIds ?? []),
  ]);
  await lockUsersForUpdate(tx, lockedUserIds);

  // The query is intentionally retained even when there are currently no
  // Entries: the Match row is the range mutex for subsequent Entry creation.
  void lockedEntries.entries;
  return createLockContext({
    tx,
    match: lockedMatch.match,
    teamId: input.teamId,
    lockedTeamIds: lockedSource.teamIds,
    lockedSourceMembers: lockedSource.members,
    lockedUserIds,
    settlementOrigin,
  });
}

/**
 * Acquires the same aggregate lock protocol for a source team that does not
 * exist yet. The Match lock protects the absent team/Entry ranges. The caller
 * must insert exactly `teamId` and reconcile before this transaction commits.
 */
export async function lockV2TeamEntryRegistrationCreationContext(
  tx: V2CompetitionTransaction,
  input: LockV2TeamEntryRegistrationCreationInput,
): Promise<V2LockedTeamEntryRegistrationContext> {
  assertStableIdentifier(input.matchId, "matchId");
  assertStableIdentifier(input.teamId, "teamId");
  if (input.additionalUserIds.length === 0) {
    throw new V2CompetitionApplicationError(
      "INVALID_INPUT",
      "A new TEAM source must lock at least its captain.",
    );
  }
  for (const userId of input.additionalUserIds) {
    assertStableIdentifier(userId, "additionalUserId");
  }
  const settlementOrigin = input.settlementOrigin ?? "STANDARD";
  assertSettlementOrigin(settlementOrigin);

  const lockedMatch = await lockTeamSourceMatch(tx, input.matchId);
  if (!lockedMatch.ok) {
    throw new V2CompetitionApplicationError(
      lockedMatch.error.includes("不存在") ? "MATCH_NOT_FOUND" : "INVALID_INPUT",
      "The requested TEAM source match is missing or invalid.",
      { matchId: input.matchId },
    );
  }
  assertEngineCanWrite(lockedMatch.match.engineVersion, "V2");

  const lockedSource = await lockTeamSourceRows(tx, {
    matchId: input.matchId,
    teamIds: [input.teamId],
    userIds: input.additionalUserIds,
  });
  if (lockedSource.teamIds.includes(input.teamId)) {
    throw new V2CompetitionApplicationError(
      "PERSISTENCE_CONFLICT",
      "The generated TEAM source identity already exists.",
      { matchId: input.matchId, teamId: input.teamId },
    );
  }

  const relatedTeams = lockedSource.teamIds.length === 0
    ? []
    : await tx.matchTeam.findMany({
        where: { id: { in: lockedSource.teamIds }, matchId: input.matchId },
        select: { captainId: true },
      });
  const lockedEntries = await lockV2EntryRows(tx, input.matchId);
  const materializedRelatedEntry = lockedSource.teamIds.length === 0
    ? null
    : await tx.matchEntry.findFirst({
        where: {
          matchId: input.matchId,
          sourceMatchTeamId: { in: lockedSource.teamIds },
        },
        select: { id: true, sourceMatchTeamId: true },
      });
  if (materializedRelatedEntry) {
    throw new V2CompetitionApplicationError(
      "ENTRY_SOURCE_NOT_ACTIVE",
      "A related TEAM source with a materialized Entry cannot be replaced implicitly.",
      {
        matchId: input.matchId,
        sourceMatchTeamId: materializedRelatedEntry.sourceMatchTeamId,
        entryId: materializedRelatedEntry.id,
      },
    );
  }
  const lockedUserIds = uniqueSorted([
    ...input.additionalUserIds,
    ...relatedTeams.map((team) => team.captainId),
    ...lockedSource.members.map((member) => member.userId),
    ...lockedEntries.members.map((member) => member.userId),
  ]);
  await lockUsersForUpdate(tx, lockedUserIds);
  void lockedEntries.entries;

  return createLockContext({
    tx,
    match: lockedMatch.match,
    teamId: input.teamId,
    lockedTeamIds: lockedSource.teamIds,
    lockedSourceMembers: lockedSource.members,
    lockedUserIds,
    settlementOrigin,
  });
}

function assertLockContext(
  tx: V2CompetitionTransaction,
  context: V2LockedTeamEntryRegistrationContext,
) {
  if (
    context[LOCK_CONTEXT_BRAND] === true &&
    context.tx === tx &&
    context.match.id.trim() !== "" &&
    context.teamId.trim() !== ""
  ) {
    return;
  }
  throw new V2CompetitionApplicationError(
    "INVALID_INPUT",
    "The team Entry reconciler requires a lock context from this transaction.",
  );
}

function resolveTeamLimits(match: LockedTeamSourceMatch) {
  const minimum = match.teamMinMembers ?? DEFAULT_TEAM_MIN_MEMBERS;
  const maximum = match.teamMaxMembers ?? DEFAULT_TEAM_MAX_MEMBERS;
  if (
    !Number.isSafeInteger(minimum) ||
    minimum < 1 ||
    !Number.isSafeInteger(maximum) ||
    maximum < minimum
  ) {
    throw new V2CompetitionApplicationError(
      "INVALID_INPUT",
      "The TEAM match has invalid member limits.",
      {
        matchId: match.id,
        teamMinMembers: match.teamMinMembers,
        teamMaxMembers: match.teamMaxMembers,
      },
    );
  }
  return { minimum, maximum };
}

function sourceRoster(
  team: Readonly<{
    captainId: string;
    members: readonly Readonly<{
      id: string;
      teamId: string;
      matchId: string;
      userId: string;
      user: Readonly<{
        id: string;
        nickname: string;
        isBanned: boolean;
        emailVerifiedAt: Date | null;
      }>;
    }>[];
  }>,
): readonly V2EntryMemberSnapshot[] {
  return team.members.map((member) => ({
    userId: member.userId,
    displayNameSnapshot: member.user.nickname,
    role: member.userId === team.captainId ? "captain" : "player",
  }));
}

function assertCompleteSource(
  context: V2LockedTeamEntryRegistrationContext,
  team: Readonly<{
    id: string;
    matchId: string;
    name: string;
    captainId: string;
    status: string;
    members: readonly Readonly<{
      id: string;
      teamId: string;
      matchId: string;
      userId: string;
      user: Readonly<{
        id: string;
        nickname: string;
        isBanned: boolean;
        emailVerifiedAt: Date | null;
      }>;
    }>[];
  }>,
) {
  if (
    team.id !== context.teamId ||
    team.matchId !== context.match.id ||
    team.name.trim() === "" ||
    team.name !== team.name.trim()
  ) {
    throw new V2CompetitionApplicationError(
      "ENTRY_SOURCE_NOT_ACTIVE",
      "The TEAM source identity or name is invalid.",
      { matchId: context.match.id, teamId: context.teamId },
    );
  }

  const userIds = team.members.map((member) => member.userId);
  const lockedUserIds = new Set(context.lockedUserIds);
  const captainCount = userIds.filter(
    (userId) => userId === team.captainId,
  ).length;
  const malformedMember = team.members.find(
    (member) =>
      member.teamId !== team.id ||
      member.matchId !== team.matchId ||
      member.user.id !== member.userId ||
      member.user.nickname.trim() === "" ||
      member.user.isBanned ||
      member.user.emailVerifiedAt === null ||
      !lockedUserIds.has(member.userId),
  );
  if (
    userIds.length === 0 ||
    new Set(userIds).size !== userIds.length ||
    captainCount !== 1 ||
    !lockedUserIds.has(team.captainId) ||
    malformedMember !== undefined
  ) {
    throw new V2CompetitionApplicationError(
      "ENTRY_SOURCE_NOT_ACTIVE",
      "The TEAM source must have one captain and a complete active, verified roster.",
      {
        matchId: context.match.id,
        teamId: context.teamId,
        memberCount: userIds.length,
      },
    );
  }
}

type ReconcilerEntry = Readonly<{
  id: string;
  matchId: string;
  kind: "INDIVIDUAL" | "DOUBLES" | "TEAM";
  status: "DRAFT" | "ACTIVE" | "WITHDRAWN" | "DISQUALIFIED" | "ARCHIVED";
  sourceKey: string;
  sourceUserId: string | null;
  sourceDoublesTeamId: string | null;
  sourceMatchTeamId: string | null;
  displayNameSnapshot: string;
  version: number;
  members: readonly Readonly<{
    id: string;
    matchId: string;
    entryId: string;
    userId: string;
    displayNameSnapshot: string;
    role: "player" | "captain" | "substitute";
    status: "ACTIVE" | "WITHDRAWN" | "REMOVED" | "DISQUALIFIED" | "SUPERSEDED";
    slot: number;
    rosterVersion: number;
    effectiveUntil: Date | null;
  }>[];
}>;

function currentRoster(entry: ReconcilerEntry) {
  return entry.members.filter(
    (member) => member.status === "ACTIVE" && member.effectiveUntil === null,
  );
}

function assertEntryIdentity(
  context: V2LockedTeamEntryRegistrationContext,
  entry: ReconcilerEntry,
) {
  if (
    entry.matchId !== context.match.id ||
    entry.kind !== "TEAM" ||
    entry.sourceKey !== `team:${context.teamId}` ||
    entry.sourceMatchTeamId !== context.teamId ||
    entry.sourceUserId !== null ||
    entry.sourceDoublesTeamId !== null
  ) {
    throw new V2CompetitionApplicationError(
      "ENTRY_ROSTER_CORRUPT",
      "The TEAM Entry has an inconsistent typed source identity.",
      { entryId: entry.id, teamId: context.teamId },
    );
  }
  if (
    entry.status === "WITHDRAWN" ||
    entry.status === "DISQUALIFIED" ||
    entry.status === "ARCHIVED"
  ) {
    throw new V2CompetitionApplicationError(
      "ENTRY_SOURCE_NOT_ACTIVE",
      "A terminal TEAM Entry cannot be reopened or synchronized automatically.",
      { entryId: entry.id, status: entry.status },
    );
  }

  const versions = new Map<number, typeof entry.members>();
  for (const member of entry.members) {
    if (
      member.entryId !== entry.id ||
      member.matchId !== entry.matchId ||
      !Number.isSafeInteger(member.rosterVersion) ||
      member.rosterVersion < 1 ||
      !Number.isSafeInteger(member.slot) ||
      member.slot < 1
    ) {
      throw new V2CompetitionApplicationError(
        "ENTRY_ROSTER_CORRUPT",
        "The TEAM Entry contains an invalid roster member identity.",
        { entryId: entry.id, memberId: member.id },
      );
    }
    const members = versions.get(member.rosterVersion) ?? [];
    versions.set(member.rosterVersion, [...members, member]);
  }
  for (const [rosterVersion, members] of versions) {
    const slots = [...members].map((member) => member.slot).sort((a, b) => a - b);
    const userIds = members.map((member) => member.userId);
    const captainCount = members.filter(
      (member) => member.role === "captain",
    ).length;
    if (
      new Set(userIds).size !== userIds.length ||
      slots.some((slot, index) => slot !== index + 1) ||
      captainCount !== 1
    ) {
      throw new V2CompetitionApplicationError(
        "ENTRY_ROSTER_CORRUPT",
        "A TEAM Entry roster version must be complete and have one captain.",
        { entryId: entry.id, rosterVersion },
      );
    }
  }

  const current = currentRoster(entry);
  if (entry.status === "ACTIVE") {
    const currentVersions = new Set(
      current.map((member) => member.rosterVersion),
    );
    const latestVersion = Math.max(0, ...entry.members.map((member) => member.rosterVersion));
    const latestMembers = versions.get(latestVersion) ?? [];
    if (
      current.length === 0 ||
      currentVersions.size !== 1 ||
      current[0].rosterVersion !== latestVersion ||
      current.length !== latestMembers.length
    ) {
      throw new V2CompetitionApplicationError(
        "ENTRY_ROSTER_CORRUPT",
        "An ACTIVE TEAM Entry must expose exactly its latest complete roster.",
        { entryId: entry.id },
      );
    }
  } else if (current.length !== 0) {
    throw new V2CompetitionApplicationError(
      "ENTRY_ROSTER_CORRUPT",
      "A DRAFT TEAM Entry cannot retain current members.",
      { entryId: entry.id },
    );
  }
}

function sameRoster(
  current: readonly Readonly<{
    userId: string;
    role: "player" | "captain" | "substitute";
    slot: number;
  }>[],
  source: readonly V2EntryMemberSnapshot[],
) {
  if (current.length !== source.length) return false;
  const ordered = [...current].sort((left, right) => left.slot - right.slot);
  return ordered.every(
    (member, index) =>
      member.slot === index + 1 &&
      member.userId === source[index].userId &&
      member.role === source[index].role,
  );
}

function maxRosterVersion(entry: ReconcilerEntry) {
  return Math.max(0, ...entry.members.map((member) => member.rosterVersion));
}

/**
 * Reconciles one already-locked TEAM source to its stable Entry identity.
 * This function cannot be called with raw IDs: it requires the capability from
 * lockV2TeamEntryRegistrationContext and never opens its own transaction.
 */
export async function reconcileV2TeamEntryRegistrationInTransaction(
  tx: V2CompetitionTransaction,
  context: V2LockedTeamEntryRegistrationContext,
  settlementPort?: V2EntrySettlementPort,
): Promise<V2TeamEntryRegistrationResult> {
  assertLockContext(tx, context);
  assertEngineCanWrite(context.match.engineVersion, "V2");
  const limits = resolveTeamLimits(context.match);
  const settlements = settlementPort ?? DEFAULT_TEAM_ENTRY_SETTLEMENT_PORT;

  const team = await tx.matchTeam.findFirst({
    where: { id: context.teamId, matchId: context.match.id },
    select: {
      id: true,
      matchId: true,
      name: true,
      captainId: true,
      status: true,
      members: {
        orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          teamId: true,
          matchId: true,
          userId: true,
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
      "The locked TEAM source disappeared before reconciliation.",
      { matchId: context.match.id, teamId: context.teamId },
    );
  }

  const entry = (await tx.matchEntry.findUnique({
    where: {
      matchId_sourceMatchTeamId: {
        matchId: context.match.id,
        sourceMatchTeamId: context.teamId,
      },
    },
    select: {
      id: true,
      matchId: true,
      kind: true,
      status: true,
      sourceKey: true,
      sourceUserId: true,
      sourceDoublesTeamId: true,
      sourceMatchTeamId: true,
      displayNameSnapshot: true,
      version: true,
      members: {
        orderBy: [{ rosterVersion: "asc" }, { slot: "asc" }],
        select: {
          id: true,
          matchId: true,
          entryId: true,
          userId: true,
          displayNameSnapshot: true,
          role: true,
          status: true,
          slot: true,
          rosterVersion: true,
          effectiveUntil: true,
        },
      },
    },
  })) as ReconcilerEntry | null;

  if (entry) assertEntryIdentity(context, entry);
  if (team.status === "cancelled") {
    if (entry) {
      throw new V2CompetitionApplicationError(
        "ENTRY_SOURCE_NOT_ACTIVE",
        "A cancelled TEAM source with an Entry requires the explicit dissolve/withdraw command.",
        { entryId: entry.id, teamId: team.id },
      );
    }
    return {
      matchId: context.match.id,
      teamId: context.teamId,
      entryId: null,
      status: null,
      version: null,
      rosterVersion: null,
      action: "NOOP_CANCELLED_SOURCE_WITHOUT_ENTRY",
    };
  }
  if (team.status !== "approved" && team.status !== "draft") {
    throw new V2CompetitionApplicationError(
      "ENTRY_SOURCE_NOT_ACTIVE",
      "Only approved or below-threshold draft TEAM sources can be reconciled automatically.",
      { teamId: team.id, status: team.status },
    );
  }

  assertCompleteSource(context, team);
  const members = sourceRoster(team);
  const memberIds = members.map((member) => member.userId);
  if (members.length > limits.maximum) {
    throw new V2CompetitionApplicationError(
      "ENTRY_SOURCE_NOT_ACTIVE",
      "The TEAM source exceeds the configured member limit.",
      {
        teamId: team.id,
        memberCount: members.length,
        maximumTeamMembers: limits.maximum,
      },
    );
  }
  const reachedMinimum = members.length >= limits.minimum;
  if (
    (team.status === "approved" && !reachedMinimum) ||
    (team.status === "draft" && reachedMinimum)
  ) {
    throw new V2CompetitionApplicationError(
      "ENTRY_SOURCE_NOT_ACTIVE",
      "The TEAM source status disagrees with its configured member threshold.",
      {
        teamId: team.id,
        status: team.status,
        memberCount: members.length,
        minimumTeamMembers: limits.minimum,
      },
    );
  }

  const resolvedSource: V2ResolvedEntrySource = {
    displayNameSnapshot: team.name,
    ownerId: team.captainId,
    members,
  };
  const kernelMatch = {
    id: context.match.id,
    type: context.match.type,
    teamMinMembers: limits.minimum,
    teamMaxMembers: limits.maximum,
  } as const;

  if (!entry) {
    if (team.status === "draft") {
      return {
        matchId: context.match.id,
        teamId: context.teamId,
        entryId: null,
        status: null,
        version: null,
        rosterVersion: null,
        action: "NOOP_DRAFT_SOURCE",
      };
    }
    assertEntryCanActivate({
      kind: "TEAM",
      memberIds,
      minimumTeamMembers: limits.minimum,
      maximumTeamMembers: limits.maximum,
    });
    const created = await createV2EntryKernel(
      tx,
      {
        match: kernelMatch,
        command: {
          kind: "TEAM",
          sourceId: context.teamId,
          status: "ACTIVE",
        },
        source: resolvedSource,
        settlementOrigin: context.settlementOrigin,
      },
      settlements,
    );
    if (!created.created || created.kind !== "TEAM" || created.status !== "ACTIVE") {
      throw new V2CompetitionApplicationError(
        "PERSISTENCE_CONFLICT",
        "TEAM Entry creation did not produce the expected new ACTIVE identity.",
        { teamId: context.teamId, entryId: created.id },
      );
    }
    return {
      matchId: context.match.id,
      teamId: context.teamId,
      entryId: created.id,
      status: "ACTIVE",
      version: created.version,
      rosterVersion: created.rosterVersion,
      action: "CREATED_ACTIVE",
    };
  }

  const current = currentRoster(entry);
  if (team.status === "draft") {
    if (entry.status !== "ACTIVE") {
      if (entry.displayNameSnapshot !== team.name) {
        const synchronized = await synchronizeV2EntryDisplayNameKernel(tx, {
          matchId: context.match.id,
          entryId: entry.id,
          expectedVersion: entry.version,
          displayNameSnapshot: team.name,
        });
        return {
          matchId: context.match.id,
          teamId: context.teamId,
          entryId: entry.id,
          status: "DRAFT",
          version: synchronized.version,
          rosterVersion: maxRosterVersion(entry) || null,
          action: "SYNCHRONIZED_NAME",
        };
      }
      return {
        matchId: context.match.id,
        teamId: context.teamId,
        entryId: entry.id,
        status: "DRAFT",
        version: entry.version,
        rosterVersion: maxRosterVersion(entry) || null,
        action: "NOOP_DRAFT_SOURCE",
      };
    }

    const transitioned = await transitionV2EntryStatusKernel(
      tx,
      {
        matchId: context.match.id,
        entry,
        expectedVersion: entry.version,
        to: "DRAFT",
        displayNameSnapshot: team.name,
      },
      settlements,
    );
    return {
      matchId: context.match.id,
      teamId: context.teamId,
      entryId: entry.id,
      status: "DRAFT",
      version: transitioned.version,
      rosterVersion: maxRosterVersion(entry),
      action: "DEACTIVATED_TO_DRAFT",
    };
  }

  assertEntryCanActivate({
    kind: "TEAM",
    memberIds,
    minimumTeamMembers: limits.minimum,
    maximumTeamMembers: limits.maximum,
  });
  if (entry.status === "DRAFT") {
    const transitioned = await transitionV2EntryStatusKernel(
      tx,
      {
        matchId: context.match.id,
        entry,
        expectedVersion: entry.version,
        to: "ACTIVE",
        activationSource: resolvedSource,
        activationOrigin: context.settlementOrigin,
        forceSuccessorActivationRoster: true,
        displayNameSnapshot: team.name,
      },
      settlements,
    );
    return {
      matchId: context.match.id,
      teamId: context.teamId,
      entryId: entry.id,
      status: "ACTIVE",
      version: transitioned.version,
      rosterVersion: maxRosterVersion(entry) + 1,
      action: "REACTIVATED",
    };
  }

  if (sameRoster(current, members)) {
    if (entry.displayNameSnapshot !== team.name) {
      const synchronized = await synchronizeV2EntryDisplayNameKernel(tx, {
        matchId: context.match.id,
        entryId: entry.id,
        expectedVersion: entry.version,
        displayNameSnapshot: team.name,
      });
      return {
        matchId: context.match.id,
        teamId: context.teamId,
        entryId: entry.id,
        status: "ACTIVE",
        version: synchronized.version,
        rosterVersion: maxRosterVersion(entry),
        action: "SYNCHRONIZED_NAME",
      };
    }
    return {
      matchId: context.match.id,
      teamId: context.teamId,
      entryId: entry.id,
      status: "ACTIVE",
      version: entry.version,
      rosterVersion: maxRosterVersion(entry),
      action: "NOOP_ALREADY_SYNCHRONIZED",
    };
  }

  const replaced = await replaceV2EntryRosterKernel(
    tx,
    {
      matchId: context.match.id,
      entry: { ...entry, members: current },
      expectedVersion: entry.version,
      members,
      settlementOrigin: context.settlementOrigin,
      displayNameSnapshot: team.name,
    },
    settlements,
  );
  return {
    matchId: context.match.id,
    teamId: context.teamId,
    entryId: entry.id,
    status: "ACTIVE",
    version: replaced.version,
    rosterVersion: replaced.rosterVersion,
    action: "REPLACED_ACTIVE_ROSTER",
  };
}

export type V2TeamEntryRegistrationDatabase = V2CompetitionDatabase;

/**
 * Thin trusted application service for jobs/tests. Route adapters must not call
 * it directly because source-action authorization belongs to the enclosing
 * MatchTeam command. Production source commands should compose the lock helper
 * and in-transaction reconciler in their own Serializable transaction.
 */
export async function reconcileV2TeamEntryRegistration(
  db: V2TeamEntryRegistrationDatabase,
  input: Pick<LockV2TeamEntryRegistrationInput, "matchId" | "teamId">,
  settlementPort?: V2EntrySettlementPort,
) {
  return runV2Transaction(db, async (tx) => {
    const context = await lockV2TeamEntryRegistrationContext(tx, input);
    return reconcileV2TeamEntryRegistrationInTransaction(
      tx,
      context,
      settlementPort,
    );
  });
}
