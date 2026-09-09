import { Prisma, type PrismaClient } from "@prisma/client";

import {
  V2CompetitionApplicationError,
  assertV2Manager,
  loadV2WriteContext,
  runV2Transaction,
  transitionV2EntryStatusKernel,
  type V2Actor,
  type V2CompetitionTransaction,
  type V2EntryStatusTransitionKernelEntry,
} from "./entries";
import { finishV2GroupOnlyMatchIfTerminal } from "./match-completion";
import { resolveV2KnockoutFixtureAdministratively } from "./knockout-advancement";
import { confirmForfeitInTransaction } from "./results";
import { lockAndLoadResultUsers } from "./settlements";

const MAX_MATCH_ENTRIES = 1_024;
const MAX_MATCH_FIXTURES = 2_047;

export type DisqualifyV2EntryCommand = Readonly<{
  actor: V2Actor;
  matchId: string;
  entryId: string;
  expectedEntryVersion: number;
  reason: string;
}>;

export type DisqualifyV2EntryResult = Readonly<{
  matchId: string;
  entryId: string;
  entryVersion: number;
  forfeitedFixtureIds: readonly string[];
  noContestFixtureIds: readonly string[];
  adminByeFixtureIds: readonly string[];
  voidedPendingRevisionIds: readonly string[];
}>;

export type DisqualifyV2EntriesInTransactionCommand = Readonly<{
  actor: V2Actor;
  matchId: string;
  targets: readonly Readonly<{
    entryId: string;
    expectedEntryVersion: number;
  }>[];
  reason: string;
}>;

export type DisqualifyV2EntriesInTransactionResult = Readonly<{
  matchId: string;
  entries: readonly Readonly<{ entryId: string; entryVersion: number }>[];
  forfeitedFixtureIds: readonly string[];
  noContestFixtureIds: readonly string[];
  adminByeFixtureIds: readonly string[];
  voidedPendingRevisionIds: readonly string[];
}>;

type NormalizedCommand = DisqualifyV2EntryCommand;
type NormalizedBatchCommand = DisqualifyV2EntriesInTransactionCommand;

function fail(
  code: V2CompetitionApplicationError["code"],
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new V2CompetitionApplicationError(code, message, details);
}

function stableIdentifier(value: unknown, name: string) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 191 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail("INVALID_INPUT", `${name} must be a stable identifier.`);
  }
  return value;
}

function normalize(command: DisqualifyV2EntryCommand): NormalizedCommand {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    fail("INVALID_INPUT", "The disqualification command must be an object.");
  }
  const allowed = new Set([
    "actor",
    "matchId",
    "entryId",
    "expectedEntryVersion",
    "reason",
  ]);
  if (Object.keys(command).some((key) => !allowed.has(key))) {
    fail("INVALID_INPUT", "The disqualification command contains unsupported fields.");
  }
  if (
    !command.actor ||
    typeof command.actor !== "object" ||
    Array.isArray(command.actor) ||
    Object.keys(command.actor).some((key) => key !== "id" && key !== "role") ||
    (command.actor.role !== "user" && command.actor.role !== "admin")
  ) {
    fail("INVALID_INPUT", "actor is invalid.");
  }
  if (
    !Number.isSafeInteger(command.expectedEntryVersion) ||
    command.expectedEntryVersion < 0 ||
    command.expectedEntryVersion > 2_147_483_647
  ) {
    fail("INVALID_INPUT", "expectedEntryVersion is invalid.");
  }
  if (
    typeof command.reason !== "string" ||
    command.reason.length < 1 ||
    command.reason.length > 500 ||
    command.reason !== command.reason.trim()
  ) {
    fail("INVALID_INPUT", "reason must be normalized text between 1 and 500 characters.");
  }
  return {
    actor: {
      id: stableIdentifier(command.actor.id, "actor.id"),
      role: command.actor.role,
    },
    matchId: stableIdentifier(command.matchId, "matchId"),
    entryId: stableIdentifier(command.entryId, "entryId"),
    expectedEntryVersion: command.expectedEntryVersion,
    reason: command.reason,
  };
}

