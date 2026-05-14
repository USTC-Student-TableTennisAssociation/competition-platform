import { CompetitionFormat } from "@prisma/client";
import { pairKey, resolveFilledKnockoutRounds } from "@/lib/match-detail";

type GroupingPayload = {
  config?: { qualifiersPerGroup?: number };
  groups?: Array<{
    name: string;
    players: Array<{ id: string; nickname?: string; eloRating?: number }>;
  }>;
  knockout?: {
    rounds: Array<{ name: string; matches: Array<{ id: string; homeLabel: string; awayLabel: string }> }>;
  };
};

type ResultLite = {
  winnerTeamIds: string[];
  loserTeamIds: string[];
  confirmed: boolean;
  score: unknown;
  createdAt: Date;
  resultVerifiedAt: Date | null;
};

export function isMatchAllResultsFinished(params: {
  format: CompetitionFormat;
  groupingGeneratedAt: Date | null;
  groupingResult: { payload: unknown } | null;
  results: ResultLite[];
}) {
  const { format, groupingGeneratedAt, groupingResult, results } = params;
  const payload = (groupingResult?.payload ?? null) as GroupingPayload | null;

  if (!payload?.groups?.length) return false;

  const confirmedSingles = results.filter(
    (result) =>
      result.confirmed &&
      result.winnerTeamIds.length === 1 &&
      result.loserTeamIds.length === 1,
  );

  const groupByPlayerId = new Map<string, string>();
  for (const group of payload.groups) {
    for (const player of group.players) {
      groupByPlayerId.set(player.id, group.name);
    }
  }

  const confirmedPairsByGroup = new Map<string, Set<string>>();
  for (const result of confirmedSingles) {
    const winnerId = result.winnerTeamIds[0];
    const loserId = result.loserTeamIds[0];
    const winnerGroup = groupByPlayerId.get(winnerId);
    if (!winnerGroup || winnerGroup !== groupByPlayerId.get(loserId)) continue;

    const existing = confirmedPairsByGroup.get(winnerGroup) ?? new Set<string>();
    existing.add(pairKey(winnerId, loserId));
    confirmedPairsByGroup.set(winnerGroup, existing);
  }

  const groupsCompleted = payload.groups.every((group) => {
    const totalMatches =
      group.players.length > 1
        ? (group.players.length * (group.players.length - 1)) / 2
        : 0;
    if (totalMatches === 0) return true;
    const confirmedCount = confirmedPairsByGroup.get(group.name)?.size ?? 0;
    return confirmedCount >= totalMatches;
  });

  if (!groupsCompleted) return false;

  if (format === "group_only" || !payload.knockout?.rounds?.length) {
    return true;
  }

  const filledKnockoutRounds = resolveFilledKnockoutRounds({
    knockoutRounds: payload.knockout.rounds,
    groups: payload.groups.map((group) => ({
      name: group.name,
      players: group.players.map((player) => ({
        id: player.id,
        nickname: player.nickname ?? player.id,
        points: 0,
        eloRating: player.eloRating ?? 0,
      })),
    })),
    qualifiersPerGroup: payload.config?.qualifiersPerGroup ?? 1,
    results,
    groupingGeneratedAt,
  });

  return filledKnockoutRounds.every((round) =>
    round.matches.every(
      (match) =>
        Boolean(match.homePlayerId && match.awayPlayerId) &&
        Boolean(match.homeOutcome && match.awayOutcome),
    ),
  );
}
