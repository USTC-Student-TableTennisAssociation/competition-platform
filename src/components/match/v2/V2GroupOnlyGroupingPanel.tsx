"use client";

import { useActionState, useMemo, useState } from "react";
import {
  groupVenueOptions,
  isGroupVenueAssignmentValid,
  readGroupVenueAssignment,
} from "@/modules/competitions-v2/domain/group-venue";
import V2GroupVenue from "./V2GroupVenue";

import {
  getV2GroupOnlyGroupingPublishIssues,
  moveV2GroupOnlyGroupingEntry,
  parseV2GroupOnlyGroupingUiPreview,
  serializeV2GroupOnlyGroupingUiPayload,
  type V2GroupOnlyGroupingCompetitorType,
  type V2GroupOnlyGroupingFormat,
  type V2GroupOnlyGroupingPublishIssue,
  type V2GroupOnlyGroupingSeedMethod,
  type V2GroupOnlyGroupingUiPayload,
} from "@/modules/competitions-v2/adapters/group-only-grouping-ui";

export type V2GroupOnlyGroupingActionState = Readonly<{
  error?: string;
  success?: string;
  previewJson?: string;
}>;

export type V2GroupOnlyGroupingAction = (
  matchId: string,
  previousState: V2GroupOnlyGroupingActionState,
  formData: FormData,
) => Promise<V2GroupOnlyGroupingActionState>;

const INITIAL_STATE: V2GroupOnlyGroupingActionState = {};

const PUBLISH_ISSUE_MESSAGES: Readonly<
  Record<V2GroupOnlyGroupingPublishIssue, string>
> = {
  INVALID_STRUCTURE: "分组预览结构异常，请重新生成预览。",
  GROUP_TOO_SMALL: "每个小组至少需要 2 个 参赛方，请先调整分组。",
  QUALIFIER_CONFIG_INVALID:
    "每组晋级数必须适配所有小组，且总晋级数必须是 2 的幂。",
  ENTRY_SET_MISMATCH: "预览名单与当前报名不一致，请重新生成预览。",
  TOO_MANY_FIXTURES: "当前分组会产生过多对局，请增加小组数量后重新预览。",
  PAYLOAD_TOO_LARGE: "分组预览数据过大，无法安全发布。",
};

type EditablePayload = Readonly<{
  sourcePreviewJson: string;
  payload: V2GroupOnlyGroupingUiPayload;
}>;

type Props = Readonly<{
  matchId: string;
  matchLabel: "单打" | "双打" | "团体";
  entryLabel: string;
  countUnit: string;
  competitorType: V2GroupOnlyGroupingCompetitorType;
  previewAction: V2GroupOnlyGroupingAction;
  publishAction: V2GroupOnlyGroupingAction;
  updateTableLabelsAction?: V2GroupOnlyGroupingAction;
  participantCount: number;
  defaultGroupCount: number;
  format?: V2GroupOnlyGroupingFormat;
  defaultQualifiersPerGroup?: number;
  published?: boolean;
  managementState?:
    | "UNPUBLISHED"
    | "GROUP_IN_PROGRESS"
    | "READY_TO_FINALIZE"
    | "KNOCKOUT_PUBLISHED";
  finalizeAction?: V2GroupOnlyGroupingAction;
  knockoutSummary?: Readonly<{
    fixtureCount: number;
    roundCount: number;
  }> | null;
  canEditTableLabels?: boolean;
  publishedGroups?: readonly Readonly<{
    groupKey: string;
    label: string;
    tableLabels: readonly string[];
    expectedFixtures: readonly Readonly<{
      fixtureId: string;
      version: number;
    }>[];
    competitorNames?: readonly string[];
  }>[];
}>;

function FinalizeGroupStageForm({
  matchId,
  action,
}: Readonly<{ matchId: string; action: V2GroupOnlyGroupingAction }>) {
  const [state, formAction, pending] = useActionState(
    action.bind(null, matchId),
    INITIAL_STATE,
  );
  return (
    <form
      action={formAction}
      className="space-y-3 rounded-lg border border-amber-400/30 bg-amber-400/5 p-3"
    >
      <input type="hidden" name="csrfToken" defaultValue="" />
      <p className="text-sm text-amber-100">
        所有小组成绩均已确认。发布后，小组排名和淘汰赛程将正式确定。
      </p>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "生成中..." : "确认小组排名并生成淘汰签表"}
      </button>
      <StateMessage state={state} />
    </form>
  );
}

