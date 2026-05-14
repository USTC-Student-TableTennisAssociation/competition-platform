import Link from "next/link";
import { removeRegistrationByManagerVoidAction } from "@/app/matchs/actions";
import { normalizeAvatarUrl } from "@/lib/utils";

type RegistrationItem = {
  id: string;
  user: {
    id: string;
    nickname: string;
    avatarUrl?: string | null;
    points: number;
    eloRating: number;
  };
};

type DoublesTeamItem = {
  teamId: string;
  members: Array<{
    userId: string;
    nickname: string;
    avatarUrl?: string | null;
  }>;
};

export default function RegisteredPlayersSection({
  matchId,
  matchType,
  registrations,
  pagedRegistrations,
  doublesTeams,
  pagedDoublesTeams,
  participantsStartIndex,
  participantsPages,
  totalParticipantsPages,
  currentParticipantsPage,
  shouldOpenParticipants,
  isAdmin,
  canRemove,
  buildHref,
}: {
  matchId: string;
  matchType: "single" | "double" | "team";
  registrations: RegistrationItem[];
  pagedRegistrations: RegistrationItem[];
  doublesTeams?: DoublesTeamItem[];
  pagedDoublesTeams?: DoublesTeamItem[];
  participantsStartIndex: number;
  participantsPages: number[];
  totalParticipantsPages: number;
  currentParticipantsPage: number;
  shouldOpenParticipants: boolean;
  isAdmin: boolean;
  canRemove: boolean;
  buildHref: (page: number) => string;
}) {
  const isDouble = matchType === "double";
  const totalDisplayCount = isDouble
    ? (doublesTeams?.length ?? 0)
    : registrations.length;

  return (
    <details
      id="registered-players"
      className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4 sm:p-6"
      open={shouldOpenParticipants}
    >
      <summary className="cursor-pointer list-none text-lg font-bold text-white marker:hidden sm:text-xl">
        <span className="inline-flex items-center gap-2">
          {isDouble ? "已报名小队" : "已报名选手"}（{totalDisplayCount}）
          <span className="text-xs font-normal text-slate-400 sm:text-sm">
            点击展开/收起
          </span>
        </span>
      </summary>

      <div className="mt-5 space-y-5">
        {isDouble ? (
          <div className="grid gap-3 md:grid-cols-2">
            {(pagedDoublesTeams ?? []).map((team, index) => {
              const playerA = team.members[0];
              const playerB = team.members[1];

              return (
                <div
                  key={team.teamId}
                  className="flex items-center gap-4 rounded-lg border border-slate-700 p-3 hover:border-cyan-400/40"
                >
                  <span className="w-6 font-mono text-slate-400">
                    {participantsStartIndex + index + 1}
                  </span>
                  <div className="flex items-center gap-1">
                    {[playerA, playerB].map((player, idx) => {
                      const avatarUrl = normalizeAvatarUrl(
                        player?.avatarUrl ?? null,
                      );
                      const fallback = (
                        player?.nickname?.[0] ?? "?"
                      ).toUpperCase();
                      return (
                        <div
                          key={`${team.teamId}-avatar-${idx}`}
                          className="grid h-8 w-8 place-items-center overflow-hidden rounded-full bg-cyan-500/20 text-xs text-cyan-100"
                        >
                          {avatarUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={avatarUrl}
                              alt={player?.nickname ?? "选手"}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            fallback
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex-1">
                    <p className="font-medium text-slate-100">
                      {playerA?.nickname ?? "选手A"} +{" "}
                      {playerB?.nickname ?? "选手B"}
                    </p>
                    <p className="text-sm text-slate-400">双打小队</p>
                  </div>
                  {isAdmin && canRemove && playerA ? (
                    <form
                      action={removeRegistrationByManagerVoidAction.bind(
                        null,
                        matchId,
                        playerA.userId,
                      )}
                    >
                      <input type="hidden" name="csrfToken" defaultValue="" />
                      <button
                        type="submit"
                        className="rounded-md border border-rose-500/40 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/10"
                      >
                        移除
                      </button>
                    </form>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {pagedRegistrations.map((item, index) => (
              <div
                key={item.id}
                className="flex items-center gap-4 rounded-lg border border-slate-700 p-3 hover:border-cyan-400/40"
              >
                <span className="w-6 font-mono text-slate-400">
                  {participantsStartIndex + index + 1}
                </span>
                <div className="grid h-10 w-10 place-items-center overflow-hidden rounded-full bg-cyan-500/20 text-cyan-100">
                  {normalizeAvatarUrl(item.user.avatarUrl ?? null) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={
                        normalizeAvatarUrl(item.user.avatarUrl ?? null) ?? ""
                      }
                      alt={item.user.nickname}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    item.user.nickname[0]
                  )}
                </div>
                <Link href={`/profile/${item.user.id}`} className="flex-1">
                  <p className="font-medium text-slate-100">
                    {item.user.nickname}
                  </p>
                  <p className="text-sm text-slate-400">
                    积分 {item.user.points} · ELO {item.user.eloRating}
                  </p>
                </Link>
                {isAdmin && canRemove ? (
                  <form
                    action={removeRegistrationByManagerVoidAction.bind(
                      null,
                      matchId,
                      item.user.id,
                    )}
                  >
                    <input type="hidden" name="csrfToken" defaultValue="" />
                    <button
                      type="submit"
                      className="rounded-md border border-rose-500/40 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/10"
                    >
                      移除
                    </button>
                  </form>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {totalParticipantsPages > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            {participantsPages.map((page) => (
              <Link
                key={page}
                href={buildHref(page)}
                className={`inline-flex h-8 min-w-8 items-center justify-center rounded-md border px-2 text-sm transition ${
                  page === currentParticipantsPage
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
