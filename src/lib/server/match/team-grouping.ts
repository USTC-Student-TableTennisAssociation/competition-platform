import { TeamRegistrationStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type TeamGroupingPlayer = {
  id: string;
  nickname: string;
  points: number;
  eloRating: number;
};

export type TeamGroupingPayloadLike = {
  competitorType?: "user" | "team";
  groups: Array<{
    name: string;
    averagePoints: number;
    players: TeamGroupingPlayer[];
  }>;
};

type CurrentTeamCompetitor = {
  id: string;
  name: string;
  points?: number;
  eloRating?: number;
};

type TeamResultLike = {
  winnerMatchTeamId?: string | null;
  loserMatchTeamId?: string | null;
  score: unknown;
};

export function reconcileTeamResultCompetitorIds<T extends TeamResultLike>(
  results: T[],
  teams: CurrentTeamCompetitor[],
) {
  const teamIds = new Set(teams.map((team) => team.id));
  const teamsByName = new Map<string, CurrentTeamCompetitor[]>();
  for (const team of teams) {
    const sameName = teamsByName.get(team.name) ?? [];
    sameName.push(team);
    teamsByName.set(team.name, sameName);
  }

  const resolveByName = (score: unknown, field: "winnerTeamName" | "loserTeamName") => {
    if (!score || typeof score !== "object") return null;
    const name = (score as Record<string, unknown>)[field];
    if (typeof name !== "string") return null;
    const matches = teamsByName.get(name) ?? [];
    return matches.length === 1 ? matches[0].id : null;
  };

  return results.map((result) => ({
    ...result,
    winnerMatchTeamId:
      result.winnerMatchTeamId && teamIds.has(result.winnerMatchTeamId)
        ? result.winnerMatchTeamId
        : resolveByName(result.score, "winnerTeamName"),
    loserMatchTeamId:
      result.loserMatchTeamId && teamIds.has(result.loserMatchTeamId)
        ? result.loserMatchTeamId
        : resolveByName(result.score, "loserTeamName"),
  }));
}

export function reconcileTeamGroupingPayload<
  T extends TeamGroupingPayloadLike,
>(payload: T, teams: CurrentTeamCompetitor[]) {
  const teamsById = new Map(teams.map((team) => [team.id, team]));
  const teamsByName = new Map<string, CurrentTeamCompetitor[]>();

  for (const team of teams) {
    const sameName = teamsByName.get(team.name) ?? [];
    sameName.push(team);
    teamsByName.set(team.name, sameName);
  }

  const unresolvedIds: string[] = [];
  let changed = false;
  const groups = payload.groups.map((group) => ({
    ...group,
    players: group.players.flatMap((player) => {
      const exact = teamsById.get(player.id);
      const sameName = teamsByName.get(player.nickname) ?? [];
      const resolved = exact ?? (sameName.length === 1 ? sameName[0] : null);

      if (!resolved) {
        unresolvedIds.push(player.id);
        return [];
      }

      if (resolved.id !== player.id) changed = true;
      return [{
        ...player,
        id: resolved.id,
        nickname: resolved.name,
        points: resolved.points ?? player.points,
        eloRating: resolved.eloRating ?? player.eloRating,
      }];
    }),
  }));

  return {
    payload: changed || unresolvedIds.length > 0 ? { ...payload, groups } : payload,
    changed,
    unresolvedIds,
  };
}

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
