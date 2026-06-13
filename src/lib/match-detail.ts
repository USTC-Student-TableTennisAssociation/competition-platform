import {
  getResultCompetitorIds,
  getResultKnockoutMatchId,
  getResultPhase,
  resolveCompetitorType,
  type CompetitorType,
} from "@/lib/match-competitor";

export type KnockoutRound = {
  name: string;
  matches: Array<{
    id: string;
    homeLabel: string;
    awayLabel: string;
    homeFilled?: boolean;
    awayFilled?: boolean;
    homePlayerId?: string | null;
    awayPlayerId?: string | null;
    homeSourceLabel?: string;
    awaySourceLabel?: string;
    homeOutcome?: "winner" | "loser";
    awayOutcome?: "winner" | "loser";
    homeScoreText?: string;
    awayScoreText?: string;
  }>;
};

export type GroupPlayer = {
  id: string;
  nickname: string;
  points: number;
  eloRating: number;
};

export type AdminEligibleMatchOption = {
  playerAId: string;
  playerANickname: string;
  playerBId: string;
  playerBNickname: string;
};

export type AdminGroupBattleTable = {
  groupName: string;
  players: Array<{ id: string; nickname: string }>;
  cells: Record<
    string,
    {
      status: "confirmed" | "pending" | "todo";
      label: string;
      scoreText: string;
    }
  >;
};

export type MatchResultLite = {
  winnerTeamIds: string[];
  loserTeamIds: string[];
  winnerMatchTeamId?: string | null;
  loserMatchTeamId?: string | null;
  confirmed: boolean;
  score: unknown;
  createdAt: Date;
  resultVerifiedAt: Date | null;
};

export type GroupingPayload = {
  competitorType?: CompetitorType;
  config?: {
    groupCount?: number;
    qualifiersPerGroup?: number;
  };
  tableAssignments?: {
    group?: Record<string, string[]>;
    knockout?: Record<string, string[]>;
  };
  groups: Array<{
    name: string;
    averagePoints: number;
    players: GroupPlayer[];
  }>;
  knockout?: {
    stage: string;
    bracketSize: number;
    rounds: Array<{
      name: string;
      matches: Array<{ id: string; homeLabel: string; awayLabel: string }>;
    }>;
  };
};

export function pairKey(idA: string, idB: string) {
  return [idA, idB].sort().join("::");
}

export function extractScoreText(score: unknown) {
  if (typeof score === "object" && score && "text" in score) {
    return String((score as { text?: unknown }).text ?? "");
  }
  if (typeof score === "string") return score;
  return "";
}

export function extractWinnerLoserSets(score: unknown) {
  if (typeof score === "object" && score) {
    const winnerScore = Number((score as { winnerScore?: unknown }).winnerScore);
    const loserScore = Number((score as { loserScore?: unknown }).loserScore);
    if (Number.isFinite(winnerScore) && Number.isFinite(loserScore)) {
      return { winnerScore, loserScore };
    }
  }
  return null;
}

export function buildGroupStandings(
  players: GroupPlayer[],
  results: MatchResultLite[],
  competitorType: CompetitorType = "user",
) {
  const standings = players.map((player) => ({
    id: player.id,
    nickname: player.nickname,
    wins: 0,
    losses: 0,
    setWins: 0,
    setLosses: 0,
    eloRating: player.eloRating,
  }));

  const byId = new Map(standings.map((item) => [item.id, item]));
  const playerIdSet = new Set(players.map((player) => player.id));

  for (const result of results) {
    if (!result.confirmed) continue;
    if (getResultPhase(result.score) === "knockout") continue;
    const competitorIds = getResultCompetitorIds(result, competitorType);
    if (!competitorIds) continue;
    const { winnerId, loserId } = competitorIds;
    if (!playerIdSet.has(winnerId) || !playerIdSet.has(loserId)) continue;

    const winner = byId.get(winnerId);
    const loser = byId.get(loserId);
    if (!winner || !loser) continue;

    winner.wins += 1;
    loser.losses += 1;

    const sets = extractWinnerLoserSets(result.score);
    if (sets) {
      winner.setWins += sets.winnerScore;
      winner.setLosses += sets.loserScore;
      loser.setWins += sets.loserScore;
      loser.setLosses += sets.winnerScore;
    }
  }

  return standings.sort((a, b) => {
    const winDiff = b.wins - a.wins;
    if (winDiff !== 0) return winDiff;
    const setDiff = b.setWins - b.setLosses - (a.setWins - a.setLosses);
    if (setDiff !== 0) return setDiff;
    const setWinDiff = b.setWins - a.setWins;
    if (setWinDiff !== 0) return setWinDiff;
    return b.eloRating - a.eloRating;
  });
}

