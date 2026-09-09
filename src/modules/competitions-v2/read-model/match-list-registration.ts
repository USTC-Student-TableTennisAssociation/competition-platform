export type MatchListRegistrationIdentity = Readonly<{
  engineVersion: "LEGACY" | "V2";
  isQuickMatch: boolean;
  type: "single" | "double" | "team";
  format: "group_only" | "group_then_knockout";
}>;

export type MatchListRegistrationSummary = Readonly<{
  participants: number;
  participantUnit: "people" | "pairs" | "teams";
  isCurrentUserRegistered: boolean;
}>;

export type AdminBulkRegistrationPolicy = Readonly<{
  canBulkRegister: boolean;
  disabledReason: string | null;
}>;

/**
 * The admin bulk-registration selector accepts user identities, so it can
 * safely create individual competitors in either engine. Doubles and team
 * entries require an explicit roster and keep using their dedicated flows.
 */
export function resolveAdminBulkRegistrationPolicy(
  input: MatchListRegistrationIdentity &
    Readonly<{
      status?: "registration" | "ongoing" | "finished";
      groupingGeneratedAt?: Date | string | null;
    }>,
): AdminBulkRegistrationPolicy {
  if (input.engineVersion === "LEGACY" && !input.isQuickMatch) {
    return { canBulkRegister: false, disabledReason: "历史比赛已归档，不能追加报名" };
  }
  if (input.isQuickMatch) {
    return {
      canBulkRegister: false,
      disabledReason: "快速比赛不支持后台批量报名",
    };
  }
  if (input.type === "double") {
    return {
      canBulkRegister: false,
      disabledReason: "双打比赛需先确定搭档并完成组队",
    };
  }
  if (input.type === "team") {
    return {
      canBulkRegister: false,
      disabledReason: "团体赛请使用队伍报名",
    };
  }
  if (
    input.engineVersion === "V2" &&
    (input.status !== "registration" || input.groupingGeneratedAt !== null)
  ) {
    return {
      canBulkRegister: false,
      disabledReason: "V2 比赛分组发布后不能追加报名",
    };
  }

  return { canBulkRegister: true, disabledReason: null };
}

/**
 * Keeps the shared list surfaces on their existing Legacy facts while routing
 * every formal V2 competition through ACTIVE MatchEntry identities. A V2
 * Entry is one competitor: one player, one doubles pair, or one team.
 */
export function resolveMatchListRegistrationSummary(
  input: MatchListRegistrationIdentity &
    Readonly<{
      legacyParticipantCount: number;
      legacyCurrentUserRegistered: boolean;
      activeEntryCount: number;
      currentUserActiveEntryKinds: readonly (
        | "INDIVIDUAL"
        | "DOUBLES"
        | "TEAM"
      )[];
    }>,
): MatchListRegistrationSummary {
  if (input.engineVersion === "LEGACY") {
    return {
      participants: input.legacyParticipantCount,
      participantUnit: input.type === "team" ? "teams" : "people",
      isCurrentUserRegistered: input.legacyCurrentUserRegistered,
    };
  }

  if (input.isQuickMatch) {
    return {
      participants: 0,
      participantUnit:
        input.type === "double"
          ? "pairs"
          : input.type === "team"
            ? "teams"
            : "people",
      isCurrentUserRegistered: false,
    };
  }

  const expectedKind =
    input.type === "single"
      ? "INDIVIDUAL"
      : input.type === "double"
        ? "DOUBLES"
        : "TEAM";
  const participantUnit =
    input.type === "single"
      ? "people"
      : input.type === "double"
        ? "pairs"
        : "teams";

  return {
    participants: input.activeEntryCount,
    participantUnit,
    isCurrentUserRegistered:
      input.currentUserActiveEntryKinds.length === 1 &&
      input.currentUserActiveEntryKinds[0] === expectedKind,
  };
}