function clampDefaultGroupCount(participantCount: number, requested: number) {
  const maximum = Math.max(1, Math.floor(participantCount / 2));
  if (!Number.isSafeInteger(requested)) return 1;
  return Math.min(Math.max(requested, 1), maximum);
}

function groupSizeSummary(
  payload: V2GroupOnlyGroupingUiPayload,
  countUnit: string,
) {
  const sizes = new Map<number, number>();
  for (const group of payload.groups) {
    sizes.set(group.players.length, (sizes.get(group.players.length) ?? 0) + 1);
  }
  return [...sizes.entries()]
    .sort(([left], [right]) => right - left)
    .map(([size, count]) => `每组 ${size} ${countUnit} × ${count}`)
    .join("，");
}

function StateMessage({
  state,
}: Readonly<{ state: V2GroupOnlyGroupingActionState }>) {
  return (
    <>
      {state.error ? (
        <p className="text-sm text-rose-300">{state.error}</p>
      ) : null}
      {state.success ? (
        <p role="status" aria-live="polite" className="text-sm text-emerald-300">
          {state.success}
        </p>
      ) : null}
    </>
  );
}

function PublishedGroupTableLabelsForm({
  matchId,
  group,
  action,
}: Readonly<{
  matchId: string;
  group: NonNullable<Props["publishedGroups"]>[number];
  action: V2GroupOnlyGroupingAction;
}>) {
  const boundAction = action.bind(null, matchId);
  const [state, formAction, pending] = useActionState(
    boundAction,
    INITIAL_STATE,
  );
  const assignment = readGroupVenueAssignment(group.tableLabels);
  const options = groupVenueOptions();
  const sourceLabels = JSON.stringify(group.tableLabels);
  const [draft, setDraft] = useState<{
    sourceLabels: string;
    venue: string | null;
    value: string;
  }>(() => ({
    sourceLabels,
    venue: assignment.conflicting ? null : assignment.venue ?? "",
    value: assignment.tableLabels.join("\n"),
  }));
  // Refresh saved fields when server labels change without remounting the
  // action state, so the organizer can still see the save confirmation.
  if (draft.sourceLabels !== sourceLabels) {
    setDraft({
      sourceLabels,
      venue: assignment.conflicting ? null : assignment.venue ?? "",
      value: assignment.tableLabels.join("\n"),
    });
  }
  const { venue, value } = draft;

  const tableLabels = value
    .split(/\r?\n/)
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
  const labels = [...(venue ? [venue] : []), ...tableLabels];
  const campusInTableLabels =
    readGroupVenueAssignment(tableLabels).venues.length > 0;
  const unresolvedConflict = assignment.conflicting && venue === null;
  const duplicate = new Set(labels).size !== labels.length;
  const tooMany = labels.length > 32;
  const tooLong = labels.some((label) => label.length > 64);
  const invalid =
    duplicate || tooMany || tooLong || campusInTableLabels ||
    unresolvedConflict || !isGroupVenueAssignmentValid(labels);

  return (
    <form
      action={formAction}
      className="space-y-3 rounded-lg border border-slate-700 bg-slate-950/35 p-3"
    >
      <input type="hidden" name="csrfToken" defaultValue="" />
      <input type="hidden" name="groupKey" value={group.groupKey} />
      <input
        type="hidden"
        name="expectedFixturesJson"
        value={JSON.stringify(group.expectedFixtures)}
      />
      <input type="hidden" name="labelsJson" value={JSON.stringify(labels)} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-medium text-cyan-100">{group.label}</h4>
        <span className="text-xs text-slate-400">
          {group.expectedFixtures.length} 场小组对局
        </span>
      </div>
      {group.competitorNames?.length ? (
        <p className="break-words text-sm leading-6 text-slate-200">
          {group.competitorNames.join("、")}
        </p>
      ) : null}
      <div className="space-y-2">
        <label
          htmlFor={`v2-group-venue-${group.groupKey}`}
          className="block text-sm text-slate-300"
        >
          小组校区
        </label>
        <select
          id={`v2-group-venue-${group.groupKey}`}
          value={venue ?? "conflicting"}
          disabled={pending}
          aria-invalid={unresolvedConflict}
          aria-describedby={`v2-group-venue-hint-${group.groupKey}`}
          onChange={(event) => {
            const nextVenue = event.target.value;
            setDraft((current) => ({ ...current, venue: nextVenue }));
          }}
          className="min-h-11 w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus-visible:outline-2 focus-visible:outline-orange-300 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {unresolvedConflict ? (
            <option value="conflicting" disabled>
              请选择唯一校区
            </option>
          ) : null}
          <option value="">待安排</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <p
          id={`v2-group-venue-hint-${group.groupKey}`}
          className="text-xs leading-5 text-slate-400"
        >
          同组统一在所选校区比赛；具体安排以小组赛程为准。
        </p>
      </div>
      {unresolvedConflict ? (
        <p role="alert" className="text-sm text-amber-200">
          原场地同时包含东区和西区，请选择一个校区，或选择“待安排”后保存。
        </p>
      ) : null}
      <label
        htmlFor={`v2-table-labels-${group.groupKey}`}
        className="block text-sm text-slate-300"
      >
        桌号或其他场地说明（选填）
      </label>
      <textarea
        id={`v2-table-labels-${group.groupKey}`}
        value={value}
        rows={Math.max(2, Math.min(5, tableLabels.length || 2))}
        disabled={pending}
        aria-invalid={campusInTableLabels || duplicate || tooMany || tooLong}
        onChange={(event) => {
          const nextValue = event.target.value;
          setDraft((current) => ({ ...current, value: nextValue }));
        }}
        placeholder={"每行一项，例如：1 号台\n校区请在上方选择"}
        className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus-visible:outline-2 focus-visible:outline-orange-300 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <p className="text-xs text-slate-400">
        每行一项，保存后同步到本组全部对局和成员赛程；留空仅清除桌号或其他说明。
      </p>
      {campusInTableLabels ? (
        <p role="alert" className="text-sm text-rose-300">
          校区请在上方选择，不要填入桌号或说明。
        </p>
      ) : null}
      {duplicate ? (
        <p className="text-sm text-rose-300">标签不能重复。</p>
      ) : null}
      {tooMany ? (
        <p className="text-sm text-rose-300">校区与场地说明合计最多 32 项。</p>
      ) : null}
      {tooLong ? (
        <p className="text-sm text-rose-300">每个标签最多 64 个字符。</p>
      ) : null}
      <button
        type="submit"
        disabled={pending || invalid}
        className="min-h-11 rounded-lg border border-cyan-500/40 px-4 py-2 text-sm text-cyan-200 hover:bg-cyan-500/10 focus-visible:outline-2 focus-visible:outline-orange-300 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "保存中..." : "保存小组场地"}
      </button>
      <StateMessage state={state} />
    </form>
  );
}

