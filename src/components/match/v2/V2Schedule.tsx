import { Trophy } from "lucide-react";
import ScheduleStages from "@/components/match/detail/ScheduleStages";
import BracketViewport from "@/components/match/detail/BracketViewport";
import ScheduleFixtureDialog, {
  FixtureTrigger,
} from "@/components/match/detail/ScheduleFixtureDialog";
import {
  BRACKET_NODE_HEIGHT,
  BRACKET_NODE_WIDTH,
  bracketRoundLabel,
  buildConvergingBracketLayout,
} from "@/modules/competitions-v2/read-model/bracket-layout";
import {
  buildV2GroupOnlyResultFixtureView,
  type V2GroupOnlyResultFixtureView,
  type V2GroupOnlyResultViewProfile,
} from "@/modules/competitions-v2/read-model/group-only-result-view";
import type {
  V2CompetitionGroupingReadModel,
  V2GroupOnlyGroupingFixture,
  V2KnockoutFixtureSideReadModel,
} from "@/modules/competitions-v2/read-model/group-only-grouping";
import V2FixtureCard from "./V2FixtureCard";
import V2KnockoutTableLabelsForm from "./V2KnockoutTableLabelsForm";

function feederLabel(
  side: V2KnockoutFixtureSideReadModel,
  groupNames: ReadonlyMap<string, string>,
  roundCount: number,
) {
  const feeder = side.feeder;
  if (feeder.kind === "QUALIFIER")
    return `${groupNames.get(feeder.sourceGroupId) ?? "小组"}第 ${feeder.sourceRank} 名`;
  return `${bracketRoundLabel(feeder.sourceRoundNumber, roundCount)}第 ${feeder.sourcePosition} 场${feeder.empty ? "无晋级者" : "胜者"}`;
}

function fixtureDisplay(
  fixture: Pick<V2GroupOnlyGroupingFixture, "status" | "startedAt">,
  view: V2GroupOnlyResultFixtureView | null,
  sideAId?: string,
) {
  const result = view?.authoritativeResult ?? view?.pendingResult;
  const score = result?.score ?? result?.aggregateScore;
  const aWon = result?.winnerEntryId === sideAId;
  const scores = score
    ? aWon
      ? [String(score.winnerScore), String(score.loserScore)]
      : [String(score.loserScore), String(score.winnerScore)]
    : result?.resolutionKind === "FORFEIT"
      ? aWon
        ? ["胜", "弃权"]
        : ["弃权", "胜"]
      : null;
  return {
    scores,
    winnerEntryId: view?.authoritativeResult?.winnerEntryId ?? null,
    pending: Boolean(view?.pendingResult),
    status: view?.pendingResult
      ? view.authoritativeResult
        ? "待更正"
        : "待确认"
      : fixture.status === "VOIDED"
        ? "已作废"
        : fixture.status === "COMPLETED"
          ? "已结束"
          : fixture.status === "READY"
            ? fixture.startedAt
              ? "比赛中"
              : "待赛"
            : "待定",
    forfeit: result?.resolutionKind === "FORFEIT",
  };
}

