import ArchivedMatchDetail from "@/components/match/ArchivedMatchDetail";
import V2DoubleMatchDetail from "@/components/match/v2/V2DoubleMatchDetail";
import V2SingleMatchDetail from "@/components/match/v2/V2SingleMatchDetail";
import V2TeamMatchDetail from "@/components/match/v2/V2TeamMatchDetail";
import BackLinkButton from "@/components/navigation/BackLinkButton";
import { getCurrentUser } from "@/lib/auth";
import {
getPendingMatchInvitesForUser,
searchDoublesInviteCandidates
} from "@/lib/doubles";
import { prisma } from "@/lib/prisma";
import {
getV2CompetitionDetailReadModel,
type V2CompetitionDetailReadModel,
} from "@/modules/competitions-v2/read-model/competition-detail";
import {
V2DoubleRegistrationIntegrityError,
} from "@/modules/competitions-v2/read-model/double-registration";
import {
getV2CertificateReadState,
toV2CertificateSectionState,
type V2CertificateSectionState,
} from "@/modules/competitions-v2/read-model/single-certificate";
import { V2SingleReadModelIntegrityError } from "@/modules/competitions-v2/read-model/single-match";
import type { V2SingleViewer } from "@/modules/competitions-v2/read-model/single-match-view";
import {
V2TeamRegistrationIntegrityError,
} from "@/modules/competitions-v2/read-model/team-registration";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";



const ADMIN_MODE_COOKIE = "ustc_tta_admin_mode";

function MatchDetailUnavailable() {
  return (
    <div className="mx-auto max-w-5xl space-y-5 sm:space-y-8">
      <BackLinkButton fallbackHref="/matchs" />
      <section className="surface-panel rounded-3xl p-5 sm:p-8">
        <h1 className="text-xl font-bold text-white sm:text-2xl">
          比赛详情暂不可用
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-400">
          为避免读取或修改不一致的比赛数据，本页面已停止加载。请稍后重试或联系管理员。
        </p>
      </section>
    </div>
  );
}

type SingleV2DetailModel = Extract<
  V2CompetitionDetailReadModel,
  { kind: "SINGLE_V2_DETAIL" }
>["model"];
type DoubleV2DetailModel = Extract<
  V2CompetitionDetailReadModel,
  { kind: "DOUBLE_V2_DETAIL" }
>["model"];
type TeamV2DetailModel = Extract<
  V2CompetitionDetailReadModel,
  { kind: "TEAM_V2_DETAIL" }
>["model"];

async function renderV2SingleMatchDetail(
  model: SingleV2DetailModel,
  currentUser: Awaited<ReturnType<typeof getCurrentUser>>,
  certificate: V2CertificateSectionState | null,
) {
  const cookieStore = await cookies();
  const adminMode = cookieStore.get(ADMIN_MODE_COOKIE)?.value;
  const viewer: V2SingleViewer = currentUser
    ? {
        userId: currentUser.id,
        role:
          currentUser.role === "admin" && adminMode !== "user"
            ? "admin"
            : "user",
      }
    : null;

  return (
    <V2SingleMatchDetail
      model={model}
      currentUser={viewer}
      certificate={certificate}
    />
  );
}

async function renderV2DoubleMatchDetail(
  model: DoubleV2DetailModel,
  currentUser: Awaited<ReturnType<typeof getCurrentUser>>,
  inviteQuery: string,
  certificate: V2CertificateSectionState | null,
) {
  const canBuildTeam = currentUser && model.viewer.action === "FORM_TEAM";
  const [inviteCandidates, pendingInvites] = canBuildTeam
    ? await Promise.all([
        inviteQuery
          ? searchDoublesInviteCandidates(model.match.id, currentUser.id, inviteQuery)
          : [],
        getPendingMatchInvitesForUser(model.match.id, currentUser.id),
      ])
    : [[], []];

  return (
    <V2DoubleMatchDetail
      model={model}
      currentUserId={currentUser?.id ?? null}
      isAdmin={currentUser?.role === "admin"}
      inviteQuery={inviteQuery}
      inviteCandidates={inviteCandidates}
      pendingInvites={pendingInvites}
      canManageGrouping={Boolean(
        currentUser &&
          (currentUser.id === model.match.createdBy ||
            currentUser.role === "admin"),
      )}
      certificate={certificate}
    />
  );
}

