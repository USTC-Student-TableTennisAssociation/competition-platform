import Link from "next/link";

import {
  acceptDoublesInviteAction,
  revokeDoublesInviteAction,
  sendDoublesInviteAction,
} from "@/app/team-invites/actions";
import BackLinkButton from "@/components/navigation/BackLinkButton";
import ExportCertificateSection from "@/components/match/detail/ExportCertificateSection";
import V2DoubleRegistrationForm from "@/components/match/v2/V2DoubleRegistrationForm";
import V2CompetitionPhases from "@/components/match/v2/V2CompetitionPhases";
import MatchDetailHeader from "@/components/match/detail/MatchDetailHeader";
import type { V2DoubleRegistrationReadState } from "@/modules/competitions-v2/read-model/double-registration";
import type { V2CertificateSectionState } from "@/modules/competitions-v2/read-model/single-certificate";

type DoubleState = Extract<
  V2DoubleRegistrationReadState,
  { kind: "DOUBLE_V2_REGISTRATION" }
>;

export default function V2DoubleMatchDetail({
  model,
  currentUserId,
  inviteQuery,
  inviteCandidates,
  pendingInvites,
  canManageGrouping,
  isAdmin = false,
  certificate,
}: Readonly<{
  model: DoubleState;
  currentUserId: string | null;
  inviteQuery: string;
  inviteCandidates: readonly Readonly<{
    id: string;
    nickname: string;
    email: string;
  }>[];
  pendingInvites: readonly Readonly<{
    id: string;
    inviterNickname: string;
    inviteeNickname: string;
    inviteeId: string;
  }>[];
  canManageGrouping: boolean;
  isAdmin?: boolean;
  certificate: V2CertificateSectionState | null;
}>) {
  const { match, viewer } = model;
  const showTeamBuilder = viewer.action === "FORM_TEAM";

  const registration = (
    <div className="space-y-5">
      <section className="rounded-xl border border-white/10 bg-[#101620] p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">双打报名</h2>
        {viewer.sourceTeam ? (
          <p className="mt-3 text-sm text-slate-300">
            我的搭档：
            {viewer.sourceTeam.members
              .map((member) => member.nickname)
              .join(" + ")}
          </p>
        ) : null}
        <div className="mt-4">
          {viewer.action === "REGISTER" ? (
            <V2DoubleRegistrationForm matchId={match.id} mode="register" />
          ) : viewer.action === "CANCEL" ? (
            <V2DoubleRegistrationForm matchId={match.id} mode="cancel" />
          ) : (
            <p className="text-sm text-slate-300">{viewer.message}</p>
          )}
        </div>
        {!currentUserId ? (
          <Link
            href="/auth"
            className="mt-4 inline-block text-sm text-orange-200 hover:text-orange-100"
          >
            登录后组队报名 →
          </Link>
        ) : null}
        <p className="mt-4 text-xs text-slate-400">
          两人组队完成报名后，双方获得相应报名积分。
        </p>
      </section>
      {showTeamBuilder ? (
        <section className="space-y-4 rounded-xl border border-white/10 bg-[#101620] p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-white">双打组队</h2>
              <p className="mt-1 text-xs text-slate-400">
                队友接受邀请后，由任一伙伴点击“小队报名”完成报名。
              </p>
            </div>
            <Link
              href="/team-invites"
              className="text-xs text-cyan-300 hover:text-cyan-200"
            >
              查看全部邀请 →
            </Link>
          </div>

          <form
            action={`/matchs/${match.id}`}
            method="get"
            className="flex flex-col gap-2 sm:flex-row"
          >
            <input
              type="text"
              name="inviteQ"
              defaultValue={inviteQuery}
              placeholder="搜索队友昵称或邮箱"
              className="h-9 w-full flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100"
            />
            <button
              type="submit"
              className="h-9 rounded-lg border border-cyan-500/40 px-3 text-sm text-cyan-200 hover:bg-cyan-500/10"
            >
              搜索
            </button>
          </form>

          {inviteQuery ? (
            <div className="space-y-2">
              {inviteCandidates.length === 0 ? (
                <p className="text-xs text-slate-400">未找到可邀请球员。</p>
              ) : (
                inviteCandidates.map((candidate) => (
                  <div
                    key={candidate.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-700 bg-slate-800/40 px-3 py-2"
                  >
                    <div>
                      <p className="text-sm text-slate-100">
                        {candidate.nickname}
                      </p>
                      <p className="text-xs text-slate-400">
                        {candidate.email}
                      </p>
                    </div>
                    <form action={sendDoublesInviteAction.bind(null, match.id)}>
                      <input type="hidden" name="csrfToken" defaultValue="" />
                      <input
                        type="hidden"
                        name="inviteeId"
                        value={candidate.id}
                      />
                      <button
                        type="submit"
                        className="rounded-md border border-cyan-500/40 px-2.5 py-1.5 text-xs text-cyan-200 hover:bg-cyan-500/10"
                      >
                        发起邀请
                      </button>
                    </form>
                  </div>
                ))
              )}
            </div>
          ) : null}

          {pendingInvites.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-slate-400">当前比赛待处理邀请</p>
              {pendingInvites.map((invite) => {
                const received = invite.inviteeId === currentUserId;
                return (
                  <div
                    key={invite.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-700 bg-slate-800/30 px-3 py-2"
                  >
                    <p className="text-sm text-slate-200">
                      {invite.inviterNickname} → {invite.inviteeNickname}
                    </p>
                    <form
                      action={
                        received
                          ? acceptDoublesInviteAction
                          : revokeDoublesInviteAction
                      }
                    >
                      <input type="hidden" name="csrfToken" defaultValue="" />
                      <input type="hidden" name="inviteId" value={invite.id} />
                      <button
                        type="submit"
                        className={
                          received
                            ? "rounded-md border border-emerald-500/40 px-2.5 py-1 text-xs text-emerald-200 hover:bg-emerald-500/10"
                            : "rounded-md border border-rose-500/40 px-2.5 py-1 text-xs text-rose-200 hover:bg-rose-500/10"
                        }
                      >
                        {received ? "接受" : "撤回"}
                      </button>
                    </form>
                  </div>
                );
              })}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
  const roster = (
    <section>
      <h2 className="text-lg font-semibold text-white">参赛小队</h2>
      <p className="mt-1 text-sm text-slate-400">点击成员查看个人资料。</p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {model.activeEntries.length === 0 ? (
          <p className="text-sm text-slate-400">当前没有有效报名。</p>
        ) : (
          model.activeEntries.map((entry, index) => (
            <div
              key={entry.entryId}
              className="rounded-xl border border-white/10 bg-[#101620] p-4"
            >
              <p className="break-words text-sm font-semibold text-slate-100">
                {index + 1}. {entry.frozenDisplayName}
              </p>
              <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-300">
                {entry.members.map((member) => (
                  <Link
                    key={member.userId}
                    href={`/profile/${member.userId}`}
                    className="min-w-0 break-words hover:text-orange-200"
                  >
                    {member.frozenDisplayName}
                  </Link>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-6">
      <BackLinkButton fallbackHref="/matchs" />
      <MatchDetailHeader
        match={match}
        typeLabel="双打"
        participantLabel={`${model.activeEntryCount} 队 · ${model.activeMemberCount} 人报名`}
      />
      <V2CompetitionPhases
        grouping={model.grouping}
        competitionType="double"
        currentUserId={currentUserId}
        isManager={canManageGrouping}
        canReplaceRoster={isAdmin}
        canFinishMatch={isAdmin}
        registrationContent={
          !model.grouping.published ? registration : undefined
        }
        rosterContent={roster}
        certificateContent={
          certificate ? (
            <ExportCertificateSection
              matchId={match.id}
              matchTitle={match.title}
              {...certificate}
            />
          ) : undefined
        }
      />
    </div>
  );
}