export default function V2Schedule({
  grouping,
  competitionType,
  currentUserId,
  isManager,
  profile,
}: Readonly<{
  grouping: V2CompetitionGroupingReadModel;
  competitionType: "single" | "double" | "team";
  currentUserId: string | null;
  isManager: boolean;
  profile: V2GroupOnlyResultViewProfile;
}>) {
  if (!grouping.published)
    return (
      <div className="rounded-xl border border-dashed border-white/15 px-5 py-12 text-center text-sm text-slate-400">
        赛程尚未发布，分组完成后将在这里显示。
      </div>
    );

  const viewer = currentUserId ? { userId: currentUserId } : null;
  const qualification =
    grouping.kind === "GROUP_THEN_KNOCKOUT_V2_MATCH"
      ? grouping.qualification
      : null;
  const knockout =
    grouping.kind === "GROUP_THEN_KNOCKOUT_V2_MATCH" ? grouping.knockout : null;
  const groupNames = new Map(
    grouping.groups.map((group) => [group.groupId, group.displayName]),
  );
  const groupFixtures = grouping.groups.flatMap((group) =>
    group.fixtures.map((fixture, index) => ({
      fixture,
      group,
      index,
      view: buildV2GroupOnlyResultFixtureView(
        fixture,
        viewer,
        isManager,
        profile,
        { stage: "GROUP" },
      ),
    })),
  );
  const knockoutFixtures =
    knockout?.rounds.flatMap((round) =>
      round.fixtures.map((fixture) => {
        const sideA = fixture.sideA.entry;
        const sideB = fixture.sideB.entry;
        const resolved = sideA && sideB ? { ...fixture, sideA, sideB } : null;
        return {
          fixture,
          resolved,
          view: resolved
            ? buildV2GroupOnlyResultFixtureView(
                resolved,
                viewer,
                isManager,
                profile,
                { stage: "KNOCKOUT" },
              )
            : null,
        };
      }),
    ) ?? [];
  const groupViews = new Map(
    groupFixtures.map((item) => [item.fixture.fixtureId, item.view]),
  );
  const knockoutViews = new Map(
    knockoutFixtures.map((item) => [item.fixture.fixtureId, item]),
  );
  const ended = (fixture: { status: string }) =>
    fixture.status === "COMPLETED" || fixture.status === "VOIDED";
  const layout = knockout ? buildConvergingBracketLayout(knockout) : null;
  const isMine = (entry: { members: readonly { userId: string }[] } | null) =>
    Boolean(
      currentUserId &&
        entry?.members.some((member) => member.userId === currentUserId),
    );
  const ownLabel = competitionType === "single" ? "我" : "本队";
  const ownKnockout = knockoutFixtures
    .filter(
      ({ fixture }) =>
        isMine(fixture.sideA.entry) || isMine(fixture.sideB.entry),
    )
    .sort((a, b) => {
      const priority = (item: typeof a) =>
        item.view?.canConfirmPending
          ? 0
          : item.view?.pendingResult
            ? 1
            : item.fixture.status === "READY"
              ? 2
              : item.fixture.status === "SCHEDULED"
                ? 3
                : 4;
      return (
        priority(a) - priority(b) ||
        b.fixture.roundNumber - a.fixture.roundNumber
      );
    })[0];
  const ownNode = layout?.nodes.find(
    (node) => node.fixtureId === ownKnockout?.fixture.fixtureId,
  );
  const fixtureDetails = [
    ...groupFixtures.map(({ fixture, group, index, view }) => ({
      fixtureId: fixture.fixtureId,
      title: `小组赛 · ${group.displayName} · 第 ${index + 1} 场`,
      content: (
        <V2FixtureCard
          matchId={grouping.match.id}
          competitionType={competitionType}
          stage="GROUP"
          label={group.displayName}
          tableLabels={group.tableLabels}
          fixture={fixture}
          view={view}
          currentUserId={currentUserId}
          isManager={isManager}
        />
      ),
    })),
    ...knockoutFixtures.map(({ fixture, resolved, view }) => {
      const label = `${bracketRoundLabel(fixture.roundNumber, knockout!.roundCount)} · 第 ${fixture.position} 场`;
      const tableForm =
        isManager && grouping.match.status === "ongoing" ? (
          <details className="mt-3 border-t border-white/8 pt-3">
            <summary className="cursor-pointer text-xs text-slate-400">
              调整本场场地
            </summary>
            <V2KnockoutTableLabelsForm
              matchId={grouping.match.id}
              fixtureId={fixture.fixtureId}
              fixtureVersion={fixture.fixtureVersion}
              roundNumber={fixture.roundNumber}
              position={fixture.position}
              tableLabels={fixture.tableLabels}
            />
          </details>
        ) : null;
      return {
        fixtureId: fixture.fixtureId,
        title: `淘汰赛 · ${label}`,
        content:
          resolved && view ? (
            <V2FixtureCard
              matchId={grouping.match.id}
              competitionType={competitionType}
              stage="KNOCKOUT"
              label={label}
              tableLabels={fixture.tableLabels}
              fixture={resolved}
              view={view}
              currentUserId={currentUserId}
              isManager={isManager}
            >
              {tableForm}
            </V2FixtureCard>
          ) : (
            <div className="space-y-4">
              {[fixture.sideA, fixture.sideB].map((side, index) => (
                <div key={index} className="rounded-lg bg-white/5 px-4 py-3">
                  <p className="text-sm font-medium">
                    {side.entry?.frozenDisplayName ?? "待定"}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    {feederLabel(side, groupNames, knockout!.roundCount)}
                  </p>
                </div>
              ))}
              <p className="text-xs text-slate-400">
                {fixture.tableLabels.length
                  ? `场地：${fixture.tableLabels.join("、")}`
                  : "场地待安排"}
              </p>
              {fixture.administrativeResolution ? (
                <div className="text-sm leading-6 text-slate-400">
                  <p>
                    {fixture.administrativeResolution.kind === "ADMIN_BYE"
                      ? `${[fixture.sideA, fixture.sideB].find((side) => side.entry?.entryId === fixture.administrativeResolution?.advancingEntryId)?.entry?.frozenDisplayName ?? "该参赛方"}经管理员轮空晋级。`
                      : "双方均无法参赛，本场无结果。"}
                  </p>
                  <p>
                    {fixture.administrativeResolution.reason} ·{" "}
                    {fixture.administrativeResolution.resolvedByName}
                  </p>
                </div>
              ) : null}
              {tableForm}
            </div>
          ),
      };
    }),
  ];

  const groupContent = (
    <section aria-labelledby="group-schedule-title" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2
            id="group-schedule-title"
            className={
              knockout ? "sr-only" : "text-lg font-semibold text-white"
            }
          >
            小组赛
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            {grouping.groups.length} 个小组
            {grouping.kind === "GROUP_THEN_KNOCKOUT_V2_MATCH"
              ? ` · 每组晋级 ${grouping.qualifiersPerGroup} 名`
              : ""}
            {" · 点击比分查看单场"}
          </p>
        </div>
        <p className="text-xs tabular-nums text-slate-400">
          已结束 {groupFixtures.filter(({ fixture }) => ended(fixture)).length}{" "}
          / {groupFixtures.length} 场
        </p>
      </div>
      <div className="grid items-start gap-4 xl:grid-cols-2">
        {grouping.groups.map((group) => {
          const standings = qualification?.standings.filter(
            (standing) => standing.groupId === group.groupId,
          );
          const standingsByEntry = new Map(
            standings?.map((standing) => [standing.entryId, standing]),
          );
          const fixturesByPair = new Map(
            group.fixtures.map((fixture) => [
              [fixture.sideA.entryId, fixture.sideB.entryId].sort().join(":"),
              fixture,
            ]),
          );
          return (
            <section
              key={group.groupId}
              className="min-w-0 overflow-hidden rounded-xl border border-white/10 bg-[#0d131d]"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
                <h3 className="text-sm font-semibold text-slate-100">
                  {group.displayName}
                  {group.entries.some(isMine) ? (
                    <span className="ml-2 text-[10px] font-normal text-orange-200">
                      我的小组
                    </span>
                  ) : null}
                </h3>
                <p className="text-xs text-slate-500">
                  {group.entries.length}{" "}
                  {competitionType === "single" ? "人" : "队"}
                  {group.tableLabels.length
                    ? ` · ${group.tableLabels.join("、")}`
                    : ""}
                </p>
              </div>
              <div
                className="overflow-x-auto"
                role="region"
                aria-label={`${group.displayName}交叉对阵表，可横向滚动`}
                tabIndex={0}
              >
                <table
                  className="w-full border-collapse text-xs"
                  style={{
                    minWidth:
                      128 + group.entries.length * 56 + (standings ? 104 : 0),
                  }}
                >
                  <caption className="sr-only">
                    {group.displayName}
                    交叉对阵表。行选手对列选手，比分按行选手视角显示；编号对应左侧参赛方。
                  </caption>
                  <thead>
                    <tr className="h-10 bg-[#111924] text-slate-400">
                      <th
                        scope="col"
                        className="sticky left-0 z-10 min-w-28 bg-[#111924] px-3 text-left font-medium sm:min-w-40"
                      >
                        参赛方 / 对手
                      </th>
                      {group.entries.map((entry, index) => (
                        <th
                          key={entry.entryId}
                          scope="col"
                          aria-label={`${index + 1} ${entry.frozenDisplayName}`}
                          className={`min-w-14 border-l border-white/5 px-1 font-medium sm:min-w-16 ${isMine(entry) ? "bg-orange-300/8 text-orange-200" : ""}`}
                          title={entry.frozenDisplayName}
                        >
                          <span aria-hidden="true">
                            {index + 1}
                            {isMine(entry) ? ` · ${ownLabel}` : ""}
                          </span>
                        </th>
                      ))}
                      {standings ? (
                        <>
                          <th
                            scope="col"
                            className="min-w-14 border-l border-white/10 px-1 font-medium"
                          >
                            胜 / 负
                          </th>
                          <th scope="col" className="min-w-12 px-1 font-medium">
                            名次
                          </th>
                        </>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {group.entries.map((entry, row) => {
                      const standing = standingsByEntry.get(entry.entryId);
                      const ownRow = isMine(entry);
                      return (
                        <tr
                          key={entry.entryId}
                          className={`border-t border-white/7 ${ownRow ? "bg-orange-300/[0.04]" : ""}`}
                        >
                          <th
                            scope="row"
                            className={`sticky left-0 z-10 px-3 py-3 text-left font-normal ${ownRow ? "bg-[#1b1c21]" : "bg-[#0d131d]"}`}
                          >
                            <div className="flex items-start gap-2">
                              <span className="pt-0.5 text-[10px] tabular-nums text-slate-500">
                                {row + 1}
                              </span>
                              <div>
                                <p className="max-w-40 break-words leading-5 text-slate-200">
                                  {entry.frozenDisplayName}
                                </p>
                                {ownRow ? (
                                  <span className="text-[10px] text-orange-200">
                                    {ownLabel}
                                  </span>
                                ) : null}
                                {standing?.qualified ? (
                                  <span className="text-[10px] text-emerald-300">
                                    晋级 · 第 {standing.qualificationOrder} 席
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          </th>
                          {group.entries.map((opponent) => {
                            if (opponent.entryId === entry.entryId)
                              return (
                                <td
                                  key={opponent.entryId}
                                  className="border-l border-white/5 bg-white/[0.025] text-center text-slate-600"
                                >
                                  —
                                </td>
                              );
                            const fixture = fixturesByPair.get(
                              [entry.entryId, opponent.entryId]
                                .sort()
                                .join(":"),
                            );
                            if (!fixture)
                              return (
                                <td
                                  key={opponent.entryId}
                                  className="border-l border-white/5 text-center text-slate-600"
                                >
                                  —
                                </td>
                              );
                            const view = groupViews.get(fixture.fixtureId)!;
                            const display = fixtureDisplay(
                              fixture,
                              view,
                              fixture.sideA.entryId,
                            );
                            const scores =
                              display.scores &&
                              (fixture.sideA.entryId === entry.entryId
                                ? display.scores
                                : [...display.scores].reverse());
                            const score = scores
                              ? scores.join(display.forfeit ? " / " : " : ")
                              : ownRow && view.canSubmitResult
                                ? "录分"
                                : display.status;
                            return (
                              <td
                                key={opponent.entryId}
                                className="border-l border-white/5 p-0.5 text-center"
                              >
                                <FixtureTrigger
                                  fixtureId={fixture.fixtureId}
                                  label={`${entry.frozenDisplayName} 对 ${opponent.frozenDisplayName}，${score}，${display.status}`}
                                  className={`flex min-h-12 w-full flex-col items-center justify-center gap-0.5 rounded-md px-1 py-2 tabular-nums transition-colors hover:bg-white/8 focus-visible:outline-2 focus-visible:outline-orange-400 ${display.pending ? "text-amber-300" : display.winnerEntryId === entry.entryId ? "text-emerald-300" : scores ? "text-slate-200" : "text-slate-500"}`}
                                >
                                  <span
                                    className={
                                      scores && !display.forfeit
                                        ? "text-sm font-semibold"
                                        : "text-[11px]"
                                    }
                                  >
                                    {score}
                                  </span>
                                  {display.pending ? (
                                    <span className="text-[9px] font-normal">
                                      {display.status}
                                    </span>
                                  ) : null}
                                </FixtureTrigger>
                              </td>
                            );
                          })}
                          {standing ? (
                            <>
                              <td className="border-l border-white/10 px-1 text-center tabular-nums text-slate-300">
                                {standing.wins} / {standing.losses}
                              </td>
                              <td
                                className={`px-1 text-center font-semibold tabular-nums ${standing.qualified ? "text-emerald-300" : "text-slate-400"}`}
                              >
                                {standing.rank}
                              </td>
                            </>
                          ) : standings ? (
                            <>
                              <td>—</td>
                              <td>—</td>
                            </>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="border-t border-white/8 px-4 py-2.5 text-[10px] leading-5 text-slate-500">
                <p>
                  行选手对列选手 · 编号对应左侧参赛方
                  <span className="sm:hidden"> · 左右滑动查看</span>
                </p>
                {standings ? (
                  <details className="mt-1">
                    <summary className="w-fit cursor-pointer text-slate-400 hover:text-slate-200">
                      查看最终排名与晋级明细
                    </summary>
                    <div className="mt-2 space-y-2">
                      {[...standings]
                        .sort((a, b) => a.rank - b.rank)
                        .map((standing) => (
                          <p
                            key={standing.standingId}
                            className="text-slate-400"
                          >
                            {standing.rank}. {standing.frozenDisplayName} ·{" "}
                            {standing.played} 场 · 得失分 {standing.scoreFor}:
                            {standing.scoreAgainst}（
                            {standing.scoreDifferential >= 0 ? "+" : ""}
                            {standing.scoreDifferential}） ·{" "}
                            {standing.qualified
                              ? `晋级第 ${standing.qualificationOrder} 席`
                              : (standing.ineligibilityReason ?? "未晋级")}
                          </p>
                        ))}
                    </div>
                  </details>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
  const knockoutContent =
    knockout && layout ? (
      <section aria-labelledby="knockout-schedule-title" className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2
              id="knockout-schedule-title"
              className={
                knockout ? "sr-only" : "text-lg font-semibold text-white"
              }
            >
              淘汰赛
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              {knockout.roundCount} 轮 · 胜者沿连线晋级，左右汇聚至决赛
            </p>
          </div>
          <p className="text-xs tabular-nums text-slate-400">
            已结束{" "}
            {knockoutFixtures.filter(({ fixture }) => ended(fixture)).length} /{" "}
            {knockout.fixtureCount} 场
          </p>
        </div>
        <div className="overflow-hidden rounded-xl border border-white/10 bg-[#0d131d]">
          <BracketViewport
            personalCenter={
              ownNode ? ownNode.x + BRACKET_NODE_WIDTH / 2 : undefined
            }
            finalCenter={
              layout.nodes.find((node) => node.side === "final")!.x +
              BRACKET_NODE_WIDTH / 2
            }
          >
            <div
              className="relative mx-auto"
              data-knockout-bracket
              style={{ width: layout.width, height: layout.height }}
            >
              {layout.columns.map((column, index) => (
                <p
                  key={index}
                  className={`absolute top-2 flex items-center justify-center gap-1.5 text-xs font-medium ${column.roundNumber === knockout.roundCount ? "text-white" : "text-slate-400"}`}
                  style={{ left: column.x, width: BRACKET_NODE_WIDTH }}
                >
                  {column.roundNumber === knockout.roundCount ? (
                    <Trophy size={14} aria-hidden="true" />
                  ) : null}
                  {bracketRoundLabel(column.roundNumber, knockout.roundCount)}
                </p>
              ))}
              <svg
                className="pointer-events-none absolute inset-0"
                width={layout.width}
                height={layout.height}
                aria-hidden="true"
              >
                {layout.edges.map((edge) => {
                  const source = knockoutViews.get(edge.sourceId)!;
                  const advanced = Boolean(
                    source.view?.authoritativeResult ||
                      source.fixture.administrativeResolution?.advancingEntryId,
                  );
                  return (
                    <path
                      data-bracket-connector
                      key={`${edge.sourceId}-${edge.targetId}`}
                      d={edge.path}
                      fill="none"
                      stroke={advanced ? "#64748b" : "#354153"}
                      strokeOpacity={advanced ? 0.7 : 1}
                      strokeWidth={1.5}
                    />
                  );
                })}
              </svg>
              {layout.nodes.map((node) => {
                const { fixture, view } = knockoutViews.get(node.fixtureId)!;
                const display = fixtureDisplay(
                  fixture,
                  view,
                  fixture.sideA.entry?.entryId,
                );
                const sides = [fixture.sideA, fixture.sideB];
                const ownFixture = sides.some((side) => isMine(side.entry));
                const status = fixture.administrativeResolution
                  ? fixture.administrativeResolution.kind === "ADMIN_BYE"
                    ? "轮空晋级"
                    : "无结果"
                  : display.status;
                return (
                  <FixtureTrigger
                    key={fixture.fixtureId}
                    fixtureId={fixture.fixtureId}
                    label={`${bracketRoundLabel(fixture.roundNumber, knockout.roundCount)}第 ${fixture.position} 场，${sides.map((side) => side.entry?.frozenDisplayName ?? feederLabel(side, groupNames, knockout.roundCount)).join(" 对 ")}，${status}`}
                    style={{
                      left: node.x,
                      top: node.y,
                      width: BRACKET_NODE_WIDTH,
                      height: BRACKET_NODE_HEIGHT,
                    }}
                    className={`absolute overflow-hidden rounded-lg border bg-[#111a27] text-left transition-colors hover:border-slate-400/70 focus-visible:outline-2 focus-visible:outline-orange-400 ${ownFixture ? "border-orange-300/60" : node.side === "final" ? "border-slate-400/60" : display.pending ? "border-amber-400/35" : "border-white/12"}`}
                  >
                    {sides.map((side, index) => {
                      const won =
                        side.entry &&
                        (display.winnerEntryId === side.entry.entryId ||
                          fixture.administrativeResolution?.advancingEntryId ===
                            side.entry.entryId);
                      return (
                        <span
                          key={index}
                          className={`flex h-8 items-center justify-between gap-2 px-3 text-xs ${index === 1 ? "border-t border-white/6" : ""} ${won ? "bg-emerald-400/[0.06] font-medium text-emerald-200" : side.entry ? "text-slate-200" : "text-slate-500"}`}
                        >
                          <span className="truncate">
                            {isMine(side.entry) ? (
                              <span className="mr-1 text-[10px] text-orange-200">
                                {ownLabel} ·
                              </span>
                            ) : null}
                            {side.entry?.frozenDisplayName ??
                              feederLabel(
                                side,
                                groupNames,
                                knockout.roundCount,
                              )}
                          </span>
                          <span
                            className={`shrink-0 font-semibold tabular-nums ${display.pending && !display.winnerEntryId ? "text-amber-300" : ""}`}
                          >
                            {display.scores?.[index] ?? "—"}
                          </span>
                        </span>
                      );
                    })}
                    <span
                      className={`flex h-8 items-center justify-between gap-2 border-t border-white/6 px-3 text-[10px] ${display.pending ? "text-amber-300" : "text-slate-500"}`}
                    >
                      <span>第 {fixture.position} 场</span>
                      <span>{status}</span>
                    </span>
                  </FixtureTrigger>
                );
              })}
            </div>
          </BracketViewport>
          <p className="border-t border-white/8 px-4 py-2.5 text-[10px] text-slate-500">
            胜者沿连线晋级 · 点击对局查看单场
          </p>
        </div>
      </section>
    ) : null;
  return (
    <ScheduleFixtureDialog fixtures={fixtureDetails}>
      <ScheduleStages
        key={knockout ? "knockout-published" : "groups"}
        defaultId={knockoutContent ? "knockout" : "group"}
        stages={[
          { id: "group", label: "小组赛", content: groupContent },
          ...(knockoutContent
            ? [{ id: "knockout", label: "淘汰赛", content: knockoutContent }]
            : []),
        ]}
      />
      {!knockoutContent && grouping.kind === "GROUP_THEN_KNOCKOUT_V2_MATCH" ? (
        <p className="mt-5 text-xs leading-6 text-slate-400">
          {grouping.managementState === "READY_TO_FINALIZE"
            ? "小组成绩已全部确认，等待管理员发布晋级名单与淘汰赛程。"
            : "淘汰赛程将在小组成绩全部确认后发布。"}
        </p>
      ) : null}
    </ScheduleFixtureDialog>
  );
}
