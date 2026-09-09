import { Calendar, MapPin, Users } from "lucide-react";
import Link from "next/link";

import TeamRegistrationPanel from "@/components/match/TeamRegistrationPanel";
import V2CompetitionPhases from "@/components/match/v2/V2CompetitionPhases";
import ExportCertificateSection from "@/components/match/detail/ExportCertificateSection";
import BackLinkButton from "@/components/navigation/BackLinkButton";
import { formatV2CompetitionDateTime } from "@/modules/competitions-v2/competition-time";
import type { V2TeamRegistrationReadState } from "@/modules/competitions-v2/read-model/team-registration";
import type { V2CertificateSectionState } from "@/modules/competitions-v2/read-model/single-certificate";

type TeamState = Extract<
  V2TeamRegistrationReadState,
  { kind: "TEAM_V2_REGISTRATION" }
>;

export default function V2TeamMatchDetail({
  model,
  currentUserId,
  currentUserRole,
  canManageGrouping,
  certificate,
}: Readonly<{
  model: TeamState;
  currentUserId: string | null;
  currentUserRole: "user" | "admin" | null;
  canManageGrouping: boolean;
  certificate: V2CertificateSectionState | null;
}>) {
  const { match, grouping } = model;
  const teams = model.teams.map((team) => ({
    id: team.id,
    name: team.name,
    inviteCode: team.inviteCode,
    captainId: team.captainId,
    captainNickname: team.captainNickname,
    contact: team.contact,
    remark: team.remark,
    reviewNote: team.reviewNote,
    status: team.entry?.status === "WITHDRAWN" || team.entry?.status === "DISQUALIFIED" ? "cancelled" as const : team.status,
    submittedAt: team.submittedAt,
    reviewedAt: team.reviewedAt,
    createdAt: team.createdAt,
    members: team.members.map((member) => ({
      userId: member.userId,
      nickname: member.nickname,
      avatarUrl: member.avatarUrl,
      joinedAt: member.joinedAt,
    })),
  }));

  return (
    <div className="mx-auto max-w-5xl space-y-5 sm:space-y-8">
      <BackLinkButton fallbackHref="/matchs" />

      <section className="surface-panel relative overflow-hidden rounded-3xl p-4 sm:p-6 md:p-8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_88%_6%,rgba(45,212,191,0.1),transparent_36%)]" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
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
                团体
                {match.format === "group_then_knockout" ? "小组 + 淘汰赛" : "纯小组赛"}
              </span>
              <span className="rounded-full bg-white/[0.045] px-3 py-1 ring-1 ring-white/8">
                {match.teamMinMembers}-{match.teamMaxMembers} 人/队
              </span>
              <span className="rounded-full bg-white/[0.045] px-3 py-1 ring-1 ring-white/8">
                报名截止：
                {formatV2CompetitionDateTime(match.registrationDeadline)}（北京时间）
              </span>
            </div>
          </div>
          {canManageGrouping ? (
            <Link
              href={`/matchs/${match.id}/grouping`}
              className="btn-secondary relative inline-flex shrink-0 items-center justify-center rounded-2xl px-4 py-2 text-sm font-bold"
            >
              {grouping.published ? "查看分组" : "管理分组"}
            </Link>
          ) : null}
        </div>

        <div className="relative mt-5 grid gap-3 text-slate-200 sm:grid-cols-3">
          <div className="flex items-center gap-3 rounded-2xl bg-slate-950/34 p-3 ring-1 ring-white/8">
            <Calendar className="h-5 w-5 text-teal-200" />
            <div>
              <p className="text-xs text-slate-400">时间</p>
              <p>{formatV2CompetitionDateTime(match.dateTime)}（北京时间）</p>
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
      </section>

      {!grouping.published ? (<>      <TeamRegistrationPanel
        matchId={match.id}
        currentUserId={currentUserId}
        isAdmin={currentUserRole === "admin"}
        registrationOpen={model.registration.open}
        registrationNotStarted={model.registration.notStarted}
        registrationClosed={model.registration.closed}
        startsAt={match.registrationStartsAt}
        deadline={match.registrationDeadline}
        minMembers={match.teamMinMembers}
        maxMembers={match.teamMaxMembers}
        teams={teams}
        allowCancellation={!grouping.published}
        captainCancellationOpen={!grouping.published}
      />

</>) : null}
      <V2CompetitionPhases
        grouping={grouping}
        competitionType="team"
        currentUserId={currentUserId}
        isManager={canManageGrouping}
        canReplaceRoster={currentUserRole === "admin"}
      />

      {grouping.published ? <details className="surface-panel rounded-2xl p-4 sm:p-6"><summary className="cursor-pointer font-semibold text-slate-100">参赛队伍与成员</summary><div className="mt-4">      <TeamRegistrationPanel
        matchId={match.id}
        currentUserId={currentUserId}
        isAdmin={currentUserRole === "admin"}
        registrationOpen={model.registration.open}
        registrationNotStarted={model.registration.notStarted}
        registrationClosed={model.registration.closed}
        startsAt={match.registrationStartsAt}
        deadline={match.registrationDeadline}
        minMembers={match.teamMinMembers}
        maxMembers={match.teamMaxMembers}
        teams={teams}
        allowCancellation={!grouping.published}
        captainCancellationOpen={!grouping.published}
      />

</div></details> : null}
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
