import KnockoutBracket from "@/components/match/KnockoutBracket";
import Link from "next/link";

type GroupingPayload = {
  groups: Array<{
    name: string;
    averagePoints: number;
    players: Array<{
      id: string;
      nickname: string;
      points: number;
      eloRating: number;
    }>;
  }>;
  tableAssignments?: {
    group?: Record<string, string[]>;
    knockout?: Record<string, string[]>;
  };
  knockout?: {
    stage: string;
    rounds: Array<{
      name: string;
      matches: Array<{ id: string; homeLabel: string; awayLabel: string }>;
    }>;
  };
};

function calculateAverageElo(
  players: GroupingPayload["groups"][number]["players"],
) {
  if (players.length === 0) return 0;
  const sum = players.reduce(
    (acc, player) =>
      acc + (Number.isFinite(player.eloRating) ? player.eloRating : 0),
    0,
  );
  return Math.round(sum / players.length);
}

export default function GroupingResultSection({
  groupingPayload,
  alreadyRegistered,
  myGroup,
  filledKnockoutRounds,
  currentUserId,
  currentUserNickname,
}: {
  groupingPayload: GroupingPayload | null;
  alreadyRegistered: boolean;
  myGroup: {
    name: string;
    averagePoints: number;
    players: Array<{
      id: string;
      nickname: string;
      points: number;
      eloRating: number;
    }>;
  } | null;
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
  currentUserId?: string | null;
  currentUserNickname?: string | null;
}) {
  return (
    <div
      id="grouping"
      className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4 sm:p-6 md:p-8"
    >
      <h2 className="mb-3 text-lg font-bold text-white sm:mb-4 sm:text-xl">
        分组结果
      </h2>
      {!groupingPayload ? (
        <p className="text-slate-400">
          报名截止后由发起人或管理员手动生成并确认分组结果。
        </p>
      ) : (
        <div className="space-y-6">
          {alreadyRegistered ? (
            myGroup ? (
              <div className="rounded-xl border border-slate-700 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="font-semibold text-cyan-100">
                    {myGroup.name}
                  </h3>
                  <span className="text-xs text-slate-400">
                    组均 ELO {calculateAverageElo(myGroup.players)}
                  </span>
                </div>
                <ul className="space-y-1 text-sm text-slate-200">
                  {myGroup.players.map((player) => (
                    <li key={player.id} className="flex justify-between">
                      <Link
                        href={`/profile/${player.id}`}
                        className={
                          currentUserId && player.id === currentUserId
                            ? "font-semibold text-amber-200 hover:underline"
                            : "hover:text-cyan-300 hover:underline"
                        }
                      >
                        {player.nickname}
                        {currentUserId && player.id === currentUserId
                          ? "（我）"
                          : ""}
                      </Link>
                      <span className="text-slate-400">
                        {player.points} 分 / ELO {player.eloRating}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 space-y-2">
                  <p className="text-xs font-semibold text-slate-200">
                    本组对局桌号
                  </p>
                  <div className="space-y-1 text-xs text-slate-300">
                    {myGroup.players.length < 2 ? (
                      <p className="text-slate-400">小组人数不足。</p>
                    ) : (
                      (() => {
                        const tables =
                          groupingPayload.tableAssignments?.group?.[
                            myGroup.name
                          ] ?? [];
                        const tableLabel =
                          tables.length > 0
                            ? `桌号 ${tables.join(" / ")}`
                            : "桌号待定";

                        return (
                          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-700/70 bg-slate-900/70 px-2 py-1">
                            <span>本组全部对局</span>
                            <span className="text-slate-400">{tableLabel}</span>
                          </div>
                        );
                      })()
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-slate-400">你已报名，当前尚未分配到小组。</p>
            )
          ) : (
            <p className="text-slate-400">
              你未报名该比赛，当前不展示你的比赛进程；可查看淘汰赛签表。
            </p>
          )}

          {groupingPayload.knockout && (
            <div className="space-y-2">
              <h3 className="font-semibold text-cyan-100">
                {groupingPayload.knockout.stage}（淘汰赛签表）
              </h3>
              <p className="text-xs text-slate-400">
                当前展示为签位示意，待小组赛结束后将按晋级结果填充具体选手。
              </p>
              <KnockoutBracket
                rounds={filledKnockoutRounds ?? groupingPayload.knockout.rounds}
                currentUserId={currentUserId}
                currentUserNickname={currentUserNickname}
              />
              <div className="mt-3 space-y-2">
                <p className="text-xs font-semibold text-slate-200">
                  淘汰赛对局桌号
                </p>
                <div className="space-y-1 text-xs text-slate-300">
                  {groupingPayload.knockout.rounds.flatMap((round) =>
                    round.matches.map((match) => {
                      const tables =
                        groupingPayload.tableAssignments?.knockout?.[
                          match.id
                        ] ?? [];
                      const tableLabel =
                        tables.length > 0
                          ? `桌号 ${tables.join(" / ")}`
                          : "桌号待定";

                      return (
                        <div
                          key={`knockout-table-${round.name}-${match.id}`}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-700/70 bg-slate-900/70 px-2 py-1"
                        >
                          <span>
                            {round.name}：{match.homeLabel} vs {match.awayLabel}
                          </span>
                          <span className="text-slate-400">{tableLabel}</span>
                        </div>
                      );
                    }),
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
