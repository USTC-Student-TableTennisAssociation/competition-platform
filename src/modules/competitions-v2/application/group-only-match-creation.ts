import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";

import {
  V2CompetitionApplicationError,
  runV2Transaction,
  type V2Actor,
  type V2CompetitionTransaction,
} from "./entries";

export const V2_GROUP_ONLY_MATCH_UNLIMITED_PARTICIPANTS = 2_147_483_647;
export const V2_GROUP_ONLY_MATCH_CREATION_REQUEST_KEY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const V2_GROUP_ONLY_MATCH_TEXT_LIMITS = Object.freeze({
  title: 200,
  description: 5_000,
  location: 200,
});

export type V2GroupOnlyMatchType = "single" | "double" | "team";
export type V2FormalMatchFormat = "group_only" | "group_then_knockout";

export const V2_TEAM_GROUP_ONLY_MATCH_MEMBER_LIMITS = Object.freeze({
  minimum: 1,
  maximum: 50,
});

type V2TeamGroupOnlyMatchCreationFields = Readonly<{
  teamRegistrationStart: Date;
  teamRegistrationDeadline: Date;
  teamMinMembers: number;
  teamMaxMembers: number;
}>;

type V2MatchCreationBaseCommand<
  TType extends V2GroupOnlyMatchType,
  TFormat extends V2FormalMatchFormat,
> = Readonly<{
  actor: V2Actor;
  requestKey: string;
  title: string;
  description: string | null;
  location: string;
  dateTime: Date;
  registrationDeadline: Date;
  type: TType;
  format: TFormat;
  groupBestOf?: 3 | 5 | 7;
  knockoutBestOf?: 3 | 5 | 7;
}>;

export type CreateV2MatchCommand<
  TType extends V2GroupOnlyMatchType,
  TFormat extends V2FormalMatchFormat,
> = V2MatchCreationBaseCommand<TType, TFormat> &
  (TType extends "team"
    ? V2TeamGroupOnlyMatchCreationFields
    : Readonly<Record<never, never>>);

export type CreateV2GroupOnlyMatchCommand<
  TType extends V2GroupOnlyMatchType,
> = CreateV2MatchCommand<TType, "group_only">;

export type CreateV2GroupThenKnockoutMatchCommand<
  TType extends V2GroupOnlyMatchType,
> = CreateV2MatchCommand<TType, "group_then_knockout">;

export type CreatedV2Match<
  TType extends V2GroupOnlyMatchType,
  TFormat extends V2FormalMatchFormat,
> = Readonly<{
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  dateTime: Date;
  registrationDeadline: Date;
  type: TType;
  format: TFormat;
  status: "registration" | "ongoing" | "finished";
  engineVersion: "V2";
  isQuickMatch: false;
  maxParticipants: number;
  createdBy: string;
  created: boolean;
}>;

export type CreatedV2GroupOnlyMatch<
  TType extends V2GroupOnlyMatchType,
> = CreatedV2Match<TType, "group_only">;

export type CreatedV2GroupThenKnockoutMatch<
  TType extends V2GroupOnlyMatchType,
> = CreatedV2Match<TType, "group_then_knockout">;

export type V2MatchApplicationService<
  TType extends V2GroupOnlyMatchType,
  TFormat extends V2FormalMatchFormat,
> = Readonly<{
  create(
    command: CreateV2MatchCommand<TType, TFormat>,
  ): Promise<CreatedV2Match<TType, TFormat>>;
  resolveExisting(
    command: CreateV2MatchCommand<TType, TFormat>,
  ): Promise<CreatedV2Match<TType, TFormat> | null>;
}>;

export type V2GroupOnlyMatchApplicationService<
  TType extends V2GroupOnlyMatchType,
> = V2MatchApplicationService<TType, "group_only">;

export type V2GroupThenKnockoutMatchApplicationService<
  TType extends V2GroupOnlyMatchType,
> = V2MatchApplicationService<TType, "group_then_knockout">;

export type V2MatchCreationConfig<
  TType extends V2GroupOnlyMatchType,
  TFormat extends V2FormalMatchFormat,
> = Readonly<{
  type: TType;
  format: TFormat;
  fingerprintNamespace: string;
  invalidTypeMessage: string;
  invalidFormatMessage: string;
  ruleNote: string;
}>;

