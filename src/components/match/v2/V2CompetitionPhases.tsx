import RosterManagementForm from "@/components/match/v2/RosterManagementForm";
import V2GroupOnlyFixtureResultPanel from "@/components/match/v2/V2GroupOnlyFixtureResultPanel";
import V2EntryDisqualificationForm from "@/components/match/v2/V2EntryDisqualificationForm";
import V2KnockoutTableLabelsForm from "@/components/match/v2/V2KnockoutTableLabelsForm";
import {
  buildV2GroupOnlyResultFixtureView,
  V2_DOUBLE_GROUP_ONLY_RESULT_VIEW_PROFILE,
  V2_SINGLE_GROUP_ONLY_RESULT_VIEW_PROFILE,
  V2_TEAM_GROUP_ONLY_RESULT_VIEW_PROFILE,
} from "@/modules/competitions-v2/read-model/group-only-result-view";
import type {
  V2CompetitionGroupingReadModel,
  V2GroupOnlyGroupingMember,
  V2KnockoutFixtureSideReadModel,
} from "@/modules/competitions-v2/read-model/group-only-grouping";

const FIXTURE_STATUS_LABEL = {
  SCHEDULED: "等待对阵",
  READY: "待赛果",
  COMPLETED: "已完成",
  VOIDED: "已作废",
} as const;

const MATCH_TYPE_LABEL = {
  single: "单打",
  double: "双打",
  team: "团体",
} as const;

function memberLabel(member: V2GroupOnlyGroupingMember) {
  const role =
    member.role === "captain"
      ? "（队长）"
      : member.role === "substitute"
        ? "（替补）"
        : "";
  return `${member.frozenDisplayName}${role}`;
}

function FrozenEntry({
  name,
  members,
}: Readonly<{
  name: string;
  members: readonly V2GroupOnlyGroupingMember[];
}>) {
  return (
    <div>
      <p className="font-medium text-slate-100">{name}</p>
      <p className="mt-1 text-xs leading-5 text-slate-400">
        {members.map(memberLabel).join("、")}
      </p>
    </div>
  );
}

function FeederLabel({
  side,
  groupNames,
}: Readonly<{
  side: V2KnockoutFixtureSideReadModel;
  groupNames: ReadonlyMap<string, string>;
}>) {
  const feeder = side.feeder;
  if (feeder.kind === "QUALIFIER") {
    return (
      <p className="text-[11px] text-cyan-300">
        资格 #{feeder.qualificationOrder} · {groupNames.get(feeder.sourceGroupId) ?? "未知小组"}
        第 {feeder.sourceRank} 名
      </p>
    );
  }
  return (
    <p className={feeder.resolved ? "text-[11px] text-cyan-300" : feeder.empty ? "text-[11px] text-slate-400" : "text-[11px] text-amber-300"}>
      {feeder.resolved ? "来源" : feeder.empty ? "来源无晋级者" : "等待来源"}：第 {feeder.sourceRoundNumber} 轮第 {feeder.sourcePosition} 场胜者
    </p>
  );
}

