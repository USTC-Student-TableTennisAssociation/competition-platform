import type { PrismaClient } from "@prisma/client";

import { generateGroupingPayload } from "../../../lib/tournament";
import {
  V2CompetitionApplicationError,
  type V2Actor,
} from "../application/entries";
import {
  V2ActionBoundaryError,
} from "./action-boundary";
import {
  V2_GROUP_ONLY_GROUPING_PREVIEW_SCHEMA_VERSION,
  assertV2GroupOnlyGroupingPreviewCapacity,
  assertV2GroupOnlyGroupingPreviewJsonSize,
  assertV2GroupOnlyGroupingPreviewQualifiers,
  type ParsedV2GroupOnlyGroupingPreviewForm,
} from "./group-only-grouping-boundary";

export type V2GroupOnlyGroupingPreviewProfile = Readonly<{
  matchType: "single" | "double" | "team";
  entryKind: "INDIVIDUAL" | "DOUBLES" | "TEAM";
  competitorType: "user" | "team";
  label: "SINGLE" | "DOUBLE" | "TEAM";
}>;

export const V2_SINGLE_GROUPING_PREVIEW_PROFILE = Object.freeze({
  matchType: "single",
  entryKind: "INDIVIDUAL",
  competitorType: "user",
  label: "SINGLE",
} satisfies V2GroupOnlyGroupingPreviewProfile);

export const V2_DOUBLE_GROUPING_PREVIEW_PROFILE = Object.freeze({
  matchType: "double",
  entryKind: "DOUBLES",
  competitorType: "team",
  label: "DOUBLE",
} satisfies V2GroupOnlyGroupingPreviewProfile);

export const V2_TEAM_GROUPING_PREVIEW_PROFILE = Object.freeze({
  matchType: "team",
  entryKind: "TEAM",
  competitorType: "team",
  label: "TEAM",
} satisfies V2GroupOnlyGroupingPreviewProfile);

export type V2GroupOnlyGroupingPreviewDependencies = Readonly<{
  db: PrismaClient;
  clock?: () => Date;
}>;

export type V2GroupOnlyGroupingPreviewState = Readonly<{
  success: string;
  previewJson: string;
}>;

function failInvalidEntry(message: string, entryId: string): never {
  throw new V2CompetitionApplicationError(
    "FIXTURE_ENTRY_INVALID",
    message,
    { entryId },
  );
}

