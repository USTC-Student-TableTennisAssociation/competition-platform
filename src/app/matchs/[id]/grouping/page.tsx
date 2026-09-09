import V2DoubleGroupingPanel from "@/components/match/v2/V2DoubleGroupingPanel";
import V2SingleGroupingPanel from "@/components/match/v2/V2SingleGroupingPanel";
import V2TeamGroupingPanel from "@/components/match/v2/V2TeamGroupingPanel";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
getV2GroupOnlyGroupingReadModel,
V2_DOUBLE_GROUPING_READ_PROFILE,
V2_SINGLE_GROUPING_READ_PROFILE,
V2_TEAM_GROUPING_READ_PROFILE,
V2GroupOnlyGroupingReadIntegrityError,
} from "@/modules/competitions-v2/read-model/group-only-grouping";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

function BackToMatchLink({ matchId }: { matchId: string }) {
  return (
    <Link
      href={`/matchs/${matchId}`}
      className="inline-flex items-center gap-2 text-slate-400 hover:text-slate-200"
    >
      <ArrowLeft className="h-4 w-4" />
      返回比赛详情
    </Link>
  );
}

export default async function MatchGroupingManagePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const [engineDiscriminator, currentUser] = await Promise.all([
    prisma.match.findUnique({
      where: { id },
      select: {
        id: true,
        engineVersion: true,
        createdBy: true,
        type: true,
        format: true,
      },
    }),
    getCurrentUser(),
  ]);

  if (!engineDiscriminator) notFound();
  if (
    !currentUser ||
    (currentUser.id !== engineDiscriminator.createdBy &&
      currentUser.role !== "admin")
  ) {
    notFound();
  }

  if (engineDiscriminator.engineVersion === "V2") {
    const readProfile =
      engineDiscriminator.type === "single"
        ? V2_SINGLE_GROUPING_READ_PROFILE
        : engineDiscriminator.type === "double"
          ? V2_DOUBLE_GROUPING_READ_PROFILE
          : engineDiscriminator.type === "team"
            ? V2_TEAM_GROUPING_READ_PROFILE
            : null;
    if (!readProfile) notFound();

    let readModel;
    try {
      readModel = await getV2GroupOnlyGroupingReadModel(
        prisma,
        id,
        readProfile,
      );
    } catch (error) {
      if (error instanceof V2GroupOnlyGroupingReadIntegrityError) {
        console.error("V2 grouping read model integrity check failed", {
          matchId: error.matchId,
          entityId: error.entityId,
        });
        notFound();
      }
      throw error;
    }

    if (readModel.kind === "MATCH_NOT_FOUND") notFound();
    if (
      readModel.kind !== "GROUP_ONLY_V2_MATCH" &&
      readModel.kind !== "GROUP_THEN_KNOCKOUT_V2_MATCH"
    ) {
      notFound();
    }
    if (
      currentUser.id !== readModel.match.createdBy &&
      currentUser.role !== "admin"
    ) {
      notFound();
    }

    const activeEntries = readModel.activeEntries;
    const defaultGroupCount = Math.max(
      1,
      Math.min(
        8,
        Math.ceil(
          activeEntries.length /
            (readModel.match.format === "group_then_knockout" ? 4 : 6),
        ),
      ),
    );
    const published = readModel.published;
    const publishedGroups = readModel.groups.map((group) => ({
      groupKey: group.groupKey,
      label: group.displayName,
      tableLabels: group.tableLabels,
      expectedFixtures: group.fixtures.map((fixture) => ({
        fixtureId: fixture.fixtureId,
        version: fixture.fixtureVersion,
      })),
      competitorNames: group.entries.map((entry) => entry.frozenDisplayName),
    }));
    const canEditTableLabels = Boolean(
      readModel.match.groupingGeneratedAt !== null &&
        readModel.match.status === "ongoing" &&
        publishedGroups.length > 0 &&
        publishedGroups.every((group) => group.expectedFixtures.length > 0),
    );

    return (
      <div className="mx-auto max-w-5xl space-y-8">
        <BackToMatchLink matchId={readModel.match.id} />
        {readModel.match.type === "single" ? (
          <V2SingleGroupingPanel
            matchId={readModel.match.id}
            participantCount={activeEntries.length}
            defaultGroupCount={defaultGroupCount}
            format={readModel.match.format}
            defaultQualifiersPerGroup={
              readModel.kind === "GROUP_THEN_KNOCKOUT_V2_MATCH"
                ? (readModel.qualifiersPerGroup ?? 2)
                : undefined
            }
            published={published}
            managementState={
              readModel.kind === "GROUP_THEN_KNOCKOUT_V2_MATCH"
                ? readModel.managementState
                : undefined
            }
            knockoutSummary={
              readModel.kind === "GROUP_THEN_KNOCKOUT_V2_MATCH"
                ? readModel.knockout
                : null
            }
            canEditTableLabels={canEditTableLabels}
            publishedGroups={publishedGroups}
          />
        ) : readModel.match.type === "double" ? (
          <V2DoubleGroupingPanel
            matchId={readModel.match.id}
            participantCount={activeEntries.length}
            defaultGroupCount={defaultGroupCount}
            format={readModel.match.format}
            defaultQualifiersPerGroup={
              readModel.kind === "GROUP_THEN_KNOCKOUT_V2_MATCH"
                ? (readModel.qualifiersPerGroup ?? 2)
                : undefined
            }
            published={published}
            managementState={
              readModel.kind === "GROUP_THEN_KNOCKOUT_V2_MATCH"
                ? readModel.managementState
                : undefined
            }
            knockoutSummary={
              readModel.kind === "GROUP_THEN_KNOCKOUT_V2_MATCH"
                ? readModel.knockout
                : null
            }
            canEditTableLabels={canEditTableLabels}
            publishedGroups={publishedGroups}
          />
        ) : (
          <V2TeamGroupingPanel
            matchId={readModel.match.id}
            participantCount={activeEntries.length}
            defaultGroupCount={defaultGroupCount}
            format={readModel.match.format}
            defaultQualifiersPerGroup={
              readModel.kind === "GROUP_THEN_KNOCKOUT_V2_MATCH"
                ? (readModel.qualifiersPerGroup ?? 2)
                : undefined
            }
            published={published}
            managementState={
              readModel.kind === "GROUP_THEN_KNOCKOUT_V2_MATCH"
                ? readModel.managementState
                : undefined
            }
            knockoutSummary={
              readModel.kind === "GROUP_THEN_KNOCKOUT_V2_MATCH"
                ? readModel.knockout
                : null
            }
            canEditTableLabels={canEditTableLabels}
            publishedGroups={publishedGroups}
          />
        )}
      </div>
    );
  }

  redirect(`/matchs/${id}`);
}