async function renderV2TeamMatchDetail(
  model: TeamV2DetailModel,
  currentUser: Awaited<ReturnType<typeof getCurrentUser>>,
  certificate: V2CertificateSectionState | null,
) {
  return (
    <V2TeamMatchDetail
      model={model}
      currentUserId={currentUser?.id ?? null}
      currentUserRole={currentUser?.role ?? null}
      canManageGrouping={Boolean(
        currentUser &&
          (currentUser.id === model.match.createdBy ||
            currentUser.role === "admin"),
      )}
      certificate={certificate}
    />
  );
}

export default async function MatchDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{
    resultsPage?: string | string[];
    playersPage?: string | string[];
    groupsPage?: string | string[];
    inviteQ?: string | string[];
  }>;
}) {
  const { id } = await params;
  const authenticatedUser = await getCurrentUser();
  const adminMode = (await cookies()).get(ADMIN_MODE_COOKIE)?.value;
  const currentUser = authenticatedUser && adminMode === "user" ? { ...authenticatedUser, role: "user" as const } : authenticatedUser;
  let competitionDetail: V2CompetitionDetailReadModel;
  try {
    competitionDetail = await getV2CompetitionDetailReadModel(
      prisma,
      id,
      currentUser?.id ?? null,
    );
  } catch (error) {
    if (
      error instanceof V2SingleReadModelIntegrityError ||
      error instanceof V2DoubleRegistrationIntegrityError ||
      error instanceof V2TeamRegistrationIntegrityError
    ) {
      console.error("V2 competition detail integrity check failed", {
        matchId: error.matchId,
        entityId: error.entityId,
        errorName: error.name,
      });
      return <MatchDetailUnavailable />;
    }
    throw error;
  }
  if (competitionDetail.kind === "MATCH_NOT_FOUND") notFound();
  if (
    competitionDetail.kind === "SINGLE_V2_DETAIL" ||
    competitionDetail.kind === "DOUBLE_V2_DETAIL" ||
    competitionDetail.kind === "TEAM_V2_DETAIL"
  ) {
    const certificateState = currentUser
      ? await getV2CertificateReadState(prisma, id, currentUser.id)
      : null;
    if (certificateState?.kind === "MATCH_NOT_FOUND") notFound();
    const certificate = currentUser
      ? toV2CertificateSectionState(certificateState, currentUser.email)
      : null;
    if (competitionDetail.kind === "SINGLE_V2_DETAIL") {
      return renderV2SingleMatchDetail(
        competitionDetail.model,
        currentUser,
        certificate,
      );
    }
    if (competitionDetail.kind === "DOUBLE_V2_DETAIL") {
      const doubleSearchParams = searchParams ? await searchParams : undefined;
      const rawDoubleInviteQuery = Array.isArray(doubleSearchParams?.inviteQ)
        ? doubleSearchParams.inviteQ[0]
        : doubleSearchParams?.inviteQ;
      const inviteQ = (rawDoubleInviteQuery ?? "").trim().slice(0, 100);
      return renderV2DoubleMatchDetail(
        competitionDetail.model,
        currentUser,
        inviteQ,
        certificate,
      );
    }
    return renderV2TeamMatchDetail(
      competitionDetail.model,
      currentUser,
      certificate,
    );
  }
  if (competitionDetail.kind === "UNSUPPORTED_V2_MATCH") {
    return <MatchDetailUnavailable />;
  }

  const archiveParams = searchParams ? await searchParams : undefined;
  const rawPage = Array.isArray(archiveParams?.resultsPage) ? archiveParams.resultsPage[0] : archiveParams?.resultsPage;
  return <ArchivedMatchDetail matchId={id} page={Number(rawPage ?? 1)} />;
}