export default function V2CompetitionPhases({
  grouping,
  competitionType,
  currentUserId,
  isManager,
  canReplaceRoster = false,
}: Readonly<{
  grouping: V2CompetitionGroupingReadModel;
  competitionType: "single" | "double" | "team";
  currentUserId: string | null;
  isManager: boolean;
  canReplaceRoster?: boolean;
}>) {
  if (grouping.match.type !== competitionType) {
    throw new Error("The V2 phase projection does not match the detail type.");
  }
  const profile =
    competitionType === "single"
      ? V2_SINGLE_GROUP_ONLY_RESULT_VIEW_PROFILE
      : competitionType === "double"
        ? V2_DOUBLE_GROUP_ONLY_RESULT_VIEW_PROFILE
        : V2_TEAM_GROUP_ONLY_RESULT_VIEW_PROFILE;
  const viewer = currentUserId ? { userId: currentUserId } : null;
  const groupNames = new Map(
    grouping.groups.map((group) => [group.groupId, group.displayName]),
  );
  const qualification =
    grouping.kind === "GROUP_THEN_KNOCKOUT_V2_MATCH"
      ? grouping.qualification
      : null;
  const knockout =
    grouping.kind === "GROUP_THEN_KNOCKOUT_V2_MATCH"
      ? grouping.knockout
      : null;

  const personalFixtures = [
    ...grouping.groups.flatMap(group => group.fixtures.map(fixture => ({ ...fixture, stage: "GROUP" as const, label: group.displayName, tableLabels: group.tableLabels }))),
    ...(knockout?.rounds.flatMap(round => round.fixtures.flatMap(fixture => fixture.sideA.entry && fixture.sideB.entry ? [{ ...fixture, sideA: fixture.sideA.entry, sideB: fixture.sideB.entry, stage: "KNOCKOUT" as const, label: `淘汰赛第 ${round.roundNumber} 轮` }] : [])) ?? []),
  ].map(fixture => ({ ...fixture, view: buildV2GroupOnlyResultFixtureView(fixture, viewer, isManager, profile, { stage: fixture.stage }) }))
    .filter(fixture => fixture.activeResult.state !== "NONE" ? fixture.view.pendingResult !== null : fixture.status === "READY")
    .filter(fixture => isManager ? fixture.view.pendingResult !== null : [fixture.sideA, fixture.sideB].some(side => side.members.some(member => member.userId === currentUserId)));

  return (
    <section className="space-y-5 rounded-2xl border border-slate-700 bg-slate-900/80 p-4 sm:p-6">
      <div>
        <h2 className="text-lg font-bold text-white">赛程与成绩</h2>
        <p className="mt-1 text-xs text-slate-400">
          查看赛程、提交比分，并由对手或管理员确认。
        </p>
      </div>

      {currentUserId && grouping.published ? <div className="rounded-xl border border-teal-400/25 bg-teal-400/5 p-4">
        <h3 className="font-semibold text-teal-100">{isManager ? "待处理成绩" : "我的对局"}（{personalFixtures.length}）</h3>
        {personalFixtures.length === 0 ? <p className="mt-2 text-sm text-slate-400">{isManager ? "目前没有待确认的比分。" : "目前没有需要你处理的对局，可在下方查看全部赛程和成绩。"}</p> : <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {personalFixtures.map(fixture => <article key={fixture.fixtureId} className="rounded-lg bg-slate-950/50 p-3">
            <p className="text-xs text-teal-200">{fixture.label}{fixture.tableLabels.length ? ` · ${fixture.tableLabels.join("、")}` : ""}</p>
            <p className="mt-2 text-sm font-medium text-white">{fixture.sideA.frozenDisplayName} · {fixture.sideB.frozenDisplayName}</p>
            <V2GroupOnlyFixtureResultPanel matchId={grouping.match.id} competitionType={competitionType} stage={fixture.stage} fixture={{ ...fixture, ...fixture.view }} />
          </article>)}
        </div>}
      </div> : null}
      <details open={!currentUserId || !grouping.published || grouping.match.status === "finished"}>
        <summary className="cursor-pointer text-sm font-semibold text-slate-200">全部赛程与成绩</summary>
        <div className="mt-4 space-y-5">
      {!grouping.published ? (
        <div className="rounded-xl border border-slate-700 bg-slate-950/30 p-4 text-sm text-slate-400">
          分组尚未发布。
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-cyan-100">小组赛</h3>
            {grouping.kind === "GROUP_THEN_KNOCKOUT_V2_MATCH" ? (
              <span className="text-xs text-slate-400">
                每组晋级 {grouping.qualifiersPerGroup} 名
              </span>
            ) : null}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {grouping.groups.map((group) => {
              const standings = qualification?.standings.filter(
                (standing) => standing.groupId === group.groupId,
              );
              return (
                <article
                  key={group.groupId}
                  className="space-y-3 rounded-xl border border-slate-700 bg-slate-950/30 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="font-semibold text-cyan-100">{group.displayName}</h4>
                    <div className="text-right text-xs text-slate-400">
                      <p>{group.fixtures.length} 场</p>
                      {group.tableLabels.length > 0 ? (
                        <p className="text-amber-200">桌号/场地：{group.tableLabels.join("、")}</p>
                      ) : null}
                    </div>
                  </div>

                  {standings ? (
                    <div className="overflow-x-auto rounded-lg border border-slate-700/80">
                      <table className="w-full min-w-[520px] text-left text-xs text-slate-300">
                        <thead className="bg-slate-800/80 text-slate-400">
                          <tr>
                            <th className="px-2 py-2">排名</th>
                            <th className="px-2 py-2">参赛方</th>
                            <th className="px-2 py-2">场次</th>
                            <th className="px-2 py-2">胜/负</th>
                            <th className="px-2 py-2">得失分</th>
                            <th className="px-2 py-2">晋级</th>
                          </tr>
                        </thead>
                        <tbody>
                          {standings.map((standing) => (
                            <tr key={standing.standingId} className="border-t border-slate-700/70">
                              <td className="px-2 py-2">{standing.rank}</td>
                              <td className="px-2 py-2">{standing.frozenDisplayName}</td>
                              <td className="px-2 py-2">{standing.played}</td>
                              <td className="px-2 py-2">{standing.wins}/{standing.losses}</td>
                              <td className="px-2 py-2">
                                {standing.scoreFor}:{standing.scoreAgainst}（{standing.scoreDifferential >= 0 ? "+" : ""}{standing.scoreDifferential}）
                              </td>
                              <td className="px-2 py-2">
                                {standing.qualified
                                  ? `#${standing.qualificationOrder}`
                                  : standing.ineligibilityReason ?? "未晋级"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {group.entries.map((entry) => (
                        <div key={entry.entryId} className="rounded-lg bg-slate-900/70 p-2.5">
                          <FrozenEntry name={entry.frozenDisplayName} members={entry.members} />
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="space-y-3">
                    {group.fixtures.map((fixture, index) => {
                      const resultView = buildV2GroupOnlyResultFixtureView(
                        fixture,
                        viewer,
                        isManager,
                        profile,
                        { stage: "GROUP" },
                      );
                      return (
                        <div
                          key={fixture.fixtureId}
                          className="rounded-lg border border-slate-700/80 bg-slate-900/70 p-3"
                        >
                          <div className="flex items-center justify-between gap-2 text-sm">
                            <span className="text-slate-100">小组对局 {index + 1}</span>
                            <span className="text-xs text-slate-400">
                              {FIXTURE_STATUS_LABEL[fixture.status]}
                            </span>
                          </div>
                          <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
                            <FrozenEntry name={fixture.sideA.frozenDisplayName} members={fixture.sideA.members} />
                            <span className="text-xs text-slate-500">VS</span>
                            <FrozenEntry name={fixture.sideB.frozenDisplayName} members={fixture.sideB.members} />
                          </div>
                          <V2GroupOnlyFixtureResultPanel
                            competitionType={competitionType}
                            stage="GROUP"
                            matchId={grouping.match.id}
                            fixture={{ ...fixture, ...resultView }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}

      {grouping.kind === "GROUP_THEN_KNOCKOUT_V2_MATCH" && grouping.published && !knockout ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-100">
          {grouping.managementState === "READY_TO_FINALIZE"
            ? "小组成绩已全部确认，管理员可以发布晋级名单与淘汰赛程。"
            : "小组赛进行中；仍有未终局或待确认赛果。"}
        </div>
      ) : null}

      {qualification && knockout ? (
        <div className="space-y-4 border-t border-slate-700 pt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="font-semibold text-fuchsia-100">淘汰赛</h3>
              <p className="mt-1 text-xs text-slate-400">
                {MATCH_TYPE_LABEL[competitionType]} · {knockout.roundCount} 轮 · {knockout.fixtureCount} 场
              </p>
            </div>
            <span className="text-xs text-slate-500">
              排名确认于 {new Date(qualification.frozenAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}
            </span>
          </div>
          {knockout.rounds.map((round) => (
            <div key={round.roundNumber} className="space-y-3">
              <h4 className="text-sm font-semibold text-fuchsia-200">
                第 {round.roundNumber} 轮{round.roundNumber === knockout.roundCount ? "（决赛）" : ""}
              </h4>
              <div className="grid gap-3 lg:grid-cols-2">
                {round.fixtures.map((fixture) => {
                  const resolved = fixture.sideA.entry !== null && fixture.sideB.entry !== null;
                  const resultView = resolved
                    ? buildV2GroupOnlyResultFixtureView(
                        {
                          fixtureId: fixture.fixtureId,
                          fixtureVersion: fixture.fixtureVersion,
                            bestOf: fixture.bestOf,
                          status: fixture.status,
                          sideA: fixture.sideA.entry!,
                          sideB: fixture.sideB.entry!,
                          activeResult: fixture.activeResult,
                        },
                        viewer,
                        isManager,
                        profile,
                        { stage: "KNOCKOUT" },
                      )
                    : null;
                  return (
                    <article
                      key={fixture.fixtureId}
                      className="rounded-xl border border-fuchsia-500/20 bg-slate-950/35 p-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium text-slate-100">第 {fixture.position} 场</p>
                        <span className="text-xs text-slate-400">{FIXTURE_STATUS_LABEL[fixture.status]}</span>
                      </div>
                      <p className="mt-1 text-xs text-amber-200">
                        {fixture.tableLabels.length > 0
                          ? `桌号/场地：${fixture.tableLabels.join("、")}`
                          : "桌号/场地待定"}
                      </p>
                      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
                        <div>
                          <FeederLabel side={fixture.sideA} groupNames={groupNames} />
                          {fixture.sideA.entry ? (
                            <FrozenEntry name={fixture.sideA.entry.frozenDisplayName} members={fixture.sideA.entry.members} />
                          ) : (
                            <p className="mt-1 text-sm text-amber-200">
                              {fixture.sideA.feeder.kind === "WINNER" && fixture.sideA.feeder.empty
                                ? "该来源无晋级者"
                                : "等待来源胜者"}
                            </p>
                          )}
                        </div>
                        <span className="text-xs text-slate-500">VS</span>
                        <div>
                          <FeederLabel side={fixture.sideB} groupNames={groupNames} />
                          {fixture.sideB.entry ? (
                            <FrozenEntry name={fixture.sideB.entry.frozenDisplayName} members={fixture.sideB.entry.members} />
                          ) : (
                            <p className="mt-1 text-sm text-amber-200">
                              {fixture.sideB.feeder.kind === "WINNER" && fixture.sideB.feeder.empty
                                ? "该来源无晋级者"
                                : "等待来源胜者"}
                            </p>
                          )}
                        </div>
                      </div>
                      {resolved && resultView ? (
                        <V2GroupOnlyFixtureResultPanel
                          competitionType={competitionType}
                          stage="KNOCKOUT"
                          matchId={grouping.match.id}
                          fixture={{
                            fixtureId: fixture.fixtureId,
                            fixtureVersion: fixture.fixtureVersion,
                            bestOf: fixture.bestOf,
                            startedAt: fixture.startedAt,
                            sideA: fixture.sideA.entry!,
                            sideB: fixture.sideB.entry!,
                            ...resultView,
                          }}
                        />
                      ) : fixture.administrativeResolution ? (
                        <div className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-sm text-amber-100">
                          <p>
                            {fixture.administrativeResolution.kind === "ADMIN_BYE"
                              ? `${fixture.sideA.entry?.entryId === fixture.administrativeResolution.advancingEntryId ? fixture.sideA.entry.frozenDisplayName : fixture.sideB.entry?.frozenDisplayName ?? "该参赛方"}经管理员轮空晋级。`
                              : "双方均无法参赛，本场无结果。"}
                          </p>
                          <p className="mt-1 text-xs text-amber-200/75">
                            {fixture.administrativeResolution.reason} · {fixture.administrativeResolution.resolvedByName}
                          </p>
                        </div>
                      ) : null}
                      {isManager && grouping.match.status === "ongoing" ? (
                        <V2KnockoutTableLabelsForm
                          matchId={grouping.match.id}
                          fixtureId={fixture.fixtureId}
                          fixtureVersion={fixture.fixtureVersion}
                          roundNumber={fixture.roundNumber}
                          position={fixture.position}
                          tableLabels={fixture.tableLabels}
                        />
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}
        </div>
      </details>
      {isManager && grouping.match.status !== "finished" ? <details className="rounded-xl border border-amber-400/25 p-4">
        <summary className="cursor-pointer font-semibold text-amber-100">赛事管理</summary>
        <div className="mt-4 space-y-4">      {canReplaceRoster && competitionType !== "single" && grouping.published ? (
        <details className="rounded-xl border border-slate-700 bg-slate-950/30 p-4">
          <summary className="cursor-pointer text-sm font-semibold text-teal-200">更换双打搭档或团体成员</summary>
          {grouping.activeEntries.map(entry => {
            const fixtures = [...grouping.groups.flatMap(group => group.fixtures.map(fixture => ({ id: fixture.fixtureId, startedAt: fixture.startedAt, status: fixture.status, pending: fixture.activeResult.state !== "NONE", involved: fixture.sideA.entryId === entry.entryId || fixture.sideB.entryId === entry.entryId }))), ...(knockout?.rounds.flatMap(round => round.fixtures.map(fixture => ({ id: fixture.fixtureId, startedAt: fixture.startedAt, status: fixture.status, pending: fixture.activeResult.state !== "NONE", involved: fixture.sideA.entry?.entryId === entry.entryId || fixture.sideB.entry?.entryId === entry.entryId }))) ?? [])].filter(fixture => fixture.involved);
            const futureCount = fixtures.filter(fixture => !fixture.startedAt && !fixture.pending && (fixture.status === "SCHEDULED" || fixture.status === "READY")).length;
            return <RosterManagementForm key={`${entry.entryId}:${entry.entryVersion}`} matchId={grouping.match.id} entryId={entry.entryId} entryVersion={entry.entryVersion} entryName={entry.frozenDisplayName} team={competitionType === "team"} initialMembers={entry.currentMembers.map(member => ({ id: member.userId, nickname: member.frozenDisplayName }))} initialCaptainId={entry.currentMembers.find(member => member.role === "captain")?.userId} futureCount={futureCount} protectedCount={fixtures.length - futureCount} />;
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
      </details> : null}
    </section>
  );
}
