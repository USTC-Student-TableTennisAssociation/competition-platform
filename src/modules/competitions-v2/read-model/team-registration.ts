import { Prisma, type PrismaClient } from "@prisma/client";

import {
  V2_TEAM_GROUPING_READ_PROFILE,
  V2GroupOnlyGroupingReadIntegrityError,
  getV2GroupOnlyGroupingReadModelInTransaction,
  type V2CompetitionGroupingReadModel,
  type V2GroupOnlyGroupingReadModel,
} from "./group-only-grouping";

const TEAM_REGISTRATION_SELECT = Prisma.validator<Prisma.MatchSelect>()({
  id: true,
  title: true,
  description: true,
  dateTime: true,
  location: true,
  isQuickMatch: true,
  type: true,
  status: true,
  engineVersion: true,
  format: true,
  createdBy: true,
  registrationDeadline: true,
  teamRegistrationStart: true,
  teamRegistrationDeadline: true,
  teamMinMembers: true,
  teamMaxMembers: true,
  createdAt: true,
  creator: {
    select: { id: true, nickname: true, avatarUrl: true },
  },
  teamRegistrations: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      matchId: true,
      captainId: true,
      name: true,
      inviteCode: true,
      contact: true,
      remark: true,
      reviewNote: true,
      status: true,
      submittedAt: true,
      reviewedAt: true,
      createdAt: true,
      captain: {
        select: {
          id: true,
          nickname: true,
          avatarUrl: true,
          isBanned: true,
          emailVerifiedAt: true,
        },
      },
      members: {
        orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          teamId: true,
          matchId: true,
          userId: true,
          joinedAt: true,
          user: {
            select: {
              id: true,
              nickname: true,
              avatarUrl: true,
              isBanned: true,
              emailVerifiedAt: true,
            },
          },
        },
      },
    },
  },
  entries: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
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
        orderBy: [
          { rosterVersion: "asc" },
          { slot: "asc" },
          { id: "asc" },
        ],
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
          user: {
            select: {
              id: true,
              nickname: true,
              avatarUrl: true,
              isBanned: true,
              emailVerifiedAt: true,
            },
          },
        },
      },
    },
  },
});

type TeamRegistrationSource = Prisma.MatchGetPayload<{
  select: typeof TEAM_REGISTRATION_SELECT;
}>;
type SourceEntry = TeamRegistrationSource["entries"][number];
type SourceTeam = TeamRegistrationSource["teamRegistrations"][number];

export type V2TeamRegistrationDatabase = Pick<PrismaClient, "$transaction">;
type V2TeamRegistrationTransaction = Parameters<
  Parameters<Pick<PrismaClient, "$transaction">["$transaction"]>[0]
>[0];

export class V2TeamRegistrationIntegrityError extends Error {
  readonly matchId: string;
  readonly entityId: string;

  constructor(message: string, matchId: string, entityId = matchId) {
    super(message);
    this.name = "V2TeamRegistrationIntegrityError";
    this.matchId = matchId;
    this.entityId = entityId;
  }
}

export type V2TeamRegistrationEntry = Readonly<{
  entryId: string;
  entryVersion: number;
  status: "DRAFT" | "ACTIVE" | "WITHDRAWN" | "DISQUALIFIED";
  currentRosterVersion: number | null;
}>;

export type V2TeamRegistrationItem = Readonly<{
  id: string;
  name: string;
  inviteCode: string;
  captainId: string;
  captainNickname: string;
  contact: string | null;
  remark: string | null;
  reviewNote: string | null;
  status: "draft" | "approved" | "cancelled";
  submittedAt: string | null;
  reviewedAt: string | null;
  createdAt: string;
  members: readonly Readonly<{
    userId: string;
    nickname: string;
    avatarUrl: string | null;
    joinedAt: string;
    isCurrentlyEligible: boolean;
  }>[];
  entry: V2TeamRegistrationEntry | null;
}>;