export type V2GroupOnlyMatchCreationConfig<
  TType extends V2GroupOnlyMatchType,
> = V2MatchCreationConfig<TType, "group_only">;

export type V2GroupOnlyMatchApplicationServiceDependencies = Readonly<{
  db: Pick<PrismaClient, "$transaction">;
}>;

function fail(
  code: V2CompetitionApplicationError["code"],
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new V2CompetitionApplicationError(code, message, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
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
    value !== "" &&
    value === value.trim() &&
    !value.includes("\u0000")
  ) {
    return;
  }
  fail("INVALID_INPUT", `${name} must be a non-empty stable identifier.`, {
    name,
  });
}

function assertNormalizedRequiredText(
  value: unknown,
  name: "title" | "location",
): asserts value is string {
  const limit = V2_GROUP_ONLY_MATCH_TEXT_LIMITS[name];
  if (
    typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    !value.includes("\u0000") &&
    value.length <= limit
  ) {
    return;
  }
  fail("INVALID_INPUT", `${name} must be normalized and within its length limit.`, {
    name,
    maxLength: limit,
  });
}

function assertNormalizedDescription(
  value: unknown,
): asserts value is string | null {
  if (value === null) return;
  if (
    typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    !value.includes("\u0000") &&
    value.length <= V2_GROUP_ONLY_MATCH_TEXT_LIMITS.description
  ) {
    return;
  }
  fail(
    "INVALID_INPUT",
    "description must be null or normalized and within its length limit.",
    { maxLength: V2_GROUP_ONLY_MATCH_TEXT_LIMITS.description },
  );
}

function copyValidDate(value: unknown, name: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("INVALID_INPUT", `${name} must be a valid Date.`, { name });
  }
  return new Date(value.getTime());
}

function copyTeamMemberLimit(value: unknown, name: string) {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < V2_TEAM_GROUP_ONLY_MATCH_MEMBER_LIMITS.minimum ||
    value > V2_TEAM_GROUP_ONLY_MATCH_MEMBER_LIMITS.maximum
  ) {
    fail("INVALID_INPUT", `${name} must be a supported positive integer.`, {
      name,
      minimum: V2_TEAM_GROUP_ONLY_MATCH_MEMBER_LIMITS.minimum,
      maximum: V2_TEAM_GROUP_ONLY_MATCH_MEMBER_LIMITS.maximum,
    });
  }
  return value;
}

function teamCreationFields<
  TType extends V2GroupOnlyMatchType,
  TFormat extends V2FormalMatchFormat,
>(
  command: CreateV2MatchCommand<TType, TFormat>,
  config: V2MatchCreationConfig<TType, TFormat>,
): V2TeamGroupOnlyMatchCreationFields | null {
  if (config.type !== "team") return null;
  return command as CreateV2MatchCommand<"team", TFormat>;
}

export function isV2GroupOnlyMatchCreationRequestKey(
  value: unknown,
): value is string {
  return (
    typeof value === "string" &&
    V2_GROUP_ONLY_MATCH_CREATION_REQUEST_KEY_PATTERN.test(value)
  );
}

function normalizeCommand<
  TType extends V2GroupOnlyMatchType,
  TFormat extends V2FormalMatchFormat,
