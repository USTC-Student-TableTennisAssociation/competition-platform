import { Prisma, type PrismaClient } from "@prisma/client";

import {
  V2CompetitionApplicationError,
  runV2Transaction,
  type V2Actor,
  type V2CompetitionTransaction,
} from "./entries";
import {
  publishV2KnockoutInTransaction,
  type PublishV2KnockoutCommand,
  type PublishV2KnockoutResult,
  type V2KnockoutPublicationTransactionHooks,
} from "./knockout-publication";
import {
  freezeV2QualificationSnapshotInTransaction,
  type FreezeV2QualificationSnapshotCommand,
  type FreezeV2QualificationSnapshotResult,
} from "./qualification-snapshot";

const MAX_IDENTIFIER_LENGTH = 191;

export type FreezeAndPublishV2KnockoutCommand = Readonly<{
  actor: V2Actor;
  matchId: string;
}>;

export type FreezeAndPublishV2KnockoutResult = Readonly<{
  matchId: string;
  qualification: FreezeV2QualificationSnapshotResult;
  knockout: PublishV2KnockoutResult;
}>;

export type V2QualificationAndKnockoutPublicationApplicationService = Readonly<{
  freezeAndPublish(
    command: FreezeAndPublishV2KnockoutCommand,
  ): Promise<FreezeAndPublishV2KnockoutResult>;
}>;

type QualificationKernel = (
  tx: V2CompetitionTransaction,
  command: FreezeV2QualificationSnapshotCommand,
  clock: () => Date,
) => Promise<FreezeV2QualificationSnapshotResult>;

type KnockoutKernel = (
  tx: V2CompetitionTransaction,
  command: PublishV2KnockoutCommand,
  clock: () => Date,
  hooks?: V2KnockoutPublicationTransactionHooks,
) => Promise<PublishV2KnockoutResult>;

/**
 * @internal Trusted composition seams for deterministic application tests.
 * Route/API adapters must omit these dependencies and use the real kernels
 * and no publication hook.
 */
export type V2QualificationAndKnockoutPublicationInternalPorts = Readonly<{
  freeze?: QualificationKernel;
  publish?: KnockoutKernel;
  knockoutHooks?: V2KnockoutPublicationTransactionHooks;
}>;

export type V2QualificationAndKnockoutPublicationApplicationServiceDependencies =
  Readonly<{
    db: Pick<PrismaClient, "$transaction">;
    clock?: () => Date;
    internal?: V2QualificationAndKnockoutPublicationInternalPorts;
  }>;

function fail(
  code: V2CompetitionApplicationError["code"],
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new V2CompetitionApplicationError(code, message, details);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  name: string,
) {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length === 0) return;
  fail("INVALID_INPUT", `${name} contains unsupported fields.`, {
    name,
    unexpected,
  });
}

function assertStableIdentifier(value: unknown, name: string): asserts value is string {
  if (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  ) {
    return;
  }
  fail("INVALID_INPUT", `${name} must be a stable identifier.`, { name });
}

function normalizeCommand(
  command: FreezeAndPublishV2KnockoutCommand,
): FreezeAndPublishV2KnockoutCommand {
  if (!isRecord(command)) {
    fail("INVALID_INPUT", "A qualification and knockout publication command is required.");
  }
  assertOnlyKeys(command, ["actor", "matchId"], "command");
  assertStableIdentifier(command.matchId, "matchId");
  if (!isRecord(command.actor)) fail("INVALID_INPUT", "actor must be an object.");
  assertOnlyKeys(command.actor, ["id", "role"], "actor");
  assertStableIdentifier(command.actor.id, "actor.id");
  if (command.actor.role !== "user" && command.actor.role !== "admin") {
    fail("INVALID_INPUT", "actor.role must be user or admin.");
  }
  return Object.freeze({
    actor: Object.freeze({ id: command.actor.id, role: command.actor.role }),
    matchId: command.matchId,
  });
}

async function lockMatch(
  tx: V2CompetitionTransaction,
  matchId: string,
) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Match" WHERE "id" = ${matchId} FOR UPDATE
  `);
  if (rows.length === 0) {
    fail("MATCH_NOT_FOUND", "The match does not exist.", { matchId });
  }
  if (rows.length !== 1 || rows[0]?.id !== matchId) {
    fail("PERSISTENCE_CONFLICT", "The locked Match identity is polluted.", {
      matchId,
    });
  }
}

export function createV2QualificationAndKnockoutPublicationApplicationService(
  dependencies: V2QualificationAndKnockoutPublicationApplicationServiceDependencies,
): V2QualificationAndKnockoutPublicationApplicationService {
  const clock = dependencies.clock ?? (() => new Date());
  const freeze =
    dependencies.internal?.freeze ?? freezeV2QualificationSnapshotInTransaction;
  const publish =
    dependencies.internal?.publish ?? publishV2KnockoutInTransaction;
  const knockoutHooks = dependencies.internal?.knockoutHooks;

  return Object.freeze({
    freezeAndPublish: async (rawCommand) => {
      const command = normalizeCommand(rawCommand);
      return runV2Transaction(dependencies.db, async (tx) => {
        await lockMatch(tx, command.matchId);
        const transactionTime = clock();
        if (
          !(transactionTime instanceof Date) ||
          !Number.isFinite(transactionTime.getTime())
        ) {
          fail("INVALID_INPUT", "The qualification publication clock is invalid.");
        }
        const causalClock = () => transactionTime;
        const qualification = await freeze(tx, command, causalClock);
        if (
          qualification.matchId !== command.matchId ||
          !qualification.snapshotId ||
          !/^[a-f0-9]{64}$/.test(qualification.sourceRevisionFingerprint)
        ) {
          fail(
            "PERSISTENCE_CONFLICT",
            "The qualification kernel returned an invalid publication identity.",
            { matchId: command.matchId },
          );
        }
        const knockout = await publish(
          tx,
          {
            actor: command.actor,
            matchId: command.matchId,
            expectedQualificationSnapshotId: qualification.snapshotId,
            expectedSourceRevisionFingerprint:
              qualification.sourceRevisionFingerprint,
          },
          causalClock,
          knockoutHooks,
        );
        if (
          knockout.matchId !== command.matchId ||
          knockout.qualificationSnapshotId !== qualification.snapshotId ||
          knockout.sourceRevisionFingerprint !==
            qualification.sourceRevisionFingerprint
        ) {
          fail(
            "PERSISTENCE_CONFLICT",
            "The knockout kernel returned a different qualification identity.",
            { matchId: command.matchId },
          );
        }
        return Object.freeze({
          matchId: command.matchId,
          qualification,
          knockout,
        });
      });
    },
  });
}