export type V2TeamRegistrationReadState =
  | Readonly<{ kind: "MATCH_NOT_FOUND" }>
  | Readonly<{ kind: "UNSUPPORTED_V2_MATCH" }>
  | Readonly<{
      kind: "TEAM_V2_REGISTRATION";
      match: Readonly<{
        id: string;
        title: string;
        description: string | null;
        dateTime: string;
        location: string | null;
        status: "registration" | "ongoing" | "finished";
        format: "group_only" | "group_then_knockout";
        createdBy: string;
        registrationStartsAt: string;
        registrationDeadline: string;
        teamMinMembers: number;
        teamMaxMembers: number;
        creator: Readonly<{
          userId: string;
          nickname: string;
          avatarUrl: string | null;
        }>;
      }>;
      registration: Readonly<{
        open: boolean;
        notStarted: boolean;
        closed: boolean;
      }>;
      teams: readonly V2TeamRegistrationItem[];
      activeEntryCount: number;
      activeMemberCount: number;
      grouping: V2CompetitionGroupingReadModel;
    }>;

function integrity(
  source: TeamRegistrationSource,
  message: string,
  entityId = source.id,
): never {
  throw new V2TeamRegistrationIntegrityError(message, source.id, entityId);
}

function validateTeamSettings(source: TeamRegistrationSource) {
  const start = source.teamRegistrationStart;
  const deadline = source.teamRegistrationDeadline;
  const minimum = source.teamMinMembers;
  const maximum = source.teamMaxMembers;
  if (
    !start ||
    !deadline ||
    !Number.isSafeInteger(minimum) ||
    minimum === null ||
    minimum < 1 ||
    !Number.isSafeInteger(maximum) ||
    maximum === null ||
    maximum < minimum ||
    maximum > 50 ||
    start.getTime() >= deadline.getTime() ||
    deadline.getTime() >= source.dateTime.getTime() ||
    source.registrationDeadline.getTime() !== deadline.getTime()
  ) {
    integrity(source, "The TEAM registration settings are inconsistent.");
  }
  return { start, deadline, minimum, maximum };
}

function validateSourceTeam(
  source: TeamRegistrationSource,
  team: SourceTeam,
  minimum: number,
  maximum: number,
) {
  if (
    team.matchId !== source.id ||
    team.name.trim() === "" ||
    team.name !== team.name.trim() ||
    team.inviteCode.trim() === "" ||
    team.captain.id !== team.captainId ||
    (team.status !== "draft" &&
      team.status !== "approved" &&
      team.status !== "cancelled") ||
    team.members.length === 0 ||
    team.members.length > maximum
  ) {
    integrity(source, "A TEAM source row is malformed.", team.id);
  }
  const userIds = team.members.map((member) => member.userId);
  if (
    new Set(userIds).size !== userIds.length ||
    userIds.filter((userId) => userId === team.captainId).length !== 1 ||
    team.members.some(
      (member) =>
        member.teamId !== team.id ||
        member.matchId !== source.id ||
        member.user.id !== member.userId ||
        member.user.nickname.trim() === "",
    ) ||
    (team.status === "approved" && team.members.length < minimum) ||
    (team.status === "draft" && team.members.length >= minimum)
  ) {
    integrity(source, "A TEAM source roster is inconsistent.", team.id);
  }
}

function validateRosterHistory(
  source: TeamRegistrationSource,
  entry: SourceEntry,
) {
  const versions = new Map<number, SourceEntry["members"]>();
  for (const member of entry.members) {
    if (
      member.matchId !== source.id ||
      member.entryId !== entry.id ||
      member.user.id !== member.userId ||
      !Number.isSafeInteger(member.rosterVersion) ||
      member.rosterVersion < 1 ||
      !Number.isSafeInteger(member.slot) ||
      member.slot < 1
    ) {
      integrity(source, "A TEAM Entry member row is malformed.", member.id);
    }
    const version = versions.get(member.rosterVersion) ?? [];
    versions.set(member.rosterVersion, [...version, member]);
  }
  for (const [rosterVersion, members] of versions) {
    const ordered = [...members].sort((left, right) => left.slot - right.slot);
    if (
      new Set(ordered.map((member) => member.userId)).size !== ordered.length ||
      ordered.some((member, index) => member.slot !== index + 1) ||
      ordered.filter((member) => member.role === "captain").length !== 1
    ) {
      integrity(
        source,
        "A TEAM Entry roster version is incomplete.",
        `${entry.id}:${rosterVersion}`,
      );
    }
  }
  return versions;
}

