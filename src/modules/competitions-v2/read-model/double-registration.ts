import { Prisma, type PrismaClient } from "@prisma/client";

import {
  V2_DOUBLE_GROUPING_READ_PROFILE,
  V2GroupOnlyGroupingReadIntegrityError,
  getV2GroupOnlyGroupingReadModelInTransaction,
  type V2CompetitionGroupingReadModel,
  type V2GroupOnlyGroupingReadModel,
} from "./group-only-grouping";

const DOUBLE_REGISTRATION_SELECT = Prisma.validator<Prisma.MatchSelect>()({
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
  createdAt: true,
  updatedAt: true,
  creator: {
    select: { id: true, nickname: true, avatarUrl: true },
  },
  doublesTeams: {
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      createdById: true,
      createdAt: true,
      members: {
        orderBy: [{ slot: "asc" }, { id: "asc" }],
        select: {
          id: true,
          userId: true,
          slot: true,
          user: {
            select: {
              id: true,
              nickname: true,
              avatarUrl: true,
              eloRating: true,
              points: true,
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
      kind: true,
      status: true,
      sourceKey: true,
      sourceDoublesTeamId: true,
      displayNameSnapshot: true,
      version: true,
      createdAt: true,
      updatedAt: true,
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
          status: true,
          slot: true,
          rosterVersion: true,
          effectiveFrom: true,
          effectiveUntil: true,
          user: {
            select: {
              id: true,
              nickname: true,
              avatarUrl: true,
              eloRating: true,
              points: true,
              isBanned: true,
            },
          },
        },
      },
    },
  },
});

type DoubleRegistrationSource = Prisma.MatchGetPayload<{
  select: typeof DOUBLE_REGISTRATION_SELECT;
}>;

export type V2DoubleRegistrationDatabase = Pick<PrismaClient, "$transaction">;
type V2DoubleRegistrationTransaction = Parameters<
  Parameters<Pick<PrismaClient, "$transaction">["$transaction"]>[0]
>[0];

export class V2DoubleRegistrationIntegrityError extends Error {
  readonly matchId: string;
  readonly entityId: string;

  constructor(message: string, matchId: string, entityId = matchId) {
    super(message);
    this.name = "V2DoubleRegistrationIntegrityError";
    this.matchId = matchId;
    this.entityId = entityId;
  }
}

export type V2DoubleRegistrationMember = Readonly<{
  userId: string;
  frozenDisplayName: string;
  nickname: string;
  avatarUrl: string | null;
  currentEloRating: number;
  currentPoints: number;
  isCurrentlyBanned: boolean;
}>;

export type V2DoubleRegistrationEntry = Readonly<{
  entryId: string;
  entryVersion: number;
  sourceTeamId: string;
  sourceKey: string;
  frozenDisplayName: string;
  status: "DRAFT" | "ACTIVE" | "WITHDRAWN" | "DISQUALIFIED" | "ARCHIVED";
  currentRosterVersion: number | null;
  members: readonly V2DoubleRegistrationMember[];
}>;

export type V2DoubleSourceTeam = Readonly<{
  sourceTeamId: string;
  createdById: string;
  membersEligible: boolean;
  members: readonly Readonly<{
    userId: string;
    nickname: string;
    avatarUrl: string | null;
    slot: number;
  }>[];
  entry: V2DoubleRegistrationEntry | null;
}>;

export type V2DoubleViewerRegistration = Readonly<{
  sourceTeam: V2DoubleSourceTeam | null;
  action: "LOGIN" | "FORM_TEAM" | "REGISTER" | "CANCEL" | "NONE";
  message: string;
}>;

export type V2DoubleRegistrationReadState =
  | Readonly<{ kind: "MATCH_NOT_FOUND" }>
  | Readonly<{ kind: "UNSUPPORTED_V2_MATCH" }>
  | Readonly<{
      kind: "DOUBLE_V2_REGISTRATION";
      match: Readonly<{
        id: string;
        title: string;
        description: string | null;
        dateTime: string;
        location: string | null;
        status: "registration" | "ongoing" | "finished";
        format: "group_only" | "group_then_knockout";
        createdBy: string;
        registrationDeadline: string;
        creator: Readonly<{
          userId: string;
          nickname: string;
          avatarUrl: string | null;
        }>;
      }>;
      activeEntries: readonly V2DoubleRegistrationEntry[];
      activeEntryCount: number;
      activeMemberCount: number;
      viewer: V2DoubleViewerRegistration;
      grouping: V2CompetitionGroupingReadModel;
    }>;

function integrity(
  source: DoubleRegistrationSource,
  message: string,
  entityId = source.id,
): never {
  throw new V2DoubleRegistrationIntegrityError(message, source.id, entityId);
}

function currentEntryMembers(
  source: DoubleRegistrationSource,
  entry: DoubleRegistrationSource["entries"][number],
) {
  const current = entry.members.filter(
    (member) => member.status === "ACTIVE" && member.effectiveUntil === null,
  );
  if (entry.status === "ACTIVE" && current.length !== 2) {
    integrity(source, "An ACTIVE doubles Entry must have exactly two current members.", entry.id);
  }
  if (entry.status === "DRAFT" && current.length !== 0 && current.length !== 2) {
    integrity(source, "A DRAFT doubles Entry has a partial current roster.", entry.id);
  }
  if (
    entry.status !== "ACTIVE" &&
    entry.status !== "DRAFT" &&
    current.length !== 0
  ) {
    integrity(source, "A terminal doubles Entry cannot retain current members.", entry.id);
  }
  if (new Set(current.map((member) => member.userId)).size !== current.length) {
    integrity(source, "A doubles Entry contains duplicate current users.", entry.id);
  }
  if (
    current.length === 2 &&
    (new Set(current.map((member) => member.rosterVersion)).size !== 1 ||
      current[0]?.slot !== 1 ||
      current[1]?.slot !== 2 ||
      current[0].rosterVersion !==
        entry.members.reduce(
          (latest, member) => Math.max(latest, member.rosterVersion),
          0,
        ))
  ) {
    integrity(
      source,
      "A current doubles Entry roster must use its latest version with slots 1 and 2.",
      entry.id,
    );
  }
  return current;
}

function toEntry(
  source: DoubleRegistrationSource,
  entry: DoubleRegistrationSource["entries"][number],
): V2DoubleRegistrationEntry {
  if (entry.kind !== "DOUBLES" || !entry.sourceDoublesTeamId) {
    integrity(source, "A V2 doubles match contains a non-doubles Entry.", entry.id);
  }
  if (entry.sourceKey !== `doubles:${entry.sourceDoublesTeamId}`) {
    integrity(source, "A doubles Entry source identity is inconsistent.", entry.id);
  }
  const current = currentEntryMembers(source, entry);
  const latestRosterVersion = entry.members.reduce(
    (latest, member) => Math.max(latest, member.rosterVersion),
    0,
  );
  return {
    entryId: entry.id,
    entryVersion: entry.version,
    sourceTeamId: entry.sourceDoublesTeamId,
    sourceKey: entry.sourceKey,
    frozenDisplayName: entry.displayNameSnapshot,
    status: entry.status,
    currentRosterVersion: current.length === 0 ? null : latestRosterVersion,
    members: current.map((member) => ({
      userId: member.userId,
      frozenDisplayName: member.displayNameSnapshot,
      nickname: member.user.nickname,
      avatarUrl: member.user.avatarUrl,
      currentEloRating: member.user.eloRating,
      currentPoints: member.user.points,
      isCurrentlyBanned: member.user.isBanned,
    })),
  };
}

function buildViewer(
  source: DoubleRegistrationSource,
  sourceTeams: readonly V2DoubleSourceTeam[],
  viewerUserId: string | null,
  now: Date,
): V2DoubleViewerRegistration {
  if (!viewerUserId) {
    return { sourceTeam: null, action: "LOGIN", message: "登录后可组队和报名。" };
  }
  const viewerTeams = sourceTeams.filter((team) =>
    team.members.some((member) => member.userId === viewerUserId),
  );
  if (viewerTeams.length > 1) {
    integrity(source, "One user belongs to multiple doubles source teams.", viewerUserId);
  }
  const sourceTeam = viewerTeams[0] ?? null;
  const registrationOpen =
    source.status === "registration" && now < source.registrationDeadline;
  if (!registrationOpen) {
    return {
      sourceTeam,
      action: "NONE",
      message: "当前不在可报名或退出的时间范围内。",
    };
  }
  if (!sourceTeam) {
    return {
      sourceTeam: null,
      action: "FORM_TEAM",
      message: "请先邀请一名队友并完成双打组队。",
    };
  }
  if (sourceTeam.entry?.status === "ACTIVE") {
    return {
      sourceTeam,
      action: "CANCEL",
      message: "小队已报名；任一伙伴均可在截止前退出报名。",
    };
  }
  if (!sourceTeam.membersEligible) {
    return {
      sourceTeam,
      action: "NONE",
      message: "小队成员账号状态不满足报名条件。",
    };
  }
  if (!sourceTeam.entry || sourceTeam.entry.status === "DRAFT") {
    return {
      sourceTeam,
      action: "REGISTER",
      message: "小队已组建，可以报名。",
    };
  }
  return {
    sourceTeam,
    action: "NONE",
    message: "该小队报名已进入终态，不能再次报名。",
  };
}

function buildState(
  source: DoubleRegistrationSource | null,
  viewerUserId: string | null,
  now: Date,
  grouping: V2GroupOnlyGroupingReadModel,
): V2DoubleRegistrationReadState {
  if (!source) return { kind: "MATCH_NOT_FOUND" };
  if (
    source.engineVersion !== "V2" ||
    source.isQuickMatch ||
    source.type !== "double" ||
    (source.format !== "group_only" &&
      source.format !== "group_then_knockout")
  ) {
    return { kind: "UNSUPPORTED_V2_MATCH" };
  }
  if (
    (grouping.kind !== "GROUP_ONLY_V2_MATCH" &&
      grouping.kind !== "GROUP_THEN_KNOCKOUT_V2_MATCH") ||
    grouping.match.id !== source.id ||
    grouping.match.type !== "double" ||
    grouping.match.format !== source.format
  ) {
    integrity(source, "The DOUBLE grouping projection is unavailable or inconsistent.");
  }

  const entries = source.entries.map((entry) => toEntry(source, entry));
  const entryBySourceTeamId = new Map<string, V2DoubleRegistrationEntry>();
  for (const entry of entries) {
    if (entryBySourceTeamId.has(entry.sourceTeamId)) {
      integrity(source, "A doubles source team maps to multiple Entries.", entry.sourceTeamId);
    }
    entryBySourceTeamId.set(entry.sourceTeamId, entry);
  }

  const sourceTeams = source.doublesTeams.map((team) => {
    if (
      team.members.length !== 2 ||
      new Set(team.members.map((member) => member.userId)).size !== 2 ||
      team.members[0]?.slot !== 1 ||
      team.members[1]?.slot !== 2
    ) {
      integrity(source, "A doubles source team must contain slots 1 and 2.", team.id);
    }
    const entry = entryBySourceTeamId.get(team.id) ?? null;
    if (entry && entry.members.length > 0) {
      const sourceMemberIds = team.members.map((member) => member.userId).sort();
      const entryMemberIds = entry.members.map((member) => member.userId).sort();
      if (
        sourceMemberIds.length !== entryMemberIds.length ||
        sourceMemberIds.some((userId, index) => userId !== entryMemberIds[index])
      ) {
        integrity(
          source,
          "An ACTIVE doubles Entry roster differs from its source team.",
          entry.entryId,
        );
      }
    }
    return {
      sourceTeamId: team.id,
      createdById: team.createdById,
      membersEligible: team.members.every(
        (member) => !member.user.isBanned && member.user.emailVerifiedAt !== null,
      ),
      members: team.members.map((member) => ({
        userId: member.userId,
        nickname: member.user.nickname,
        avatarUrl: member.user.avatarUrl,
        slot: member.slot,
      })),
      entry,
    } satisfies V2DoubleSourceTeam;
  });

  const sourceTeamIds = new Set(sourceTeams.map((team) => team.sourceTeamId));
  for (const entry of entries) {
    if (!sourceTeamIds.has(entry.sourceTeamId)) {
      integrity(source, "A doubles Entry points to a missing source team.", entry.entryId);
    }
  }
  const activeEntries = entries.filter((entry) => entry.status === "ACTIVE");
  const activeUserIds = activeEntries.flatMap((entry) =>
    entry.members.map((member) => member.userId),
  );
  if (new Set(activeUserIds).size !== activeUserIds.length) {
    integrity(source, "A user appears in multiple ACTIVE doubles Entries.");
  }

  return {
    kind: "DOUBLE_V2_REGISTRATION",
    match: {
      id: source.id,
      title: source.title,
      description: source.description,
      dateTime: source.dateTime.toISOString(),
      location: source.location,
      status: source.status,
      format: source.format,
      createdBy: source.createdBy,
      registrationDeadline: source.registrationDeadline.toISOString(),
      creator: {
        userId: source.creator.id,
        nickname: source.creator.nickname,
        avatarUrl: source.creator.avatarUrl,
      },
    },
    activeEntries,
    activeEntryCount: activeEntries.length,
    activeMemberCount: activeEntries.length * 2,
    viewer: buildViewer(source, sourceTeams, viewerUserId, now),
    grouping,
  };
}

/** Reads the doubles registration state from one RepeatableRead V2 snapshot. */
export async function getV2DoubleRegistrationReadStateInTransaction(
  tx: V2DoubleRegistrationTransaction,
  matchId: string,
  viewerUserId: string | null,
  now = new Date(),
): Promise<V2DoubleRegistrationReadState> {
  try {
    const [source, grouping] = await Promise.all([
      tx.match.findUnique({
        where: { id: matchId },
        select: DOUBLE_REGISTRATION_SELECT,
      }),
      getV2GroupOnlyGroupingReadModelInTransaction(
        tx,
        matchId,
        V2_DOUBLE_GROUPING_READ_PROFILE,
      ),
    ]);
    return buildState(source, viewerUserId, now, grouping);
  } catch (error) {
    if (error instanceof V2GroupOnlyGroupingReadIntegrityError) {
      throw new V2DoubleRegistrationIntegrityError(
        error.message,
        error.matchId,
        error.entityId,
      );
    }
    throw error;
  }
}

export async function getV2DoubleRegistrationReadState(
  db: V2DoubleRegistrationDatabase,
  matchId: string,
  viewerUserId: string | null,
  now = new Date(),
): Promise<V2DoubleRegistrationReadState> {
  return db.$transaction(
    (tx) =>
      getV2DoubleRegistrationReadStateInTransaction(
        tx,
        matchId,
        viewerUserId,
        now,
      ),
    { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 10_000 },
  );
}
