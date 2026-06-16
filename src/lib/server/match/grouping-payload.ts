import { Prisma } from "@prisma/client";

type GroupingPlayer = {
  id: string;
  eloRating?: number;
};

type GroupingPayload = {
  groups?: Array<{
    name?: string;
    averagePoints?: number;
    players: GroupingPlayer[];
  }>;
};

export function removeCompetitorsFromGroupingPayload(
  payload: Prisma.JsonValue,
  competitorIds: Set<string>,
) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const grouping = payload as GroupingPayload;
  if (!Array.isArray(grouping.groups)) return null;

  let changed = false;
  const groups = grouping.groups.map((group) => {
    if (!Array.isArray(group.players)) return group;
    const players = group.players.filter(
      (player) => !competitorIds.has(player.id),
    );
    if (players.length === group.players.length) return group;

    changed = true;
    const averagePoints =
      players.length > 0
        ? Math.round(
            players.reduce(
              (sum, player) => sum + (player.eloRating ?? 0),
              0,
            ) / players.length,
          )
        : 0;
    return { ...group, players, averagePoints };
  });

  if (!changed) return null;
  return { ...grouping, groups } as unknown as Prisma.InputJsonValue;
}