function toEntry(
  source: TeamRegistrationSource,
  team: SourceTeam,
  entry: SourceEntry,
): V2TeamRegistrationEntry {
  if (
    entry.matchId !== source.id ||
    entry.kind !== "TEAM" ||
    (entry.status !== "DRAFT" &&
      entry.status !== "ACTIVE" &&
      entry.status !== "WITHDRAWN" &&
      entry.status !== "DISQUALIFIED") ||
    entry.sourceKey !== `team:${team.id}` ||
    entry.sourceMatchTeamId !== team.id ||
    entry.sourceUserId !== null ||
    entry.sourceDoublesTeamId !== null ||
    entry.displayNameSnapshot !== team.name
  ) {
    integrity(source, "A TEAM Entry source identity is inconsistent.", entry.id);
  }
  const versions = validateRosterHistory(source, entry);
  const current = entry.members.filter(
    (member) => member.status === "ACTIVE" && member.effectiveUntil === null,
  );
  const latestRosterVersion = Math.max(0, ...versions.keys());
  if (entry.status !== "ACTIVE") {
    if (current.length !== 0) {
      integrity(source, "A non-active TEAM Entry retains a current roster.", entry.id);
    }
    return {
      entryId: entry.id,
      entryVersion: entry.version,
      status: entry.status,
      currentRosterVersion: null,
    };
  }

  const latest = versions.get(latestRosterVersion) ?? [];
  const orderedCurrent = [...current].sort((left, right) => left.slot - right.slot);
  if (
    latestRosterVersion < 1 ||
    orderedCurrent.length !== latest.length ||
    orderedCurrent.some(
      (member, index) =>
        member.id !== latest[index]?.id ||
        member.rosterVersion !== latestRosterVersion,
    ) ||
    orderedCurrent.length !== team.members.length ||
    orderedCurrent.some(
      (member, index) =>
        member.userId !== team.members[index]?.userId ||
        member.role !==
          (member.userId === team.captainId ? "captain" : "player"),
    )
  ) {
    integrity(source, "An ACTIVE TEAM Entry roster differs from its source.", entry.id);
  }
  return {
    entryId: entry.id,
    entryVersion: entry.version,
    status: "ACTIVE",
    currentRosterVersion: latestRosterVersion,
  };
}

