import { createHash } from "node:crypto";
import {
  loadV2WriteContext,
  runV2Transaction,
  V2CompetitionApplicationError,
  type V2Actor,
  type V2CompetitionDatabase,
  type V2CompetitionTransaction,
} from "./entries";
import { finishV2GroupOnlyMatchIfTerminal } from "./match-completion";
import { v2UnplayedFixtureVoidAuditAction } from "./fixtures";

export class V2MatchClosureError extends Error {
  constructor(
    readonly code: "NOT_SUPPORTED" | "NOT_STARTED" | "PENDING_RESULTS" | "STALE_PREVIEW" | "INVALID_STATE",
    message: string,
  ) {
    super(message);
    this.name = "V2MatchClosureError";
  }
}

export type V2MatchClosurePreview = Readonly<{
  matchId: string;
  title: string;
  fingerprint: string;
  alreadyFinished: boolean;
  totalCount: number;
  completedCount: number;
  voidedCount: number;
  unsubmitted: readonly Readonly<{
    fixtureId: string;
    group: string;
    sideA: string;
    sideB: string;
    started: boolean;
  }>[];
  pending: readonly Readonly<{
    fixtureId: string;
    group: string;
    sideA: string;
    sideB: string;
    correction: boolean;
  }>[];
}>;

async function loadClosureSnapshot(
  tx: V2CompetitionTransaction,
  input: Readonly<{ actor: V2Actor; matchId: string }>,
) {
  const context = await loadV2WriteContext(tx, input.matchId, input.actor);
  if (context.actor.role !== "admin") {
    throw new V2CompetitionApplicationError("FORBIDDEN", "Only an administrator can finish a competition.");
  }
  if (context.match.format !== "group_only") {
    throw new V2MatchClosureError("NOT_SUPPORTED", "目前仅支持结束纯小组赛，淘汰赛请按正常赛程处理。");
  }
  if (context.match.status === "registration") {
    throw new V2MatchClosureError("NOT_STARTED", "比赛尚未发布赛程，不能使用结束比赛功能。");
  }
  const publication = await tx.match.findUniqueOrThrow({
    where: { id: input.matchId },
    select: { title: true, groupingGeneratedAt: true },
  });
  if (!publication.groupingGeneratedAt) {
    throw new V2MatchClosureError("NOT_STARTED", "比赛尚未发布赛程，不能使用结束比赛功能。");
  }
  const fixtures = await tx.matchFixture.findMany({
    where: { matchId: input.matchId },
    orderBy: { id: "asc" },
    select: {
      id: true, fixtureKey: true, stage: true, status: true, version: true,
      groupId: true, groupKey: true, startedAt: true,
      sideAEntryId: true, sideBEntryId: true,
      sideAEntry: { select: { displayNameSnapshot: true } },
      sideBEntry: { select: { displayNameSnapshot: true } },
      group: { select: { displayName: true, position: true } },
      resultRevisions: {
        orderBy: { revisionNumber: "asc" },
        select: {
          id: true, status: true, revisionNumber: true,
          settlementEvents: {
            where: { kind: "RESULT_APPLY", status: "APPLIED" },
            orderBy: { id: "asc" },
            select: { id: true },
          },
        },
      },
    },
  });
  if (fixtures.length === 0 || fixtures.some(fixture => fixture.stage !== "GROUP")) {
    throw new V2MatchClosureError("INVALID_STATE", "赛程数据不完整，不能结束比赛，请联系管理员核对。");
  }
  const unsubmitted = fixtures.filter(fixture =>
    (fixture.status === "READY" || fixture.status === "SCHEDULED") &&
    !fixture.resultRevisions.some(revision => revision.status === "PENDING" || revision.status === "CONFIRMED"),
  );
  if (fixtures.some(fixture => fixture.status === "COMPLETED" && !fixture.resultRevisions.some(revision => revision.status === "CONFIRMED")) ||
      unsubmitted.some(fixture => fixture.resultRevisions.some(revision => revision.settlementEvents.length > 0)) ||
      fixtures.some(fixture =>
        (fixture.status === "READY" || fixture.status === "SCHEDULED") &&
        fixture.resultRevisions.some(revision => revision.status === "CONFIRMED"))) {
    throw new V2MatchClosureError("INVALID_STATE", "存在状态异常的已结算成绩，不能直接作废，请联系管理员核对。");
  }
  const describe = (fixture: typeof fixtures[number]) => ({
    fixtureId: fixture.id,
    group: fixture.group?.displayName ?? fixture.groupKey ?? "小组赛",
    sideA: fixture.sideAEntry?.displayNameSnapshot ?? "待定",
    sideB: fixture.sideBEntry?.displayNameSnapshot ?? "待定",
  });
  const fingerprint = createHash("sha256").update(JSON.stringify({
    matchId: input.matchId, status: context.match.status,
    publication, fixtures,
  })).digest("hex");
  const preview: V2MatchClosurePreview = {
    matchId: input.matchId, title: publication.title, fingerprint,
    alreadyFinished: context.match.status === "finished",
    totalCount: fixtures.length,
    completedCount: fixtures.filter(fixture => fixture.status === "COMPLETED").length,
    voidedCount: fixtures.filter(fixture => fixture.status === "VOIDED").length,
    unsubmitted: unsubmitted
      .sort((a, b) => (a.group?.position ?? 0) - (b.group?.position ?? 0) || a.fixtureKey.localeCompare(b.fixtureKey))
      .map(fixture => ({ ...describe(fixture), started: fixture.startedAt !== null })),
    pending: fixtures.filter(fixture => fixture.resultRevisions.some(revision => revision.status === "PENDING"))
      .map(fixture => ({
        ...describe(fixture),
        correction: fixture.resultRevisions.some(revision => revision.status === "CONFIRMED"),
      })),
  };
  return { context, preview, unsubmitted };
}

