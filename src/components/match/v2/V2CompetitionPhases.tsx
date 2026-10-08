import Link from "next/link";
import type { ReactNode } from "react";
import MatchDetailTabs, {
  type MatchDetailTab,
} from "@/components/match/detail/MatchDetailTabs";
import RosterManagementForm from "./RosterManagementForm";
import V2PersonalFixtures from "./V2PersonalFixtures";
import V2EntryDisqualificationForm from "./V2EntryDisqualificationForm";
import V2Schedule from "./V2Schedule";
import V2MatchClosureForm from "./V2MatchClosureForm";
import { bracketRoundLabel } from "@/modules/competitions-v2/read-model/bracket-layout";
import {
  buildV2GroupOnlyResultFixtureView,
  V2_DOUBLE_GROUP_ONLY_RESULT_VIEW_PROFILE,
  V2_SINGLE_GROUP_ONLY_RESULT_VIEW_PROFILE,
  V2_TEAM_GROUP_ONLY_RESULT_VIEW_PROFILE,
} from "@/modules/competitions-v2/read-model/group-only-result-view";
import type { V2CompetitionGroupingReadModel } from "@/modules/competitions-v2/read-model/group-only-grouping";

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-white/15 px-5 py-12 text-center text-sm leading-6 text-slate-400">
      {children}
    </div>
  );
}