function normalizeBatch(
  command: DisqualifyV2EntriesInTransactionCommand,
): NormalizedBatchCommand {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    fail("INVALID_INPUT", "The batch disqualification command must be an object.");
  }
  if (
    Object.keys(command).some(
      (key) => !["actor", "matchId", "targets", "reason"].includes(key),
    ) ||
    !Array.isArray(command.targets) ||
    command.targets.length < 1 ||
    command.targets.length > MAX_MATCH_ENTRIES
  ) {
    fail("INVALID_INPUT", "The batch disqualification targets are invalid.");
  }
  const normalizedSingleCommands = command.targets.map((target) =>
    normalize({
      actor: command.actor,
      matchId: command.matchId,
      entryId: target.entryId,
      expectedEntryVersion: target.expectedEntryVersion,
      reason: command.reason,
    }),
  );
  const targetIds = normalizedSingleCommands.map((item) => item.entryId);
  if (new Set(targetIds).size !== targetIds.length) {
    fail("INVALID_INPUT", "The batch disqualification targets must be unique.");
  }
  const first = normalizedSingleCommands[0];
  return {
    actor: first.actor,
    matchId: first.matchId,
    reason: first.reason,
    targets: normalizedSingleCommands
      .map((item) => ({
        entryId: item.entryId,
        expectedEntryVersion: item.expectedEntryVersion,
      }))
      .sort((left, right) => left.entryId.localeCompare(right.entryId)),
  };
}

async function lockAggregateRows(
  tx: V2CompetitionTransaction,
  matchId: string,
) {
  const entries = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "match_entry"
    WHERE "match_id" = ${matchId}
    ORDER BY "id" FOR UPDATE
  `);
  if (entries.length > MAX_MATCH_ENTRIES) {
    fail("INVALID_INPUT", "The match has too many Entries to disqualify safely.");
  }
  await tx.$queryRaw(Prisma.sql`
    SELECT member."id" FROM "match_entry_member" AS member
    INNER JOIN "match_entry" AS entry ON entry."id" = member."entry_id"
    WHERE entry."match_id" = ${matchId}
    ORDER BY member."id" FOR UPDATE OF member
  `);
  const fixtures = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "match_fixture"
    WHERE "match_id" = ${matchId}
    ORDER BY "id" FOR UPDATE
  `);
  if (fixtures.length > MAX_MATCH_FIXTURES) {
    fail("INVALID_INPUT", "The match has too many Fixtures to disqualify safely.");
  }
  await tx.$queryRaw(Prisma.sql`
    SELECT "id" FROM "match_fixture_dependency"
    WHERE "match_id" = ${matchId}
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT revision."id" FROM "result_revision" AS revision
    INNER JOIN "match_fixture" AS fixture ON fixture."id" = revision."fixture_id"
    WHERE fixture."match_id" = ${matchId}
    ORDER BY revision."id" FOR UPDATE OF revision
  `);
  await tx.$queryRaw(Prisma.sql`
    SELECT resolution."id"
    FROM "match_fixture_administrative_resolution" AS resolution
    WHERE resolution."match_id" = ${matchId}
    ORDER BY resolution."id" FOR UPDATE OF resolution
  `);
}

type LoadedEntry = V2EntryStatusTransitionKernelEntry &
  Readonly<{
    sourceUserId: string | null;
    sourceDoublesTeamId: string | null;
    sourceMatchTeamId: string | null;
    members: readonly (V2EntryStatusTransitionKernelEntry["members"][number] &
      Readonly<{ id: string }>)[];
  }>;

function expectedKind(type: "single" | "double" | "team") {
  return type === "single" ? "INDIVIDUAL" : type === "double" ? "DOUBLES" : "TEAM";
}

async function voidPendingRevision(
  tx: V2CompetitionTransaction,
  input: Readonly<{
    matchId: string;
    fixtureId: string;
    fixtureVersion: number;
    revisionId: string;
    actorId: string;
    reason: string;
    now: Date;
  }>,
) {
  const revision = await tx.resultRevision.updateMany({
    where: {
      id: input.revisionId,
      matchId: input.matchId,
      fixtureId: input.fixtureId,
      status: "PENDING",
    },
    data: {
      status: "VOIDED",
      verifiedById: input.actorId,
      resolvedAt: input.now,
      reason: input.reason,
    },
  });
  if (revision.count !== 1) {
    fail("CONCURRENT_WRITE_CONFLICT", "A pending result changed during disqualification.");
  }
  const fixture = await tx.matchFixture.updateMany({
    where: {
      id: input.fixtureId,
      matchId: input.matchId,
      version: input.fixtureVersion,
    },
    data: { version: { increment: 1 } },
  });
  if (fixture.count !== 1) {
    fail("CONCURRENT_WRITE_CONFLICT", "A fixture changed during disqualification.");
  }
}