export function previewV2MatchClosure(
  db: V2CompetitionDatabase,
  input: Readonly<{ actor: V2Actor; matchId: string }>,
) {
  return runV2Transaction(db, async tx => (await loadClosureSnapshot(tx, input)).preview);
}

export function finishV2Match(
  db: V2CompetitionDatabase,
  input: Readonly<{ actor: V2Actor; matchId: string; expectedFingerprint: string; reason?: string }>,
) {
  if (!/^[a-f0-9]{64}$/.test(input.expectedFingerprint)) {
    throw new V2MatchClosureError("STALE_PREVIEW", "请重新预览对局后再结束比赛。");
  }
  const reason = input.reason?.trim() || "赛事已结束，作废未提交有效成绩的剩余对局。";
  if (reason.length > 500) throw new V2MatchClosureError("INVALID_STATE", "结束原因不能超过 500 个字。");
  return runV2Transaction(db, async tx => {
    const { context, preview, unsubmitted } = await loadClosureSnapshot(tx, input);
    if (preview.alreadyFinished) return { alreadyFinished: true, voidedCount: 0 };
    if (preview.pending.length > 0) {
      throw new V2MatchClosureError("PENDING_RESULTS", `还有 ${preview.pending.length} 场待确认成绩或待处理更正，请先处理后再结束比赛。`);
    }
    if (preview.fingerprint !== input.expectedFingerprint) {
      throw new V2MatchClosureError("STALE_PREVIEW", "对局状态已变化，请重新预览后再结束比赛。");
    }
    if (unsubmitted.length > 0) {
      const updated = await tx.matchFixture.updateMany({
        where: { matchId: input.matchId, OR: unsubmitted.map(fixture => ({ id: fixture.id, version: fixture.version, status: fixture.status })) },
        data: { status: "VOIDED", version: { increment: 1 } },
      });
      if (updated.count !== unsubmitted.length) {
        throw new V2MatchClosureError("STALE_PREVIEW", "对局状态已变化，请重新预览后再结束比赛。");
      }
      await tx.auditLog.createMany({
        data: unsubmitted.map(fixture => ({
          actorId: context.actor.id,
          action: v2UnplayedFixtureVoidAuditAction(context.match.type),
          entityType: "MatchFixture", entityId: fixture.id,
          details: { matchId: input.matchId, fromStatus: fixture.status, stage: fixture.stage, targetLabel: fixture.fixtureKey, reason, operation: "finish_match" },
        })),
      });
    }
    if (!(await finishV2GroupOnlyMatchIfTerminal(tx, context.match))) {
      throw new V2MatchClosureError("INVALID_STATE", "赛程数据不完整，结束操作未生效，请联系管理员核对。");
    }
    await tx.auditLog.create({
      data: {
        actorId: context.actor.id, action: "v2_match_finish", entityType: "Match", entityId: input.matchId,
        details: { reason, previousStatus: context.match.status, status: "finished", voidedFixtureIds: unsubmitted.map(fixture => fixture.id), completedCount: preview.completedCount, expectedFingerprint: input.expectedFingerprint },
      },
    });
    return { alreadyFinished: false, voidedCount: unsubmitted.length };
  });
}
