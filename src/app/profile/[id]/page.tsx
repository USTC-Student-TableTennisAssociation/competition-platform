import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { toClubId } from "@/lib/club-id";
import BackLinkButton from "@/components/navigation/BackLinkButton";
import ProfileOverview from "@/components/auth/ProfileOverview";

export default async function PublicProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const currentUser = await getCurrentUser();

  if (currentUser?.id === id) {
    redirect("/profile");
  }

  const user = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      nickname: true,
      bio: true,
      avatarUrl: true,
      points: true,
      eloRating: true,
      wins: true,
      losses: true,
    },
  });

  if (!user) {
    notFound();
  }

  const [eloHistory, recentResults, badgeRows] = await Promise.all([
    prisma.eloHistory.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
      take: 20,
      select: { eloAfter: true, createdAt: true },
    }),
    prisma.matchResult.findMany({
      where: {
        confirmed: true,
        OR: [
          { winnerTeamIds: { has: user.id } },
          { loserTeamIds: { has: user.id } },
        ],
      },
      include: {
        match: {
          select: {
            id: true,
            title: true,
            dateTime: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.userBadge.findMany({
      where: { userId: user.id },
      include: {
        badge: {
          select: {
            id: true,
            title: true,
            description: true,
            iconUrl: true,
          },
        },
      },
      orderBy: { awardedAt: "desc" },
      take: 12,
    }),
  ]);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <BackLinkButton fallbackHref="/rankings" />
      <h1 className="text-3xl font-bold text-white">选手档案</h1>

      <ProfileOverview
        user={{
          id: user.id,
          nickname: user.nickname,
          bio: user.bio,
          avatarUrl: user.avatarUrl,
          points: user.points,
          eloRating: user.eloRating,
          wins: user.wins,
          losses: user.losses,
        }}
        clubId={toClubId(user.id)}
        eloPoints={eloHistory.map((item) => ({
          eloAfter: item.eloAfter,
          createdAt: item.createdAt.toISOString(),
        }))}
        recentResults={recentResults.map((item) => ({
          id: item.id,
          matchId: item.match.id,
          matchTitle: item.match.title,
          matchDate: item.match.dateTime.toISOString(),
          isWin: item.winnerTeamIds.includes(user.id),
          scoreText:
            typeof item.score === "object" && item.score && "text" in item.score
              ? String(item.score.text ?? "")
              : typeof item.score === "string"
                ? item.score
                : "",
        }))}
        badges={badgeRows.map((item) => ({
          id: item.badge.id,
          title: item.badge.title,
          description: item.badge.description,
          iconUrl: item.badge.iconUrl,
          awardedAt: item.awardedAt.toISOString(),
        }))}
        showEdit={false}
      />
    </div>
  );
}