export async function disqualifyV2EntriesInTransaction(
  tx: V2CompetitionTransaction,
  rawCommand: DisqualifyV2EntriesInTransactionCommand,
  exitKind: "DISQUALIFIED" | "WITHDRAWN" = "DISQUALIFIED",
): Promise<DisqualifyV2EntriesInTransactionResult> {
  const command = normalizeBatch(rawCommand);
  const context = await loadV2WriteContext(tx, command.matchId, command.actor);
  assertV2Manager(context);
  if (context.match.status === "finished") {
    fail("FORBIDDEN", "A finished competition cannot gain a new disqualification.");
  }
  await lockAggregateRows(tx, command.matchId);
  const entries = (await tx.matchEntry.findMany({
    where: { matchId: command.matchId },
    orderBy: { id: "asc" },
    select: {
      id: true,
      kind: true,
      status: true,
      version: true,
      sourceUserId: true,
      sourceDoublesTeamId: true,
      sourceMatchTeamId: true,
      members: {
        orderBy: [{ rosterVersion: "desc" }, { slot: "asc" }, { id: "asc" }],
        select: {
          id: true,
          userId: true,
          displayNameSnapshot: true,
          role: true,
          status: true,
          effectiveUntil: true,
          rosterVersion: true,
        },
      },
    },
  })) as LoadedEntry[];
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const targets = command.targets.map((candidate) => {
    const entry = entryById.get(candidate.entryId);
    if (!entry) fail("ENTRY_NOT_FOUND", "An Entry does not belong to this match.");
    if (entry.version !== candidate.expectedEntryVersion) {
      fail("ENTRY_VERSION_CONFLICT", "An Entry changed after it was read.", {
        entryId: entry.id,
        expectedVersion: candidate.expectedEntryVersion,
        actualVersion: entry.version,
      });
    }
    if (entry.status !== "ACTIVE") {
      fail("FORBIDDEN", "Only active Entries can be disqualified.", {
        entryId: entry.id,
        entryStatus: entry.status,
      });
    }
    return entry;
  });
  if (exitKind === "WITHDRAWN") {
    const pending = await tx.resultRevision.findFirst({
      where: {
        status: "PENDING",
        fixture: { matchId: command.matchId, OR: [
          { sideAEntryId: { in: command.targets.map(target => target.entryId) } },
          { sideBEntryId: { in: command.targets.map(target => target.entryId) } },
        ] },
      },
      select: { id: true, fixtureId: true },
    });
    if (pending) fail("PENDING_RESULT_REQUIRES_REVIEW", "请先核实并确认或驳回该参赛方的待确认比分，再安排退赛。", { fixtureId: pending.fixtureId });
  }
  const requiredKind = expectedKind(context.match.type);
  if (entries.some((entry) => entry.kind !== requiredKind)) {
    fail("ENTRY_KIND_MATCH_TYPE_MISMATCH", "The match contains an invalid Entry kind.");
  }
  const allMemberUserIds = [
    ...new Set(entries.flatMap((entry) => entry.members.map((member) => member.userId))),
  ].sort();
  const users = await lockAndLoadResultUsers(tx, allMemberUserIds);
  const userById = new Map(users.map((user) => [user.id, user]));
  if (userById.size !== allMemberUserIds.length) {
    fail("ENTRY_ROSTER_CORRUPT", "A frozen Entry member no longer exists.");
  }

  const statusByEntryId = new Map(entries.map((entry) => [entry.id, entry.status]));
  for (const target of targets) statusByEntryId.set(target.id, exitKind);
  const available = (
    entryId: string | null,
    rosterVersion: number | null,
  ) => {
    if (entryId === null || rosterVersion === null) return false;
    const entry = entries.find((candidate) => candidate.id === entryId);
    const members = entry?.members.filter(
      (member) => member.rosterVersion === rosterVersion,
    );
    return Boolean(
      entry &&
        statusByEntryId.get(entryId) === "ACTIVE" &&
        members &&
        members.length > 0 &&
        members.every((member) => {
          const user = userById.get(member.userId);
          return user && !user.isBanned && user.emailVerifiedAt !== null;
        }),
    );
  };

  const now = new Date();
  const transitions: Array<{ entryId: string; entryVersion: number }> = [];
  for (const target of targets) {
    const transition = await transitionV2EntryStatusKernel(tx, {
      matchId: command.matchId,
      entry: target,
      expectedVersion: target.version,
      to: exitKind,
    });
    transitions.push({ entryId: target.id, entryVersion: transition.version });
    await tx.auditLog.create({
      data: {
        actorId: context.actor.id,
        action: `v2_${context.match.type}_entry_${exitKind === "WITHDRAWN" ? "withdraw" : "disqualify"}`,
        entityType: "MatchEntry",
        entityId: target.id,
        details: {
          matchId: context.match.id,
          entryId: target.id,
          entryKind: target.kind,
          reason: command.reason,
        },
      },
    });
  }

  const voidedPendingRevisionIds: string[] = [];
  const targetEntryIds = targets.map((target) => target.id);
  const affectedFixtures = await tx.matchFixture.findMany({
    where: {
      matchId: command.matchId,
      OR: [
        { sideAEntryId: { in: targetEntryIds } },
        { sideBEntryId: { in: targetEntryIds } },
      ],
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      status: true,
      version: true,
      sideAEntryId: true,
      sideBEntryId: true,
      sideARosterVersion: true,
      sideBRosterVersion: true,
      resultRevisions: {
        where: { status: "PENDING" },
        orderBy: [{ revisionNumber: "asc" }, { id: "asc" }],
        select: { id: true },
      },
    },
  });
  for (const fixture of affectedFixtures) {
    if (fixture.resultRevisions.length > 1) {
      fail("FIXTURE_RESULT_REQUIRED", "A Fixture has duplicate pending results.");
    }
    const pending = fixture.resultRevisions[0];
    if (!pending) continue;
    await voidPendingRevision(tx, {
      matchId: command.matchId,
      fixtureId: fixture.id,
      fixtureVersion: fixture.version,
      revisionId: pending.id,
      actorId: context.actor.id,
      reason: `ENTRY_DISQUALIFIED: ${command.reason}`,
      now,
    });
    voidedPendingRevisionIds.push(pending.id);
  }

  const forfeitedFixtureIds: string[] = [];
  const noContestFixtureIds: string[] = [];
  const adminByeFixtureIds: string[] = [];

  const unresolvedGroups = await tx.matchFixture.findMany({
    where: {
      matchId: command.matchId,
      stage: "GROUP",
      status: { in: ["SCHEDULED", "READY"] },
      OR: [
        { sideAEntryId: { in: targetEntryIds } },
        { sideBEntryId: { in: targetEntryIds } },
      ],
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      version: true,
      status: true,
      sideAEntryId: true,
      sideBEntryId: true,
      sideARosterVersion: true,
      sideBRosterVersion: true,
    },
  });
  for (const fixture of unresolvedGroups) {
    const sideAAvailable = available(
      fixture.sideAEntryId,
      fixture.sideARosterVersion,
    );
    const sideBAvailable = available(
      fixture.sideBEntryId,
      fixture.sideBRosterVersion,
    );
    if (sideAAvailable !== sideBAvailable) {
      const winnerEntryId = sideAAvailable
        ? fixture.sideAEntryId!
        : fixture.sideBEntryId!;
      const loserEntryId = sideAAvailable
        ? fixture.sideBEntryId!
        : fixture.sideAEntryId!;
      await confirmForfeitInTransaction(
        tx,
        {
          actor: { actorId: context.actor.id, role: context.actor.role },
          matchId: command.matchId,
          fixtureId: fixture.id,
          expectedFixtureVersion: fixture.version,
          requiredFixtureStage: "GROUP",
          winnerEntryId,
          loserEntryId,
          reason: command.reason,
        },
        () => now,
      );
      forfeitedFixtureIds.push(fixture.id);
      continue;
    }
    if (!sideAAvailable && !sideBAvailable) {
      const updated = await tx.matchFixture.updateMany({
        where: {
          id: fixture.id,
          matchId: command.matchId,
          version: fixture.version,
          status: fixture.status,
        },
        data: {
          status: "VOIDED",
          completedAt: now,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        fail("CONCURRENT_WRITE_CONFLICT", "A group Fixture changed during disqualification.");
      }
      await tx.auditLog.create({
        data: {
          actorId: context.actor.id,
          action: `v2_${context.match.type}_group_no_contest`,
          entityType: "MatchFixture",
          entityId: fixture.id,
          details: {
            matchId: command.matchId,
            fixtureId: fixture.id,
            reason: command.reason,
            settlement: "NONE",
          },
        },
      });
      noContestFixtureIds.push(fixture.id);
    }
  }

  for (let iteration = 0; iteration < MAX_MATCH_FIXTURES; iteration += 1) {
    const fixtures = await tx.matchFixture.findMany({
      where: {
        matchId: command.matchId,
        stage: "KNOCKOUT",
        status: { in: ["SCHEDULED", "READY"] },
      },
      orderBy: [{ roundNumber: "asc" }, { position: "asc" }, { id: "asc" }],
      select: {
        id: true,
        status: true,
        version: true,
        sideAEntryId: true,
        sideBEntryId: true,
        sideARosterVersion: true,
        sideBRosterVersion: true,
        resultRevisions: {
          where: { status: { in: ["PENDING", "CONFIRMED"] } },
          select: { id: true, status: true },
        },
        incomingDependencies: {
          orderBy: { targetSide: "asc" },
          select: {
            targetSide: true,
            sourceQualificationStandingId: true,
            sourceFixture: {
              select: {
                status: true,
                administrativeResolution: { select: { kind: true } },
              },
            },
          },
        },
      },
    });
    let progressed = false;
    for (const fixture of fixtures) {
      const activePending = fixture.resultRevisions.find(
        (revision) => revision.status === "PENDING",
      );
      const hasConfirmed = fixture.resultRevisions.some(
        (revision) => revision.status === "CONFIRMED",
      );
      const sideAAvailable = available(
        fixture.sideAEntryId,
        fixture.sideARosterVersion,
      );
      const sideBAvailable = available(
        fixture.sideBEntryId,
        fixture.sideBRosterVersion,
      );
      if (
        activePending &&
        !hasConfirmed &&
        ((fixture.sideAEntryId !== null && !sideAAvailable) ||
          (fixture.sideBEntryId !== null && !sideBAvailable))
      ) {
        await voidPendingRevision(tx, {
          matchId: command.matchId,
          fixtureId: fixture.id,
          fixtureVersion: fixture.version,
          revisionId: activePending.id,
          actorId: context.actor.id,
          reason: `ENTRY_DISQUALIFIED: ${command.reason}`,
          now,
        });
        voidedPendingRevisionIds.push(activePending.id);
        progressed = true;
        break;
      }
      if (activePending || hasConfirmed) continue;

      const dependencyBySide = new Map(
        fixture.incomingDependencies.map((dependency) => [
          dependency.targetSide,
          dependency,
        ]),
      );
      const sideIsTerminalEmpty = (side: "SIDE_A" | "SIDE_B") => {
        const entryId = side === "SIDE_A" ? fixture.sideAEntryId : fixture.sideBEntryId;
        if (entryId !== null) return false;
        const dependency = dependencyBySide.get(side);
        return Boolean(
          dependency &&
            dependency.sourceQualificationStandingId === null &&
            dependency.sourceFixture?.status === "VOIDED" &&
            dependency.sourceFixture.administrativeResolution?.kind === "NO_CONTEST",
        );
      };
      const sideAEmpty = sideIsTerminalEmpty("SIDE_A");
      const sideBEmpty = sideIsTerminalEmpty("SIDE_B");
      const bothPopulated =
        fixture.sideAEntryId !== null && fixture.sideBEntryId !== null;
      if (bothPopulated && sideAAvailable !== sideBAvailable) {
        const winnerEntryId = sideAAvailable
          ? fixture.sideAEntryId!
          : fixture.sideBEntryId!;
        const loserEntryId = sideAAvailable
          ? fixture.sideBEntryId!
          : fixture.sideAEntryId!;
        await confirmForfeitInTransaction(
          tx,
          {
            actor: { actorId: context.actor.id, role: context.actor.role },
            matchId: command.matchId,
            fixtureId: fixture.id,
            expectedFixtureVersion: fixture.version,
            requiredFixtureStage: "KNOCKOUT",
            winnerEntryId,
            loserEntryId,
            reason: command.reason,
          },
          () => now,
        );
        forfeitedFixtureIds.push(fixture.id);
        progressed = true;
        break;
      }
      let kind: "NO_CONTEST" | "ADMIN_BYE" | null = null;
      if (bothPopulated && !sideAAvailable && !sideBAvailable) {
        kind = "NO_CONTEST";
      } else if (
        fixture.sideAEntryId !== null &&
        sideBEmpty
      ) {
        kind = sideAAvailable ? "ADMIN_BYE" : "NO_CONTEST";
      } else if (
        fixture.sideBEntryId !== null &&
        sideAEmpty
      ) {
        kind = sideBAvailable ? "ADMIN_BYE" : "NO_CONTEST";
      } else if (
        fixture.sideAEntryId === null &&
        fixture.sideBEntryId === null &&
        sideAEmpty &&
        sideBEmpty
      ) {
        kind = "NO_CONTEST";
      }
      if (!kind) continue;
      await resolveV2KnockoutFixtureAdministratively(tx, {
        match: context.match,
        actorId: context.actor.id,
        fixtureId: fixture.id,
        kind,
        reason: command.reason,
        clock: () => now,
      });
      (kind === "ADMIN_BYE" ? adminByeFixtureIds : noContestFixtureIds).push(
        fixture.id,
      );
      progressed = true;
      break;
    }
    if (!progressed) break;
    if (iteration === MAX_MATCH_FIXTURES - 1) {
      fail("FIXTURE_DEPENDENCY_CYCLE", "Knockout disqualification did not converge.");
    }
  }

  await finishV2GroupOnlyMatchIfTerminal(tx, context.match);
  return {
    matchId: command.matchId,
    entries: transitions,
    forfeitedFixtureIds,
    noContestFixtureIds,
    adminByeFixtureIds,
    voidedPendingRevisionIds,
  };
}

export async function disqualifyV2EntryInTransaction(
  tx: V2CompetitionTransaction,
  rawCommand: DisqualifyV2EntryCommand,
): Promise<DisqualifyV2EntryResult> {
  const command = normalize(rawCommand);
  const result = await disqualifyV2EntriesInTransaction(tx, {
    actor: command.actor,
    matchId: command.matchId,
    targets: [
      {
        entryId: command.entryId,
        expectedEntryVersion: command.expectedEntryVersion,
      },
    ],
    reason: command.reason,
  });
  const entry = result.entries[0];
  if (!entry || entry.entryId !== command.entryId) {
    fail("CONCURRENT_WRITE_CONFLICT", "The disqualified Entry result is missing.");
  }
  return {
    matchId: result.matchId,
    entryId: entry.entryId,
    entryVersion: entry.entryVersion,
    forfeitedFixtureIds: result.forfeitedFixtureIds,
    noContestFixtureIds: result.noContestFixtureIds,
    adminByeFixtureIds: result.adminByeFixtureIds,
    voidedPendingRevisionIds: result.voidedPendingRevisionIds,
  };
}

export function createV2EntryDisqualificationApplicationService(
  dependencies: Readonly<{ db: Pick<PrismaClient, "$transaction"> }>,
) {
  return Object.freeze({
    withdraw: (rawCommand: DisqualifyV2EntryCommand) => {
      const command = normalize(rawCommand);
      return runV2Transaction(dependencies.db, tx => disqualifyV2EntriesInTransaction(tx, {
        actor: command.actor,
        matchId: command.matchId,
        targets: [{ entryId: command.entryId, expectedEntryVersion: command.expectedEntryVersion }],
        reason: command.reason,
      }, "WITHDRAWN"));
    },
    disqualify: (rawCommand: DisqualifyV2EntryCommand) => {
      return runV2Transaction(dependencies.db, (tx) =>
        disqualifyV2EntryInTransaction(tx, rawCommand),
      );
    },
  });
}
