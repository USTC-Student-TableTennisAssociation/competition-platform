import { notFound, redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { toClubId } from "@/lib/club-id";
import BackLinkButton from "@/components/navigation/BackLinkButton";
import ProfileOverview from "@/components/auth/ProfileOverview";
import { getTermRegistrationCount } from "@/modules/competitions-v2/read-model/user-competition-history";

function getCurrentTermStart() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  if (month >= 8) return new Date(year, 8, 1);
  if (month >= 1) return new Date(year, 1, 1);
  return new Date(year - 1, 8, 1);
}

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

  const termStart = getCurrentTermStart();
  const [eloHistory, badgeRows, betterRankCount, termRegistrationCount] =
    await Promise.all([
    prisma.eloHistory.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
      take: 20,
      select: { eloAfter: true, createdAt: true },
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
    prisma.user.count({
      where: {
        isBanned: false,
        OR: [
          { eloRating: { gt: user.eloRating } },
          {
            eloRating: user.eloRating,
            points: { gt: user.points },
          },
        ],
      },
    }),
    getTermRegistrationCount(prisma, user.id, termStart),
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
        rank={betterRankCount + 1}
        termCount={termRegistrationCount}
        eloPoints={eloHistory.map((item) => ({
          eloAfter: item.eloAfter,
          createdAt: item.createdAt.toISOString(),
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
