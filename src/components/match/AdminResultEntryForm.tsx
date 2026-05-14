"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import {
  reportMatchResultAction,
  type MatchFormState,
} from "@/app/matchs/actions";
import KnockoutBracket from "@/components/match/KnockoutBracket";

const initialState: MatchFormState = {};

type PlayerOption = {
  id: string;
  nickname: string;
};

type GroupMatchOption = {
  groupName: string;
  playerAId: string;
  playerANickname: string;
  playerBId: string;
  playerBNickname: string;
};

type KnockoutMatchOption = {
  matchId: string;
  roundName: string;
  playerAId: string;
  playerANickname: string;
  playerBId: string;
  playerBNickname: string;
};

type GroupBattleTable = {
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

export default function AdminResultEntryForm({
  matchId,
  players,
  groupMatchOptions,
  knockoutMatchOptions,
  groupBattleTables,
  initialPhase,
  initialGroupName,
  initialRoundName,
  initialWinnerId,
  initialLoserId,
  knockoutRounds,
}: {
  matchId: string;
  players: PlayerOption[];
  groupMatchOptions: GroupMatchOption[];
  knockoutMatchOptions: KnockoutMatchOption[];
  groupBattleTables: GroupBattleTable[];
  initialPhase?: "group" | "knockout";
  initialGroupName?: string;
  initialRoundName?: string;
  initialWinnerId?: string;
  initialLoserId?: string;
  knockoutRounds?: Array<{
    name: string;
    matches: Array<{
      id: string;
      homeLabel: string;
      awayLabel: string;
      homePlayerId?: string | null;
      awayPlayerId?: string | null;
      homeFilled?: boolean;
      awayFilled?: boolean;
      homeOutcome?: string;
      awayOutcome?: string;
      homeScoreText?: string;
      awayScoreText?: string;
    }>;
  }>;
}) {
  const persistedState =
    typeof window !== "undefined"
      ? (() => {
          try {
            const raw = window.localStorage.getItem(
              `admin-result-entry:${matchId}`,
            );
            if (!raw) return null;
            return JSON.parse(raw) as {
              phase?: "group" | "knockout";
              groupName?: string;
              roundName?: string;
              groupWinnerId?: string;
              groupLoserId?: string;
              selectedPairKey?: string;
              winnerSide?: "A" | "B";
            };
          } catch {
            return null;
          }
        })()
      : null;

  const [phase, setPhase] = useState<"group" | "knockout">(
    persistedState?.phase ?? initialPhase ?? "group",
  );
  const [groupName, setGroupName] = useState(
    persistedState?.groupName ?? initialGroupName ?? "",
  );
  const [roundName, setRoundName] = useState(
    persistedState?.roundName ?? initialRoundName ?? "",
  );
  const [groupWinnerId, setGroupWinnerId] = useState(
    persistedState?.groupWinnerId ?? initialWinnerId ?? "",
  );
  const [groupLoserId, setGroupLoserId] = useState(
    persistedState?.groupLoserId ?? initialLoserId ?? "",
  );
  const [selectedPairKey, setSelectedPairKey] = useState(
    persistedState?.selectedPairKey ?? "",
  );
  const [winnerSide, setWinnerSide] = useState<"A" | "B">(
    persistedState?.winnerSide ?? "A",
  );
  const [bestOf, setBestOf] = useState<3 | 5 | 7>(5);
  const [loserScore, setLoserScore] = useState(0);

  const action = reportMatchResultAction.bind(null, matchId);
  const [state, formAction, pending] = useActionState(action, initialState);

  const sortedPlayers = useMemo(
    () => [...players].sort((a, b) => a.nickname.localeCompare(b.nickname)),
    [players],
  );

  const groupNames = useMemo(
    () =>
      Array.from(
        new Set([
          ...groupMatchOptions.map((item) => item.groupName),
          ...groupBattleTables.map((item) => item.groupName),
        ]),
      ),
    [groupMatchOptions, groupBattleTables],
  );

  const knockoutRoundNames = useMemo(
    () =>
      Array.from(new Set(knockoutMatchOptions.map((item) => item.roundName))),
    [knockoutMatchOptions],
  );

  const activeGroupName =
    groupName && groupNames.includes(groupName)
      ? groupName
      : (groupNames[0] ?? "");

  const activeRoundName =
    roundName && knockoutRoundNames.includes(roundName)
      ? roundName
      : (knockoutRoundNames[0] ?? "");

  const visiblePairs = useMemo(() => {
    if (phase === "group") {
      return groupMatchOptions.filter(
        (item) => item.groupName === activeGroupName,
      );
    }
    return knockoutMatchOptions.filter(
      (item) => item.roundName === activeRoundName,
    );
  }, [
    phase,
    groupMatchOptions,
    knockoutMatchOptions,
    activeGroupName,
    activeRoundName,
  ]);

  const defaultPairKey = visiblePairs[0]
    ? "matchId" in visiblePairs[0] && visiblePairs[0].matchId
      ? visiblePairs[0].matchId
      : `${visiblePairs[0].playerAId}::${visiblePairs[0].playerBId}`
    : "";

  const activePairKey =
    selectedPairKey &&
    visiblePairs.some(
      (item) =>
        ("matchId" in item && item.matchId
          ? item.matchId
          : `${item.playerAId}::${item.playerBId}`) === selectedPairKey,
    )
      ? selectedPairKey
      : defaultPairKey;

  const visibleKnockoutPairs = useMemo(
    () =>
      visiblePairs.filter(
        (item): item is KnockoutMatchOption => "matchId" in item,
      ),
    [visiblePairs],
  );

  const activeKnockoutPair =
    visibleKnockoutPairs.find((item) => item.matchId === activePairKey) ??
    visibleKnockoutPairs[0];

  const activeKnockoutPairKey = activeKnockoutPair?.matchId ?? "";

  const groupPairs = useMemo(
    () =>
      groupMatchOptions.filter((item) => item.groupName === activeGroupName),
    [groupMatchOptions, activeGroupName],
  );

  const groupPlayerNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const pair of groupPairs) {
      map.set(pair.playerAId, pair.playerANickname);
      map.set(pair.playerBId, pair.playerBNickname);
    }
    return map;
  }, [groupPairs]);

  const groupWinnerCandidates = useMemo(() => {
    const ids = new Set<string>();
    for (const pair of groupPairs) {
      ids.add(pair.playerAId);
      ids.add(pair.playerBId);
    }

    return Array.from(ids)
      .map((id) => ({ id, nickname: groupPlayerNameMap.get(id) ?? id }))
      .sort((a, b) => a.nickname.localeCompare(b.nickname));
  }, [groupPairs, groupPlayerNameMap]);

  const activeGroupWinnerId =
    groupWinnerId &&
    groupWinnerCandidates.some((item) => item.id === groupWinnerId)
      ? groupWinnerId
      : (groupWinnerCandidates[0]?.id ?? "");

  const groupLoserCandidates = useMemo(() => {
    if (!activeGroupWinnerId)
      return [] as Array<{ id: string; nickname: string }>;

    const ids = new Set<string>();
    for (const pair of groupPairs) {
      if (pair.playerAId === activeGroupWinnerId) ids.add(pair.playerBId);
      if (pair.playerBId === activeGroupWinnerId) ids.add(pair.playerAId);
    }

    return Array.from(ids)
      .map((id) => ({ id, nickname: groupPlayerNameMap.get(id) ?? id }))
      .sort((a, b) => a.nickname.localeCompare(b.nickname));
  }, [groupPairs, groupPlayerNameMap, activeGroupWinnerId]);

  const activeGroupLoserId =
    groupLoserId &&
    groupLoserCandidates.some((item) => item.id === groupLoserId)
      ? groupLoserId
      : (groupLoserCandidates[0]?.id ?? "");

  const activeGroupBattleTable =
    groupBattleTables.find((item) => item.groupName === activeGroupName) ??
    null;

  const winsNeeded = Math.floor(bestOf / 2) + 1;
  const winnerScore = winsNeeded;
  const loserScoreOptions = Array.from({ length: winsNeeded }, (_, i) => i);

  const winnerId =
    phase === "group"
      ? activeGroupWinnerId
      : !activeKnockoutPair
        ? ""
        : winnerSide === "A"
          ? activeKnockoutPair.playerAId
          : activeKnockoutPair.playerBId;

  const loserId =
    phase === "group"
      ? activeGroupLoserId
      : !activeKnockoutPair
        ? ""
        : winnerSide === "A"
          ? activeKnockoutPair.playerBId
          : activeKnockoutPair.playerAId;

  const canSubmit =
    phase === "group"
      ? Boolean(activeGroupWinnerId && activeGroupLoserId)
      : Boolean(activeKnockoutPair) && sortedPlayers.length >= 2;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const payload = {
      phase,
      groupName: activeGroupName,
      roundName: activeRoundName,
      groupWinnerId: activeGroupWinnerId,
      groupLoserId: activeGroupLoserId,
      selectedPairKey: activePairKey,
      winnerSide,
    };
    window.localStorage.setItem(
      `admin-result-entry:${matchId}`,
      JSON.stringify(payload),
    );
  }, [
    matchId,
    phase,
    activeGroupName,
    activeRoundName,
    activeGroupWinnerId,
    activeGroupLoserId,
    activePairKey,
    winnerSide,
  ]);

  return (
    <form
      action={formAction}
      className="space-y-3 rounded-xl border border-slate-700 bg-slate-800/50 p-3 sm:space-y-4 sm:p-4"
    >
      <input type="hidden" name="csrfToken" defaultValue="" />
      <h3 className="text-sm font-semibold text-slate-100">管理员录入赛果</h3>
      <p className="text-xs text-slate-400">
        管理员录入后将进入待确认队列，需在下方“管理员待确认赛果”中确认或否决。
      </p>

      <div className="grid grid-cols-2 gap-2 sm:gap-3">
        <label className="space-y-1 text-xs text-slate-300 sm:text-sm">
          <span>阶段</span>
          <select
            name="phase"
            value={phase}
            onChange={(event) => {
              const next = event.target.value as "group" | "knockout";
              setPhase(next);
              setGroupWinnerId("");
              setGroupLoserId("");
              setSelectedPairKey("");
              setWinnerSide("A");
            }}
            className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2.5 text-sm text-slate-100"
          >
            <option value="group">小组赛</option>
            <option value="knockout">淘汰赛</option>
          </select>
        </label>

        {phase === "group" ? (
          <label className="space-y-1 text-xs text-slate-300 sm:text-sm">
            <span>小组</span>
            <select
              name="groupName"
              value={activeGroupName}
              onChange={(event) => {
                setGroupName(event.target.value);
                setGroupWinnerId("");
                setGroupLoserId("");
                setSelectedPairKey("");
                setWinnerSide("A");
              }}
              className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2.5 text-sm text-slate-100"
              required
            >
              {groupNames.length === 0 ? (
                <option value="">暂无可录入小组对局</option>
              ) : (
                groupNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))
              )}
            </select>
          </label>
        ) : (
          <label className="space-y-1 text-xs text-slate-300 sm:text-sm">
            <span>淘汰赛轮次</span>
            <select
              name="knockoutRound"
              value={activeRoundName}
              onChange={(event) => {
                setRoundName(event.target.value);
                setGroupWinnerId("");
                setGroupLoserId("");
                setSelectedPairKey("");
                setWinnerSide("A");
              }}
              className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2.5 text-sm text-slate-100"
              required
            >
              {knockoutRoundNames.length === 0 ? (
                <option value="">暂无可录入淘汰赛对局</option>
              ) : (
                knockoutRoundNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))
              )}
            </select>
          </label>
        )}
      </div>

      {phase === "group" ? (
        <div className="space-y-3 sm:space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:gap-3">
            <label className="space-y-1 text-xs text-slate-300 sm:text-sm">
              <span>获胜方（仅显示还有未登记比赛的选手）</span>
              <select
                value={activeGroupWinnerId}
                onChange={(event) => {
                  setGroupWinnerId(event.target.value);
                  setGroupLoserId("");
                }}
                className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2.5 text-sm text-slate-100"
                disabled={groupWinnerCandidates.length === 0}
              >
                {groupWinnerCandidates.length === 0 ? (
                  <option value="">当前小组无可录入对局</option>
                ) : (
                  groupWinnerCandidates.map((player) => (
                    <option key={player.id} value={player.id}>
                      {player.nickname}
                    </option>
                  ))
                )}
              </select>
            </label>

            <label className="space-y-1 text-xs text-slate-300 sm:text-sm">
              <span>失败方（仅显示与胜方仍有未登记比赛的对手）</span>
              <select
                value={activeGroupLoserId}
                onChange={(event) => setGroupLoserId(event.target.value)}
                className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2.5 text-sm text-slate-100"
                disabled={groupLoserCandidates.length === 0}
              >
                {groupLoserCandidates.length === 0 ? (
                  <option value="">请先选择有效胜方</option>
                ) : (
                  groupLoserCandidates.map((player) => (
                    <option key={player.id} value={player.id}>
                      {player.nickname}
                    </option>
                  ))
                )}
              </select>
            </label>
          </div>

          {activeGroupBattleTable && (
            <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-2.5 sm:p-3">
              <p className="mb-2 text-xs text-slate-400">
                {activeGroupBattleTable.groupName} 对战表（行选手对列选手）
              </p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-130 text-sm">
                  <thead>
                    <tr className="text-left text-slate-400">
                      <th className="min-w-24 px-2 py-2">选手</th>
                      {activeGroupBattleTable.players.map((player) => (
                        <th
                          key={`admin-head-${player.id}`}
                          className="min-w-24 px-2 py-2 text-center"
                        >
                          {player.nickname}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {activeGroupBattleTable.players.map((rowPlayer) => (
                      <tr
                        key={`admin-row-${rowPlayer.id}`}
                        className="border-t border-slate-700/80 text-slate-200"
                      >
                        <td className="px-2 py-2 font-medium text-slate-100">
                          {rowPlayer.nickname}
                        </td>
                        {activeGroupBattleTable.players.map((colPlayer) => {
                          if (rowPlayer.id === colPlayer.id) {
                            return (
                              <td
                                key={`admin-${rowPlayer.id}-${colPlayer.id}`}
                                className="px-2 py-2"
                              >
                                <div className="relative h-12 rounded border border-slate-700/80 bg-[linear-gradient(135deg,transparent_49%,rgba(148,163,184,0.5)_50%,transparent_51%)]" />
                              </td>
                            );
                          }

                          const cell =
                            activeGroupBattleTable.cells[
                              `${rowPlayer.id}::${colPlayer.id}`
                            ];

                          return (
                            <td
                              key={`admin-${rowPlayer.id}-${colPlayer.id}`}
                              className="px-2 py-2 text-center"
                            >
                              <div className="rounded border border-slate-700/80 bg-slate-900/70 px-2 py-1.5">
                                <p
                                  className={`text-sm font-medium ${
                                    cell?.status === "confirmed"
                                      ? cell.label === "胜"
                                        ? "text-emerald-300"
                                        : "text-rose-300"
                                      : cell?.status === "pending"
                                        ? "text-amber-300"
                                        : "text-slate-400"
                                  }`}
                                >
                                  {cell?.label ?? "未进行"}{" "}
                                  {cell?.scoreText || "-"}
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
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:gap-3">
          <label className="space-y-1 text-xs text-slate-300 sm:text-sm">
            <span>可录入对局（仅未完成）</span>
            <select
              value={activeKnockoutPairKey}
              onChange={(event) => {
                setSelectedPairKey(event.target.value);
                setWinnerSide("A");
              }}
              className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2.5 text-sm text-slate-100"
              disabled={visiblePairs.length === 0}
            >
              {visiblePairs.length === 0 ? (
                <option value="">当前无可录入对局</option>
              ) : (
                visibleKnockoutPairs.map((item) => (
                  <option key={item.matchId} value={item.matchId}>
                    {item.playerANickname} vs {item.playerBNickname}
                  </option>
                ))
              )}
            </select>
          </label>

          <label className="space-y-1 text-xs text-slate-300 sm:text-sm">
            <span>获胜方</span>
            <select
              value={winnerSide}
              onChange={(event) =>
                setWinnerSide(event.target.value as "A" | "B")
              }
              className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2.5 text-sm text-slate-100"
              disabled={!activeKnockoutPair}
            >
              {activeKnockoutPair ? (
                <>
                  <option value="A">
                    {activeKnockoutPair.playerANickname}
                  </option>
                  <option value="B">
                    {activeKnockoutPair.playerBNickname}
                  </option>
                </>
              ) : (
                <option value="A">请先选择对局</option>
              )}
            </select>
          </label>

          {knockoutRounds && knockoutRounds.length > 0 ? (
            <div className="col-span-2 rounded-xl border border-slate-700 bg-slate-900/60 p-2.5 sm:p-3">
              <p className="mb-2 text-xs text-slate-400">
                淘汰赛签表（已自动定位并高亮当前选择对局）
              </p>
              <KnockoutBracket
                rounds={knockoutRounds}
                selectedMatchId={activeKnockoutPair?.matchId ?? null}
                autoFocusMatchId={activeKnockoutPair?.matchId ?? null}
              />
            </div>
          ) : null}
        </div>
      )}

      <input type="hidden" name="winnerTeamIds" value={winnerId} />
      <input type="hidden" name="loserTeamIds" value={loserId} />

      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <label className="space-y-1 text-xs text-slate-300 sm:text-sm">
          <span>局制（必选）</span>
          <select
            name="bestOf"
            required
            value={bestOf}
            onChange={(event) => {
              const value = Number(event.target.value) as 3 | 5 | 7;
              setBestOf(value);
              setLoserScore(0);
            }}
            className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100"
          >
            <option value={3}>3局2胜</option>
            <option value={5}>5局3胜</option>
            <option value={7}>7局4胜</option>
          </select>
        </label>

        <label className="space-y-1 text-xs text-slate-300 sm:text-sm">
          <span>胜方局分（固定）</span>
          <input
            readOnly
            value={winnerScore}
            className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900/70 px-2 text-sm text-slate-100"
          />
        </label>

        <label className="space-y-1 text-xs text-slate-300 sm:text-sm">
          <span>负方局分（必选）</span>
          <select
            name="loserScore"
            required
            value={loserScore}
            onChange={(event) => setLoserScore(Number(event.target.value))}
            className="h-9 w-full rounded-lg border border-slate-600 bg-slate-900 px-2 text-sm text-slate-100"
          >
            {loserScoreOptions.map((score) => (
              <option key={`loser-${bestOf}-${score}`} value={score}>
                {score}
              </option>
            ))}
          </select>
        </label>
      </div>

      {state.error ? (
        <p className="text-sm text-rose-300">{state.error}</p>
      ) : null}
      {state.success ? (
        <p className="text-sm text-emerald-300">{state.success}</p>
      ) : null}

      <button
        type="submit"
        disabled={pending || !canSubmit}
        className="w-full rounded-md border border-cyan-500/40 px-3 py-2 text-sm text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-60 sm:w-auto"
      >
        {pending ? "录入中..." : "录入为待确认"}
      </button>
    </form>
  );
}
