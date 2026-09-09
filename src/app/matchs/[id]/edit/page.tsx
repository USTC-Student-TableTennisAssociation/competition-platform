import V2SingleMatchSettingsForm from "@/components/match/v2/V2SingleMatchSettingsForm";
import { getCurrentUser } from "@/lib/auth";
import { isVenueOption } from "@/lib/locations";
import { prisma } from "@/lib/prisma";
import { V2_TEAM_MATCH_MEMBER_LIMITS } from "@/modules/competitions-v2/application/team-matches";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound,redirect } from "next/navigation";

function isSupportedV2MatchSettingsScope(
  type: string,
  format: string,
) {
  return (
    (type === "single" || type === "double" || type === "team") &&
    (format === "group_only" || format === "group_then_knockout")
  );
}

export default async function EditMatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [currentUser, matchDiscriminator] = await Promise.all([
    getCurrentUser(),
    prisma.match.findUnique({
      where: { id },
      select: {
        id: true,
        engineVersion: true,
        createdBy: true,
      },
    }),
  ]);

  if (!matchDiscriminator) notFound();
  if (!currentUser) redirect("/auth");
  if (currentUser.id !== matchDiscriminator.createdBy) redirect(`/matchs/${id}`);
  if (matchDiscriminator.engineVersion === "V2") {
    const match = await prisma.match.findUnique({
      where: { id, engineVersion: "V2" },
      select: {
        id: true,
        title: true,
        description: true,
        location: true,
        type: true,
        format: true,
        isQuickMatch: true,
        status: true,
        createdAt: true,
        dateTime: true,
        registrationDeadline: true,
        teamRegistrationStart: true,
        teamRegistrationDeadline: true,
        teamMinMembers: true,
        teamMaxMembers: true,
        groupingGeneratedAt: true,
        updatedAt: true,
        groupingResult: { select: { id: true } },
        _count: {
          select: {
            fixtures: true,
            matchGroups: true,
            qualificationSnapshots: true,
          },
        },
      },
    });
    const now = new Date();
    const hasValidTeamPolicy =
      match?.type !== "team" ||
      (match.teamRegistrationStart !== null &&
        match.teamRegistrationDeadline !== null &&
        match.teamMinMembers !== null &&
        match.teamMaxMembers !== null &&
        match.registrationDeadline.getTime() ===
          match.teamRegistrationDeadline.getTime() &&
        match.teamRegistrationStart.getTime() <
          match.teamRegistrationDeadline.getTime() &&
        match.teamMinMembers >= V2_TEAM_MATCH_MEMBER_LIMITS.minimum &&
        match.teamMaxMembers <= V2_TEAM_MATCH_MEMBER_LIMITS.maximum &&
        match.teamMaxMembers >= match.teamMinMembers);
    const authoritativeRegistrationDeadline =
      match?.type === "team"
        ? match.teamRegistrationDeadline
        : match?.registrationDeadline;
    if (
      !match ||
      match.isQuickMatch ||
      !isSupportedV2MatchSettingsScope(match.type, match.format) ||
      !hasValidTeamPolicy ||
      match.status !== "registration" ||
      now < match.createdAt ||
      authoritativeRegistrationDeadline === null ||
      authoritativeRegistrationDeadline === undefined ||
      now >= authoritativeRegistrationDeadline ||
      match.groupingGeneratedAt !== null ||
      match.groupingResult !== null ||
      match._count.fixtures > 0 ||
      match._count.matchGroups > 0 ||
      match._count.qualificationSnapshots > 0 ||
      !match.location ||
      !isVenueOption(match.location)
    ) {
      redirect(`/matchs/${id}`);
    }

    return (
      <div className="mx-auto max-w-3xl space-y-8">
        <Link
          href={`/matchs/${id}`}
          className="inline-flex items-center gap-2 text-slate-400 hover:text-slate-200"
        >
          <ArrowLeft className="h-4 w-4" />
          返回比赛详情
        </Link>

        <div className="rounded-2xl border border-slate-700 bg-slate-900/80 p-8">
          <h1 className="mb-2 text-2xl font-bold text-white">修改比赛基本信息</h1>
          <p className="mb-6 text-sm leading-6 text-slate-400">
            V2 比赛在报名期内、分组发布前可以修改基本信息和比赛时间。
          </p>
          <V2SingleMatchSettingsForm
            matchId={match.id}
            expectedUpdatedAt={match.updatedAt.toISOString()}
            initial={{
              title: match.title,
              description: match.description ?? "",
              location: match.location,
              dateTimeIso: match.dateTime.toISOString(),
              registrationDeadlineIso:
                authoritativeRegistrationDeadline.toISOString(),
            }}
          />
        </div>
      </div>
    );
  }

  redirect(`/matchs/${id}`);
}
