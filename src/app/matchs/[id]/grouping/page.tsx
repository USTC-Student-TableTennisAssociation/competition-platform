import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import GroupingAdminPanel from "@/components/match/GroupingAdminPanel";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { generateGroupingPayload } from "@/lib/tournament";

export default async function MatchGroupingManagePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [match, currentUser] = await Promise.all([
    prisma.match.findUnique({
      where: { id },
      include: {
        registrations: {
          include: {
            user: {
              select: {
                id: true,
                nickname: true,
                eloRating: true,
                points: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        groupingResult: true,
      },
    }),
    getCurrentUser(),
  ]);

  if (!match) notFound();

  const now = new Date();
  const isCreator = currentUser?.id === match.createdBy;
  const isAdmin = currentUser?.role === "admin";
  const canManageGrouping = Boolean(currentUser && (isCreator || isAdmin));

  if (!canManageGrouping) notFound();

  const groupingPayload = (match.groupingResult?.payload ?? null) as {
    config?: {
      groupCount?: number;
      qualifiersPerGroup?: number;
      seedMethod?: "min_diff" | "snake";
    };
    groups: Array<{
      name: string;
      averagePoints: number;
      players: Array<{
        id: string;
        nickname: string;
        points: number;
        eloRating: number;
      }>;
    }>;
    knockout?: {
      stage: string;
      bracketSize: number;
      rounds: Array<{
        name: string;
        matches: Array<{ id: string; homeLabel: string; awayLabel: string }>;
      }>;
    };
  } | null;

  const defaultGroupCount = Math.max(
    1,
    Math.min(
      8,
      Math.ceil(
        match.registrations.length / (match.format === "group_only" ? 6 : 4),
      ),
    ),
  );

  const fallbackGroupingPayload =
    !groupingPayload &&
    now >= match.registrationDeadline &&
    match.registrations.length >= 2
      ? (() => {
          try {
            return generateGroupingPayload(
              match.format,
              match.registrations.map((item) => ({
                id: item.user.id,
                nickname: item.user.nickname,
                points: item.user.points,
                eloRating: item.user.eloRating,
              })),
              {
                groupCount: defaultGroupCount,
                qualifiersPerGroup:
                  match.format === "group_then_knockout" ? 2 : undefined,
                seedMethod: "min_diff",
              },
            );
          } catch {
            return null;
          }
        })()
      : null;

  const initialGroupCount =
    groupingPayload?.config?.groupCount ??
    fallbackGroupingPayload?.config?.groupCount ??
    defaultGroupCount;
  const initialQualifiersPerGroup =
    groupingPayload?.config?.qualifiersPerGroup ??
    fallbackGroupingPayload?.config?.qualifiersPerGroup ??
    (match.format === "group_then_knockout" ? 2 : 1);

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <Link
        href={`/matchs/${match.id}`}
        className="inline-flex items-center gap-2 text-slate-400 hover:text-slate-200"
      >
        <ArrowLeft className="h-4 w-4" />
        返回比赛详情
      </Link>

      <GroupingAdminPanel
        matchId={match.id}
        initialPayloadJson={
          groupingPayload
            ? JSON.stringify(groupingPayload)
            : fallbackGroupingPayload
              ? JSON.stringify(fallbackGroupingPayload)
              : undefined
        }
        collapsible={false}
        matchFormat={match.format}
        participantCount={match.registrations.length}
        defaultGroupCount={initialGroupCount}
        defaultQualifiersPerGroup={initialQualifiersPerGroup}
      />
    </div>
  );
}
