import { expireOpenMatchPosts } from "@/app/match-posts/actions";
import type { FreeMatchPostItem } from "@/components/home/FreeMatchHall";
import PersonalHome, { type HomeOpenMatch } from "@/components/home/PersonalHome";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeAvatarUrl } from "@/lib/utils";
import { getHomeUserCompetitionProjection, type HomeUserCompetitionProjection } from "@/modules/competitions-v2/read-model/home-user-competition";
import { resolveMatchListRegistrationSummary } from "@/modules/competitions-v2/read-model/match-list-registration";
import { MatchApplicationStatus, MatchPostStatus, MatchStatus } from "@prisma/client";

export default async function Home() {
  const currentUser = await getCurrentUser();
  const openRegistrationUserId = currentUser?.id ?? "__guest__";
  const now = new Date();

  await expireOpenMatchPosts();

  const [
    openMatches,
    freeMatchPosts,
    competitionProjection,
    rankedPlayers,
    eloHistories,
  ] = await Promise.all([
    prisma.match.findMany({
      where: {
        isQuickMatch: false,
        engineVersion: "V2",
        entries: {
          none: {
            status: "ACTIVE",
            members: { some: { userId: openRegistrationUserId, status: "ACTIVE", effectiveUntil: null } },
          },
        },
        status: MatchStatus.registration,
        registrationDeadline: { gt: now },
      },
      orderBy: [{ registrationDeadline: "asc" }, { dateTime: "asc" }],
      take: 3,
      include: {
        _count: {
          select: {
            registrations: { where: { user: { isBanned: false } } },
            entries: {
              where: { status: "ACTIVE" },
            },
          },
        },
        registrations: {
          where: { userId: openRegistrationUserId },
          select: { id: true },
        },
        entries: {
          where: {
            status: "ACTIVE",
            members: {
              some: {
                userId: openRegistrationUserId,
                status: "ACTIVE",
                effectiveUntil: null,
              },
            },
          },
          select: { id: true, kind: true },
          take: 2,
        },
      },
    }),
    prisma.matchPost.findMany({
      where: {
        status: MatchPostStatus.OPEN,
        playAt: { gt: now },
        creator: { isBanned: false },
      },
      orderBy: { playAt: "asc" },
      take: 6,
      include: {
        creator: {
          select: {
            id: true,
            nickname: true,
            avatarUrl: true,
            eloRating: true,
          },
        },
        applications: {
          where: currentUser
            ? {
                applicant: { isBanned: false },
                OR: [
                  { status: MatchApplicationStatus.PENDING },
                  { applicantId: currentUser.id },
                ],
              }
            : {
                status: MatchApplicationStatus.PENDING,
                applicant: { isBanned: false },
              },
          orderBy: { createdAt: "asc" },
          include: {
            applicant: {
              select: {
                id: true,
                nickname: true,
                avatarUrl: true,
                eloRating: true,
              },
            },
          },
        },
      },
    }),
    currentUser
      ? getHomeUserCompetitionProjection(prisma, currentUser.id)
      : Promise.resolve({
          myMatches: [],
          recentResults: [],
          pendingResultCount: 0,
          legacyMatchesToFinish: [],
        } satisfies HomeUserCompetitionProjection),
    prisma.user.findMany({
      where: { isBanned: false },
      orderBy: [{ eloRating: "desc" }, { points: "desc" }, { id: "asc" }],
      select: { id: true, nickname: true, eloRating: true, points: true },
    }),
    currentUser
      ? prisma.eloHistory.findMany({
          where: { userId: currentUser.id },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 20,
          select: { eloBefore: true, eloAfter: true, createdAt: true },
        })
      : Promise.resolve([]),
  ]);

  // Equal ELO and points share a rank; stable IDs only order the display.
  const ranked: Array<(typeof rankedPlayers)[number] & { rank: number }> = [];
  for (const [index, player] of rankedPlayers.entries()) {
    const previous = ranked[index - 1];
    const sharedRank = previous && previous.eloRating === player.eloRating && previous.points === player.points;
    ranked.push({ ...player, rank: sharedRank ? previous.rank : index + 1 });
  }
  const myIndex = currentUser ? ranked.findIndex(player => player.id === currentUser.id) : -1;
  const myRank = myIndex < 0 ? null : ranked[myIndex].rank;
  const rankStart = myIndex < 0 ? 0 : Math.max(0, Math.min(myIndex - 1, ranked.length - 3));
  const nearbyPlayers = ranked.slice(rankStart, rankStart + 3);

  const openMatchItems: HomeOpenMatch[] = openMatches.map((match) => {
    const registrationSummary = resolveMatchListRegistrationSummary({
      engineVersion: match.engineVersion,
      isQuickMatch: match.isQuickMatch,
      type: match.type,
      format: match.format,
      legacyParticipantCount: match._count.registrations,
      legacyCurrentUserRegistered: match.registrations.length > 0,
      activeEntryCount: match._count.entries,
      currentUserActiveEntryKinds: match.entries.map((entry) => entry.kind),
    });

    return {
      id: match.id,
      title: match.title,
      type: match.type,
      dateTime: match.dateTime,
      deadline: match.registrationDeadline,
      location: match.location ?? "待定",
      participants: registrationSummary.participants,
      participantUnit: registrationSummary.participantUnit,
      maxParticipants: match.maxParticipants,
      isRegistered: registrationSummary.isCurrentUserRegistered,
    };
  });

  const freeMatchItems: FreeMatchPostItem[] = freeMatchPosts.map((post) => {
    const currentUserApplication =
      currentUser
        ? post.applications.find(
            (application) => application.applicantId === currentUser.id,
          )
        : null;
    const isCreator = currentUser?.id === post.creatorId;

    return {
      id: post.id,
      description: post.description,
      playAt: post.playAt.toISOString(),
      durationMinutes: post.durationMinutes,
      location: post.location,
      minElo: post.minElo,
      maxElo: post.maxElo,
      isRatedPreferred: post.isRatedPreferred,
      creator: {
        ...post.creator,
        avatarUrl: normalizeAvatarUrl(post.creator.avatarUrl),
      },
      applications: isCreator
        ? post.applications
            .filter(
              (application) =>
                application.status === MatchApplicationStatus.PENDING,
            )
            .map((application) => ({
              id: application.id,
              message: application.message,
              createdAt: application.createdAt.toISOString(),
              applicant: {
                ...application.applicant,
                avatarUrl: normalizeAvatarUrl(application.applicant.avatarUrl),
              },
            }))
        : [],
      currentUserApplicationStatus: currentUserApplication?.status ?? null,
    };
  });

  const eloPoints = [...eloHistories].reverse().map(item => ({
    elo: item.eloAfter,
    createdAt: item.createdAt.toISOString(),
  }));
  const firstHistory = eloHistories.at(-1);
  const latestHistory = eloHistories[0];
  const eloChange = firstHistory && latestHistory
    ? latestHistory.eloAfter - firstHistory.eloBefore
    : null;

  return (
    <PersonalHome
      user={currentUser}
      rank={myRank}
      nearbyPlayers={nearbyPlayers}
      competition={competitionProjection}
      matches={openMatchItems}
      posts={freeMatchItems}
      eloPoints={eloPoints}
      eloChange={eloChange}
    />
  );
}
