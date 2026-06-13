export type CompetitorType = "user" | "team";

export type CompetitorResult = {
  winnerTeamIds: string[];
  loserTeamIds: string[];
  winnerMatchTeamId?: string | null;
  loserMatchTeamId?: string | null;
};

export function getResultCompetitorIds(
  result: CompetitorResult,
  competitorType: CompetitorType,
) {
  if (competitorType === "team") {
    if (!result.winnerMatchTeamId || !result.loserMatchTeamId) return null;
    if (result.winnerMatchTeamId === result.loserMatchTeamId) return null;
    return {
      winnerId: result.winnerMatchTeamId,
      loserId: result.loserMatchTeamId,
    };
  }

  if (result.winnerTeamIds.length !== 1 || result.loserTeamIds.length !== 1) {
    return null;
  }
  if (result.winnerTeamIds[0] === result.loserTeamIds[0]) return null;
  return {
    winnerId: result.winnerTeamIds[0],
    loserId: result.loserTeamIds[0],
  };
}

export function resolveCompetitorType(value: unknown): CompetitorType {
  return value === "team" ? "team" : "user";
}

export type ResultPhase = "group" | "knockout";

export function getResultPhase(score: unknown): ResultPhase | null {
  if (!score || typeof score !== "object") return null;
  const phase = (score as { phase?: unknown }).phase;
  return phase === "group" || phase === "knockout" ? phase : null;
}

export function getResultGroupName(score: unknown) {
  if (!score || typeof score !== "object") return null;
  const groupName = (score as { groupName?: unknown }).groupName;
  return typeof groupName === "string" && groupName ? groupName : null;
}

export function getResultKnockoutMatchId(score: unknown) {
  if (!score || typeof score !== "object") return null;
  const matchId = (score as { knockoutMatchId?: unknown }).knockoutMatchId;
  return typeof matchId === "string" && matchId ? matchId : null;
}
