import type { Prisma } from "@prisma/client";

import {
  assertFixtureReadyParticipants,
  assertFixtureStageMetadata,
  assertFixtureStatusTransition,
} from "../domain";
import type {
  EntryKind,
  FixtureStage,
  FixtureStageMetadata,
  FixtureStatus,
} from "../domain";
import {
  V2CompetitionApplicationError,
  assertV2Manager,
  loadV2WriteContext,
  runV2Transaction,
} from "./entries";
import { findV2GroupFixtureVoidBlock } from "./group-fixture-void-policy";
import { finishV2GroupOnlyMatchIfTerminal } from "./match-completion";
import type {
  V2Actor,
  V2CompetitionDatabase,
  V2CompetitionTransaction,
} from "./entries";

export type FixtureSide = "SIDE_A" | "SIDE_B";
export type FixtureOutcome = "WINNER" | "LOSER";

function assertStableIdentifier(value: string, name: string) {
  if (value.trim() !== "" && value === value.trim()) return;
  throw new V2CompetitionApplicationError(
    "INVALID_INPUT",
    `${name} must be a non-empty stable identifier.`,
    { name },
  );
}

function expectedEntryKind(matchType: "single" | "double" | "team"): EntryKind {
  if (matchType === "single") return "INDIVIDUAL";
  if (matchType === "double") return "DOUBLES";
  return "TEAM";
}

export function v2UnplayedFixtureVoidAuditAction(
  matchType: "single" | "double" | "team",
) {
  if (matchType === "single") return "v2_single_fixture_void_unplayed";
  if (matchType === "double") return "v2_double_fixture_void_unplayed";
  return "v2_team_fixture_void_unplayed";
}

type FixtureEntryRecord = Readonly<{
  id: string;
  kind: EntryKind;
  status: string;
  currentRosterVersion: number;
}>;

async function loadFixtureEntries(
  tx: V2CompetitionTransaction,
  matchId: string,
  matchType: "single" | "double" | "team",
  entryIds: readonly string[],
): Promise<Map<string, FixtureEntryRecord>> {
  const uniqueIds = [...new Set(entryIds)];
  if (uniqueIds.length === 0) return new Map();

  const entries = await tx.matchEntry.findMany({
    where: { matchId, id: { in: uniqueIds } },
    select: {
      id: true,
      kind: true,
      status: true,
      members: {
        where: { status: "ACTIVE", effectiveUntil: null },
        select: { rosterVersion: true },
      },
    },
  });
  if (entries.length !== uniqueIds.length) {
    throw new V2CompetitionApplicationError(
      "FIXTURE_ENTRY_INVALID",
      "Every fixture entry must belong to the same match.",
      { matchId, entryIds: uniqueIds },
    );
  }

  const requiredKind = expectedEntryKind(matchType);
  const result = new Map<string, FixtureEntryRecord>();
  for (const entry of entries) {
    const rosterVersions = new Set(
      entry.members.map((member) => member.rosterVersion),
    );
    if (
      entry.status !== "ACTIVE" ||
      entry.kind !== requiredKind ||
      rosterVersions.size !== 1
    ) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_ENTRY_INVALID",
        "A fixture side must be one active entry of the match's competitor kind.",
        {
          entryId: entry.id,
          status: entry.status,
          kind: entry.kind,
          requiredKind,
          rosterVersions: [...rosterVersions],
        },
      );
    }
    result.set(entry.id, {
      id: entry.id,
      kind: entry.kind,
      status: entry.status,
      currentRosterVersion: [...rosterVersions][0],
    });
  }
  return result;
}

function fixtureStageData(metadata: FixtureStageMetadata) {
  if (metadata.stage === "GROUP") {
    return {
      stage: metadata.stage,
      groupKey: metadata.groupKey,
      roundNumber: null,
      position: null,
    } as const;
  }
  if (metadata.stage === "KNOCKOUT") {
    return {
      stage: metadata.stage,
      groupKey: null,
      roundNumber: metadata.roundNumber,
      position: metadata.position,
    } as const;
  }
  return {
    stage: metadata.stage,
    groupKey: null,
    roundNumber: null,
    position: null,
  } as const;
}

export type CreateV2FixtureInput = Readonly<{
  actor: V2Actor;
  matchId: string;
  fixtureKey: string;
  stage: FixtureStageMetadata;
  sideAEntryId: string | null;
  sideBEntryId: string | null;
  scheduledAt?: Date | null;
  metadata?: Prisma.InputJsonValue;
  adminOverride?: boolean;
  overrideReason?: string;
}>;

export type V2FixtureWriteResult = Readonly<{
  id: string;
  matchId: string;
  fixtureKey: string;
  stage: FixtureStage;
  status: FixtureStatus;
  version: number;
  sideARosterVersion: number | null;
  sideBRosterVersion: number | null;
  created: boolean;
}>;

