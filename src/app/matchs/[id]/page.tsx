import { Calendar, MapPin, Users } from "lucide-react";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import RegisterMatchButton from "@/components/match/RegisterMatchButton";
import UnregisterMatchButton from "@/components/match/UnregisterMatchButton";
import AdminResultsSection from "@/components/match/detail/AdminResultsSection";
import GroupingResultSection from "@/components/match/detail/GroupingResultSection";
import GroupsOverviewSection from "@/components/match/detail/GroupsOverviewSection";
import MyProgressSection from "@/components/match/detail/MyProgressSection";
import RegisteredPlayersSection from "@/components/match/detail/RegisteredPlayersSection";
import ExportCertificateSection from "@/components/match/detail/ExportCertificateSection";
import BackLinkButton from "@/components/navigation/BackLinkButton";
import {
  getDoublesTeamForUser,
  getPendingMatchInvitesForUser,
  getRegisteredDoublesTeams,
  searchDoublesInviteCandidates,
} from "@/lib/doubles";
import {
  acceptDoublesInviteAction,
  revokeDoublesInviteAction,
  sendDoublesInviteAction,
} from "@/app/team-invites/actions";
import {
  buildAdminEligibleOptions,
  buildAdminGroupBattleTables,
  resolveFilledKnockoutRounds,
} from "@/lib/match-detail";
import {
  buildAdminPendingResults,
  buildInitialAdminFormContext,
  extractPageParam,
  paginateItems,
} from "@/lib/match-detail-page";
import { evaluateCertificateEligibility } from "@/lib/certificate";

const statusLabelMap = {
  registration: "报名中",
  ongoing: "进行中",
  finished: "已结束",
} as const;

const ADMIN_MODE_COOKIE = "ustc_tta_admin_mode";

