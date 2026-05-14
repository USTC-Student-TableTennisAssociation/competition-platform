import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { getInvitesForUser } from "@/lib/doubles";
import {
  acceptDoublesInviteAction,
  revokeDoublesInviteAction,
} from "@/app/team-invites/actions";

export default async function TeamInvitesPage() {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    redirect("/auth");
  }

  const invites = await getInvitesForUser(currentUser.id);

  const groupedByMatch = invites.reduce<
    Record<
      string,
      {
        matchTitle: string;
        items: typeof invites;
      }
    >
  >((acc, invite) => {
    if (!acc[invite.matchId]) {
      acc[invite.matchId] = {
        matchTitle: invite.matchTitle,
        items: [],
      };
    }
    acc[invite.matchId].items.push(invite);
    return acc;
  }, {});

  const entries = Object.entries(groupedByMatch);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <section className="rounded-2xl border border-slate-700 bg-slate-900/80 p-6">
        <h1 className="text-2xl font-bold text-white">组队邀请</h1>
        <p className="mt-2 text-sm text-slate-300">
          按比赛查看你的双打邀请记录。接受某条邀请后，同比赛下你相关的其他待处理邀请会自动作废。
        </p>
      </section>

      {entries.length === 0 ? (
        <section className="rounded-2xl border border-slate-700 bg-slate-900/80 p-6 text-sm text-slate-300">
          暂无组队邀请记录。
        </section>
      ) : (
        <div className="space-y-4">
          {entries.map(([matchId, group]) => (
            <section
              key={matchId}
              className="rounded-2xl border border-slate-700 bg-slate-900/80 p-6"
            >
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-white">
                  {group.matchTitle}
                </h2>
                <Link
                  href={`/matchs/${matchId}`}
                  className="text-sm text-cyan-300 hover:text-cyan-200"
                >
                  去比赛页 →
                </Link>
              </div>

              <div className="mt-4 space-y-3">
                {group.items.map((invite) => {
                  const isReceived = invite.inviteeId === currentUser.id;
                  const isPending = invite.status === "pending";

                  return (
                    <div
                      key={invite.id}
                      className="rounded-xl border border-slate-700 bg-slate-800/50 p-4"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="text-slate-200">
                          {invite.inviterNickname} → {invite.inviteeNickname}
                        </span>
                        <span className="rounded-full border border-slate-600 px-2 py-0.5 text-xs text-slate-300">
                          {invite.status}
                        </span>
                      </div>

                      {isPending ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {isReceived ? (
                            <form action={acceptDoublesInviteAction}>
                              <input
                                type="hidden"
                                name="csrfToken"
                                defaultValue=""
                              />
                              <input
                                type="hidden"
                                name="inviteId"
                                value={invite.id}
                              />
                              <button
                                type="submit"
                                className="rounded-md border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/10"
                              >
                                接受邀请
                              </button>
                            </form>
                          ) : null}

                          {!isReceived ? (
                            <form action={revokeDoublesInviteAction}>
                              <input
                                type="hidden"
                                name="csrfToken"
                                defaultValue=""
                              />
                              <input
                                type="hidden"
                                name="inviteId"
                                value={invite.id}
                              />
                              <button
                                type="submit"
                                className="rounded-md border border-rose-500/40 px-3 py-1.5 text-xs text-rose-200 hover:bg-rose-500/10"
                              >
                                撤回邀请
                              </button>
                            </form>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
