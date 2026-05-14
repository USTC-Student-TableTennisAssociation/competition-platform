"use client";

import { useActionState, useMemo, useState } from "react";
import {
  previewGroupingAction,
  confirmGroupingAction,
  type GroupingAdminState,
} from "@/app/matchs/actions";
import KnockoutBracket from "@/components/match/KnockoutBracket";

type GroupingPayload = {
  generatedAt?: string;
  config?: {
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
  tableAssignments?: {
    group?: Record<string, string[]>;
    knockout?: Record<string, string[]>;
  };
  knockout?: {
    stage: string;
    bracketSize: number;
    rounds: Array<{
      name: string;
      matches: Array<{ id: string; homeLabel: string; awayLabel: string }>;
    }>;
  };
};

type SeedMethod = "min_diff" | "snake";

type Props = {
  matchId: string;
  initialPayloadJson?: string;
  collapsible?: boolean;
  matchFormat: "group_only" | "group_then_knockout";
  participantCount: number;
  defaultGroupCount: number;
  defaultQualifiersPerGroup: number;
};

const initialState: GroupingAdminState = {};

function parsePayload(text?: string) {
  if (!text) return null;
  try {
    const payload = JSON.parse(text) as GroupingPayload;
    if (!payload?.groups) return payload;

    return {
      ...payload,
      groups: payload.groups.map((group) => ({
        ...group,
        averagePoints: recalculateGroupAverage(group),
      })),
    };
  } catch {
    return null;
  }
}

function recalculateGroupAverage(group: GroupingPayload["groups"][number]) {
  if (group.players.length === 0) return 0;
  const sum = group.players.reduce(
    (acc, player) =>
      acc + (Number.isFinite(player.eloRating) ? player.eloRating : 0),
    0,
  );
  return Math.round(sum / group.players.length);
}

function isPowerOfTwo(value: number) {
  return value > 0 && (value & (value - 1)) === 0;
}

function buildGroupSizeSummary(groups: GroupingPayload["groups"]) {
  const bucket = new Map<number, number>();
  for (const group of groups) {
    const size = group.players.length;
    bucket.set(size, (bucket.get(size) ?? 0) + 1);
  }

  return [...bucket.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([size, count]) => `${size}人组×${count}`)
    .join("，");
}

function normalizeTables(raw: string) {
  return raw
    .split(/[,，\s]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export default function GroupingAdminPanel({
  matchId,
  initialPayloadJson,
  collapsible = true,
  matchFormat,
  participantCount,
  defaultGroupCount,
  defaultQualifiersPerGroup,
}: Props) {
  const previewAction = previewGroupingAction.bind(null, matchId);
  const confirmAction = confirmGroupingAction.bind(null, matchId);

  const [previewState, previewFormAction, previewPending] = useActionState(
    previewAction,
    initialState,
  );
  const [confirmState, confirmFormAction, confirmPending] = useActionState(
    confirmAction,
    initialState,
  );
  const initialPayload = parsePayload(initialPayloadJson);
  const previewPayload = useMemo(
    () => parsePayload(previewState.previewJson),
    [previewState.previewJson],
  );
  const [editablePayload, setEditablePayload] =
    useState<GroupingPayload | null>(() => initialPayload);
  const [editableSourceGeneratedAt, setEditableSourceGeneratedAt] = useState<
    string | null
  >(initialPayload?.generatedAt ?? null);
  const [moveTargets, setMoveTargets] = useState<Record<string, string>>({});
  const [groupCount, setGroupCount] = useState(defaultGroupCount);
  const [qualifiersPerGroup, setQualifiersPerGroup] = useState(
    defaultQualifiersPerGroup,
  );
  const [seedMethod, setSeedMethod] = useState<SeedMethod>(
    initialPayload?.config?.seedMethod ?? "min_diff",
  );

  const potentialFailureReasons: string[] = [];
  if (participantCount < 2) {
    potentialFailureReasons.push("报名人数不足（至少需要 2 人）");
  }
  if (!Number.isFinite(groupCount) || groupCount < 1) {
    potentialFailureReasons.push("组数必须为正整数");
  }
  if (groupCount > participantCount) {
    potentialFailureReasons.push("组数不能超过报名人数");
  }
  if (matchFormat === "group_then_knockout") {
    const totalQualified = groupCount * qualifiersPerGroup;
    if (!Number.isFinite(qualifiersPerGroup) || qualifiersPerGroup < 1) {
      potentialFailureReasons.push("每组晋级人数必须为正整数");
    }
    if (qualifiersPerGroup > participantCount) {
      potentialFailureReasons.push("每组晋级人数不能超过报名人数");
    }
    if (
      Number.isFinite(groupCount) &&
      Number.isFinite(qualifiersPerGroup) &&
      groupCount >= 1 &&
      qualifiersPerGroup >= 1 &&
      !isPowerOfTwo(totalQualified)
    ) {
      potentialFailureReasons.push("组数 × 每组晋级人数 必须为 2 的次幂");
    }
    if (
      Number.isFinite(groupCount) &&
      groupCount >= 1 &&
      Math.ceil(participantCount / groupCount) < qualifiersPerGroup
    ) {
      potentialFailureReasons.push(
        "存在小组人数可能小于晋级人数，请减少组数或降低晋级人数",
      );
    }
  }

  const payload =
    previewPayload &&
    editablePayload &&
    editableSourceGeneratedAt &&
    previewPayload.generatedAt !== editableSourceGeneratedAt
      ? previewPayload
      : (editablePayload ?? previewPayload ?? initialPayload);

  const handleMovePlayer = (playerId: string, sourceGroupName: string) => {
    if (!payload) return;
    const targetGroupName = moveTargets[playerId];
    if (!targetGroupName || targetGroupName === sourceGroupName) return;

    const sourceGroup = payload.groups.find(
      (group) => group.name === sourceGroupName,
    );
    if (!sourceGroup) return;

    const movingPlayer = sourceGroup.players.find(
      (player) => player.id === playerId,
    );
    if (!movingPlayer) return;

    const nextGroups = payload.groups.map((group) => {
      if (group.name === sourceGroup.name) {
        const players = group.players.filter(
          (player) => player.id !== playerId,
        );
        return {
          ...group,
          players,
          averagePoints: recalculateGroupAverage({ ...group, players }),
        };
      }

      if (group.name === targetGroupName) {
        const players = [...group.players, movingPlayer];
        return {
          ...group,
          players,
          averagePoints: recalculateGroupAverage({ ...group, players }),
        };
      }

      return group;
    });

    setEditableSourceGeneratedAt(payload.generatedAt ?? null);
    setEditablePayload({
      ...payload,
      groups: nextGroups,
    });

    setMoveTargets((prev) => ({
      ...prev,
      [playerId]: "",
    }));
  };

  const panelContent = (
    <div className={collapsible ? "mt-5 space-y-5" : "space-y-5"}>
      <div
        className={
          collapsible
            ? "space-y-4 rounded-xl border border-slate-700 bg-slate-900/70 p-4"
            : "space-y-4"
        }
      >
        <form
          action={previewFormAction}
          className="space-y-3 rounded-lg border border-slate-700 bg-slate-900/60 p-3"
        >
          <input type="hidden" name="csrfToken" defaultValue="" />
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-sm text-slate-300">
              <span>组数设置</span>
              <input
                type="number"
                name="groupCount"
                min={1}
                max={Math.max(participantCount, 1)}
                value={groupCount}
                onChange={(event) =>
                  setGroupCount(Number(event.target.value) || 1)
                }
                className="w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 text-slate-100"
              />
            </label>

            {matchFormat === "group_then_knockout" ? (
              <label className="space-y-1 text-sm text-slate-300">
                <span>每组晋级人数</span>
                <input
                  type="number"
                  name="qualifiersPerGroup"
                  min={1}
                  max={Math.max(participantCount, 1)}
                  value={qualifiersPerGroup}
                  onChange={(event) =>
                    setQualifiersPerGroup(Number(event.target.value) || 1)
                  }
                  className="w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 text-slate-100"
                />
              </label>
            ) : (
              <div className="space-y-1 text-sm text-slate-400">
                <span>每组晋级人数</span>
                <p className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-400">
                  当前赛制为仅分组，不启用晋级设置
                </p>
              </div>
            )}
          </div>

          <label className="space-y-1 text-sm text-slate-300">
            <span>分组方式</span>
            <select
              name="seedMethod"
              value={seedMethod}
              onChange={(event) =>
                setSeedMethod(event.target.value as SeedMethod)
              }
              className="w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 text-slate-100"
            >
              <option value="min_diff">组内分差最小</option>
              <option value="snake">蛇形排列</option>
            </select>
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={previewPending}
              className="rounded-lg border border-cyan-500/40 px-3 py-1.5 text-sm text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-60"
            >
              {previewPending ? "生成中..." : "生成分组预览"}
            </button>
            <p className="text-xs text-slate-400">
              参赛人数：{participantCount}，可先调整参数再生成预览。
            </p>
          </div>

          {potentialFailureReasons.length > 0 ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2">
              <p className="text-xs font-medium text-amber-200">
                当前参数可能导致分组失败：
              </p>
              <ul className="mt-1 space-y-1 text-xs text-amber-100/90">
                {potentialFailureReasons.map((reason) => (
                  <li key={reason}>• {reason}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {previewState.error ? (
            <p className="text-sm text-rose-300">{previewState.error}</p>
          ) : null}
          {previewState.success ? (
            <p className="text-sm text-emerald-300">{previewState.success}</p>
          ) : null}

          {payload && payload.groups.length > 0 ? (
            <div className="rounded-md border border-emerald-500/35 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-200">
              分组成功：共 {payload.groups.length} 组，
              {buildGroupSizeSummary(payload.groups)}。
            </div>
          ) : null}
        </form>

        {payload ? (
          <>
          <p className="text-sm text-slate-300">
            当前编辑中的分组结果（确认后会发布给所有用户）
          </p>

          <div className="space-y-1">
            <h4 className="text-sm font-semibold text-cyan-100">
              调整分组成员
            </h4>
            <p className="text-xs text-slate-300">
              直接在对应小组内为选手选择目标组并移动，无需全局搜索选手。
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {payload.groups.map((group) => (
              <div
                key={group.name}
                className="rounded-lg border border-slate-700 p-3"
              >
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-medium text-cyan-100">
                    {group.name}
                  </span>
                  <span className="text-xs text-slate-400">
                    组均 ELO {group.averagePoints}
                  </span>
                </div>
                <ul className="space-y-2 text-sm text-slate-200">
                  {group.players.map((p) => (
                    <li
                      key={p.id}
                      className="rounded-md border border-slate-700 bg-slate-900/70 p-2"
                    >
                      <div className="flex justify-between">
                        <span>{p.nickname}</span>
                        <span className="text-slate-400">
                          {p.points} / ELO {p.eloRating}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <select
                          aria-label={`为 ${p.nickname} 选择目标组`}
                          value={moveTargets[p.id] ?? ""}
                          onChange={(event) =>
                            setMoveTargets((prev) => ({
                              ...prev,
                              [p.id]: event.target.value,
                            }))
                          }
                          className="flex-1 rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                        >
                          <option value="">选择目标组</option>
                          {payload.groups
                            .filter((target) => target.name !== group.name)
                            .map((target) => (
                              <option key={target.name} value={target.name}>
                                {target.name}
                              </option>
                            ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => handleMovePlayer(p.id, group.name)}
                          className="rounded-md border border-cyan-400/40 px-2 py-1 text-xs text-cyan-200 hover:bg-cyan-500/10"
                        >
                          移动
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="space-y-3">
            <div className="space-y-1">
              <h4 className="text-sm font-semibold text-cyan-100">
                对局桌号设置
              </h4>
              <p className="text-xs text-slate-300">
                支持填写多个桌号，用逗号或空格分隔（例如：1,2 或 1 2）。
              </p>
            </div>

            {payload.groups.map((group) => {
              const currentTables =
                payload.tableAssignments?.group?.[group.name] ?? [];
              const inputValue = currentTables.join(", ");

              return (
                <div
                  key={`tables-${group.name}`}
                  className="rounded-lg border border-slate-700 bg-slate-900/60 p-3"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-sm font-medium text-slate-100">
                      {group.name}
                    </span>
                    <span className="text-xs text-slate-400">小组对局桌号</span>
                  </div>
                  <input
                    type="text"
                    value={inputValue}
                    onChange={(event) => {
                      if (!payload) return;
                      const tables = normalizeTables(event.target.value);

                      const nextGroupAssignments = {
                        ...(payload.tableAssignments?.group ?? {}),
                      } as Record<string, string[]>;

                      if (tables.length > 0) {
                        nextGroupAssignments[group.name] = tables;
                      } else {
                        delete nextGroupAssignments[group.name];
                      }

                      const nextTableAssignments = {
                        group: nextGroupAssignments,
                        knockout: {
                          ...(payload.tableAssignments?.knockout ?? {}),
                        },
                      };

                      const hasAnyTables =
                        Object.keys(nextTableAssignments.group).length > 0 ||
                        Object.keys(nextTableAssignments.knockout).length > 0;

                      setEditableSourceGeneratedAt(payload.generatedAt ?? null);
                      setEditablePayload({
                        ...payload,
                        tableAssignments: hasAnyTables
                          ? nextTableAssignments
                          : undefined,
                      });
                    }}
                    placeholder="桌号，如 1 或 1,2"
                    className="w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                  />
                  <p className="mt-2 text-xs text-slate-400">
                    该桌号适用于本组全部对局。
                  </p>
                </div>
              );
            })}

            {payload.knockout ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-slate-100">
                    淘汰赛对局桌号
                  </h4>
                  <span className="text-xs text-slate-400">
                    {payload.knockout.stage}
                  </span>
                </div>
                <div className="space-y-2">
                  {payload.knockout.rounds.map((round) => (
                    <div
                      key={`knockout-${round.name}`}
                      className="rounded-lg border border-slate-700 bg-slate-900/60 p-3"
                    >
                      <p className="mb-2 text-xs font-semibold text-slate-200">
                        {round.name}
                      </p>
                      <div className="space-y-2">
                        {round.matches.map((match) => {
                          const currentTables =
                            payload.tableAssignments?.knockout?.[match.id] ??
                            [];
                          const inputValue = currentTables.join(", ");

                          return (
                            <div
                              key={`knockout-${round.name}-${match.id}`}
                              className="flex flex-col gap-2 rounded-md border border-slate-700 bg-slate-900/70 p-2 sm:flex-row sm:items-center"
                            >
                              <div className="text-xs text-slate-200 sm:min-w-56">
                                {match.homeLabel} vs {match.awayLabel}
                              </div>
                              <input
                                type="text"
                                value={inputValue}
                                onChange={(event) => {
                                  if (!payload) return;
                                  const tables = normalizeTables(
                                    event.target.value,
                                  );

                                  const nextKnockoutAssignments = {
                                    ...(payload.tableAssignments?.knockout ??
                                      {}),
                                  } as Record<string, string[]>;

                                  if (tables.length > 0) {
                                    nextKnockoutAssignments[match.id] = tables;
                                  } else {
                                    delete nextKnockoutAssignments[match.id];
                                  }

                                  const nextTableAssignments = {
                                    group: {
                                      ...(payload.tableAssignments?.group ??
                                        {}),
                                    },
                                    knockout: nextKnockoutAssignments,
                                  };

                                  const hasAnyTables =
                                    Object.keys(nextTableAssignments.group)
                                      .length > 0 ||
                                    Object.keys(nextTableAssignments.knockout)
                                      .length > 0;

                                  setEditableSourceGeneratedAt(
                                    payload.generatedAt ?? null,
                                  );
                                  setEditablePayload({
                                    ...payload,
                                    tableAssignments: hasAnyTables
                                      ? nextTableAssignments
                                      : undefined,
                                  });
                                }}
                                placeholder="桌号，如 3 或 3,4"
                                className="w-full flex-1 rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                              />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {payload.knockout && (
            <div className="space-y-2">
              <h4 className="font-medium text-cyan-100">
                {payload.knockout.stage}（仅展示，不支持在此调整签位）
              </h4>
              <KnockoutBracket rounds={payload.knockout.rounds} />
            </div>
          )}

          <form action={confirmFormAction}>
            <input type="hidden" name="csrfToken" defaultValue="" />
            <input
              type="hidden"
              name="previewJson"
              value={JSON.stringify(payload)}
            />
            <button
              disabled={confirmPending}
              className="rounded-lg bg-linear-to-r from-cyan-500 to-blue-500 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            >
              {confirmPending ? "发布中..." : "保存并发布分组结果"}
            </button>
          </form>
          {confirmState.error && (
            <p className="text-sm text-rose-300">{confirmState.error}</p>
          )}
          {confirmState.success && (
            <p className="text-sm text-emerald-300">{confirmState.success}</p>
          )}
          </>
        ) : (
          <p className="rounded-md border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-slate-300">
            还没有可编辑的分组预览，请先调整参数并点击“生成分组预览”。
          </p>
        )}
      </div>
    </div>
  );

  if (!collapsible) {
    return (
      <section className="space-y-4">
        <h2 className="text-xl font-semibold text-white">
          分组与签位管理（发起人/管理员）
        </h2>
        {panelContent}
      </section>
    );
  }

  return (
    <details className="rounded-2xl border border-amber-400/30 bg-amber-500/5 p-6">
      <summary className="cursor-pointer list-none text-lg font-semibold text-amber-100 marker:hidden">
        <span className="inline-flex items-center gap-2">
          分组与签位管理（发起人/管理员）
          <span className="text-xs font-normal text-amber-200/70">
            默认折叠，点击展开
          </span>
        </span>
      </summary>
      {panelContent}
    </details>
  );
}
