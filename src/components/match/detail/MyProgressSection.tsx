import ReportResultForm from "@/components/match/ReportResultForm";
import {
  buildGroupStandings,
  extractScoreText,
  extractWinnerLoserSets,
  pairKey,
  type GroupingPayload,
} from "@/lib/match-detail";

type MatchResultItem = {
  id: string;
  confirmed: boolean;
  winnerTeamIds: string[];
  loserTeamIds: string[];
  score: unknown;
  createdAt: Date;
  resultVerifiedAt: Date | null;
  reporter: {
    id: string;
    nickname: string;
  };
};

type RegistrationItem = {
  userId: string;
  user: {
    nickname: string;
  };
};

type BattleMatrix = {
  players: Array<{ id: string; nickname: string }>;
  getCell: (
    rowId: string,
    colId: string,
  ) => {
    status: "confirmed" | "pending" | "todo";
    label: string;
    scoreText: string;
  };
};

function MatrixTable({
  matrix,
  headPrefix,
  cellPrefix,
  currentUserId,
}: {
  matrix: BattleMatrix;
  headPrefix: string;
  cellPrefix: string;
  currentUserId: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-130 text-sm">
        <thead>
          <tr className="text-left text-slate-400">
            <th className="min-w-24 px-2 py-2">选手</th>
            {matrix.players.map((player) => (
              <th
                key={`${headPrefix}${player.id}`}
                className={`min-w-24 px-2 py-2 text-center ${
                  player.id === currentUserId
                    ? "font-semibold text-amber-200"
                    : ""
                }`}
              >
                {player.nickname}
                {player.id === currentUserId ? "（我）" : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.players.map((rowPlayer) => (
            <tr
              key={`${cellPrefix}row-${rowPlayer.id}`}
              className="border-t border-slate-700/80 text-slate-200"
            >
              <td
                className={`px-2 py-2 font-medium ${
                  rowPlayer.id === currentUserId
                    ? "text-amber-200"
                    : "text-slate-100"
                }`}
              >
                {rowPlayer.nickname}
                {rowPlayer.id === currentUserId ? "（我）" : ""}
              </td>
              {matrix.players.map((colPlayer) => {
                if (rowPlayer.id === colPlayer.id) {
                  return (
                    <td
                      key={`${cellPrefix}${rowPlayer.id}-${colPlayer.id}`}
                      className="px-2 py-2"
                    >
                      <div className="relative h-12 rounded border border-slate-700/80 bg-[linear-gradient(135deg,transparent_49%,rgba(148,163,184,0.5)_50%,transparent_51%)]" />
                    </td>
                  );
                }

                const cell = matrix.getCell(rowPlayer.id, colPlayer.id);
                return (
                  <td
                    key={`${cellPrefix}${rowPlayer.id}-${colPlayer.id}`}
                    className="px-2 py-2 text-center"
                  >
                    <div className="rounded border border-slate-700/80 bg-slate-900/70 px-2 py-1.5">
                      <p
                        className={`text-sm font-medium ${
                          cell.status === "confirmed"
                            ? cell.label === "胜"
                              ? "text-emerald-300"
                              : "text-rose-300"
                            : cell.status === "pending"
                              ? "text-amber-300"
                              : "text-slate-400"
                        }`}
                      >
                        {cell.label} {cell.scoreText || "-"}
                      </p>
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function MyProgressSection({
  matchId,
  matchType,
  currentUserId,
  registrations,
  results,
  groupingPayload,
  filledKnockoutRounds,
}: {
  matchId: string;
  matchType: string;
  currentUserId: string;
  registrations: RegistrationItem[];
  results: MatchResultItem[];
  groupingPayload: GroupingPayload;
  filledKnockoutRounds: Array<{
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
      homeOutcome?: string;
      awayOutcome?: string;
      homeScoreText?: string;
      awayScoreText?: string;
    }>;
  }> | null;
}) {
  const myGroup = groupingPayload.groups.find((group) =>
    group.players.some((player) => player.id === currentUserId),
  );

  const groupPlayerIds = new Set((myGroup?.players ?? []).map((p) => p.id));
  const opponents = (myGroup?.players ?? [])
    .filter((player) => player.id !== currentUserId)
    .map((player) => {
      const played = results.some((result) => {
        if (!result.confirmed) return false;
        const ids = [...result.winnerTeamIds, ...result.loserTeamIds];
        return ids.includes(currentUserId) && ids.includes(player.id);
      });
      return { id: player.id, nickname: player.nickname, played };
    });

  const isGroupSingleResult = (
    winnerTeamIds: string[],
    loserTeamIds: string[],
  ) => {
    if (winnerTeamIds.length !== 1 || loserTeamIds.length !== 1) return false;
    const winnerId = winnerTeamIds[0];
    const loserId = loserTeamIds[0];
    return groupPlayerIds.has(winnerId) && groupPlayerIds.has(loserId);
  };

  const confirmedGroupResultByPair = new Map<
    string,
    {
      winnerId: string;
      loserId: string;
      scoreText: string;
      winnerScore: number | null;
      loserScore: number | null;
      result: MatchResultItem;
    }
  >();

  for (const result of results) {
    if (!isGroupSingleResult(result.winnerTeamIds, result.loserTeamIds))
      continue;

    const winnerId = result.winnerTeamIds[0];
    const loserId = result.loserTeamIds[0];
    const key = pairKey(winnerId, loserId);
    const scoreText = extractScoreText(result.score);

    if (result.confirmed) {
      if (confirmedGroupResultByPair.has(key)) continue;
      const sets = extractWinnerLoserSets(result.score);
      confirmedGroupResultByPair.set(key, {
        winnerId,
        loserId,
        scoreText,
        winnerScore: sets?.winnerScore ?? null,
        loserScore: sets?.loserScore ?? null,
        result,
      });
    }
  }

  const groupPlayers = myGroup?.players ?? [];
  const sortedStandings = buildGroupStandings(
    groupPlayers,
    Array.from(confirmedGroupResultByPair.values()).map((item) => item.result),
  );

  const totalGroupMatches =
    myGroup && myGroup.players.length > 1
      ? (myGroup.players.length * (myGroup.players.length - 1)) / 2
      : 0;
  const confirmedGroupMatches = confirmedGroupResultByPair.size;
  const groupCompleted =
    totalGroupMatches > 0 && confirmedGroupMatches === totalGroupMatches;
  const hasKnockoutPhase =
    Boolean(groupingPayload.knockout) &&
    ((groupingPayload.knockout?.rounds?.length ?? 0) > 0 ||
      (filledKnockoutRounds?.length ?? 0) > 0);
  const qualifiersPerGroup = groupingPayload.config?.qualifiersPerGroup ?? 1;
  const qualifiedPlayers = groupCompleted
    ? sortedStandings.slice(
        0,
        Math.min(qualifiersPerGroup, sortedStandings.length),
      )
    : [];

  const parseGroupNameFromQualifierLabel = (label?: string) => {
    if (!label) return null;
    const matched = label.match(/^(第\s*\d+\s*组)第\s*\d+\s*名$/);
    return matched ? matched[1] : null;
  };

  let knockoutState: "group" | "ready" | "waiting" | "eliminated" | "finished" =
    "group";
  let knockoutOpponent: { id: string; nickname: string } | null = null;
  let waitingReason = "";
  let currentKnockoutRoundName: string | null = null;
  let hasKnockoutEntry = false;
  const hasQualified = qualifiedPlayers.some(
    (item) => item.id === currentUserId,
  );

  if (groupCompleted && hasKnockoutPhase && filledKnockoutRounds) {
    knockoutState = "finished";

    outer: for (const round of filledKnockoutRounds) {
      for (const matchRound of round.matches) {
        const isHome = matchRound.homePlayerId === currentUserId;
        const isAway = matchRound.awayPlayerId === currentUserId;
        if (!isHome && !isAway) continue;

        hasKnockoutEntry = true;
        currentKnockoutRoundName = round.name;

        const myOutcome = isHome
          ? matchRound.homeOutcome
          : matchRound.awayOutcome;

        if (myOutcome === "loser") {
          knockoutState = "eliminated";
          waitingReason = "你在淘汰赛中已被淘汰。";
          break outer;
        }

        if (myOutcome === "winner") {
          knockoutState = "finished";
          continue;
        }

        const opponentId = isHome
          ? matchRound.awayPlayerId
          : matchRound.homePlayerId;
        const opponentLabel = isHome
          ? matchRound.awayLabel
          : matchRound.homeLabel;
        const opponentSource = isHome
          ? matchRound.awaySourceLabel
          : matchRound.homeSourceLabel;

        if (opponentId) {
          knockoutState = "ready";
          knockoutOpponent = {
            id: opponentId,
            nickname: opponentLabel,
          };
        } else {
          knockoutState = "waiting";
          waitingReason = "当前淘汰赛对手尚未产生，请等待相关对局完成。";
          parseGroupNameFromQualifierLabel(opponentSource);
        }

        break outer;
      }
    }

    if (!hasKnockoutEntry && !hasQualified) {
      knockoutState = "eliminated";
      waitingReason = "你在本届比赛中止步于小组赛。";
    } else if (!hasKnockoutEntry && hasQualified) {
      knockoutState = "waiting";
      waitingReason =
        "你已从小组赛出线，淘汰赛对阵尚未生成，请等待管理员更新赛程。";
    }
  } else if (groupCompleted && hasKnockoutPhase) {
    knockoutState = "waiting";
    waitingReason = "淘汰赛对阵尚未生成，请等待管理员更新赛程。";
  }

  const pendingResults = results
    .filter((result) => {
      if (result.confirmed) return false;
      const ids = [...result.winnerTeamIds, ...result.loserTeamIds];
      return ids.includes(currentUserId);
    })
    .map((result) => {
      const winnerLabel = result.winnerTeamIds
        .map(
          (id) =>
            registrations.find((r) => r.userId === id)?.user.nickname ?? id,
        )
        .join(" / ");
      const loserLabel = result.loserTeamIds
        .map(
          (id) =>
            registrations.find((r) => r.userId === id)?.user.nickname ?? id,
        )
        .join(" / ");

      return {
        id: result.id,
        reporterId: result.reporter.id,
        reporterName: result.reporter.nickname,
        winnerLabel,
        loserLabel,
        scoreText:
          typeof result.score === "object" &&
          result.score &&
          "text" in result.score
            ? String(result.score.text ?? "")
            : "",
      };
    });

  const buildGroupBattleMatrix = (
    players: Array<{ id: string; nickname: string }>,
  ) => {
    const playerIds = new Set(players.map((player) => player.id));
    const confirmedByPair = new Map<
      string,
      {
        winnerId: string;
        scoreText: string;
        winnerScore: number | null;
        loserScore: number | null;
      }
    >();
    const pendingByPair = new Map<
      string,
      {
        winnerId: string;
        scoreText: string;
        winnerScore: number | null;
        loserScore: number | null;
      }
    >();

    for (const result of results) {
      if (result.winnerTeamIds.length !== 1 || result.loserTeamIds.length !== 1)
        continue;

      const winnerId = result.winnerTeamIds[0];
      const loserId = result.loserTeamIds[0];
      if (!playerIds.has(winnerId) || !playerIds.has(loserId)) continue;

      const key = pairKey(winnerId, loserId);
      const scoreText = extractScoreText(result.score);
      const sets = extractWinnerLoserSets(result.score);
      const winnerScore = sets?.winnerScore ?? null;
      const loserScore = sets?.loserScore ?? null;

      const payload = { winnerId, scoreText, winnerScore, loserScore };

      if (result.confirmed) {
        if (!confirmedByPair.has(key)) {
          confirmedByPair.set(key, payload);
        }
      } else if (!pendingByPair.has(key)) {
        pendingByPair.set(key, payload);
      }
    }

    const formatScore = (
      rowId: string,
      data: {
        winnerId: string;
        scoreText: string;
        winnerScore: number | null;
        loserScore: number | null;
      },
    ) => {
      // If we have numeric scores, format them based on perspective
      if (data.winnerScore !== null && data.loserScore !== null) {
        if (rowId === data.winnerId) {
          return `${data.winnerScore}:${data.loserScore}`;
        }
        return `${data.loserScore}:${data.winnerScore}`;
      }
      // If no numeric scores, fallback to text (but we can't easily reverse text)
      return data.scoreText;
    };

    const getCell = (rowId: string, colId: string) => {
      const key = pairKey(rowId, colId);
      const confirmed = confirmedByPair.get(key);
      if (confirmed) {
        return {
          status: "confirmed" as const,
          label: confirmed.winnerId === rowId ? "胜" : "负",
          scoreText: formatScore(rowId, confirmed),
        };
      }

      const pending = pendingByPair.get(key);
      if (pending) {
        // For pending, we show "待确认"
        // But we should also show score from perspective if possible
        // Actually, for pending matches, user might want to see what was reported
        return {
          status: "pending" as const,
          label: "待确认",
          scoreText: formatScore(rowId, pending),
        };
      }

      return {
        status: "todo" as const,
        label: "未进行",
        scoreText: "",
      };
    };

    return { players, getCell };
  };

  const myGroupMatrix = buildGroupBattleMatrix(groupPlayers);

  const completedCount = confirmedGroupMatches;
  const confirmedTotalMatches = results.filter((result) => {
    if (!result.confirmed) return false;
    const ids = [...result.winnerTeamIds, ...result.loserTeamIds];
    return ids.includes(currentUserId);
  }).length;

  const knockoutStageLabel = currentKnockoutRoundName ?? "淘汰赛阶段";

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4 sm:p-6 md:p-8">
      <h2 className="mb-2 text-lg font-bold text-white sm:text-xl">
        我的比赛进程
      </h2>
      {!groupCompleted ? (
        <p className="mb-4 text-sm text-slate-400">
          当前进度：已完成 {completedCount}/{totalGroupMatches}{" "}
          场组内对局。每场需由对手或管理员确认后生效并推进进程。
        </p>
      ) : !hasKnockoutPhase ? (
        <div className="mb-4 rounded-xl border border-emerald-500/35 bg-emerald-500/5 p-4">
          <p className="text-sm text-emerald-200">
            本次小组赛已完成 {completedCount}/{totalGroupMatches}{" "}
            场组内对局，恭喜完赛！
          </p>
          <p className="mt-2 text-sm text-slate-300">
            你的小组赛成绩已记录，可在下方对战表和排名中查看详情。
          </p>
        </div>
      ) : knockoutState === "eliminated" ? (
        <div className="mb-4 rounded-xl border border-rose-500/35 bg-rose-500/5 p-4">
          <p className="text-sm text-rose-200">
            你在本届比赛中已完成 {confirmedTotalMatches} 场对局，目前止步于{" "}
            {currentKnockoutRoundName ?? "小组赛"}。
          </p>
          <p className="mt-2 text-sm text-slate-300">
            感谢你的全力以赴！你的比赛数据已存档，可随时在“历史记录”中查看。
          </p>
        </div>
      ) : (
        <div className="mb-4 rounded-xl border border-cyan-500/35 bg-cyan-500/5 p-4">
          <p className="text-sm text-cyan-100">
            你在本届比赛中已完成 {confirmedTotalMatches} 场对局，目前在淘汰赛
            {knockoutStageLabel}。
          </p>
        </div>
      )}
      {matchType !== "single" ? (
        <p className="text-sm text-amber-300">
          当前流程化登记先支持单打。双打/团体请由管理员使用赛果录入接口。
        </p>
      ) : myGroup ? (
        <div className="space-y-6">
          {!groupCompleted ? (
            <ReportResultForm
              matchId={matchId}
              currentUserId={currentUserId}
              mode="group"
              opponents={opponents}
              pendingResults={pendingResults}
            />
          ) : null}

          <div className="rounded-xl border border-slate-700 bg-slate-800/40 p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-100">
                小组对战表
              </h3>
              <p className="text-xs text-slate-400">
                记分口径：行选手对列选手，比分格式为“行方局数:列方局数”。
              </p>
            </div>
            <MatrixTable
              matrix={myGroupMatrix}
              headPrefix="head-"
              cellPrefix=""
              currentUserId={currentUserId}
            />
          </div>

          {groupCompleted && hasKnockoutPhase ? (
            <div className="rounded-xl border border-cyan-500/35 bg-cyan-500/5 p-4">
              <h3 className="mb-3 text-sm font-semibold text-cyan-200">
                淘汰赛进程
              </h3>
              {knockoutState === "ready" && knockoutOpponent ? (
                <ReportResultForm
                  matchId={matchId}
                  currentUserId={currentUserId}
                  mode="knockout"
                  knockoutOpponent={knockoutOpponent}
                  pendingResults={pendingResults}
                />
              ) : knockoutState === "waiting" ? (
                <p className="text-sm text-slate-300">{waitingReason}</p>
              ) : knockoutState === "eliminated" ? (
                <p className="text-sm text-rose-300">{waitingReason}</p>
              ) : (
                <p className="text-sm text-emerald-300">
                  你已完成当前淘汰赛轮次，请等待下一轮生成。
                </p>
              )}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-slate-400">
          你当前不在任何分组中，暂无法登记组内赛果。
        </p>
      )}
    </div>
  );
}