>(
  rawCommand: CreateV2MatchCommand<TType, TFormat>,
  config: V2MatchCreationConfig<TType, TFormat>,
): CreateV2MatchCommand<TType, TFormat> {
  if (!isRecord(rawCommand)) {
    fail("INVALID_INPUT", "The match creation command must be an object.");
  }
  assertOnlyKeys(
    rawCommand,
    [
      "actor",
      "requestKey",
      "title",
      "description",
      "location",
      "dateTime",
      "registrationDeadline",
      "type",
      "format",
      "groupBestOf",
      "knockoutBestOf",
      ...(config.type === "team"
        ? [
            "teamRegistrationStart",
            "teamRegistrationDeadline",
            "teamMinMembers",
            "teamMaxMembers",
          ]
        : []),
    ],
    "command",
  );
  if (!isRecord(rawCommand.actor)) {
    fail("INVALID_INPUT", "actor must be an object.");
  }
  assertOnlyKeys(rawCommand.actor, ["id", "role"], "actor");
  assertStableIdentifier(rawCommand.actor.id, "actor.id");
  if (rawCommand.actor.role !== "user" && rawCommand.actor.role !== "admin") {
    fail("INVALID_INPUT", "actor.role must be user or admin.");
  }
  if (!isV2GroupOnlyMatchCreationRequestKey(rawCommand.requestKey)) {
    fail("INVALID_INPUT", "requestKey must be a canonical UUID v4.", {
      name: "requestKey",
    });
  }
  assertNormalizedRequiredText(rawCommand.title, "title");
  assertNormalizedDescription(rawCommand.description);
  assertNormalizedRequiredText(rawCommand.location, "location");
  if (rawCommand.type !== config.type) {
    fail("INVALID_INPUT", config.invalidTypeMessage, { type: rawCommand.type });
  }
  if (rawCommand.format !== config.format) {
    fail("INVALID_INPUT", config.invalidFormatMessage, {
      format: rawCommand.format,
    });
  }

  const dateTime = copyValidDate(rawCommand.dateTime, "dateTime");
  const registrationDeadline = copyValidDate(
    rawCommand.registrationDeadline,
    "registrationDeadline",
  );
  if (registrationDeadline.getTime() >= dateTime.getTime()) {
    fail(
      "INVALID_INPUT",
      "The registration deadline must be earlier than the match start time.",
    );
  }

  for (const value of [rawCommand.groupBestOf, rawCommand.knockoutBestOf]) {
    if (value !== undefined && value !== 3 && value !== 5 && value !== 7) {
      fail("INVALID_INPUT", "局制必须是三局两胜、五局三胜或七局四胜。");
    }
  }
  const normalizedBase = {
    actor: { id: rawCommand.actor.id, role: rawCommand.actor.role },
    requestKey: rawCommand.requestKey,
    title: rawCommand.title,
    description: rawCommand.description,
    location: rawCommand.location,
    dateTime,
    registrationDeadline,
    type: config.type,
    format: config.format,
    groupBestOf: rawCommand.groupBestOf ?? 5,
    knockoutBestOf: rawCommand.knockoutBestOf ?? 5,
  };
  if (config.type !== "team") {
    return normalizedBase as CreateV2MatchCommand<TType, TFormat>;
  }

  const teamCommand = rawCommand as CreateV2MatchCommand<"team", TFormat>;
  const teamRegistrationStart = copyValidDate(
    teamCommand.teamRegistrationStart,
    "teamRegistrationStart",
  );
  const teamRegistrationDeadline = copyValidDate(
    teamCommand.teamRegistrationDeadline,
    "teamRegistrationDeadline",
  );
  const teamMinMembers = copyTeamMemberLimit(
    teamCommand.teamMinMembers,
    "teamMinMembers",
  );
  const teamMaxMembers = copyTeamMemberLimit(
    teamCommand.teamMaxMembers,
    "teamMaxMembers",
  );
  if (teamRegistrationStart.getTime() >= teamRegistrationDeadline.getTime()) {
    fail(
      "INVALID_INPUT",
      "The TEAM registration start must be earlier than its deadline.",
    );
  }
  if (teamRegistrationDeadline.getTime() >= dateTime.getTime()) {
    fail(
      "INVALID_INPUT",
      "The TEAM registration deadline must be earlier than the match start time.",
    );
  }
  if (teamMaxMembers < teamMinMembers) {
    fail(
      "INVALID_INPUT",
      "teamMaxMembers must be greater than or equal to teamMinMembers.",
    );
  }

  return {
    ...normalizedBase,
    // Match.registrationDeadline remains the shared grouping deadline. TEAM
    // uses its dedicated authoritative window, so both persisted deadlines
    // intentionally converge on the TEAM deadline.
    registrationDeadline: teamRegistrationDeadline,
    teamRegistrationStart,
    teamRegistrationDeadline,
    teamMinMembers,
    teamMaxMembers,
  } as CreateV2MatchCommand<TType, TFormat>;
}

export function fingerprintV2MatchCreation<
  TType extends V2GroupOnlyMatchType,
  TFormat extends V2FormalMatchFormat,
