import type { PrismaClient } from "@prisma/client";
import {
  buildV2ProgressiveKnockoutPlan,
  V2_PROGRESSIVE_KNOCKOUT_POLICY_VERSION,
  V2_PROGRESSIVE_KNOCKOUT_PUBLICATION,
  V2_PROGRESSIVE_KNOCKOUT_SCHEMA_VERSION,
} from "../domain/progressive-knockout-plan";
import {
  getV2GroupOnlyGroupingReadModelInTransaction,
  V2_SINGLE_GROUPING_READ_PROFILE,
  V2_DOUBLE_GROUPING_READ_PROFILE,
  V2_TEAM_GROUPING_READ_PROFILE,
} from "../read-model/group-only-grouping";
import {
  assertV2Manager,
  loadV2WriteContext,
  runV2Transaction,
  V2CompetitionApplicationError,
  type V2Actor,
  type V2CompetitionTransaction,
} from "./entries";

export type PublishV2ProgressiveKnockoutCommand = Readonly<{
  actor: V2Actor;
  matchId: string;
}>;

export type PublishV2ProgressiveKnockoutResult = Readonly<{
  matchId: string;
  scheduleId: string;
  created: boolean;
  roundCount: number;
  fixtureCount: number;
  publishedAt: Date;
}>;

function profileFor(type: "single" | "double" | "team") {
  return type === "single"
    ? V2_SINGLE_GROUPING_READ_PROFILE
    : type === "double"
      ? V2_DOUBLE_GROUPING_READ_PROFILE
      : V2_TEAM_GROUPING_READ_PROFILE;
}