export function resolveFilledKnockoutRounds(params: {
  knockoutRounds: KnockoutRound[];
  groups: Array<{ name: string; players: GroupPlayer[] }>;
  qualifiersPerGroup: number;
  results: MatchResultLite[];
  groupingGeneratedAt: Date | null;
  competitorType?: CompetitorType;
}) {
  const {
    knockoutRounds,
    groups,
    qualifiersPerGroup,
    results,
    groupingGeneratedAt,
    competitorType = "user",
  } = params;

  const qualifierLabelToPlayer = new Map<
    string,
    { id: string; nickname: string }
  >();

  const confirmedResults = results.filter(
    (result) =>
      result.confirmed && Boolean(getResultCompetitorIds(result, competitorType)),
  );
  const confirmedGroupResults = confirmedResults.filter(
    (result) => getResultPhase(result.score) !== "knockout",
  );

  for (const group of groups) {
    const standings = buildGroupStandings(
      group.players,
      confirmedGroupResults,
      competitorType,
    );
    const groupPlayerIdSet = new Set(group.players.map((player) => player.id));
    const groupConfirmedCount = confirmedGroupResults.filter((result) => {
      const ids = getResultCompetitorIds(result, competitorType);
      if (!ids) return false;
      const { winnerId, loserId } = ids;
      return groupPlayerIdSet.has(winnerId) && groupPlayerIdSet.has(loserId);
    }).length;
    const totalGroupMatches =
      group.players.length > 1
        ? (group.players.length * (group.players.length - 1)) / 2
        : 0;
    const groupCompleted =
      totalGroupMatches > 0 && groupConfirmedCount >= totalGroupMatches;

    if (!groupCompleted) continue;

    standings
      .slice(0, Math.min(qualifiersPerGroup, standings.length))
      .forEach((item, index) => {
        qualifierLabelToPlayer.set(`${group.name}第 ${index + 1} 名`, {
          id: item.id,
          nickname: item.nickname,
        });
      });
  }

  const winnerByMatchId = new Map<string, { id: string; nickname: string }>();

  const getHeadToHeadResult = (idA: string, idB: string, matchId: string) => {
    const candidates = confirmedResults.filter((result) => {
      if (groupingGeneratedAt && result.createdAt < groupingGeneratedAt) {
        return false;
      }
      const knockoutMatchId = getResultKnockoutMatchId(result.score);
      if (competitorType === "team") {
        if (getResultPhase(result.score) !== "knockout") return false;
        if (knockoutMatchId !== matchId) return false;
      } else if (knockoutMatchId && knockoutMatchId !== matchId) {
        return false;
      } else if (getResultPhase(result.score) === "group") {
        return false;
      }
      const ids = getResultCompetitorIds(result, competitorType);
      return Boolean(
        ids &&
          ((ids.winnerId === idA && ids.loserId === idB) ||
            (ids.winnerId === idB && ids.loserId === idA)),
      );
    });

    if (candidates.length === 0) return null;

    return [...candidates].sort((a, b) => {
      const ta = (a.resultVerifiedAt ?? a.createdAt).getTime();
      const tb = (b.resultVerifiedAt ?? b.createdAt).getTime();
      return tb - ta;
    })[0];
  };

  const resolveLabel = (label: string) => {
    const fromQualifier = qualifierLabelToPlayer.get(label);
    if (fromQualifier) {
      return {
        displayLabel: fromQualifier.nickname,
        playerId: fromQualifier.id,
        filled: true,
        sourceLabel: label,
      };
    }

    const matchWinnerRef = label.match(/^胜者\s+(.+)$/);
    if (matchWinnerRef) {
      const fromWinner = winnerByMatchId.get(matchWinnerRef[1]);
      if (fromWinner) {
        return {
          displayLabel: fromWinner.nickname,
          playerId: fromWinner.id,
          filled: true,
          sourceLabel: label,
        };
      }
    }

    return {
      displayLabel: label,
      playerId: null,
      filled: false,
      sourceLabel: label,
    };
  };

  return knockoutRounds.map((round) => ({
    ...round,
    matches: round.matches.map((match) => {
      const home = resolveLabel(match.homeLabel);
      const away = resolveLabel(match.awayLabel);

      if (home.playerId && away.playerId) {
        const matchResult = getHeadToHeadResult(
          home.playerId,
          away.playerId,
          match.id,
        );
        if (matchResult) {
          const resultIds = getResultCompetitorIds(matchResult, competitorType);
          if (!resultIds) return match;
          const winnerId = resultIds.winnerId;
          const winnerLabel =
            winnerId === home.playerId ? home.displayLabel : away.displayLabel;
          winnerByMatchId.set(match.id, {
            id: winnerId,
            nickname: winnerLabel,
          });

          const sets = extractWinnerLoserSets(matchResult.score);
          const winnerScore = sets?.winnerScore ?? null;
          const loserScore = sets?.loserScore ?? null;
          const homeIsWinner = winnerId === home.playerId;

          return {
            ...match,
            homeLabel: home.displayLabel,
            awayLabel: away.displayLabel,
            homeFilled: home.filled,
            awayFilled: away.filled,
            homePlayerId: home.playerId,
            awayPlayerId: away.playerId,
            homeSourceLabel: home.sourceLabel,
            awaySourceLabel: away.sourceLabel,
            homeOutcome: homeIsWinner ? "winner" : "loser",
            awayOutcome: homeIsWinner ? "loser" : "winner",
            homeScoreText:
              winnerScore !== null && loserScore !== null
                ? homeIsWinner
                  ? `${winnerScore}:${loserScore}`
                  : `${loserScore}:${winnerScore}`
                : "",
            awayScoreText:
              winnerScore !== null && loserScore !== null
                ? homeIsWinner
                  ? `${loserScore}:${winnerScore}`
                  : `${winnerScore}:${loserScore}`
                : "",
          };
        }
      }

      return {
        ...match,
        homeLabel: home.displayLabel,
        awayLabel: away.displayLabel,
        homeFilled: home.filled,
        awayFilled: away.filled,
        homePlayerId: home.playerId,
        awayPlayerId: away.playerId,
        homeSourceLabel: home.sourceLabel,
        awaySourceLabel: away.sourceLabel,
      };
    }),
  }));
}