export async function createV2Fixture(
  db: V2CompetitionDatabase,
  input: CreateV2FixtureInput,
): Promise<V2FixtureWriteResult> {
  assertStableIdentifier(input.matchId, "matchId");
  assertStableIdentifier(input.fixtureKey, "fixtureKey");
  assertFixtureStageMetadata(input.stage);

  try {
    return await runV2Transaction(db, async (tx) => {
      const context = await loadV2WriteContext(tx, input.matchId, input.actor);
      assertV2Manager(context);

      if (context.match.status === "finished") {
        throw new V2CompetitionApplicationError(
          "FIXTURE_CREATION_NOT_ALLOWED",
          "Fixtures cannot be created for a finished match.",
          { matchId: context.match.id },
        );
      }
      const registrationDeadline =
        context.match.type === "team"
          ? context.match.teamRegistrationDeadline ??
            context.match.registrationDeadline
          : context.match.registrationDeadline;
      const beforeRegistrationDeadline = new Date() < registrationDeadline;
      if (input.adminOverride === true) {
        if (context.actor.role !== "admin") {
          throw new V2CompetitionApplicationError(
            "FORBIDDEN",
            "Only a platform administrator can request early fixture generation.",
            { matchId: context.match.id },
          );
        }
        const reason = input.overrideReason?.trim() ?? "";
        if (!reason) {
          throw new V2CompetitionApplicationError(
            "INVALID_INPUT",
            "An administrator override requires a non-empty reason.",
            { matchId: context.match.id, operation: "fixture_create" },
          );
        }
        await tx.auditLog.create({
          data: {
            actorId: context.actor.id,
            action: "v2_fixture_create_admin_override",
            entityType: "Match",
            entityId: context.match.id,
            details: { matchId: context.match.id, reason },
          },
        });
      } else if (beforeRegistrationDeadline) {
        throw new V2CompetitionApplicationError(
          "FIXTURE_CREATION_NOT_ALLOWED",
          "Fixtures can be generated only after registration closes.",
          { matchId: context.match.id, registrationDeadline },
        );
      }

      if (
        input.sideAEntryId !== null &&
        input.sideAEntryId === input.sideBEntryId
      ) {
        throw new V2CompetitionApplicationError(
          "FIXTURE_ENTRY_INVALID",
          "A fixture cannot use the same entry on both sides.",
          { entryId: input.sideAEntryId },
        );
      }
      if (
        input.stage.stage !== "KNOCKOUT" &&
        (!input.sideAEntryId || !input.sideBEntryId)
      ) {
        throw new V2CompetitionApplicationError(
          "FIXTURE_ENTRY_INVALID",
          "Group and free-play fixtures require both entries when created.",
          { stage: input.stage.stage },
        );
      }

      const entryIds = [input.sideAEntryId, input.sideBEntryId].filter(
        (entryId): entryId is string => entryId !== null,
      );
      const entries = await loadFixtureEntries(
        tx,
        input.matchId,
        context.match.type,
        entryIds,
      );
      const sideA = input.sideAEntryId
        ? (entries.get(input.sideAEntryId) ?? null)
        : null;
      const sideB = input.sideBEntryId
        ? (entries.get(input.sideBEntryId) ?? null)
        : null;

      const existing = await tx.matchFixture.findUnique({
        where: {
          matchId_fixtureKey: {
            matchId: input.matchId,
            fixtureKey: input.fixtureKey,
          },
        },
        select: {
          id: true,
          matchId: true,
          fixtureKey: true,
          stage: true,
          status: true,
          version: true,
          sideAEntryId: true,
          sideBEntryId: true,
          sideARosterVersion: true,
          sideBRosterVersion: true,
          groupKey: true,
          roundNumber: true,
          position: true,
        },
      });
      const stageData = fixtureStageData(input.stage);
      if (existing) {
        const sameDefinition =
          existing.stage === stageData.stage &&
          existing.groupKey === stageData.groupKey &&
          existing.roundNumber === stageData.roundNumber &&
          existing.position === stageData.position &&
          existing.sideAEntryId === input.sideAEntryId &&
          existing.sideBEntryId === input.sideBEntryId;
        if (!sameDefinition) {
          throw new V2CompetitionApplicationError(
            "FIXTURE_KEY_CONFLICT",
            "The fixture key already identifies a different fixture.",
            { matchId: input.matchId, fixtureKey: input.fixtureKey },
          );
        }
        return { ...existing, created: false };
      }

      const created = await tx.matchFixture.create({
        data: {
          matchId: input.matchId,
          fixtureKey: input.fixtureKey,
          ...stageData,
          status: "SCHEDULED",
          sideAEntryId: input.sideAEntryId,
          sideBEntryId: input.sideBEntryId,
          sideARosterVersion: sideA?.currentRosterVersion ?? null,
          sideBRosterVersion: sideB?.currentRosterVersion ?? null,
          scheduledAt: input.scheduledAt,
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        },
        select: {
          id: true,
          matchId: true,
          fixtureKey: true,
          stage: true,
          status: true,
          version: true,
          sideARosterVersion: true,
          sideBRosterVersion: true,
        },
      });
      return { ...created, created: true };
    });
  } catch (error) {
    if (
      error instanceof V2CompetitionApplicationError &&
      error.code === "PERSISTENCE_CONFLICT" &&
      error.details.persistenceCode === "P2002"
    ) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_KEY_CONFLICT",
        "The fixture key was created concurrently.",
        { matchId: input.matchId, fixtureKey: input.fixtureKey },
      );
    }
    throw error;
  }
}