export async function publishV2ProgressiveKnockoutInTransaction(
  tx: V2CompetitionTransaction,
  command: PublishV2ProgressiveKnockoutCommand,
  clock: () => Date = () => new Date(),
): Promise<PublishV2ProgressiveKnockoutResult> {
  if (
    !command ||
    Object.keys(command).some(key => !["actor", "matchId"].includes(key)) ||
    typeof command.matchId !== "string" || !command.matchId.trim() ||
    command.matchId !== command.matchId.trim() || command.matchId.length > 191 ||
    !command.actor ||
    Object.keys(command.actor).some(key => !["id", "role"].includes(key)) ||
    typeof command.actor.id !== "string" || !command.actor.id.trim() ||
    command.actor.id !== command.actor.id.trim() ||
    !["user", "admin"].includes(command.actor.role)
  ) {
    throw new V2CompetitionApplicationError(
      "INVALID_INPUT", "A stable match ID and authenticated actor are required.",
    );
  }
  const context = await loadV2WriteContext(tx, command.matchId, command.actor);
  assertV2Manager(context);
  if (context.match.status !== "ongoing" || context.match.format !== "group_then_knockout") {
    throw new V2CompetitionApplicationError(
      "FIXTURE_CREATION_NOT_ALLOWED",
      "Only an ongoing group-then-knockout match can publish an early bracket.",
    );
  }
  const model = await getV2GroupOnlyGroupingReadModelInTransaction(
    tx, command.matchId, profileFor(context.match.type),
  );
  if (model.kind !== "GROUP_THEN_KNOCKOUT_V2_MATCH" || !model.published) {
    throw new V2CompetitionApplicationError(
      "FIXTURE_CREATION_NOT_ALLOWED", "Publish the groups before the knockout schedule.",
    );
  }
  const grouping = await tx.matchGrouping.findUniqueOrThrow({
    where: {
      matchId: command.matchId
    }
  });
  const existing = await tx.matchKnockoutSchedule.findUnique({
    where: {
      matchId: command.matchId
    }
  });
  if (existing) {
    if (
      existing.schemaVersion !== V2_PROGRESSIVE_KNOCKOUT_SCHEMA_VERSION ||
      ![2, 3].includes(existing.bracketPolicyVersion) ||
      existing.groupingId !== grouping.id || !model.knockout
    ) {
      throw new V2CompetitionApplicationError(
        "PERSISTENCE_CONFLICT", "The early bracket identity is inconsistent.",
      );
    }
    return {
      matchId: command.matchId,
      scheduleId: existing.id,
      created: false,
      // The read model has validated the persisted layout, including any frozen
      // policy-3 slot order. Retrying publication must not rebuild default slots.
      roundCount: model.knockout.roundCount,
      fixtureCount: model.knockout.fixtureCount,
      publishedAt: existing.createdAt
    };
  }
  const groups = await tx.matchGroup.findMany({
    where: {
      matchId: command.matchId
    },
    orderBy: {
      position: "asc"
    }
  });
  const plan = buildV2ProgressiveKnockoutPlan({
    groupingId: grouping.id,
    groups,
    qualifiersPerGroup: grouping.qualifiersPerGroup!
  });
  if (
    model.qualification || model.knockout ||
    await tx.matchFixture.count({ where: { matchId: command.matchId, stage: "KNOCKOUT" } }) ||
    await tx.matchQualificationSnapshot.count({ where: { matchId: command.matchId } }) ||
    await tx.matchGroupQualificationSnapshot.count({ where: { matchId: command.matchId } })
  ) {
    throw new V2CompetitionApplicationError(
      "FIXTURE_CREATION_NOT_ALLOWED", "An existing knockout publication cannot be replaced.",
    );
  }
  const publishedAt = clock();
  if (
    !(publishedAt instanceof Date) || !Number.isFinite(publishedAt.getTime()) ||
    publishedAt < grouping.createdAt
  ) {
    throw new V2CompetitionApplicationError(
      "INVALID_INPUT", "The knockout publication time cannot precede its grouping.",
    );
  }
  const match = await tx.match.findUniqueOrThrow({
    where: {
      id: command.matchId
    },
    select: {
      knockoutBestOf: true
    }
  });
  const schedule = await tx.matchKnockoutSchedule.create({
    data: {
      matchId: command.matchId,
      groupingId: grouping.id,
      schemaVersion: V2_PROGRESSIVE_KNOCKOUT_SCHEMA_VERSION,
      bracketPolicyVersion: V2_PROGRESSIVE_KNOCKOUT_POLICY_VERSION,
      layoutFingerprint: plan.layoutFingerprint,
      createdAt: publishedAt
    }
  });
  await tx.matchFixture.createMany({
    data: plan.fixtures.map(f => ({
      matchId: command.matchId,
      fixtureKey: f.fixtureKey,
      stage: "KNOCKOUT",
      status: "SCHEDULED",
      bestOf: match.knockoutBestOf,
      roundNumber: f.roundNumber,
      position: f.position,
      createdAt: publishedAt,
      metadata: {
        publication: V2_PROGRESSIVE_KNOCKOUT_PUBLICATION,
        schemaVersion: V2_PROGRESSIVE_KNOCKOUT_SCHEMA_VERSION,
        bracketPolicyVersion: V2_PROGRESSIVE_KNOCKOUT_POLICY_VERSION,
        groupingId: grouping.id,
        layoutFingerprint: plan.layoutFingerprint,
        publishedAt: publishedAt.toISOString(),
        roundNumber: f.roundNumber,
        position: f.position
      }
    }))
  });
  const fixtures = await tx.matchFixture.findMany({
    where: {
      matchId: command.matchId,
      stage: "KNOCKOUT"
    },
    select: {
      id: true,
      fixtureKey: true
    }
  });
  const ids = new Map(fixtures.map(f => [
    f.fixtureKey, f.id
  ]));
  await tx.matchFixtureDependency.createMany({
    data: plan.fixtures.flatMap(f => ([
      "SIDE_A", "SIDE_B"
    ] as const).map(side => {
      const source = side === "SIDE_A" ? f.sideA : f.sideB;
      return {
        matchId: command.matchId,
        targetFixtureId: ids.get(f.fixtureKey)!,
        targetSide: side,
        ...(source.kind === "GROUP_RANK" ? {
          sourceGroupId: source.groupId,
          sourceGroupRank: source.rank
        } : {
          sourceFixtureId: ids.get(source.fixtureKey)!,
          sourceOutcome: "WINNER" as const
        })
      };
    }))
  });
  await tx.auditLog.create({
    data: {
      actorId: command.actor.id,
      action: "v2_progressive_knockout_schedule_publish",
      entityType: "Match",
      entityId: command.matchId,
      details: {
        scheduleId: schedule.id,
        groupingId: grouping.id,
        layoutFingerprint: plan.layoutFingerprint,
        fixtureCount: plan.fixtureCount,
        roundCount: plan.roundCount
      }
    }
  });
  const after = await getV2GroupOnlyGroupingReadModelInTransaction(
    tx, command.matchId, profileFor(context.match.type),
  );
  if (
    after.kind !== "GROUP_THEN_KNOCKOUT_V2_MATCH" || !after.knockout ||
    after.knockout.fixtureCount !== plan.fixtureCount
  ) {
    throw new V2CompetitionApplicationError(
      "PERSISTENCE_CONFLICT", "The early bracket was not published completely.",
    );
  }
  return {
    matchId: command.matchId,
    scheduleId: schedule.id,
    created: true,
    roundCount: plan.roundCount,
    fixtureCount: plan.fixtureCount,
    publishedAt
  };
}

export function createV2ProgressiveKnockoutPublicationApplicationService({ db, clock }: {
  db: Pick<PrismaClient, "$transaction">;
  clock?: () => Date;
}) {
  return {
    publish: (command: PublishV2ProgressiveKnockoutCommand) => runV2Transaction(
      db, tx => publishV2ProgressiveKnockoutInTransaction(tx, command, clock),
    ),
  };
}