export function buildAdminEligibleOptions(params: {
  groupingPayload: {
    competitorType?: CompetitorType;
    groups: Array<{ name: string; players: GroupPlayer[] }>;
    knockout?: { rounds: KnockoutRound[] };
  };
  filledKnockoutRounds: Array<{
    name: string;
    matches: Array<{
      id: string;
      homeLabel: string;
      awayLabel: string;
      homePlayerId?: string | null;
      awayPlayerId?: string | null;
      homeOutcome?: string;
      awayOutcome?: string;
    }>;
  }> | null;
  results: Array<{
    winnerTeamIds: string[];
    loserTeamIds: string[];
    winnerMatchTeamId?: string | null;
    loserMatchTeamId?: string | null;
    score?: unknown;
    createdAt: Date;
  }>;
  groupingGeneratedAt: Date | null;
  competitorType?: CompetitorType;
}) {
  const {
    groupingPayload,
    filledKnockoutRounds,
    results,
    groupingGeneratedAt,
    competitorType = resolveCompetitorType(groupingPayload.competitorType),
  } = params;

  const groupPairKeys = new Set(
    results
      .filter((result) => getResultPhase(result.score) !== "knockout")
      .map((result) => getResultCompetitorIds(result, competitorType))
      .filter((ids): ids is { winnerId: string; loserId: string } => Boolean(ids))
      .map((ids) => pairKey(ids.winnerId, ids.loserId)),
  );

  const knockoutMatchIds = new Set(
    results
      .filter(
        (result) =>
          !groupingGeneratedAt || result.createdAt >= groupingGeneratedAt,
      )
      .map((result) => getResultKnockoutMatchId(result.score))
      .filter((matchId): matchId is string => Boolean(matchId)),
  );

  const groupMatchOptions = groupingPayload.groups.flatMap((group) => {
    const items: Array<AdminEligibleMatchOption & { groupName: string }> = [];

    for (let i = 0; i < group.players.length; i += 1) {
      for (let j = i + 1; j < group.players.length; j += 1) {
        const playerA = group.players[i];
        const playerB = group.players[j];
        const key = pairKey(playerA.id, playerB.id);
        if (groupPairKeys.has(key)) continue;

        items.push({
          groupName: group.name,
          playerAId: playerA.id,
          playerANickname: playerA.nickname,
          playerBId: playerB.id,
          playerBNickname: playerB.nickname,
        });
      }
    }

    return items;
  });

  const knockoutMatchOptions = (filledKnockoutRounds ?? []).flatMap((round) =>
    round.matches.flatMap((match) => {
      if (!match.homePlayerId || !match.awayPlayerId) return [];
      if (match.homeOutcome || match.awayOutcome) return [];

      if (knockoutMatchIds.has(match.id)) return [];

      return [
        {
          matchId: match.id,
          roundName: round.name,
          playerAId: match.homePlayerId,
          playerANickname: match.homeLabel,
          playerBId: match.awayPlayerId,
          playerBNickname: match.awayLabel,
        },
      ];
    }),
  );

  return { groupMatchOptions, knockoutMatchOptions };
}