export default async function MatchDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?:
    | {
        playersPage?: string | string[];
        groupsPage?: string | string[];
        inviteQ?: string | string[];
      }
    | Promise<{
        playersPage?: string | string[];
        groupsPage?: string | string[];
        inviteQ?: string | string[];
      }>;
}) {
  const { id } = await params;

  const resolvedSearchParams = searchParams
    ? await Promise.resolve(searchParams)
    : undefined;
  const rawPlayersPage = extractPageParam(resolvedSearchParams?.playersPage);
  const rawGroupsPage = extractPageParam(resolvedSearchParams?.groupsPage);
  const rawInviteQuery = Array.isArray(resolvedSearchParams?.inviteQ)
    ? resolvedSearchParams?.inviteQ[0]
    : resolvedSearchParams?.inviteQ;
  const inviteQ = (rawInviteQuery ?? "").trim();

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
                avatarUrl: true,
                eloRating: true,
                points: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
        groupingResult: true,
        results: {
          include: {
            reporter: { select: { id: true, nickname: true } },
          },
          orderBy: { createdAt: "desc" },
        },
      },
    }),
    getCurrentUser(),
  ]);

  if (!match) notFound();

  const cookieStore = await cookies();
  const adminMode = cookieStore.get(ADMIN_MODE_COOKIE)?.value;
  const adminViewEnabled = adminMode !== "user";

  const [userIdentity, existingCertificate] = currentUser
    ? await Promise.all([
        prisma.userIdentity.findUnique({
          where: { userId: currentUser.id },
        }),
        prisma.participationCertificate.findUnique({
          where: {
            matchId_userId: {
              matchId: match.id,
              userId: currentUser.id,
            },
          },
        }),
      ])
    : [null, null];

  const certificateEligibility = currentUser
    ? evaluateCertificateEligibility({
        match: {
          status: match.status,
          type: match.type,
          groupingResult: match.groupingResult,
          groupingGeneratedAt: match.groupingGeneratedAt,
          registrations: match.registrations,
          results: match.results,
        },
        currentUserId: currentUser.id,
      })
    : null;

  const now = new Date();
  const isCreator = currentUser?.id === match.createdBy;
  const isAdmin = currentUser?.role === "admin" && adminViewEnabled;
  const adminViewBlocked = currentUser?.role === "admin" && !adminViewEnabled;
  const canManageGrouping = Boolean(currentUser && isAdmin);
  const canRegister =
    Boolean(currentUser) &&
    match.status === "registration" &&
    now < match.registrationDeadline;
  const alreadyRegistered = Boolean(
    currentUser &&
    match.registrations.some(
      (r: { userId: string }) => r.userId === currentUser.id,
    ),
  );
  const isDoubleMatch = match.type === "double";

  const [
    myDoublesTeam,
    pendingDoublesInvites,
    doublesInviteCandidates,
    registeredDoublesTeams,
  ] =
    currentUser && isDoubleMatch
      ? await Promise.all([
          getDoublesTeamForUser(match.id, currentUser.id),
          getPendingMatchInvitesForUser(match.id, currentUser.id),
          inviteQ
            ? searchDoublesInviteCandidates(match.id, currentUser.id, inviteQ)
            : Promise.resolve([]),
          getRegisteredDoublesTeams(match.id),
        ])
      : [null, [], [], []];

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

  const filledKnockoutRounds = groupingPayload?.knockout
    ? resolveFilledKnockoutRounds({
        knockoutRounds: groupingPayload.knockout.rounds,
        groups: groupingPayload.groups,
        qualifiersPerGroup: groupingPayload.config?.qualifiersPerGroup ?? 1,
        results: match.results,
        groupingGeneratedAt: match.groupingGeneratedAt ?? null,
      })
    : null;

  const adminEligibleOptions =
    groupingPayload && match.type === "single"
      ? buildAdminEligibleOptions({
          groupingPayload,
          filledKnockoutRounds,
          results: match.results,
          groupingGeneratedAt: match.groupingGeneratedAt ?? null,
        })
      : null;

  const adminGroupBattleTables = groupingPayload
    ? buildAdminGroupBattleTables({
        groups: groupingPayload.groups,
        results: match.results,
      })
    : [];

  const participantsPagination = isDoubleMatch
    ? paginateItems(registeredDoublesTeams, rawPlayersPage, 12)
    : paginateItems(match.registrations, rawPlayersPage, 12);
  const totalParticipantsPages = participantsPagination.totalPages;
  const currentParticipantsPage = participantsPagination.currentPage;
  const participantsStartIndex = participantsPagination.startIndex;
  const pagedRegistrations = isDoubleMatch
    ? []
    : (participantsPagination.pagedItems as typeof match.registrations);
  const pagedDoublesTeams = isDoubleMatch
    ? (participantsPagination.pagedItems as typeof registeredDoublesTeams)
    : [];
  const participantsPages = participantsPagination.pages;
  const shouldOpenParticipants = participantsPagination.shouldOpen;
  const preservedPlayersPage = participantsPagination.preservedPage;

  const currentUserId = currentUser?.id ?? null;
  const myGroup =
    currentUserId && groupingPayload
      ? groupingPayload.groups.find((group) =>
          group.players.some((player) => player.id === currentUserId),
        )
      : null;

  const adminPendingResults = buildAdminPendingResults({
    results: match.results,
    registrations: match.registrations,
  });

  const {
    initialAdminPhase,
    initialAdminGroupName,
    initialAdminRoundName,
    initialAdminWinnerId,
    initialAdminLoserId,
  } = buildInitialAdminFormContext({
    currentUser,
    createdBy: match.createdBy,
    results: match.results,
  });

  const groupsPagination = paginateItems(
    groupingPayload?.groups ?? [],
    rawGroupsPage,
    6,
  );
  const totalGroupsPages = groupsPagination.totalPages;
  const currentGroupsPage = groupsPagination.currentPage;
  const pagedGroups = groupsPagination.pagedItems;
  const groupsPages = groupsPagination.pages;
  const shouldOpenGroups = groupsPagination.shouldOpen;
  const preservedGroupsPage = groupsPagination.preservedPage;

  const buildMatchHref = (options?: {
    playersPage?: number;
    groupsPage?: number;
    hash?: string;
  }) => {
    const params = new URLSearchParams();
    const nextPlayersPage = options?.playersPage;
    const nextGroupsPage = options?.groupsPage;

    if (nextPlayersPage && nextPlayersPage > 0) {
      params.set("playersPage", String(nextPlayersPage));
    }
    if (nextGroupsPage && nextGroupsPage > 0) {
      params.set("groupsPage", String(nextGroupsPage));
    }

    const queryString = params.toString();
    return `/matchs/${match.id}${queryString ? `?${queryString}` : ""}${options?.hash ?? ""}`;
  };

  const statusLabel =
    statusLabelMap[match.status as keyof typeof statusLabelMap] ?? "状态未知";

  return (
    <div className="mx-auto max-w-5xl space-y-5 sm:space-y-8">
      <BackLinkButton fallbackHref="/matchs" />

      <div className="rounded-2xl border border-slate-700 bg-slate-900/80 p-4 sm:p-6 md:p-8">
        <div className="mb-4 flex items-start justify-between gap-3 sm:mb-6 sm:gap-4">
          <div>
            <span className="rounded-full bg-cyan-500/20 px-2.5 py-1 text-xs font-medium text-cyan-100 sm:px-3 sm:text-sm">
              {statusLabel}
            </span>
            <h1 className="mt-2 text-2xl font-bold text-white sm:mt-3 sm:text-3xl">
              {match.title}
            </h1>
            <p className="mt-2 text-sm text-slate-300 sm:text-base">
              {match.description || "暂无描述"}
            </p>
            <p className="mt-2 text-xs text-slate-400 sm:text-sm">
              赛制：
              {match.format === "group_only"
                ? "分组比赛"
                : "前期分组后期淘汰赛"}
            </p>
            <p className="text-xs text-slate-400 sm:text-sm">
              报名截止：{match.registrationDeadline.toLocaleString("zh-CN")}
            </p>
            {(isCreator || isAdmin) &&
              now < match.registrationDeadline &&
              !adminViewBlocked && (
                <Link
                  href={`/matchs/${match.id}/edit`}
                  className="mt-3 inline-block rounded-lg border border-cyan-400/40 px-3 py-1.5 text-xs text-cyan-100 hover:bg-cyan-500/10"
                >
                  修改比赛
                </Link>
              )}
          </div>
        </div>

        <div className="grid gap-3 text-slate-200 sm:grid-cols-2 lg:grid-cols-3 sm:gap-4">
          <div className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-cyan-300" />
            <div>
              <p className="text-xs text-slate-400">时间</p>
              <p className="text-sm sm:text-base">
                {match.dateTime.toLocaleString("zh-CN")}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-cyan-300" />
            <div>
              <p className="text-xs text-slate-400">地点</p>
              <p className="text-sm sm:text-base">{match.location ?? "待定"}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Users className="h-5 w-5 text-cyan-300" />
            <div>
              <p className="text-xs text-slate-400">
                {isDoubleMatch ? "参赛小队" : "参赛人数"}
              </p>
              <p className="text-sm sm:text-base">
                {isDoubleMatch
                  ? `${Math.floor(match.registrations.length / 2)} 组`
                  : `${match.registrations.length} 人`}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-5 sm:mt-8">
          {!currentUser ? (
            <p className="text-sm text-slate-300">请先登录后报名。</p>
          ) : isCreator && !alreadyRegistered ? (
            <p className="text-sm text-slate-300">
              你是比赛发起人，当前尚未报名，可手动点击报名加入参赛名单。
            </p>
          ) : null}

          {currentUser &&
            (alreadyRegistered ? (
              now < match.registrationDeadline ? (
                <UnregisterMatchButton matchId={match.id} />
              ) : null
            ) : (
              <RegisterMatchButton
                matchId={match.id}
                submitText={isDoubleMatch ? "以小队报名" : "立即报名"}
                disabled={!canRegister || (isDoubleMatch && !myDoublesTeam)}
                disabledText={
                  now >= match.registrationDeadline
                    ? "报名已截止"
                    : isDoubleMatch && !myDoublesTeam
                      ? "请先完成双打组队"
                      : "当前不可报名"
                }
              />
            ))}

          {currentUser && isDoubleMatch && !alreadyRegistered ? (
            <div className="mt-4 space-y-4 rounded-xl border border-slate-700 bg-slate-900/60 p-3 sm:p-4">
              <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-3">
                <h3 className="text-sm font-semibold text-slate-100">
                  双打组队邀请
                </h3>
                <Link
                  href="/team-invites"
                  className="text-xs text-cyan-300 hover:text-cyan-200"
                >
                  查看全部邀请 →
                </Link>
              </div>

              {myDoublesTeam ? (
                <p className="text-sm text-emerald-200">
                  当前小队：{myDoublesTeam.members[0]?.nickname} +{" "}
                  {myDoublesTeam.members[1]?.nickname}
                </p>
              ) : (
                <p className="text-sm text-slate-300">
                  先邀请并接受队友后，才可进行双打报名。
                </p>
              )}

              <form
                action={`/matchs/${match.id}`}
                method="get"
                className="flex flex-col gap-2 sm:flex-row"
              >
                <input type="hidden" name="csrfToken" defaultValue="" />
                <input
                  type="text"
                  name="inviteQ"
                  defaultValue={inviteQ}
                  placeholder="搜索队友昵称或邮箱"
                  className="h-9 w-full flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100"
                />
                <button
                  type="submit"
                  className="h-9 rounded-lg border border-cyan-500/40 px-3 text-sm text-cyan-200 hover:bg-cyan-500/10 sm:h-auto"
                >
                  搜索
                </button>
              </form>

              {inviteQ ? (
                <div className="space-y-2">
                  {doublesInviteCandidates.length === 0 ? (
                    <p className="text-xs text-slate-400">未找到可邀请球员。</p>
                  ) : (
                    doublesInviteCandidates.map(
                      (candidate: {
                        id: string;
                        nickname: string;
                        email: string;
                      }) => (
                        <div
                          key={candidate.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-700 bg-slate-800/40 px-3 py-2"
                        >
                          <div>
                            <p className="text-sm text-slate-100">
                              {candidate.nickname}
                            </p>
                            <p className="text-xs text-slate-400">
                              {candidate.email}
                            </p>
                          </div>
                          <form
                            action={sendDoublesInviteAction.bind(
                              null,
                              match.id,
                            )}
                          >
                            <input
                              type="hidden"
                              name="csrfToken"
                              defaultValue=""
                            />
                            <input
                              type="hidden"
                              name="inviteeId"
                              value={candidate.id}
                            />
                            <button
                              type="submit"
                              className="rounded-md border border-cyan-500/40 px-2.5 py-1.5 text-xs text-cyan-200 hover:bg-cyan-500/10"
                            >
                              发起邀请
                            </button>
                          </form>
                        </div>
                      ),
                    )
                  )}
                </div>
              ) : null}

              {pendingDoublesInvites.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs text-slate-400">当前比赛待处理邀请</p>
                  {pendingDoublesInvites.map(
                    (invite: {
                      id: string;
                      inviterNickname: string;
                      inviteeNickname: string;
                      inviteeId: string;
                    }) => {
                      const isReceived = invite.inviteeId === currentUser.id;
                      return (
                        <div
                          key={invite.id}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-700 bg-slate-800/30 px-3 py-2"
                        >
                          <p className="text-sm text-slate-200">
                            {invite.inviterNickname} → {invite.inviteeNickname}
                          </p>
                          <div className="flex items-center gap-2">
                            {isReceived ? (
                              <form action={acceptDoublesInviteAction}>
                                <input
                                  type="hidden"
                                  name="csrfToken"
                                  value=""
                                />
                                <input
                                  type="hidden"
                                  name="inviteId"
                                  value={invite.id}
                                />
                                <button
                                  type="submit"
                                  className="rounded-md border border-emerald-500/40 px-2.5 py-1 text-xs text-emerald-200 hover:bg-emerald-500/10"
                                >
                                  接受
                                </button>
                              </form>
                            ) : (
                              <form action={revokeDoublesInviteAction}>
                                <input
                                  type="hidden"
                                  name="csrfToken"
                                  value=""
                                />
                                <input
                                  type="hidden"
                                  name="inviteId"
                                  value={invite.id}
                                />
                                <button
                                  type="submit"
                                  className="rounded-md border border-rose-500/40 px-2.5 py-1 text-xs text-rose-200 hover:bg-rose-500/10"
                                >
                                  撤回
                                </button>
                              </form>
                            )}
                          </div>
                        </div>
                      );
                    },
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {Boolean(
        currentUser &&
        alreadyRegistered &&
        match.status !== "registration" &&
        groupingPayload,
      ) &&
        currentUser &&
        groupingPayload && (
          <MyProgressSection
            matchId={match.id}
            matchType={match.type}
            currentUserId={currentUser.id}
            registrations={match.registrations}
            results={match.results}
            groupingPayload={groupingPayload}
            filledKnockoutRounds={filledKnockoutRounds}
          />
        )}

      {currentUser && certificateEligibility ? (
        <ExportCertificateSection
          matchId={match.id}
          matchTitle={match.title}
          currentUserEmail={currentUser.email}
          identityBound={Boolean(userIdentity)}
          eligibility={certificateEligibility}
          existingCertificateNo={existingCertificate?.certificateNo ?? null}
        />
      ) : null}

      {isAdmin && (
        <AdminResultsSection
          matchId={match.id}
          matchType={match.type}
          hasGroupingPayload={Boolean(groupingPayload)}
          registrations={match.registrations}
          adminEligibleOptions={adminEligibleOptions}
          adminGroupBattleTables={adminGroupBattleTables}
          initialAdminPhase={initialAdminPhase}
          initialAdminGroupName={initialAdminGroupName}
          initialAdminRoundName={initialAdminRoundName}
          initialAdminWinnerId={initialAdminWinnerId}
          initialAdminLoserId={initialAdminLoserId}
          adminPendingResults={adminPendingResults}
          filledKnockoutRounds={filledKnockoutRounds}
        />
      )}

      {canManageGrouping && (
        <div className="rounded-2xl border border-amber-400/30 bg-amber-500/5 p-4 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-amber-100 sm:text-lg">
                分组与签位管理（管理员）
              </h2>
              <p className="mt-1 text-xs text-amber-100/80 sm:text-sm">
                点击进入后可编辑分组并发布结果。
              </p>
            </div>
            <Link
              href={`/matchs/${match.id}/grouping`}
              className="rounded-lg border border-amber-300/40 px-3 py-1.5 text-xs font-medium text-amber-100 hover:bg-amber-500/10 sm:text-sm"
            >
              进入分组与签位管理
            </Link>
          </div>
        </div>
      )}

      {(!groupingPayload ||
        alreadyRegistered ||
        Boolean(groupingPayload?.knockout)) && (
        <GroupingResultSection
          groupingPayload={groupingPayload}
          alreadyRegistered={alreadyRegistered}
          myGroup={myGroup ?? null}
          filledKnockoutRounds={filledKnockoutRounds}
          currentUserId={currentUser?.id}
          currentUserNickname={currentUser?.nickname}
        />
      )}

      {groupingPayload && (
        <GroupsOverviewSection
          groupingPayload={groupingPayload}
          pagedGroups={pagedGroups}
          groupsPages={groupsPages}
          totalGroupsPages={totalGroupsPages}
          currentGroupsPage={currentGroupsPage}
          shouldOpenGroups={shouldOpenGroups}
          buildHref={(page) =>
            buildMatchHref({
              playersPage: preservedPlayersPage,
              groupsPage: page,
              hash: "#all-groups",
            })
          }
        />
      )}

      <RegisteredPlayersSection
        matchId={match.id}
        matchType={match.type}
        registrations={match.registrations}
        pagedRegistrations={pagedRegistrations}
        doublesTeams={registeredDoublesTeams}
        pagedDoublesTeams={pagedDoublesTeams}
        participantsStartIndex={participantsStartIndex}
        participantsPages={participantsPages}
        totalParticipantsPages={totalParticipantsPages}
        currentParticipantsPage={currentParticipantsPage}
        shouldOpenParticipants={shouldOpenParticipants}
        isAdmin={isAdmin}
        canRemove={isAdmin}
        buildHref={(page) =>
          buildMatchHref({
            playersPage: page,
            groupsPage: preservedGroupsPage,
            hash: "#registered-players",
          })
        }
      />
    </div>
  );
}