function average(values: readonly number[], entryId: string) {
  if (
    values.length === 0 ||
    values.some((value) => !Number.isSafeInteger(value))
  ) {
    failInvalidEntry("A grouping seed contains invalid numeric input.", entryId);
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/**
 * Builds a display-only grouping preview for the shared group-phase UI. The
 * eventual publication command still carries only Entry identities, versions,
 * and group placement; the publication kernel re-reads every source and seed.
 */
export async function createV2GroupOnlyGroupingPreview(
  dependencies: V2GroupOnlyGroupingPreviewDependencies,
  profile: V2GroupOnlyGroupingPreviewProfile,
  input: Readonly<{
    matchId: string;
    actor: V2Actor;
    requested: ParsedV2GroupOnlyGroupingPreviewForm;
  }>,
): Promise<V2GroupOnlyGroupingPreviewState> {
  const [match, actor] = await Promise.all([
    dependencies.db.match.findUnique({
      where: { id: input.matchId },
      select: {
        id: true,
        createdBy: true,
        engineVersion: true,
        isQuickMatch: true,
        type: true,
        status: true,
        format: true,
        registrationDeadline: true,
        teamRegistrationDeadline: true,
        teamMinMembers: true,
        teamMaxMembers: true,
        entries: {
          where: { status: "ACTIVE" },
          orderBy: { id: "asc" },
          select: {
            id: true,
            version: true,
            kind: true,
            sourceKey: true,
            sourceUserId: true,
            sourceDoublesTeamId: true,
            sourceMatchTeamId: true,
            displayNameSnapshot: true,
            sourceUser: {
              select: {
                id: true,
                nickname: true,
                points: true,
                eloRating: true,
                isBanned: true,
                emailVerifiedAt: true,
              },
            },
            sourceDoublesTeam: {
              select: {
                id: true,
                matchId: true,
                members: {
                  orderBy: { slot: "asc" },
                  select: { userId: true, slot: true, matchId: true },
                },
              },
            },
            sourceMatchTeam: {
              select: {
                id: true,
                matchId: true,
                status: true,
                captainId: true,
                members: {
                  orderBy: { userId: "asc" },
                  select: { userId: true, matchId: true },
                },
              },
            },
            members: {
              where: { status: "ACTIVE", effectiveUntil: null },
              orderBy: [{ slot: "asc" }, { id: "asc" }],
              select: {
                id: true,
                userId: true,
                role: true,
                slot: true,
                rosterVersion: true,
                user: {
                  select: {
                    id: true,
                    nickname: true,
                    points: true,
                    eloRating: true,
                    isBanned: true,
                    emailVerifiedAt: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
    dependencies.db.user.findUnique({
      where: { id: input.actor.id },
      select: {
        id: true,
        role: true,
        isBanned: true,
        emailVerifiedAt: true,
      },
    }),
  ]);

  if (!match) {
    throw new V2ActionBoundaryError(
      "RESOURCE_NOT_FOUND",
      "The match does not exist.",
    );
  }
  if (
    match.engineVersion !== "V2" ||
    match.isQuickMatch ||
    match.type !== profile.matchType
  ) {
    throw new V2ActionBoundaryError(
      "INVALID_RESOURCE_STATE",
      `This adapter accepts formal ${profile.label} V2 matches only.`,
    );
  }
  if (!actor || actor.isBanned || !actor.emailVerifiedAt) {
    throw new V2CompetitionApplicationError(
      "ACTOR_NOT_ACTIVE",
      "The grouping preview actor is missing, banned, or unverified.",
      { actorId: input.actor.id },
    );
  }
  if (actor.role !== input.actor.role) {
    throw new V2CompetitionApplicationError(
      "ACTOR_ROLE_STALE",
      "The grouping preview actor role is stale.",
      { actorId: input.actor.id },
    );
  }
  if (actor.role !== "admin" && match.createdBy !== actor.id) {
    throw new V2CompetitionApplicationError(
      "FORBIDDEN",
      "Only the match creator or an administrator can preview grouping.",
      { actorId: actor.id, matchId: match.id },
    );
  }
  const now = dependencies.clock?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("The V2 grouping preview clock returned an invalid date.");
  }
  const registrationDeadline =
    profile.matchType === "team"
      ? (match.teamRegistrationDeadline ?? match.registrationDeadline)
      : match.registrationDeadline;
  if (match.status === "finished" || now < registrationDeadline) {
    throw new V2CompetitionApplicationError(
      "FIXTURE_CREATION_NOT_ALLOWED",
      "Grouping preview is available only after registration closes and before the match finishes.",
      { matchId: match.id, registrationDeadline },
    );
  }

  assertV2GroupOnlyGroupingPreviewCapacity({
    entryCount: match.entries.length,
    groupCount: input.requested.groupCount,
    label: profile.label,
  });
  assertV2GroupOnlyGroupingPreviewQualifiers({
    format: match.format,
    entryCount: match.entries.length,
    groupCount: input.requested.groupCount,
    qualifiersPerGroup: input.requested.qualifiersPerGroup,
  });

  const seenUserIds = new Set<string>();
  const participants = match.entries.map((entry) => {
    if (entry.kind !== profile.entryKind) {
      failInvalidEntry(
        `Every active ${profile.label} Entry must use the expected kind.`,
        entry.id,
      );
    }
    const members = entry.members;
    const expectedMemberCount =
      profile.matchType === "single"
        ? 1
        : profile.matchType === "double"
          ? 2
          : members.length;
    const rosterVersion = members[0]?.rosterVersion;
    if (
      members.length !== expectedMemberCount ||
      members.length === 0 ||
      !Number.isSafeInteger(rosterVersion) ||
      (rosterVersion ?? 0) < 1 ||
      members.some(
        (member, index) =>
          member.slot !== index + 1 ||
          member.rosterVersion !== rosterVersion ||
          !member.user ||
          member.userId !== member.user.id ||
          member.user.isBanned ||
          !member.user.emailVerifiedAt ||
          seenUserIds.has(member.userId),
      )
    ) {
      failInvalidEntry(
        `Every active ${profile.label} Entry must have one complete current roster.`,
        entry.id,
      );
    }

    if (profile.matchType === "single") {
      const member = members[0];
      if (
        !entry.sourceUserId ||
        entry.sourceKey !== `individual:${entry.sourceUserId}` ||
        entry.sourceDoublesTeamId !== null ||
        entry.sourceMatchTeamId !== null ||
        !entry.sourceUser ||
        entry.sourceUser.id !== entry.sourceUserId ||
        member.userId !== entry.sourceUserId ||
        member.role !== "player"
      ) {
        failInvalidEntry(
          "Every active SINGLE Entry must resolve to one authoritative active user.",
          entry.id,
        );
      }
    } else if (profile.matchType === "double") {
      const source = entry.sourceDoublesTeam;
      if (
        !entry.sourceDoublesTeamId ||
        entry.sourceKey !== `doubles:${entry.sourceDoublesTeamId}` ||
        entry.sourceUserId !== null ||
        entry.sourceMatchTeamId !== null ||
        !source ||
        source.id !== entry.sourceDoublesTeamId ||
        source.matchId !== match.id ||
        source.members.length !== 2 ||
        members.some((member) => member.role !== "player") ||
        source.members.some(
          (sourceMember, index) =>
            sourceMember.matchId !== match.id ||
            sourceMember.slot !== index + 1 ||
            sourceMember.userId !== members[index]?.userId,
        )
      ) {
        failInvalidEntry(
          "Every active DOUBLE Entry must match one complete two-player source roster.",
          entry.id,
        );
      }
    } else {
      const source = entry.sourceMatchTeam;
      const sourceUserIds = source?.members.map((member) => member.userId).sort() ?? [];
      const memberUserIds = members.map((member) => member.userId).sort();
      const captains = members.filter((member) => member.role === "captain");
      if (
        !entry.sourceMatchTeamId ||
        entry.sourceKey !== `team:${entry.sourceMatchTeamId}` ||
        entry.sourceUserId !== null ||
        entry.sourceDoublesTeamId !== null ||
        !source ||
        source.id !== entry.sourceMatchTeamId ||
        source.matchId !== match.id ||
        source.status !== "approved" ||
        !Number.isSafeInteger(match.teamMinMembers) ||
        !Number.isSafeInteger(match.teamMaxMembers) ||
        match.teamMinMembers === null ||
        match.teamMaxMembers === null ||
        members.length < match.teamMinMembers ||
        members.length > match.teamMaxMembers ||
        captains.length !== 1 ||
        captains[0]?.userId !== source.captainId ||
        sourceUserIds.length !== memberUserIds.length ||
        source.members.some((member) => member.matchId !== match.id) ||
        sourceUserIds.some((userId, index) => userId !== memberUserIds[index])
      ) {
        failInvalidEntry(
          "Every active TEAM Entry must match one approved source roster.",
          entry.id,
        );
      }
    }

    for (const member of members) seenUserIds.add(member.userId);
    return {
      id: entry.id,
      nickname:
        profile.matchType === "single"
          ? entry.sourceUser!.nickname
          : entry.displayNameSnapshot,
      points: average(
        members.map((member) => member.user.points),
        entry.id,
      ),
      eloRating: average(
        members.map((member) => member.user.eloRating),
        entry.id,
      ),
    };
  });

  const payload = generateGroupingPayload(match.format, participants, {
    groupCount: input.requested.groupCount,
    qualifiersPerGroup: input.requested.qualifiersPerGroup,
    seedMethod: input.requested.seedMethod,
    competitorType: profile.competitorType,
  });
  const previewJson = JSON.stringify({
    competitorType: payload.competitorType,
    format: payload.format,
    config: payload.config,
    groups: payload.groups,
    generatedAt: now.toISOString(),
    v2Preview: {
      schemaVersion: V2_GROUP_ONLY_GROUPING_PREVIEW_SCHEMA_VERSION,
      matchId: match.id,
      expectedEntries: match.entries.map((entry) => ({
        entryId: entry.id,
        version: entry.version,
      })),
    },
  });
  assertV2GroupOnlyGroupingPreviewJsonSize(previewJson);
  return {
    success: "已生成 V2 分组预览，请确认后发布。",
    previewJson,
  };
}