function buildState(
  source: TeamRegistrationSource | null,
  now: Date,
  grouping: V2GroupOnlyGroupingReadModel,
): V2TeamRegistrationReadState {
  if (!source) return { kind: "MATCH_NOT_FOUND" };
  if (
    source.engineVersion !== "V2" ||
    source.isQuickMatch ||
    source.type !== "team" ||
    (source.format !== "group_only" &&
      source.format !== "group_then_knockout")
  ) {
    return { kind: "UNSUPPORTED_V2_MATCH" };
  }
  if (!Number.isFinite(now.getTime())) {
    integrity(source, "The TEAM registration clock is invalid.");
  }
  if (
    (grouping.kind !== "GROUP_ONLY_V2_MATCH" &&
      grouping.kind !== "GROUP_THEN_KNOCKOUT_V2_MATCH") ||
    grouping.match.id !== source.id ||
    grouping.match.type !== "team" ||
    grouping.match.format !== source.format
  ) {
    integrity(source, "The TEAM grouping projection is unavailable or inconsistent.");
  }

  const settings = validateTeamSettings(source);
  const entryByTeamId = new Map<string, SourceEntry>();
  for (const entry of source.entries) {
    if (!entry.sourceMatchTeamId || entryByTeamId.has(entry.sourceMatchTeamId)) {
      integrity(source, "A TEAM source maps to an invalid number of Entries.", entry.id);
    }
    entryByTeamId.set(entry.sourceMatchTeamId, entry);
  }

  const teams = source.teamRegistrations.map((team) => {
    validateSourceTeam(
      source,
      team,
      settings.minimum,
      settings.maximum,
    );
    const status = team.status as "draft" | "approved" | "cancelled";
    const sourceEntry = entryByTeamId.get(team.id) ?? null;
    const entry = sourceEntry ? toEntry(source, team, sourceEntry) : null;
    if (
      (status === "approved" && entry?.status !== "ACTIVE") ||
      (status === "draft" && entry !== null && entry.status !== "DRAFT") ||
      (status === "cancelled" && entry !== null && entry.status !== "WITHDRAWN")
    ) {
      if (status === "approved" && (entry?.status === "DISQUALIFIED" || entry?.status === "WITHDRAWN")) {
        // A post-publication manager DQ deliberately preserves the approved
        // source row while terminating only its V2 competition identity.
      } else {
      integrity(source, "A TEAM source status disagrees with its Entry.", team.id);
      }
    }
    entryByTeamId.delete(team.id);
    return {
      id: team.id,
      name: team.name,
      inviteCode: team.inviteCode,
      captainId: team.captainId,
      captainNickname: team.captain.nickname,
      contact: team.contact,
      remark: team.remark,
      reviewNote: team.reviewNote,
      status,
      submittedAt: team.submittedAt?.toISOString() ?? null,
      reviewedAt: team.reviewedAt?.toISOString() ?? null,
      createdAt: team.createdAt.toISOString(),
      members: team.members.map((member) => ({
        userId: member.userId,
        nickname: member.user.nickname,
        avatarUrl: member.user.avatarUrl,
        joinedAt: member.joinedAt.toISOString(),
        isCurrentlyEligible:
          !member.user.isBanned && member.user.emailVerifiedAt !== null,
      })),
      entry,
    } satisfies V2TeamRegistrationItem;
  });
  if (entryByTeamId.size !== 0) {
    integrity(source, "A TEAM Entry points to a missing source team.");
  }

  const activeTeams = teams.filter((team) => team.entry?.status === "ACTIVE");
  const activeEntryIds = activeTeams.map((team) => team.entry!.entryId).sort();
  const groupingEntryIds = grouping.activeEntries
    .map((entry) => entry.entryId)
    .sort();
  if (
    activeEntryIds.length !== groupingEntryIds.length ||
    activeEntryIds.some((entryId, index) => entryId !== groupingEntryIds[index])
  ) {
    integrity(source, "The TEAM detail and grouping Entry sets disagree.");
  }

  const registrationOpen =
    source.status === "registration" &&
    now.getTime() >= settings.start.getTime() &&
    now.getTime() < settings.deadline.getTime();
  return {
    kind: "TEAM_V2_REGISTRATION",
    match: {
      id: source.id,
      title: source.title,
      description: source.description,
      dateTime: source.dateTime.toISOString(),
      location: source.location,
      status: source.status,
      format: source.format,
      createdBy: source.createdBy,
      registrationStartsAt: settings.start.toISOString(),
      registrationDeadline: settings.deadline.toISOString(),
      teamMinMembers: settings.minimum,
      teamMaxMembers: settings.maximum,
      creator: {
        userId: source.creator.id,
        nickname: source.creator.nickname,
        avatarUrl: source.creator.avatarUrl,
      },
    },
    registration: {
      open: registrationOpen,
      notStarted:
        source.status === "registration" &&
        now.getTime() < settings.start.getTime(),
      closed:
        source.status !== "registration" ||
        now.getTime() >= settings.deadline.getTime(),
    },
    teams,
    activeEntryCount: activeTeams.length,
    activeMemberCount: activeTeams.reduce(
      (total, team) => total + team.members.length,
      0,
    ),
    grouping,
  };
}

/** Reads TEAM sources, Entries, and grouping from one RepeatableRead snapshot. */
export async function getV2TeamRegistrationReadStateInTransaction(
  tx: V2TeamRegistrationTransaction,
  matchId: string,
  now = new Date(),
): Promise<V2TeamRegistrationReadState> {
  try {
    const [source, grouping] = await Promise.all([
      tx.match.findUnique({
        where: { id: matchId },
        select: TEAM_REGISTRATION_SELECT,
      }),
      getV2GroupOnlyGroupingReadModelInTransaction(
        tx,
        matchId,
        V2_TEAM_GROUPING_READ_PROFILE,
      ),
    ]);
    return buildState(source, now, grouping);
  } catch (error) {
    if (error instanceof V2GroupOnlyGroupingReadIntegrityError) {
      throw new V2TeamRegistrationIntegrityError(
        error.message,
        error.matchId,
        error.entityId,
      );
    }
    throw error;
  }
}

export async function getV2TeamRegistrationReadState(
  db: V2TeamRegistrationDatabase,
  matchId: string,
  now = new Date(),
): Promise<V2TeamRegistrationReadState> {
  return db.$transaction(
    (tx) => getV2TeamRegistrationReadStateInTransaction(tx, matchId, now),
    { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 10_000 },
  );
}