export type TransitionV2FixtureStatusInput = Readonly<{
  actor: V2Actor;
  matchId: string;
  fixtureId: string;
  expectedVersion: number;
  to: FixtureStatus;
  /** Optional server-side capability guard; never source this from a client. */
  requiredFixtureStage?: "GROUP";
}>;

export async function transitionV2FixtureStatus(
  db: V2CompetitionDatabase,
  input: TransitionV2FixtureStatusInput,
) {
  if (
    input.requiredFixtureStage !== undefined &&
    input.requiredFixtureStage !== "GROUP"
  ) {
    throw new V2CompetitionApplicationError(
      "INVALID_INPUT",
      "requiredFixtureStage must be the server-owned GROUP capability.",
      { requiredFixtureStage: input.requiredFixtureStage },
    );
  }
  return runV2Transaction(db, async (tx) => {
    const context = await loadV2WriteContext(tx, input.matchId, input.actor);
    assertV2Manager(context);
    const fixture = await tx.matchFixture.findFirst({
      where: { id: input.fixtureId, matchId: input.matchId },
      select: {
        id: true,
        fixtureKey: true,
        status: true,
        version: true,
        stage: true,
        sideAEntryId: true,
        sideBEntryId: true,
        sideARosterVersion: true,
        sideBRosterVersion: true,
      },
    });
    if (!fixture) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_NOT_FOUND",
        "The fixture does not belong to this match.",
        { matchId: input.matchId, fixtureId: input.fixtureId },
      );
    }
    if (
      input.requiredFixtureStage !== undefined &&
      fixture.stage !== input.requiredFixtureStage
    ) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_STAGE_NOT_ALLOWED",
        `This fixture boundary accepts ${input.requiredFixtureStage} fixtures only.`,
        {
          fixtureId: fixture.id,
          stage: fixture.stage,
          requiredFixtureStage: input.requiredFixtureStage,
        },
      );
    }
    if (fixture.version !== input.expectedVersion) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_VERSION_CONFLICT",
        "The fixture changed after it was read.",
        { expectedVersion: input.expectedVersion, actualVersion: fixture.version },
      );
    }
    if (input.to === "COMPLETED" || fixture.status === "COMPLETED") {
      throw new V2CompetitionApplicationError(
        "FIXTURE_RESULT_MANAGED_STATUS",
        "Completing or voiding a completed fixture must use the result command so settlement stays consistent.",
        { fixtureId: fixture.id, from: fixture.status, to: input.to },
      );
    }
    if (fixture.stage === "KNOCKOUT" && input.to === "VOIDED") {
      throw new V2CompetitionApplicationError(
        "FIXTURE_RESULT_MANAGED_STATUS",
        "A knockout fixture cannot be voided because VOIDED never advances the bracket; use an explicit forfeit or result correction.",
        { fixtureId: fixture.id, stage: fixture.stage },
      );
    }
    assertFixtureStatusTransition(fixture.status, input.to);
    const isStatusNoOp = fixture.status === input.to;
    if (isStatusNoOp && input.to !== "READY") {
      if (input.to === "VOIDED") {
        await finishV2GroupOnlyMatchIfTerminal(tx, context.match);
      }
      return { id: fixture.id, status: fixture.status, version: fixture.version };
    }

    if (input.to === "READY") {
      assertFixtureReadyParticipants({
        stage: fixture.stage,
        homeEntryId: fixture.sideAEntryId,
        awayEntryId: fixture.sideBEntryId,
      });
      const entries = await loadFixtureEntries(
        tx,
        input.matchId,
        context.match.type,
        [fixture.sideAEntryId!, fixture.sideBEntryId!],
      );
      if (
        fixture.sideARosterVersion === null ||
        fixture.sideBRosterVersion === null
      ) {
        throw new V2CompetitionApplicationError(
          "FIXTURE_ENTRY_INVALID",
          "A ready fixture must bind a roster version for each side.",
          { fixtureId: fixture.id },
        );
      }
      const boundRosters = await tx.matchEntryMember.findMany({
        where: {
          matchId: input.matchId,
          OR: [
            {
              entryId: fixture.sideAEntryId!,
              rosterVersion: fixture.sideARosterVersion,
            },
            {
              entryId: fixture.sideBEntryId!,
              rosterVersion: fixture.sideBRosterVersion,
            },
          ],
        },
        select: { id: true, entryId: true, rosterVersion: true, slot: true },
      });
      for (const [entryId, rosterVersion] of [
        [fixture.sideAEntryId!, fixture.sideARosterVersion] as const,
        [fixture.sideBEntryId!, fixture.sideBRosterVersion] as const,
      ]) {
        const entry = entries.get(entryId)!;
        const members = boundRosters.filter(
          (member) =>
            member.entryId === entryId &&
            member.rosterVersion === rosterVersion,
        );
        const uniqueSlots = new Set(members.map((member) => member.slot));
        const hasSequentialSlots = [...uniqueSlots]
          .sort((left, right) => left - right)
          .every((slot, index) => slot === index + 1);
        const minimumCount =
          entry.kind === "INDIVIDUAL"
            ? 1
            : entry.kind === "DOUBLES"
              ? 2
              : context.match.teamMinMembers ?? 1;
        const maximumCount =
          entry.kind === "INDIVIDUAL"
            ? 1
            : entry.kind === "DOUBLES"
              ? 2
              : context.match.teamMaxMembers ?? Number.POSITIVE_INFINITY;
        if (
          rosterVersion === null ||
          rosterVersion < 1 ||
          members.length < minimumCount ||
          members.length > maximumCount ||
          uniqueSlots.size !== members.length ||
          !hasSequentialSlots
        ) {
          throw new V2CompetitionApplicationError(
            "FIXTURE_ENTRY_INVALID",
            "Each fixture side must bind an existing, structurally complete roster version.",
            {
              fixtureId: fixture.id,
              entryId,
              rosterVersion,
              memberCount: members.length,
            },
          );
        }
      }

      const expectedLineup = ([
        {
          side: "SIDE_A",
          entryId: fixture.sideAEntryId!,
          rosterVersion: fixture.sideARosterVersion,
        },
        {
          side: "SIDE_B",
          entryId: fixture.sideBEntryId!,
          rosterVersion: fixture.sideBRosterVersion,
        },
      ] as const).flatMap((side) =>
        boundRosters
          .filter(
            (member) =>
              member.entryId === side.entryId &&
              member.rosterVersion === side.rosterVersion,
          )
          .sort((left, right) => left.slot - right.slot)
          .map((member) => ({
            matchId: input.matchId,
            fixtureId: fixture.id,
            entryId: side.entryId,
            entryMemberId: member.id,
            side: side.side,
            position: member.slot,
          })),
      );
      const existingLineup = await tx.matchFixtureLineupMember.findMany({
        where: { matchId: input.matchId, fixtureId: fixture.id },
        select: {
          entryId: true,
          entryMemberId: true,
          side: true,
          position: true,
        },
      });
      if (existingLineup.length === 0) {
        await tx.matchFixtureLineupMember.createMany({
          data: expectedLineup,
        });
      } else {
        const expectedKeys = new Set(
          expectedLineup.map(
            (line) =>
              `${line.side}:${line.position}:${line.entryId}:${line.entryMemberId}`,
          ),
        );
        const existingKeys = new Set(
          existingLineup.map(
            (line) =>
              `${line.side}:${line.position}:${line.entryId}:${line.entryMemberId}`,
          ),
        );
        const isExactLineup =
          existingLineup.length === expectedLineup.length &&
          existingKeys.size === existingLineup.length &&
          expectedKeys.size === expectedLineup.length &&
          [...existingKeys].every((key) => expectedKeys.has(key));
        if (!isExactLineup) {
          throw new V2CompetitionApplicationError(
            "FIXTURE_LINEUP_INVALID",
            "The existing fixture lineup conflicts with its frozen roster snapshot.",
            {
              fixtureId: fixture.id,
              expectedLineupSize: expectedLineup.length,
              existingLineupSize: existingLineup.length,
            },
          );
        }
      }
    }

    if (isStatusNoOp) {
      return { id: fixture.id, status: fixture.status, version: fixture.version };
    }

    if (input.to === "VOIDED") {
      const qualificationBlock = await findV2GroupFixtureVoidBlock(tx, {
        matchId: input.matchId,
        format: context.match.format,
        stage: fixture.stage,
        sideAEntryId: fixture.sideAEntryId,
        sideBEntryId: fixture.sideBEntryId,
      });
      if (qualificationBlock !== null) {
        throw new V2CompetitionApplicationError(
          "FIXTURE_RESULT_MANAGED_STATUS",
          qualificationBlock.reason === "ACTIVE_PAIRING"
            ? "A group-stage pairing between two active Entries cannot be voided before knockout qualification; record or correct its result instead."
            : "The group-stage fixture has invalid participant identities and cannot be voided safely.",
          {
            fixtureId: fixture.id,
            format: context.match.format,
            ...qualificationBlock,
          },
        );
      }
      const blockingResultRevisionCount = await tx.resultRevision.count({
        where: {
          fixtureId: fixture.id,
          OR: [
            { status: { in: ["PENDING", "CONFIRMED"] } },
            {
              settlementEvents: {
                some: { kind: "RESULT_APPLY", status: "APPLIED" },
              },
            },
          ],
        },
      });
      if (blockingResultRevisionCount !== 0) {
        throw new V2CompetitionApplicationError(
          "FIXTURE_RESULT_MANAGED_STATUS",
          "A fixture with an active result or unreversed settlement must be voided through the result command.",
          { fixtureId: fixture.id, blockingResultRevisionCount },
        );
      }
    }

    const updated = await tx.matchFixture.updateMany({
      where: {
        id: fixture.id,
        matchId: input.matchId,
        version: input.expectedVersion,
      },
      data: {
        status: input.to,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_VERSION_CONFLICT",
        "The fixture changed concurrently.",
        { expectedVersion: input.expectedVersion },
      );
    }
    if (
      input.to === "VOIDED" &&
      input.requiredFixtureStage === "GROUP" &&
      (fixture.status === "SCHEDULED" || fixture.status === "READY")
    ) {
      await tx.auditLog.create({
        data: {
          actorId: context.actor.id,
          action: v2UnplayedFixtureVoidAuditAction(context.match.type),
          entityType: "MatchFixture",
          entityId: fixture.id,
          details: {
            matchId: input.matchId,
            fromStatus: fixture.status,
            stage: fixture.stage,
            targetLabel: fixture.fixtureKey,
          },
        },
      });
    }
    if (input.to === "VOIDED") {
      await finishV2GroupOnlyMatchIfTerminal(tx, context.match);
    }
    return { id: fixture.id, status: input.to, version: fixture.version + 1 };
  });
}