export function buildAdminGroupBattleTables(params: {
  groups: Array<{ name: string; players: GroupPlayer[] }>;
  results: Array<{
    winnerTeamIds: string[];
    loserTeamIds: string[];
    confirmed: boolean;
    score: unknown;
    winnerMatchTeamId?: string | null;
    loserMatchTeamId?: string | null;
  }>;
  competitorType?: CompetitorType;
}) {
  const { groups, results, competitorType = "user" } = params;

  return groups.map<AdminGroupBattleTable>((group) => {
    const playerIds = new Set(group.players.map((player) => player.id));
    const confirmedByPair = new Map<
      string,
      {
        winnerId: string;
        winnerScore: number | null;
        loserScore: number | null;
        scoreText: string;
      }
    >();
    const pendingByPair = new Map<
      string,
      {
        winnerId: string;
        winnerScore: number | null;
        loserScore: number | null;
        scoreText: string;
      }
    >();

    for (const result of results) {
      if (getResultPhase(result.score) === "knockout") continue;
      const ids = getResultCompetitorIds(result, competitorType);
      if (!ids) continue;
      const { winnerId, loserId } = ids;
      if (!playerIds.has(winnerId) || !playerIds.has(loserId)) continue;

      const sets = extractWinnerLoserSets(result.score);
      const scoreText = extractScoreText(result.score);
      const payload = {
        winnerId,
        winnerScore: sets?.winnerScore ?? null,
        loserScore: sets?.loserScore ?? null,
        scoreText,
      };

      const key = pairKey(winnerId, loserId);

      if (result.confirmed) {
        if (!confirmedByPair.has(key)) confirmedByPair.set(key, payload);
      } else if (!pendingByPair.has(key)) {
        pendingByPair.set(key, payload);
      }
    }

    const cells: AdminGroupBattleTable["cells"] = {};

    const formatScore = (
      rowId: string,
      data: {
        winnerId: string;
        winnerScore: number | null;
        loserScore: number | null;
        scoreText: string;
      },
    ) => {
      if (data.winnerScore !== null && data.loserScore !== null) {
        return rowId === data.winnerId
          ? `${data.winnerScore}:${data.loserScore}`
          : `${data.loserScore}:${data.winnerScore}`;
      }
      return data.scoreText;
    };

    for (const rowPlayer of group.players) {
      for (const colPlayer of group.players) {
        if (rowPlayer.id === colPlayer.id) continue;

        const key = pairKey(rowPlayer.id, colPlayer.id);
        const confirmed = confirmedByPair.get(key);
        const pending = pendingByPair.get(key);

        if (confirmed) {
          cells[`${rowPlayer.id}::${colPlayer.id}`] = {
            status: "confirmed",
            label: confirmed.winnerId === rowPlayer.id ? "胜" : "负",
            scoreText: formatScore(rowPlayer.id, confirmed),
          };
        } else if (pending) {
          cells[`${rowPlayer.id}::${colPlayer.id}`] = {
            status: "pending",
            label: "待确认",
            scoreText: formatScore(rowPlayer.id, pending),
          };
        } else {
          cells[`${rowPlayer.id}::${colPlayer.id}`] = {
            status: "todo",
            label: "未进行",
            scoreText: "",
          };
        }
      }
    }

    return {
      groupName: group.name,
      players: group.players.map((player) => ({
        id: player.id,
        nickname: player.nickname,
      })),
      cells,
    };
  });
}