export default function V2GroupOnlyGroupingPanel({
  matchId,
  matchLabel,
  entryLabel,
  countUnit,
  competitorType,
  previewAction,
  publishAction,
  updateTableLabelsAction,
  participantCount,
  defaultGroupCount,
  format = "group_only",
  defaultQualifiersPerGroup = 2,
  published = false,
  managementState,
  finalizeAction,
  knockoutSummary = null,
  canEditTableLabels = false,
  publishedGroups = [],
}: Props) {
  const boundPreviewAction = previewAction.bind(null, matchId);
  const boundPublishAction = publishAction.bind(null, matchId);
  const [previewState, previewFormAction, previewPending] = useActionState(
    boundPreviewAction,
    INITIAL_STATE,
  );
  const [publishState, publishFormAction, publishPending] = useActionState(
    boundPublishAction,
    INITIAL_STATE,
  );
  const safeParticipantCount = Number.isSafeInteger(participantCount)
    ? Math.max(participantCount, 0)
    : 0;
  const [groupCount, setGroupCount] = useState(() =>
    clampDefaultGroupCount(safeParticipantCount, defaultGroupCount),
  );
  const [seedMethod, setSeedMethod] =
    useState<V2GroupOnlyGroupingSeedMethod>("min_diff");
  const [qualifiersPerGroup, setQualifiersPerGroup] = useState(() =>
    Number.isSafeInteger(defaultQualifiersPerGroup) &&
    defaultQualifiersPerGroup > 0
      ? defaultQualifiersPerGroup
      : 2,
  );
  const [editable, setEditable] = useState<EditablePayload | null>(null);
  const [moveTargets, setMoveTargets] = useState<Record<string, string>>({});
  const [localError, setLocalError] = useState<string | null>(null);

  const previewResult = useMemo(
    () =>
      parseV2GroupOnlyGroupingUiPreview(
        previewState.previewJson,
        matchId,
        competitorType,
        format,
      ),
    [competitorType, format, matchId, previewState.previewJson],
  );
  const sourcePreviewJson = previewState.previewJson;
  const payload =
    previewResult.ok && sourcePreviewJson
      ? editable?.sourcePreviewJson === sourcePreviewJson
        ? editable.payload
        : previewResult.payload
      : null;
  const publishIssues = payload
    ? getV2GroupOnlyGroupingPublishIssues(payload, competitorType, format)
    : ([] as const);
  const publishJson = payload
    ? serializeV2GroupOnlyGroupingUiPayload(payload, competitorType, format)
    : null;
  const settingsDifferFromPreview = Boolean(
    payload &&
      (payload.config.groupCount !== groupCount ||
        payload.config.seedMethod !== seedMethod ||
        (format === "group_then_knockout" &&
          payload.config.qualifiersPerGroup !== qualifiersPerGroup)),
  );
  const invalidPreview = Boolean(
    sourcePreviewJson && !previewResult.ok && !previewState.error,
  );
  const totalQualifiers = qualifiersPerGroup * groupCount;
  const previewParameterError =
    safeParticipantCount < 2
      ? "至少需要 2 个有效报名才能分组。"
      : groupCount * 2 > safeParticipantCount
        ? "每个小组至少需要 2 个参赛方，请减少组数。"
        : format === "group_then_knockout" &&
            (qualifiersPerGroup >
              Math.floor(safeParticipantCount / groupCount) ||
              totalQualifiers < 2 ||
              !Number.isSafeInteger(totalQualifiers) ||
              !Number.isInteger(Math.log2(totalQualifiers)))
          ? "每组晋级数不能超过最小组人数，且总晋级数必须是 2 的幂。"
          : null;
  const locallyPublished = published || Boolean(publishState.success);
  const canPublish = Boolean(
    payload &&
      publishJson &&
      publishIssues.length === 0 &&
      !settingsDifferFromPreview &&
      !publishPending,
  );

  const moveEntry = (entryId: string, sourceGroupIndex: number) => {
    if (!payload || !sourcePreviewJson) return;
    const rawTarget = moveTargets[entryId];
    if (rawTarget === undefined || rawTarget === "") return;
    const targetGroupIndex = Number(rawTarget);
    const next = moveV2GroupOnlyGroupingEntry(
      payload,
      entryId,
      sourceGroupIndex,
      targetGroupIndex,
    );
    if (!next) {
      setLocalError("未能移动该参赛方，请重新生成预览后再试。");
      return;
    }
    setEditable({ sourcePreviewJson, payload: next });
    setMoveTargets((current) => ({ ...current, [entryId]: "" }));
    setLocalError(null);
  };

  if (locallyPublished) {
    return (
      <section className="space-y-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
        <h3 className="font-semibold text-emerald-100">小组赛分组已发布</h3>
        <p className="text-sm text-slate-300">
          按小组安排东区或西区，同组全部对局使用相同场地，成员可在赛程中查看。签位和对阵不能重新排列；需要换人时，请联系平台管理员在比赛详情的赛事管理中操作。
        </p>
        {!published ? <StateMessage state={publishState} /> : null}
        {format === "group_then_knockout" &&
        managementState === "GROUP_IN_PROGRESS" ? (
          <p className="rounded-lg border border-sky-400/30 bg-sky-400/5 p-3 text-sm text-sky-100">
            小组赛进行中：仍有未完成对局、待确认赛果或待处理的更正，暂不能生成淘汰签表。
          </p>
        ) : null}
        {format === "group_then_knockout" &&
        managementState === "READY_TO_FINALIZE" &&
        finalizeAction ? (
          <FinalizeGroupStageForm matchId={matchId} action={finalizeAction} />
        ) : null}
        {format === "group_then_knockout" &&
        managementState === "KNOCKOUT_PUBLISHED" ? (
          <p className="rounded-lg border border-violet-400/30 bg-violet-400/5 p-3 text-sm text-violet-100">
            淘汰签表已生成
            {knockoutSummary
              ? `：共 ${knockoutSummary.roundCount} 轮、${knockoutSummary.fixtureCount} 场。`
              : "。"}
            小组排名和晋级名单已确定，淘汰赛程已发布。
          </p>
        ) : null}
        {publishedGroups.length > 0 &&
        canEditTableLabels &&
        updateTableLabelsAction ? (
          <div className="grid gap-4 md:grid-cols-2">
            {publishedGroups.map((group) => (
              <PublishedGroupTableLabelsForm
                key={group.groupKey}
                matchId={matchId}
                group={group}
                action={updateTableLabelsAction}
              />
            ))}
          </div>
        ) : publishedGroups.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            {publishedGroups.map((group) => (
              <div
                key={group.groupKey}
                className="rounded-lg border border-slate-700 bg-slate-950/35 p-3"
              >
                <p className="font-medium text-cyan-100">{group.label}</p>
                {group.competitorNames?.length ? (
                  <p className="mt-1 text-sm text-slate-200">
                    {group.competitorNames.join("、")}
                  </p>
                ) : null}
                <p className="mt-1 text-sm text-slate-300">
                  {group.expectedFixtures.length} 场小组对局
                </p>
                {updateTableLabelsAction ? (
                  <>
                    <V2GroupVenue
                      labels={group.tableLabels}
                      showUnassigned
                      className="mt-2"
                    />
                    <p className="mt-1 text-xs text-slate-500">
                      当前状态不可编辑，标签仅供查看。
                    </p>
                  </>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-amber-200">
            暂时无法读取完整赛程，请刷新页面后重试。
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="space-y-5 rounded-xl border border-slate-700 bg-slate-900/70 p-4">
      <div>
        <h3 className="font-semibold text-cyan-100">{matchLabel}小组赛分组</h3>
        {format === "group_then_knockout" ? (
          <p className="mt-1 text-sm text-amber-200">
            当前状态：尚未发布小组分组。
          </p>
        ) : null}
        <p className="mt-1 text-sm text-slate-300">
          {format === "group_then_knockout"
            ? "先发布小组循环赛；全部成绩确认后，再确定排名并发布淘汰赛程。"
            : "当前赛制为小组内单循环。"}
          {updateTableLabelsAction ? "发布后可按小组安排校区和桌号，同组统一场地。" : ""}
        </p>
      </div>

      <form
        action={previewFormAction}
        className="space-y-3 rounded-lg border border-slate-700 bg-slate-950/35 p-3"
      >
        <input type="hidden" name="csrfToken" defaultValue="" />
        <div className="grid gap-3 md:grid-cols-3">
          <label className="space-y-1 text-sm text-slate-300">
            <span>小组数量</span>
            <input
              type="number"
              name="groupCount"
              min={1}
              max={Math.max(1, Math.floor(safeParticipantCount / 2))}
              value={groupCount}
              onChange={(event) => {
                const next = Number(event.target.value);
                setGroupCount(
                  Number.isSafeInteger(next) && next > 0 ? next : 1,
                );
              }}
              className="w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 text-slate-100"
            />
          </label>

          {format === "group_then_knockout" ? (
            <label className="space-y-1 text-sm text-slate-300">
              <span>每组晋级数</span>
              <input
                type="number"
                name="qualifiersPerGroup"
                min={1}
                max={Math.max(1, Math.floor(safeParticipantCount / groupCount))}
                value={qualifiersPerGroup}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setQualifiersPerGroup(
                    Number.isSafeInteger(next) && next > 0 ? next : 1,
                  );
                }}
                className="w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 text-slate-100"
              />
            </label>
          ) : null}

          <label className="space-y-1 text-sm text-slate-300">
            <span>分组方式</span>
            <select
              name="seedMethod"
              value={seedMethod}
              onChange={(event) =>
                setSeedMethod(
                  event.target.value as V2GroupOnlyGroupingSeedMethod,
                )
              }
              className="w-full rounded-md border border-slate-600 bg-slate-900 px-2 py-1.5 text-slate-100"
            >
              <option value="min_diff">按实力连续分组</option>
              <option value="snake">蛇形分组</option>
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={previewPending || Boolean(previewParameterError)}
            className="rounded-lg border border-cyan-500/40 px-3 py-1.5 text-sm text-cyan-200 hover:bg-cyan-500/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {previewPending ? "生成中..." : "生成分组预览"}
          </button>
          <p className="text-xs text-slate-400">
            当前报名{entryLabel}：{safeParticipantCount} {countUnit}。每组至少 2{" "}
            {countUnit}。
          </p>
        </div>
        {previewParameterError ? (
          <p className="text-sm text-amber-200">{previewParameterError}</p>
        ) : null}
        <StateMessage state={previewState} />
        {invalidPreview ? (
          <p className="text-sm text-rose-300">
            返回的预览结构无法安全识别，请刷新页面后重新生成。
          </p>
        ) : null}
      </form>

      {payload ? (
        <>
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-200">
            当前预览共 {payload.groups.length} 组：
            {groupSizeSummary(payload, countUnit)}。
          </div>

          <div className="space-y-1">
            <h4 className="text-sm font-semibold text-cyan-100">
              调整 参赛方 所属小组
            </h4>
            <p className="text-xs text-slate-400">
              名称、积分和 ELO 仅用于这次预览展示；发布时服务端会按 参赛方
              重新读取权威资料。
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            {payload.groups.map((group, groupIndex) => (
              <div
                key={`${groupIndex}-${group.name}`}
                className="rounded-lg border border-slate-700 bg-slate-950/25 p-3"
              >
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span className="font-medium text-cyan-100">
                    {group.name}
                  </span>
                  <span className="text-xs text-slate-400">
                    {group.players.length} {countUnit} · 预览均值{" "}
                    {group.averagePoints}
                  </span>
                </div>
                {group.players.length > 0 ? (
                  <ul className="space-y-2">
                    {group.players.map((player) => (
                      <li
                        key={player.id}
                        className="rounded-md border border-slate-700 bg-slate-900/75 p-2"
                      >
                        <div className="flex flex-wrap justify-between gap-2 text-sm">
                          <span className="text-slate-100">
                            {player.nickname}
                          </span>
                          <span className="text-slate-400">
                            积分 {player.points} · ELO {player.eloRating}
                          </span>
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <select
                            aria-label={`为 ${player.nickname} 选择目标组`}
                            value={moveTargets[player.id] ?? ""}
                            onChange={(event) =>
                              setMoveTargets((current) => ({
                                ...current,
                                [player.id]: event.target.value,
                              }))
                            }
                            className="min-w-0 flex-1 rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                          >
                            <option value="">选择目标组</option>
                            {payload.groups.map((target, targetIndex) =>
                              targetIndex === groupIndex ? null : (
                                <option key={targetIndex} value={targetIndex}>
                                  {target.name}
                                </option>
                              ),
                            )}
                          </select>
                          <button
                            type="button"
                            disabled={!moveTargets[player.id]}
                            onClick={() => moveEntry(player.id, groupIndex)}
                            className="rounded-md border border-cyan-400/40 px-2 py-1 text-xs text-cyan-200 hover:bg-cyan-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            移动
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="rounded-md border border-rose-500/30 bg-rose-500/5 p-2 text-sm text-rose-200">
                    当前小组为空，不能发布。
                  </p>
                )}
              </div>
            ))}
          </div>

          <form
            action={publishFormAction}
            className="space-y-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3"
          >
            <input type="hidden" name="csrfToken" defaultValue="" />
            <input type="hidden" name="previewJson" value={publishJson ?? ""} />
            <p className="text-sm text-slate-200">
              发布后将生成小组循环赛程，分组和对阵不能重新排列。
            </p>
            {settingsDifferFromPreview ? (
              <p className="text-sm text-amber-200">
                分组参数已改变，请先按新参数重新生成预览。
              </p>
            ) : null}
            {publishIssues.map((issue) => (
              <p key={issue} className="text-sm text-rose-300">
                {PUBLISH_ISSUE_MESSAGES[issue]}
              </p>
            ))}
            {localError ? (
              <p className="text-sm text-rose-300">{localError}</p>
            ) : null}
            <button
              type="submit"
              disabled={!canPublish}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {publishPending ? "发布中..." : "确认并发布分组"}
            </button>
            <StateMessage state={publishState} />
          </form>
        </>
      ) : null}
    </section>
  );
}