export type RebindV2FixtureRostersInput = Readonly<{
  actor: V2Actor;
  matchId: string;
  fixtureId: string;
  expectedVersion: number;
}>;

/** Rebinds an unplayed, lineup-free fixture to each entry's current roster. */
export async function rebindV2FixtureRosters(
  db: V2CompetitionDatabase,
  input: RebindV2FixtureRostersInput,
) {
  return runV2Transaction(db, async (tx) => {
    const context = await loadV2WriteContext(tx, input.matchId, input.actor);
    assertV2Manager(context);
    const fixture = await tx.matchFixture.findFirst({
      where: { id: input.fixtureId, matchId: input.matchId },
      select: {
        id: true,
        status: true,
        version: true,
        sideAEntryId: true,
        sideBEntryId: true,
        _count: { select: { lineupMembers: true, resultRevisions: true } },
      },
    });
    if (!fixture) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_NOT_FOUND",
        "The fixture does not belong to this match.",
        { fixtureId: input.fixtureId, matchId: input.matchId },
      );
    }
    if (fixture.version !== input.expectedVersion) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_VERSION_CONFLICT",
        "The fixture changed after it was read.",
        { expectedVersion: input.expectedVersion, actualVersion: fixture.version },
      );
    }
    if (
      fixture.status !== "SCHEDULED" ||
      fixture._count.lineupMembers > 0 ||
      fixture._count.resultRevisions > 0
    ) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_LINEUP_FROZEN",
        "Only an unplayed scheduled fixture without lineup or result history can be rebound.",
        { fixtureId: fixture.id, status: fixture.status },
      );
    }
    if (!fixture.sideAEntryId || !fixture.sideBEntryId) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_ENTRY_INVALID",
        "Both fixture sides must be resolved before roster rebinding.",
        { fixtureId: fixture.id },
      );
    }

    const entries = await loadFixtureEntries(
      tx,
      input.matchId,
      context.match.type,
      [fixture.sideAEntryId, fixture.sideBEntryId],
    );
    const updated = await tx.matchFixture.updateMany({
      where: {
        id: fixture.id,
        matchId: input.matchId,
        version: input.expectedVersion,
      },
      data: {
        sideARosterVersion: entries.get(fixture.sideAEntryId)!
          .currentRosterVersion,
        sideBRosterVersion: entries.get(fixture.sideBEntryId)!
          .currentRosterVersion,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_VERSION_CONFLICT",
        "The fixture changed concurrently.",
        { expectedVersion: input.expectedVersion },
      );
    }
    return {
      id: fixture.id,
      version: fixture.version + 1,
      sideARosterVersion: entries.get(fixture.sideAEntryId)!
        .currentRosterVersion,
      sideBRosterVersion: entries.get(fixture.sideBEntryId)!
        .currentRosterVersion,
    };
  });
}

