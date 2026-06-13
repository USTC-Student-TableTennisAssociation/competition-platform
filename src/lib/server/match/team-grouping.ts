import { TeamRegistrationStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export async function getApprovedTeamGroupingCompetitors(matchId: string) {
  const teams = await prisma.matchTeam.findMany({
    where: {
      matchId,
      status: TeamRegistrationStatus.approved,
      captain: { isBanned: false },
      members: {
        some: {},
        none: { user: { isBanned: true } },
      },
    },
    include: {
      captain: {
        select: { id: true, nickname: true, isBanned: true },
      },
      members: {
        include: {
          user: {
            select: {
              id: true,
              nickname: true,
              eloRating: true,
              points: true,
              isBanned: true,
            },
          },
        },
        orderBy: { joinedAt: "asc" },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return teams.map((team) => {
    const memberCount = team.members.length;
    const eloRating = Math.round(
      team.members.reduce((sum, member) => sum + member.user.eloRating, 0) /
        memberCount,
    );
    const points = Math.round(
      team.members.reduce((sum, member) => sum + member.user.points, 0) /
        memberCount,
    );

    return {
      id: team.id,
      nickname: team.name,
      eloRating,
      points,
      captain: team.captain,
      members: team.members.map((member) => member.user),
    };
  });
}