>(
  command: CreateV2MatchCommand<TType, TFormat>,
  config: V2MatchCreationConfig<TType, TFormat>,
) {
  const teamFields = teamCreationFields(command, config);
  const canonicalPayload = JSON.stringify([
    config.fingerprintNamespace,
    1,
    command.actor.id,
    command.title,
    command.description,
    command.location,
    command.dateTime.toISOString(),
    command.registrationDeadline.toISOString(),
    command.type,
    command.format,
    command.groupBestOf ?? 5,
    command.knockoutBestOf ?? 5,
    ...(teamFields
      ? [
          teamFields.teamRegistrationStart.toISOString(),
          teamFields.teamRegistrationDeadline.toISOString(),
          teamFields.teamMinMembers,
          teamFields.teamMaxMembers,
        ]
      : []),
  ]);
  return createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
}

export function fingerprintV2GroupOnlyMatchCreation<
  TType extends V2GroupOnlyMatchType,
>(
  command: CreateV2GroupOnlyMatchCommand<TType>,
  config: V2GroupOnlyMatchCreationConfig<TType>,
) {
  return fingerprintV2MatchCreation(command, config);
}

async function loadLockedActiveActor(
  tx: V2CompetitionTransaction,
  actorInput: V2Actor,
) {
  const lockedActor = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${actorInput.id} FOR UPDATE`,
  );
  if (lockedActor.length === 0) {
    fail("ACTOR_NOT_ACTIVE", "The actor is missing, banned, or not verified.", {
      actorId: actorInput.id,
    });
  }
  const actor = await tx.user.findUnique({
    where: { id: actorInput.id },
    select: {
      id: true,
      role: true,
      isBanned: true,
      emailVerifiedAt: true,
    },
  });
  if (!actor || actor.isBanned || !actor.emailVerifiedAt) {
    fail("ACTOR_NOT_ACTIVE", "The actor is missing, banned, or not verified.", {
      actorId: actorInput.id,
    });
  }
  if (actor.role !== actorInput.role) {
    fail(
      "ACTOR_ROLE_STALE",
      "The supplied actor role no longer matches the database.",
      { actorId: actorInput.id },
    );
  }
  return actor;
}

async function loadExistingCreation<
  TType extends V2GroupOnlyMatchType,
  TFormat extends V2FormalMatchFormat,
>(
  tx: V2CompetitionTransaction,
  actorId: string,
  requestKey: string,
  creationRequestFingerprint: string,
  config: V2MatchCreationConfig<TType, TFormat>,
): Promise<CreatedV2Match<TType, TFormat> | null> {
  const existing = await tx.match.findUnique({
    where: {
      createdBy_creationRequestKey: {
        createdBy: actorId,
        creationRequestKey: requestKey,
      },
    },
    select: {
      id: true,
      title: true,
      description: true,
      location: true,
      dateTime: true,
      registrationDeadline: true,
      type: true,
      format: true,
      status: true,
      engineVersion: true,
      isQuickMatch: true,
      maxParticipants: true,
      createdBy: true,
      creationRequestFingerprint: true,
    },
  });
  if (!existing) return null;
  if (
    existing.creationRequestFingerprint !== creationRequestFingerprint ||
    existing.engineVersion !== "V2" ||
    existing.isQuickMatch ||
    existing.type !== config.type ||
    existing.format !== config.format
  ) {
    fail(
      "PERSISTENCE_CONFLICT",
      "The creation request key is already bound to a different command.",
      { requestKey },
    );
  }
  return {
    id: existing.id,
    title: existing.title,
    description: existing.description,
    location: existing.location,
    dateTime: existing.dateTime,
    registrationDeadline: existing.registrationDeadline,
    type: config.type,
    format: config.format,
    status: existing.status,
    engineVersion: "V2",
    isQuickMatch: false,
    maxParticipants: existing.maxParticipants,
    createdBy: existing.createdBy,
    created: false,
  };
}

async function createInTransaction<
  TType extends V2GroupOnlyMatchType,
  TFormat extends V2FormalMatchFormat,
>(
  tx: V2CompetitionTransaction,
  command: CreateV2MatchCommand<TType, TFormat>,
  creationRequestFingerprint: string,
  config: V2MatchCreationConfig<TType, TFormat>,
): Promise<CreatedV2Match<TType, TFormat>> {
  const actor = await loadLockedActiveActor(tx, command.actor);
  const teamFields = teamCreationFields(command, config);
  const existing = await loadExistingCreation(
    tx,
    actor.id,
    command.requestKey,
    creationRequestFingerprint,
    config,
  );
  if (existing) return existing;

  const created = await tx.match.create({
    data: {
      title: command.title,
      description: command.description,
      location: command.location,
      dateTime: command.dateTime,
      registrationDeadline: command.registrationDeadline,
      type: config.type,
      format: config.format,
      maxParticipants: V2_GROUP_ONLY_MATCH_UNLIMITED_PARTICIPANTS,
      status: "registration",
      engineVersion: "V2",
      creationRequestKey: command.requestKey,
      creationRequestFingerprint,
      isQuickMatch: false,
      createdBy: actor.id,
      teamRegistrationStart: teamFields?.teamRegistrationStart ?? null,
      teamRegistrationDeadline: teamFields?.teamRegistrationDeadline ?? null,
      teamMinMembers: teamFields?.teamMinMembers ?? null,
      teamMaxMembers: teamFields?.teamMaxMembers ?? null,
      rule: { note: config.ruleNote },
      groupBestOf: command.groupBestOf ?? 5,
      knockoutBestOf: command.knockoutBestOf ?? 5,
    },
    select: {
      id: true,
      title: true,
      description: true,
      location: true,
      dateTime: true,
      registrationDeadline: true,
      type: true,
      format: true,
      status: true,
      engineVersion: true,
      isQuickMatch: true,
      maxParticipants: true,
      createdBy: true,
    },
  });

  await tx.auditLog.create({
    data: {
      actorId: actor.id,
      action: "match.create",
      entityType: "Match",
      entityId: created.id,
      details: {
        targetLabel: created.title,
        title: created.title,
        type: created.type,
        format: created.format,
        engineVersion: created.engineVersion,
        creationRequestFingerprint,
        isQuickMatch: created.isQuickMatch,
        dateTime: created.dateTime.toISOString(),
        registrationDeadline: created.registrationDeadline.toISOString(),
        teamRegistrationStart:
          teamFields?.teamRegistrationStart.toISOString() ?? null,
        teamRegistrationDeadline:
          teamFields?.teamRegistrationDeadline.toISOString() ?? null,
        teamMinMembers: teamFields?.teamMinMembers ?? null,
        teamMaxMembers: teamFields?.teamMaxMembers ?? null,
      },
    },
  });
  return { ...created, created: true } as CreatedV2Match<TType, TFormat>;
}

/** Shared audited/idempotent creation kernel for one exact formal V2 slice. */
export function createV2MatchApplicationService<
  TType extends V2GroupOnlyMatchType,
  TFormat extends V2FormalMatchFormat,
>(
  dependencies: V2GroupOnlyMatchApplicationServiceDependencies,
  config: V2MatchCreationConfig<TType, TFormat>,
): V2MatchApplicationService<TType, TFormat> {
  return Object.freeze({
    create: async (rawCommand) => {
      const command = normalizeCommand(rawCommand, config);
      const fingerprint = fingerprintV2MatchCreation(command, config);
      try {
        return await runV2Transaction(dependencies.db, (tx) =>
          createInTransaction(tx, command, fingerprint, config),
        );
      } catch (error) {
        if (
          !(error instanceof V2CompetitionApplicationError) ||
          (error.code !== "CONCURRENT_WRITE_CONFLICT" &&
            error.code !== "PERSISTENCE_CONFLICT")
        ) {
          throw error;
        }
        const resolved = await runV2Transaction(dependencies.db, async (tx) => {
          const actor = await loadLockedActiveActor(tx, command.actor);
          return loadExistingCreation(
            tx,
            actor.id,
            command.requestKey,
            fingerprint,
            config,
          );
        });
        if (resolved) return resolved;
        throw error;
      }
    },
    resolveExisting: async (rawCommand) => {
      const command = normalizeCommand(rawCommand, config);
      const fingerprint = fingerprintV2MatchCreation(command, config);
      return runV2Transaction(dependencies.db, async (tx) => {
        const actor = await loadLockedActiveActor(tx, command.actor);
        return loadExistingCreation(
          tx,
          actor.id,
          command.requestKey,
          fingerprint,
          config,
        );
      });
    },
  });
}

/** Backwards-compatible shared facade for the existing group-only API. */
export function createV2GroupOnlyMatchApplicationService<
  TType extends V2GroupOnlyMatchType,
>(
  dependencies: V2GroupOnlyMatchApplicationServiceDependencies,
  config: V2GroupOnlyMatchCreationConfig<TType>,
): V2GroupOnlyMatchApplicationService<TType> {
  return createV2MatchApplicationService(dependencies, config);
}