export default function V2CompetitionPhases({
  grouping,
  competitionType,
  currentUserId,
  isManager,
  canReplaceRoster = false,
  canFinishMatch = false,
  registrationContent,
  rosterContent,
  certificateContent,
  managementContent,
}: Readonly<{
  grouping: V2CompetitionGroupingReadModel;
  competitionType: "single" | "double" | "team";
  currentUserId: string | null;
  isManager: boolean;
  canReplaceRoster?: boolean;
  canFinishMatch?: boolean;
  registrationContent?: ReactNode;
  rosterContent?: ReactNode;
  certificateContent?: ReactNode;
  managementContent?: ReactNode;
}>) {
  if (grouping.match.type !== competitionType)
    throw new Error("The V2 phase projection does not match the detail type.");
  const profile =
    competitionType === "single"
      ? V2_SINGLE_GROUP_ONLY_RESULT_VIEW_PROFILE
      : competitionType === "double"
        ? V2_DOUBLE_GROUP_ONLY_RESULT_VIEW_PROFILE
        : V2_TEAM_GROUP_ONLY_RESULT_VIEW_PROFILE;
  const viewer = currentUserId ? { userId: currentUserId } : null;
  const knockout =
    grouping.kind === "GROUP_THEN_KNOCKOUT_V2_MATCH" ? grouping.knockout : null;
  const personalFixtures = [
    ...grouping.groups.flatMap((group) =>
      group.fixtures.map((fixture) => ({
        ...fixture,
        stage: "GROUP" as const,
        label: group.displayName,
        tableLabels: group.tableLabels,
      })),
    ),
    ...(knockout?.rounds.flatMap((round) =>
      round.fixtures.flatMap((fixture) =>
        fixture.sideA.entry && fixture.sideB.entry
          ? [
              {
                ...fixture,
                sideA: fixture.sideA.entry,
                sideB: fixture.sideB.entry,
                stage: "KNOCKOUT" as const,
                label: `淘汰赛 · ${bracketRoundLabel(round.roundNumber, knockout!.roundCount)}`,
              },
            ]
          : [],
      ),
    ) ?? []),
  ]
    .map((fixture) => ({
      ...fixture,
      view: buildV2GroupOnlyResultFixtureView(
        fixture,
        viewer,
        isManager,
        profile,
        { stage: fixture.stage },
      ),
    }))
    .filter((fixture) =>
      isManager
        ? fixture.view.pendingResult !== null
        : [fixture.sideA, fixture.sideB].some((side) =>
            side.members.some((member) => member.userId === currentUserId),
          ),
    );
  const fixtureCount =
    grouping.groups.reduce((count, group) => count + group.fixtures.length, 0) +
    (knockout?.fixtureCount ?? 0);
  const finished = grouping.match.status === "finished";
  const hasPersonal = Boolean(
    currentUserId &&
      grouping.published &&
      (isManager ? !finished : personalFixtures.length > 0),
  );
  const confirmations = personalFixtures.filter(
    ({ view }) => view.canConfirmPending,
  ).length;
  const submissions = personalFixtures.filter(
    ({ view }) => view.canSubmitResult,
  ).length;
  const waitingForOpponent =
    knockout?.rounds.some((round) =>
      round.fixtures.some(
        (fixture) =>
          fixture.status === "SCHEDULED" &&
          [fixture.sideA, fixture.sideB].some((side) =>
            side.entry?.members.some(
              (member) => member.userId === currentUserId,
            ),
          ) &&
          (!fixture.sideA.entry || !fixture.sideB.entry),
      ),
    ) ?? false;
  const schedule = (
    <V2Schedule
      grouping={grouping}
      competitionType={competitionType}
      currentUserId={currentUserId}
      isManager={isManager}
      profile={profile}
    />
  );

  const tabs: MatchDetailTab[] = [];
  if (registrationContent)
    tabs.push({
      id: "registration",
      label: competitionType === "single" ? "报名" : "报名与组队",
      content: registrationContent,
    });
  tabs.push({
    id: "schedule",
    label: "赛程",
    count: fixtureCount,
    content: schedule,
  });
  if (hasPersonal)
    tabs.push({
      id: "personal",
      label: isManager ? "待确认成绩" : finished ? "我的成绩" : "我的对局",
      count: personalFixtures.length,
      attention: personalFixtures.some(
        ({ view }) => view.canSubmitResult || view.canConfirmPending,
      ),
      content: (
        <div>
          <h2 className="text-lg font-semibold text-white">
            {isManager
              ? "核对待确认成绩"
              : finished
                ? "我的比赛成绩"
                : confirmations
                  ? `${confirmations} 场比分等你确认`
                  : "我的赛程与比分"}
          </h2>
          <p className="mt-1 mb-5 text-sm text-slate-400">
            {isManager
              ? "核对待确认的比分，确认后计入正式成绩。"
              : finished
                ? "比赛已结束，你参加过的对局与成绩保留在这里。"
                : waitingForOpponent
                  ? "等待下一轮对手确定，签位发布后会在这里更新。"
                  : competitionType === "team"
                    ? "查看本队对局；本场队长负责录入和确认队伍总比分。"
                    : submissions
                      ? "选择自己的对手录入比分；需要你确认的成绩会排在前面。"
                      : "查看已结束的成绩；待确认的比分与新签位会自动更新。"}
          </p>
          {personalFixtures.length ? (
            <V2PersonalFixtures
              matchId={grouping.match.id}
              competitionType={competitionType}
              fixtures={personalFixtures}
              currentUserId={currentUserId}
              isManager={isManager}
            />
          ) : (
            <EmptyState>
              {isManager
                ? "目前没有待确认的成绩。"
                : "目前没有需要处理的对局，可在完整赛程中查看成绩。"}
            </EmptyState>
          )}
        </div>
      ),
    });
  if (rosterContent)
    tabs.push({
      id: "roster",
      label: "参赛名单",
      count: grouping.activeEntries.length,
      content: rosterContent,
    });
  if (isManager && grouping.match.status !== "finished")
    tabs.push({
      id: "management",
      label: "赛事管理",
      content: (
        <div className="space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-white">赛事管理</h2>
            <p className="mt-1 text-sm text-slate-400">
              分组、赛程发布和参赛资格管理。
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href={`/matchs/${grouping.match.id}/grouping`}
              className="btn-primary rounded-lg px-4 py-2.5 text-sm font-medium"
            >
              {grouping.published ? "分组与晋级管理" : "预览与发布分组"}
            </Link>
          </div>
          {canFinishMatch && grouping.published && grouping.match.status === "ongoing" && grouping.match.format === "group_only" ? (
            <V2MatchClosureForm matchId={grouping.match.id} />
          ) : null}
          {managementContent}
          {canReplaceRoster &&
          competitionType !== "single" &&
          grouping.published ? (
            <details className="rounded-xl border border-slate-700 bg-slate-950/30 p-4">
              <summary className="cursor-pointer text-sm font-semibold text-teal-200">
                更换双打搭档或团体成员
              </summary>
              {grouping.activeEntries.map((entry) => {
                const fixtures = [
                  ...grouping.groups.flatMap((group) =>
                    group.fixtures.map((fixture) => ({
                      id: fixture.fixtureId,
                      startedAt: fixture.startedAt,
                      status: fixture.status,
                      pending: fixture.activeResult.state !== "NONE",
                      involved:
                        fixture.sideA.entryId === entry.entryId ||
                        fixture.sideB.entryId === entry.entryId,
                    })),
                  ),
                  ...(knockout?.rounds.flatMap((round) =>
                    round.fixtures.map((fixture) => ({
                      id: fixture.fixtureId,
                      startedAt: fixture.startedAt,
                      status: fixture.status,
                      pending: fixture.activeResult.state !== "NONE",
                      involved:
                        fixture.sideA.entry?.entryId === entry.entryId ||
                        fixture.sideB.entry?.entryId === entry.entryId,
                    })),
                  ) ?? []),
                ].filter((fixture) => fixture.involved);
                const futureCount = fixtures.filter(
                  (fixture) =>
                    !fixture.startedAt &&
                    !fixture.pending &&
                    (fixture.status === "SCHEDULED" ||
                      fixture.status === "READY"),
                ).length;
                return (
                  <RosterManagementForm
                    key={`${entry.entryId}:${entry.entryVersion}`}
                    matchId={grouping.match.id}
                    entryId={entry.entryId}
                    entryVersion={entry.entryVersion}
                    entryName={entry.frozenDisplayName}
                    team={competitionType === "team"}
                    initialMembers={entry.currentMembers.map((member) => ({
                      id: member.userId,
                      nickname: member.frozenDisplayName,
                    }))}
                    initialCaptainId={
                      entry.currentMembers.find(
                        (member) => member.role === "captain",
                      )?.userId
                    }
                    futureCount={futureCount}
                    protectedCount={fixtures.length - futureCount}
                  />
                );
              })}
            </details>
          ) : null}

          {isManager && grouping.activeEntries.length > 0 ? (
            <details className="rounded-xl border border-rose-500/25 bg-slate-950/30 p-4">
              <summary className="cursor-pointer text-sm font-semibold text-rose-200">
                安排退赛
              </summary>
              <p className="mt-2 text-xs leading-5 text-slate-400">
                先核实待确认比分，再安排退赛。已确认成绩保留，剩余场次按弃权处理。
              </p>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {grouping.activeEntries.map((entry) => (
                  <V2EntryDisqualificationForm
                    key={`${entry.entryId}:${entry.entryVersion}`}
                    matchId={grouping.match.id}
                    entryId={entry.entryId}
                    entryVersion={entry.entryVersion}
                    entryName={entry.frozenDisplayName}
                  />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      ),
    });
  if (certificateContent)
    tabs.push({
      id: "certificate",
      label: "参赛证明",
      content: certificateContent,
    });
  const defaultId =
    !grouping.published && registrationContent
      ? "registration"
      : hasPersonal && (!isManager || personalFixtures.length > 0)
        ? "personal"
        : "schedule";
  return (
    <MatchDetailTabs
      key={`${grouping.match.id}:${grouping.published}`}
      tabs={tabs}
      defaultId={defaultId}
      live={hasPersonal && !finished}
      awaitingConfirmation={personalFixtures.some(
        ({ view }) => view.pendingResult,
      )}
    />
  );
}
