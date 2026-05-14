type PageParam = string | string[] | undefined;

export function extractPageParam(value: PageParam) {
  return Array.isArray(value) ? value[0] : value;
}

export function paginateItems<T>(
  items: T[],
  rawPage: string | undefined,
  perPage: number,
) {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const parsedPage = Number(rawPage);
  const currentPage =
    Number.isFinite(parsedPage) && parsedPage > 0
      ? Math.min(parsedPage, totalPages)
      : 1;
  const startIndex = (currentPage - 1) * perPage;

  return {
    perPage,
    totalPages,
    currentPage,
    startIndex,
    pagedItems: items.slice(startIndex, startIndex + perPage),
    pages: Array.from({ length: totalPages }, (_, index) => index + 1),
    shouldOpen: Boolean(rawPage),
    preservedPage: Boolean(rawPage) ? currentPage : undefined,
  };
}

export function buildAdminPendingResults(params: {
  results: Array<{
    id: string;
    confirmed: boolean;
    winnerTeamIds: string[];
    loserTeamIds: string[];
    score: unknown;
    reporter: { nickname: string };
  }>;
  registrations: Array<{ userId: string; user: { nickname: string } }>;
}) {
  const { results, registrations } = params;

  return results
    .filter((result) => !result.confirmed)
    .map((result) => {
      const winnerLabel = result.winnerTeamIds
        .map(
          (uid) =>
            registrations.find((registration) => registration.userId === uid)
              ?.user.nickname ?? uid,
        )
        .join(" / ");
      const loserLabel = result.loserTeamIds
        .map(
          (uid) =>
            registrations.find((registration) => registration.userId === uid)
              ?.user.nickname ?? uid,
        )
        .join(" / ");

      return {
        id: result.id,
        reporterName: result.reporter.nickname,
        winnerLabel,
        loserLabel,
        scoreText:
          typeof result.score === "object" &&
          result.score &&
          "text" in result.score
            ? String(result.score.text ?? "")
            : "",
        phaseLabel:
          typeof result.score === "object" &&
          result.score &&
          "phase" in result.score
            ? String(result.score.phase ?? "")
            : "",
        groupName:
          typeof result.score === "object" &&
          result.score &&
          "groupName" in result.score
            ? String(result.score.groupName ?? "")
            : "",
        knockoutRound:
          typeof result.score === "object" &&
          result.score &&
          "knockoutRound" in result.score
            ? String(result.score.knockoutRound ?? "")
            : "",
      };
    });
}

export function buildInitialAdminFormContext(params: {
  currentUser: { id: string; role: string } | null;
  createdBy: string;
  results: Array<{
    reporter: { id: string };
    winnerTeamIds: string[];
    loserTeamIds: string[];
    score: unknown;
  }>;
}) {
  const { currentUser, createdBy, results } = params;

  const latestAdminResultContext =
    currentUser && (currentUser.role === "admin" || currentUser.id === createdBy)
      ? results.find((result) => {
          if (result.reporter.id !== currentUser.id) return false;
          return (
            typeof result.score === "object" &&
            result.score !== null &&
            "phase" in result.score
          );
        })
      : null;

  const initialAdminPhase =
    latestAdminResultContext &&
    typeof latestAdminResultContext.score === "object" &&
    latestAdminResultContext.score &&
    "phase" in latestAdminResultContext.score
      ? (String(latestAdminResultContext.score.phase ?? "") as
          | "group"
          | "knockout")
      : undefined;

  const initialAdminGroupName =
    latestAdminResultContext &&
    typeof latestAdminResultContext.score === "object" &&
    latestAdminResultContext.score &&
    "groupName" in latestAdminResultContext.score
      ? String(latestAdminResultContext.score.groupName ?? "")
      : undefined;

  const initialAdminRoundName =
    latestAdminResultContext &&
    typeof latestAdminResultContext.score === "object" &&
    latestAdminResultContext.score &&
    "knockoutRound" in latestAdminResultContext.score
      ? String(latestAdminResultContext.score.knockoutRound ?? "")
      : undefined;

  return {
    initialAdminPhase,
    initialAdminGroupName,
    initialAdminRoundName,
    initialAdminWinnerId: latestAdminResultContext?.winnerTeamIds?.[0],
    initialAdminLoserId: latestAdminResultContext?.loserTeamIds?.[0],
  };
}