export type V2FixtureLineupInput = Readonly<{
  side: FixtureSide;
  entryId: string;
  entryMemberId: string;
  position: number;
}>;

export type ReplaceV2FixtureLineupInput = Readonly<{
  actor: V2Actor;
  matchId: string;
  fixtureId: string;
  expectedVersion: number;
  lineup: readonly V2FixtureLineupInput[];
}>;

function assertLineupCount(kind: EntryKind, count: number, side: FixtureSide) {
  const valid =
    (kind === "INDIVIDUAL" && count === 1) ||
    (kind === "DOUBLES" && count === 2) ||
    (kind === "TEAM" && count >= 1);
  if (valid) return;
  throw new V2CompetitionApplicationError(
    "FIXTURE_LINEUP_INVALID",
    "The lineup size does not match its entry kind.",
    { kind, count, side },
  );
}

export async function replaceV2FixtureLineup(
  db: V2CompetitionDatabase,
  input: ReplaceV2FixtureLineupInput,
) {
  return runV2Transaction(db, async (tx) => {
    const context = await loadV2WriteContext(tx, input.matchId, input.actor);
    assertV2Manager(context);
    const fixture = await tx.matchFixture.findFirst({
      where: { id: input.fixtureId, matchId: input.matchId },
      select: {
        id: true,
        status: true,
        version: true,
        sideAEntryId: true,
        sideBEntryId: true,
        sideARosterVersion: true,
        sideBRosterVersion: true,
        _count: { select: { resultRevisions: true } },
      },
    });
    if (!fixture) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_NOT_FOUND",
        "The fixture does not belong to this match.",
        { fixtureId: input.fixtureId, matchId: input.matchId },
      );
    }
    if (fixture.version !== input.expectedVersion) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_VERSION_CONFLICT",
        "The fixture changed after it was read.",
        { expectedVersion: input.expectedVersion, actualVersion: fixture.version },
      );
    }
    if (fixture.status !== "READY" || fixture._count.resultRevisions > 0) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_LINEUP_FROZEN",
        "A lineup can change only while its ready fixture has no result history.",
        { fixtureId: fixture.id, status: fixture.status },
      );
    }
    if (
      !fixture.sideAEntryId ||
      !fixture.sideBEntryId ||
      fixture.sideARosterVersion === null ||
      fixture.sideBRosterVersion === null
    ) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_ENTRY_INVALID",
        "The fixture sides and roster versions must be resolved first.",
        { fixtureId: fixture.id },
      );
    }
    if (input.lineup.length === 0) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_LINEUP_INVALID",
        "A fixture lineup cannot be empty.",
        { fixtureId: fixture.id },
      );
    }

    const positions = new Set<string>();
    const memberIds = new Set<string>();
    for (const line of input.lineup) {
      if (line.side !== "SIDE_A" && line.side !== "SIDE_B") {
        throw new V2CompetitionApplicationError(
          "FIXTURE_LINEUP_INVALID",
          "A lineup side must be SIDE_A or SIDE_B.",
          { side: line.side },
        );
      }
      if (!Number.isInteger(line.position) || line.position < 1) {
        throw new V2CompetitionApplicationError(
          "FIXTURE_LINEUP_INVALID",
          "Lineup positions must be positive integers.",
          { side: line.side, position: line.position },
        );
      }
      const positionKey = `${line.side}:${line.position}`;
      if (positions.has(positionKey) || memberIds.has(line.entryMemberId)) {
        throw new V2CompetitionApplicationError(
          "FIXTURE_LINEUP_INVALID",
          "Lineup positions and entry members must be unique per fixture.",
          { positionKey, entryMemberId: line.entryMemberId },
        );
      }
      positions.add(positionKey);
      memberIds.add(line.entryMemberId);

      const expectedEntryId =
        line.side === "SIDE_A"
          ? fixture.sideAEntryId
          : fixture.sideBEntryId;
      if (line.entryId !== expectedEntryId) {
        throw new V2CompetitionApplicationError(
          "FIXTURE_LINEUP_INVALID",
          "A lineup member must belong to the entry assigned to that side.",
          { side: line.side, entryId: line.entryId, expectedEntryId },
        );
      }
    }

    const members = await tx.matchEntryMember.findMany({
      where: {
        matchId: input.matchId,
        OR: [
          {
            entryId: fixture.sideAEntryId,
            rosterVersion: fixture.sideARosterVersion,
          },
          {
            entryId: fixture.sideBEntryId,
            rosterVersion: fixture.sideBRosterVersion,
          },
        ],
      },
      orderBy: [{ entryId: "asc" }, { slot: "asc" }, { id: "asc" }],
      select: {
        id: true,
        entryId: true,
        userId: true,
        status: true,
        rosterVersion: true,
        slot: true,
      },
    });
    const expectedMemberIds = new Set(members.map((member) => member.id));
    if (
      members.length !== memberIds.size ||
      [...memberIds].some((memberId) => !expectedMemberIds.has(memberId))
    ) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_LINEUP_INVALID",
        "The lineup must contain every member of both fixture-bound roster versions exactly once.",
        {
          fixtureId: fixture.id,
          expectedLineupSize: members.length,
          actualLineupSize: memberIds.size,
        },
      );
    }
    const membersById = new Map(members.map((member) => [member.id, member]));
    const userIds = new Set<string>();
    for (const line of input.lineup) {
      const member = membersById.get(line.entryMemberId)!;
      const expectedRosterVersion =
        line.side === "SIDE_A"
          ? fixture.sideARosterVersion
          : fixture.sideBRosterVersion;
      if (
        member.entryId !== line.entryId ||
        member.rosterVersion !== expectedRosterVersion ||
        member.status === "WITHDRAWN" ||
        member.status === "REMOVED" ||
        member.status === "DISQUALIFIED"
      ) {
        throw new V2CompetitionApplicationError(
          "FIXTURE_LINEUP_INVALID",
          "A lineup member must belong to the fixture-bound roster version.",
          {
            entryMemberId: member.id,
            entryId: member.entryId,
            rosterVersion: member.rosterVersion,
            expectedRosterVersion,
            status: member.status,
          },
        );
      }
      if (userIds.has(member.userId)) {
        throw new V2CompetitionApplicationError(
          "FIXTURE_LINEUP_INVALID",
          "One user cannot appear twice in a fixture lineup.",
          { userId: member.userId },
        );
      }
      userIds.add(member.userId);
    }

    for (const side of ["SIDE_A", "SIDE_B"] as const) {
      const positions = input.lineup
        .filter((line) => line.side === side)
        .map((line) => line.position)
        .sort((left, right) => left - right);
      if (positions.some((position, index) => position !== index + 1)) {
        throw new V2CompetitionApplicationError(
          "FIXTURE_LINEUP_INVALID",
          "Lineup positions must be contiguous on each fixture side.",
          { side, positions },
        );
      }
    }

    const sideAEntry = await tx.matchEntry.findFirst({
      where: { id: fixture.sideAEntryId, matchId: input.matchId },
      select: { kind: true },
    });
    const sideBEntry = await tx.matchEntry.findFirst({
      where: { id: fixture.sideBEntryId, matchId: input.matchId },
      select: { kind: true },
    });
    if (!sideAEntry || !sideBEntry) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_ENTRY_INVALID",
        "A fixture entry disappeared during lineup validation.",
        { fixtureId: fixture.id },
      );
    }
    assertLineupCount(
      sideAEntry.kind,
      input.lineup.filter((line) => line.side === "SIDE_A").length,
      "SIDE_A",
    );
    assertLineupCount(
      sideBEntry.kind,
      input.lineup.filter((line) => line.side === "SIDE_B").length,
      "SIDE_B",
    );

    const updated = await tx.matchFixture.updateMany({
      where: {
        id: fixture.id,
        matchId: input.matchId,
        version: input.expectedVersion,
      },
      data: { version: { increment: 1 } },
    });
    if (updated.count !== 1) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_VERSION_CONFLICT",
        "The fixture changed concurrently.",
        { expectedVersion: input.expectedVersion },
      );
    }
    await tx.matchFixtureLineupMember.deleteMany({
      where: { fixtureId: fixture.id, matchId: input.matchId },
    });
    await tx.matchFixtureLineupMember.createMany({
      data: input.lineup.map((line) => ({
        matchId: input.matchId,
        fixtureId: fixture.id,
        entryId: line.entryId,
        entryMemberId: line.entryMemberId,
        side: line.side,
        position: line.position,
      })),
    });
    return {
      id: fixture.id,
      version: fixture.version + 1,
      lineupSize: input.lineup.length,
    };
  });
}

