import { Calendar, MapPin, Users } from "lucide-react";
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
import { formatV2CompetitionDateTime } from "@/modules/competitions-v2/competition-time";
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

  return (
    <div className="mx-auto max-w-5xl space-y-5 sm:space-y-8">
      <BackLinkButton fallbackHref="/matchs" />

      <section className="surface-panel relative overflow-hidden rounded-3xl p-4 sm:p-6 md:p-8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_88%_6%,rgba(45,212,191,0.1),transparent_36%)]" />
        <div className="relative">
          <span className="status-pill ring-1 ring-cyan-400/30">
            {match.status === "registration"
              ? "报名中"
              : match.status === "ongoing"
                ? "进行中"
                : "已结束"}
          </span>
          <h1 className="mt-3 text-2xl font-black tracking-tight text-white sm:text-4xl">
            {match.title}
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-400 sm:text-base">
            {match.description || "暂无描述"}
          </p>
          <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-300">
            <span className="rounded-full bg-white/[0.045] px-3 py-1 ring-1 ring-white/8">
              双打
              {match.format === "group_then_knockout" ? "小组 + 淘汰赛" : "纯小组赛"}
            </span>
            <span className="rounded-full bg-white/[0.045] px-3 py-1 ring-1 ring-white/8">
              报名截止：
              {formatV2CompetitionDateTime(match.registrationDeadline)}（北京时间）
            </span>
          </div>
        </div>

        <div className="relative mt-5 grid gap-3 text-slate-200 sm:grid-cols-3">
          <div className="flex items-center gap-3 rounded-2xl bg-slate-950/34 p-3 ring-1 ring-white/8">
            <Calendar className="h-5 w-5 text-teal-200" />
            <div>
              <p className="text-xs text-slate-400">时间</p>
              <p>
                {formatV2CompetitionDateTime(match.dateTime)}（北京时间）
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-2xl bg-slate-950/34 p-3 ring-1 ring-white/8">
            <MapPin className="h-5 w-5 text-teal-200" />
            <div>
              <p className="text-xs text-slate-400">地点</p>
              <p>{match.location ?? "待定"}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 rounded-2xl bg-slate-950/34 p-3 ring-1 ring-white/8">
            <Users className="h-5 w-5 text-teal-200" />
            <div>
              <p className="text-xs text-slate-400">有效报名</p>
              <p>
                {model.activeEntryCount} 队 / {model.activeMemberCount} 人
              </p>
            </div>
          </div>
        </div>

        <div className="relative mt-5 space-y-3">
          {viewer.sourceTeam ? (
            <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3 text-sm text-emerald-100">
              当前小队：
              {viewer.sourceTeam.members.map((member) => member.nickname).join(" + ")}
            </div>
          ) : null}
          {viewer.action === "REGISTER" ? (
            <V2DoubleRegistrationForm matchId={match.id} mode="register" />
          ) : viewer.action === "CANCEL" ? (
            <V2DoubleRegistrationForm matchId={match.id} mode="cancel" />
          ) : (
            <p className="text-sm text-slate-300">{viewer.message}</p>
          )}
          <p className="text-xs text-slate-400">
            两人组队完成报名后，双方获得相应报名积分。
          </p>
        </div>
      </section>

      {showTeamBuilder ? (
        <section className="space-y-4 rounded-2xl border border-slate-700 bg-slate-900/80 p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-white">双打组队</h2>
              <p className="mt-1 text-xs text-slate-400">
                邀请被接受后只形成小队来源；仍需由任一伙伴点击“小队报名”。
              </p>
            </div>
            <Link
              href="/team-invites"
              className="text-xs text-cyan-300 hover:text-cyan-200"
            >
              查看全部邀请 →
            </Link>
          </div>

          <form action={`/matchs/${match.id}`} method="get" className="flex flex-col gap-2 sm:flex-row">
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
                      <p className="text-sm text-slate-100">{candidate.nickname}</p>
                      <p className="text-xs text-slate-400">{candidate.email}</p>
                    </div>
                    <form action={sendDoublesInviteAction.bind(null, match.id)}>
                      <input type="hidden" name="csrfToken" defaultValue="" />
                      <input type="hidden" name="inviteeId" value={candidate.id} />
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


      {canManageGrouping && match.status !== "finished" ? (
        <div className="flex justify-end">
          <Link
            href={`/matchs/${match.id}/grouping`}
            className="rounded-lg border border-cyan-500/40 px-3 py-1.5 text-sm text-cyan-200 hover:bg-cyan-500/10"
          >
            {model.grouping.published ? "查看阶段管理" : "生成分组"}
          </Link>
        </div>
      ) : null}

      <V2CompetitionPhases
        grouping={model.grouping}
        competitionType="double"
        currentUserId={currentUserId}
        isManager={canManageGrouping}
        canReplaceRoster={isAdmin}
      />

      <details className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4 sm:p-6">
        <summary className="cursor-pointer text-lg font-bold text-white">
          已报名小队（{model.activeEntries.length}）
        </summary>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {model.activeEntries.length === 0 ? (
            <p className="text-sm text-slate-400">当前没有有效报名。</p>
          ) : (
            model.activeEntries.map((entry, index) => (
              <div key={entry.entryId} className="rounded-lg border border-slate-700 p-3">
                <p className="text-sm font-semibold text-cyan-100">
                  {index + 1}. {entry.frozenDisplayName}
                </p>
                <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-300">
                  {entry.members.map((member) => (
                    <Link key={member.userId} href={`/profile/${member.userId}`}>
                      {member.frozenDisplayName}
                    </Link>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </details>

      {certificate ? (
        <ExportCertificateSection
          matchId={match.id}
          matchTitle={match.title}
          {...certificate}
        />
      ) : null}
    </div>
  );
}
