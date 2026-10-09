import TeamRegistrationPanel from "@/components/match/TeamRegistrationPanel";
import V2CompetitionPhases from "@/components/match/v2/V2CompetitionPhases";
import ExportCertificateSection from "@/components/match/detail/ExportCertificateSection";
import BackLinkButton from "@/components/navigation/BackLinkButton";
import type { ComponentProps } from "react";
import MatchDetailHeader from "@/components/match/detail/MatchDetailHeader";
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
    status:
      team.entry?.status === "WITHDRAWN" ||
      team.entry?.status === "DISQUALIFIED"
        ? ("cancelled" as const)
        : team.status,
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

  const registrationProps: ComponentProps<typeof TeamRegistrationPanel> = {
    matchId: match.id,
    currentUserId,
    isAdmin: currentUserRole === "admin",
    registrationOpen: model.registration.open,
    registrationNotStarted: model.registration.notStarted,
    registrationClosed: model.registration.closed,
    startsAt: match.registrationStartsAt,
    deadline: match.registrationDeadline,
    minMembers: match.teamMinMembers,
    maxMembers: match.teamMaxMembers,
    teams,
    allowCancellation: !grouping.published,
    captainCancellationOpen: !grouping.published,
  };
  return (
    <div className="mx-auto max-w-6xl space-y-6 pb-6">
      <BackLinkButton fallbackHref="/matchs" />
      <MatchDetailHeader
        match={match}
        typeLabel="团体"
        participantLabel={`${model.activeEntryCount} 队 · ${model.activeMemberCount} 人报名`}
        teamSizeLabel={`${match.teamMinMembers}–${match.teamMaxMembers} 人 / 队`}
      />
      <V2CompetitionPhases
        grouping={grouping}
        competitionType="team"
        currentUserId={currentUserId}
        isManager={canManageGrouping}
        canReplaceRoster={currentUserRole === "admin"}
        canFinishMatch={currentUserRole === "admin"}
        registrationContent={
          !grouping.published ? (
            <TeamRegistrationPanel
              {...registrationProps}
              displayMode="registration"
            />
          ) : undefined
        }
        rosterContent={
          <TeamRegistrationPanel {...registrationProps} displayMode="roster" />
        }
        managementContent={
          currentUserRole === "admin" ? (
            <TeamRegistrationPanel
              {...registrationProps}
              displayMode="management"
            />
          ) : undefined
        }
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