export type AddV2FixtureDependencyInput = Readonly<{
  actor: V2Actor;
  matchId: string;
  sourceFixtureId: string;
  sourceOutcome: FixtureOutcome;
  expectedSourceVersion: number;
  targetFixtureId: string;
  targetSide: FixtureSide;
  expectedTargetVersion: number;
}>;

type DependencyEdge = Readonly<{
  sourceFixtureId: string;
  targetFixtureId: string;
}>;

export function wouldCreateFixtureDependencyCycle(
  edges: readonly DependencyEdge[],
  candidate: DependencyEdge,
) {
  if (candidate.sourceFixtureId === candidate.targetFixtureId) return true;
  const outgoing = new Map<string, string[]>();
  for (const edge of [...edges, candidate]) {
    const targets = outgoing.get(edge.sourceFixtureId) ?? [];
    targets.push(edge.targetFixtureId);
    outgoing.set(edge.sourceFixtureId, targets);
  }

  const pending = [candidate.targetFixtureId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === candidate.sourceFixtureId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(outgoing.get(current) ?? []));
  }
  return false;
}

export async function addV2FixtureDependency(
  db: V2CompetitionDatabase,
  input: AddV2FixtureDependencyInput,
) {
  return runV2Transaction(db, async (tx) => {
    const context = await loadV2WriteContext(tx, input.matchId, input.actor);
    assertV2Manager(context);
    if (input.sourceFixtureId === input.targetFixtureId) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_DEPENDENCY_CYCLE",
        "A fixture cannot depend on itself.",
        { fixtureId: input.sourceFixtureId },
      );
    }

    const fixtures = await tx.matchFixture.findMany({
      where: {
        matchId: input.matchId,
        id: { in: [input.sourceFixtureId, input.targetFixtureId] },
      },
      select: {
        id: true,
        stage: true,
        status: true,
        version: true,
        roundNumber: true,
        sideAEntryId: true,
        sideBEntryId: true,
      },
    });
    if (fixtures.length !== 2) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_NOT_FOUND",
        "Both dependency fixtures must belong to the same match.",
        { matchId: input.matchId },
      );
    }
    const source = fixtures.find((fixture) => fixture.id === input.sourceFixtureId)!;
    const target = fixtures.find((fixture) => fixture.id === input.targetFixtureId)!;
    if (
      source.version !== input.expectedSourceVersion ||
      target.version !== input.expectedTargetVersion
    ) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_VERSION_CONFLICT",
        "A dependency fixture changed after it was read.",
        {
          expectedSourceVersion: input.expectedSourceVersion,
          actualSourceVersion: source.version,
          expectedTargetVersion: input.expectedTargetVersion,
          actualTargetVersion: target.version,
        },
      );
    }
    const targetSideOccupied =
      input.targetSide === "SIDE_A"
        ? target.sideAEntryId !== null
        : target.sideBEntryId !== null;
    if (
      source.stage !== "KNOCKOUT" ||
      target.stage !== "KNOCKOUT" ||
      target.status !== "SCHEDULED" ||
      source.status === "COMPLETED" ||
      source.status === "VOIDED" ||
      source.roundNumber === null ||
      target.roundNumber === null ||
      source.roundNumber >= target.roundNumber ||
      targetSideOccupied
    ) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_DEPENDENCY_INVALID",
        "A dependency must feed an empty side of a later scheduled knockout fixture.",
        {
          sourceFixtureId: source.id,
          targetFixtureId: target.id,
          targetSide: input.targetSide,
        },
      );
    }

    const existingForTarget = await tx.matchFixtureDependency.findUnique({
      where: {
        targetFixtureId_targetSide: {
          targetFixtureId: target.id,
          targetSide: input.targetSide,
        },
      },
      select: {
        id: true,
        sourceFixtureId: true,
        sourceOutcome: true,
        targetFixtureId: true,
        targetSide: true,
      },
    });
    if (existingForTarget) {
      if (
        existingForTarget.sourceFixtureId === source.id &&
        existingForTarget.sourceOutcome === input.sourceOutcome
      ) {
        return { ...existingForTarget, created: false };
      }
      throw new V2CompetitionApplicationError(
        "FIXTURE_DEPENDENCY_CONFLICT",
        "The target fixture side already has a different dependency.",
        { targetFixtureId: target.id, targetSide: input.targetSide },
      );
    }

    const existingForOutcome = await tx.matchFixtureDependency.findUnique({
      where: {
        sourceFixtureId_sourceOutcome: {
          sourceFixtureId: source.id,
          sourceOutcome: input.sourceOutcome,
        },
      },
      select: { id: true },
    });
    if (existingForOutcome) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_DEPENDENCY_CONFLICT",
        "This source outcome already feeds another fixture.",
        { sourceFixtureId: source.id, sourceOutcome: input.sourceOutcome },
      );
    }

    const dependencyRows = await tx.matchFixtureDependency.findMany({
      where: { matchId: input.matchId },
      select: { sourceFixtureId: true, targetFixtureId: true },
    });
    const edges = dependencyRows.filter(
      (edge): edge is DependencyEdge => edge.sourceFixtureId !== null,
    );
    if (
      wouldCreateFixtureDependencyCycle(edges, {
        sourceFixtureId: source.id,
        targetFixtureId: target.id,
      })
    ) {
      throw new V2CompetitionApplicationError(
        "FIXTURE_DEPENDENCY_CYCLE",
        "The fixture dependency would create a cycle.",
        { sourceFixtureId: source.id, targetFixtureId: target.id },
      );
    }

    const versionChecks = [
      { id: source.id, expectedVersion: input.expectedSourceVersion },
      { id: target.id, expectedVersion: input.expectedTargetVersion },
    ].sort((left, right) => left.id.localeCompare(right.id));
    for (const versionCheck of versionChecks) {
      const updated = await tx.matchFixture.updateMany({
        where: {
          id: versionCheck.id,
          matchId: input.matchId,
          version: versionCheck.expectedVersion,
        },
        data: { version: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new V2CompetitionApplicationError(
          "FIXTURE_VERSION_CONFLICT",
          "A dependency fixture changed concurrently.",
          { fixtureId: versionCheck.id },
        );
      }
    }

    const created = await tx.matchFixtureDependency.create({
      data: {
        matchId: input.matchId,
        sourceFixtureId: source.id,
        sourceOutcome: input.sourceOutcome,
        targetFixtureId: target.id,
        targetSide: input.targetSide,
      },
      select: {
        id: true,
        sourceFixtureId: true,
        sourceOutcome: true,
        targetFixtureId: true,
        targetSide: true,
      },
    });
    return { ...created, created: true };
  });
}
