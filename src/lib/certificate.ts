import { randomBytes } from "node:crypto";
import { buildGroupStandings, resolveFilledKnockoutRounds, type GroupingPayload } from "@/lib/match-detail";
import { hashPassword, verifyPassword } from "@/lib/password";

export type CertificateEligibility = {
  eligible: boolean;
  reason?: string;
};

type MatchResultLite = {
  winnerTeamIds: string[];
  loserTeamIds: string[];
  confirmed: boolean;
  score: unknown;
  createdAt: Date;
  resultVerifiedAt: Date | null;
};

type CertificateMatch = {
  status: "registration" | "ongoing" | "finished";
  type: "single" | "double" | "team";
  groupingResult: { payload: unknown } | null;
  groupingGeneratedAt: Date | null;
  registrations: Array<{ userId: string }>;
  results: MatchResultLite[];
};

export function normalizeIdentityInput(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function hashIdentityValue(value: string) {
  return hashPassword(value);
}

export function verifyIdentityValue(value: string, storedHash: string) {
  return verifyPassword(value, storedHash).ok;
}

function formatDatePart(value: number) {
  return String(value).padStart(2, "0");
}

export function generateCertificateNumber(now = new Date()) {
  const datePart = `${now.getFullYear()}${formatDatePart(now.getMonth() + 1)}${formatDatePart(now.getDate())}`;
  const randomPart = randomBytes(3).toString("hex").toUpperCase();
  return `PPC-${datePart}-${randomPart}`;
}

function resultIncludesUser(result: MatchResultLite, userId: string) {
  return result.winnerTeamIds.includes(userId) || result.loserTeamIds.includes(userId);
}

export function evaluateCertificateEligibility(params: {
  match: CertificateMatch;
  currentUserId: string;
}): CertificateEligibility {
  const { match, currentUserId } = params;
  const isRegistered = match.registrations.some(
    (item) => item.userId === currentUserId,
  );
  if (!isRegistered) {
    return { eligible: false, reason: "你未报名本次比赛，无法导出参赛证明。" };
  }
  const confirmedForUser = match.results.filter(
    (result) => result.confirmed && resultIncludesUser(result, currentUserId),
  );
  const pendingForUser = match.results.filter(
    (result) => !result.confirmed && resultIncludesUser(result, currentUserId),
  );

  if (confirmedForUser.length < 1) {
    return {
      eligible: false,
      reason: "至少完成 1 场确认对局后才可导出参赛证明。",
    };
  }

  if (pendingForUser.length > 0) {
    return {
      eligible: false,
      reason: "你还有未确认的比赛结果，请先完成确认。",
    };
  }

  const groupingPayload = (match.groupingResult?.payload ?? null) as GroupingPayload | null;

  if (match.type !== "single" || !groupingPayload) {
    if (match.status !== "finished") {
      return {
        eligible: false,
        reason: "当前比赛尚未结束，暂不能导出参赛证明。",
      };
    }

    return { eligible: true };
  }

  const currentGroup = groupingPayload.groups.find((group) =>
    group.players.some((player) => player.id === currentUserId),
  );

  if (!currentGroup) {
    if (match.status !== "finished") {
      return {
        eligible: false,
        reason: "当前比赛尚未结束，暂不能导出参赛证明。",
      };
    }

    return { eligible: true };
  }

  const confirmedSingles = match.results.filter(
    (result) =>
      result.confirmed &&
      result.winnerTeamIds.length === 1 &&
      result.loserTeamIds.length === 1,
  );

  const groupPlayerIds = new Set(currentGroup.players.map((player) => player.id));
  const opponentIds = new Set<string>();
  for (const result of confirmedSingles) {
    const winnerId = result.winnerTeamIds[0];
    const loserId = result.loserTeamIds[0];
    if (winnerId === currentUserId && groupPlayerIds.has(loserId)) {
      opponentIds.add(loserId);
    }
    if (loserId === currentUserId && groupPlayerIds.has(winnerId)) {
      opponentIds.add(winnerId);
    }
  }

  const totalOpponents = Math.max(0, currentGroup.players.length - 1);
  if (totalOpponents > 0 && opponentIds.size < totalOpponents) {
    return {
      eligible: false,
      reason: "你在本次比赛中还有未完成的对局，暂不能导出参赛证明。",
    };
  }

  const hasKnockout = Boolean(groupingPayload.knockout?.rounds?.length);
  if (!hasKnockout) {
    return { eligible: true };
  }

  const groupConfirmedCount = confirmedSingles.filter((result) => {
    const winnerId = result.winnerTeamIds[0];
    const loserId = result.loserTeamIds[0];
    return groupPlayerIds.has(winnerId) && groupPlayerIds.has(loserId);
  }).length;
  const totalGroupMatches =
    currentGroup.players.length > 1
      ? (currentGroup.players.length * (currentGroup.players.length - 1)) / 2
      : 0;
  const groupCompleted = totalGroupMatches > 0 && groupConfirmedCount >= totalGroupMatches;

  if (!groupCompleted) {
    return {
      eligible: false,
      reason: "小组赛尚未全部结束，暂不能导出参赛证明。",
    };
  }

  const qualifiersPerGroup = groupingPayload.config?.qualifiersPerGroup ?? 1;
  const standings = buildGroupStandings(currentGroup.players, confirmedSingles);
  const qualified = standings
    .slice(0, Math.min(qualifiersPerGroup, standings.length))
    .some((player) => player.id === currentUserId);

  if (!qualified) {
    return { eligible: true };
  }

  const filledKnockoutRounds = resolveFilledKnockoutRounds({
    knockoutRounds: groupingPayload.knockout?.rounds ?? [],
    groups: groupingPayload.groups,
    qualifiersPerGroup,
    results: match.results,
    groupingGeneratedAt: match.groupingGeneratedAt ?? null,
  });

  const userKnockoutMatches = filledKnockoutRounds.flatMap((round) =>
    round.matches.filter(
      (matchItem) =>
        matchItem.homePlayerId === currentUserId ||
        matchItem.awayPlayerId === currentUserId,
    ),
  );

  if (userKnockoutMatches.length === 0) {
    return {
      eligible: false,
      reason: "淘汰赛对阵尚未生成，请稍后再试。",
    };
  }

  const hasUnfinishedKnockout = userKnockoutMatches.some(
    (matchItem) => !matchItem.homeOutcome || !matchItem.awayOutcome,
  );

  if (hasUnfinishedKnockout) {
    return {
      eligible: false,
      reason: "你在淘汰赛还有未结束的比赛，暂不能导出参赛证明。",
    };
  }

  return { eligible: true };
}
