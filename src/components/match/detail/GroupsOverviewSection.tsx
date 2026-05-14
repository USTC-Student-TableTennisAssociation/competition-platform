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

export default function GroupsOverviewSection({
  groupingPayload,
  pagedGroups,
  groupsPages,
  totalGroupsPages,
  currentGroupsPage,
  shouldOpenGroups,
  buildHref,
}: {
  groupingPayload: GroupingPayload;
  pagedGroups: GroupingPayload["groups"];
  groupsPages: number[];
  totalGroupsPages: number;
  currentGroupsPage: number;
  shouldOpenGroups: boolean;
  buildHref: (page: number) => string;
}) {
  return (
    <details
      id="all-groups"
      className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4 sm:p-6"
      open={shouldOpenGroups}
    >
      <summary className="cursor-pointer list-none text-lg font-bold text-white marker:hidden sm:text-xl">
        <span className="inline-flex items-center gap-2">
          全部小组查看（{groupingPayload.groups.length}）
          <span className="text-xs font-normal text-slate-400 sm:text-sm">
            点击展开/收起
          </span>
        </span>
      </summary>

      <div className="mt-5 space-y-5">
        <div className="grid gap-4 md:grid-cols-2">
          {pagedGroups.map((group) => (
            <div
              key={group.name}
              className="rounded-xl border border-slate-700 p-4"
            >
              <div className="mb-2 flex items-center justify-between">
                <h3 className="font-semibold text-cyan-100">{group.name}</h3>
                <span className="text-xs text-slate-400">
                  组均 ELO {calculateAverageElo(group.players)}
                </span>
              </div>
              <ul className="space-y-1 text-sm text-slate-200">
                {group.players.map((player) => (
                  <li key={player.id} className="flex justify-between">
                    <Link
                      href={`/profile/${player.id}`}
                      className="hover:text-cyan-300 hover:underline"
                    >
                      {player.nickname}
                    </Link>
                    <span className="text-slate-400">
                      {player.points} 分 / ELO {player.eloRating}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {totalGroupsPages > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            {groupsPages.map((page) => (
              <Link
                key={page}
                href={buildHref(page)}
                className={`inline-flex h-8 min-w-8 items-center justify-center rounded-md border px-2 text-sm transition ${
                  page === currentGroupsPage
                    ? "border-cyan-400 bg-cyan-500/20 text-cyan-100"
                    : "border-slate-700 text-slate-300 hover:border-cyan-400/40"
                }`}
              >
                {page}
              </Link>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}
