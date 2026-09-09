import type { PrismaClient } from "@prisma/client";

import { V2_SINGLE_MATCH_TEXT_LIMITS } from "./matches";
import { V2_TEAM_MATCH_MEMBER_LIMITS } from "./team-matches";
import {
  V2CompetitionApplicationError,
  loadV2WriteContext,
  runV2Transaction,
  type V2Actor,
} from "./entries";

export type UpdateV2MatchSettingsCommand = Readonly<{
  actor: V2Actor;
  matchId: string;
  expectedUpdatedAt: Date;
  title: string;
  description: string | null;
  location: string;
  dateTime: Date;
  registrationDeadline: Date;
}>;

export type UpdateV2SingleMatchSettingsCommand = UpdateV2MatchSettingsCommand;

export type UpdatedV2MatchSettings = Readonly<{
  matchId: string;
  title: string;
  description: string | null;
  location: string;
  dateTime: Date;
  registrationDeadline: Date;
  updatedAt: Date;
  changed: boolean;
}>;

export type UpdatedV2SingleMatchSettings = UpdatedV2MatchSettings;

export type V2MatchSettingsApplicationService = Readonly<{
  update(
    command: UpdateV2MatchSettingsCommand,
  ): Promise<UpdatedV2MatchSettings>;
}>;

export type V2SingleMatchSettingsApplicationService =
  V2MatchSettingsApplicationService;

export type V2MatchSettingsApplicationServiceDependencies = Readonly<{
  db: Pick<PrismaClient, "$transaction">;
  clock?: () => Date;
}>;

export type V2SingleMatchSettingsApplicationServiceDependencies =
  V2MatchSettingsApplicationServiceDependencies;

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
  const accepted = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !accepted.has(key));
  if (unexpected.length > 0) {
    fail("INVALID_INPUT", `${name} contains unsupported fields.`, {
      name,
      unexpected,
    });
  }
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

function copyValidDate(value: unknown, name: string) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("INVALID_INPUT", `${name} must be a valid Date.`, { name });
  }
  return new Date(value.getTime());
}

function assertRequiredText(
  value: unknown,
  name: "title" | "location",
): asserts value is string {
  const maxLength = V2_SINGLE_MATCH_TEXT_LIMITS[name];
  if (
    typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  ) {
    return;
  }
  fail("INVALID_INPUT", `${name} is invalid.`, { name, maxLength });
}

function assertDescription(value: unknown): asserts value is string | null {
  if (value === null) return;
  if (
    typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    value.length <= V2_SINGLE_MATCH_TEXT_LIMITS.description &&
    !value.includes("\u0000")
  ) {
    return;
  }
  fail("INVALID_INPUT", "description is invalid.", {
    maxLength: V2_SINGLE_MATCH_TEXT_LIMITS.description,
  });
}

function normalizeCommand(
  command: UpdateV2MatchSettingsCommand,
): UpdateV2MatchSettingsCommand {
  if (!isRecord(command)) {
    fail("INVALID_INPUT", "The match settings command must be an object.");
  }
  assertOnlyKeys(
    command,
    [
      "actor",
      "matchId",
      "expectedUpdatedAt",
      "title",
      "description",
      "location",
      "dateTime",
      "registrationDeadline",
    ],
    "command",
  );
  if (!isRecord(command.actor)) {
    fail("INVALID_INPUT", "actor must be an object.");
  }
  assertOnlyKeys(command.actor, ["id", "role"], "actor");
  assertStableIdentifier(command.actor.id, "actor.id");
  if (command.actor.role !== "user" && command.actor.role !== "admin") {
    fail("INVALID_INPUT", "actor.role must be user or admin.");
  }
  assertStableIdentifier(command.matchId, "matchId");
  const expectedUpdatedAt = copyValidDate(
    command.expectedUpdatedAt,
    "expectedUpdatedAt",
  );
  assertRequiredText(command.title, "title");
  assertDescription(command.description);
  assertRequiredText(command.location, "location");
  const dateTime = copyValidDate(command.dateTime, "dateTime");
  const registrationDeadline = copyValidDate(
    command.registrationDeadline,
    "registrationDeadline",
  );
  if (registrationDeadline.getTime() >= dateTime.getTime()) {
    fail(
      "INVALID_INPUT",
      "The registration deadline must be earlier than the match start time.",
    );
  }

  return {
    actor: { id: command.actor.id, role: command.actor.role },
    matchId: command.matchId,
    expectedUpdatedAt,
    title: command.title,
    description: command.description,
    location: command.location,
    dateTime,
    registrationDeadline,
  };
}

function sameSettings(
  current: Readonly<{
    title: string;
    description: string | null;
    location: string | null;
    dateTime: Date;
    registrationDeadline: Date;
  }>,
  command: UpdateV2MatchSettingsCommand,
) {
  return (
    current.title === command.title &&
    current.description === command.description &&
    current.location === command.location &&
    current.dateTime.getTime() === command.dateTime.getTime() &&
    current.registrationDeadline.getTime() ===
      command.registrationDeadline.getTime()
  );
}

function isSupportedFormalType(value: unknown) {
  return value === "single" || value === "double" || value === "team";
}

function isSupportedFormalFormat(value: unknown) {
  return value === "group_only" || value === "group_then_knockout";
}

/**
 * Updates presentation metadata and the registration/start schedule for
 * every formal V2 type x format slice. The Match row is the aggregate
 * lock: grouping, Fixture, engine, status, and creation-idempotency fields are
 * never changed by this command.
 */
export function createV2MatchSettingsApplicationService(
  dependencies: V2MatchSettingsApplicationServiceDependencies,
): V2MatchSettingsApplicationService {
  const clock = dependencies.clock ?? (() => new Date());

  return Object.freeze({
    update: async (rawCommand) => {
      const command = normalizeCommand(rawCommand);
      return runV2Transaction(dependencies.db, async (tx) => {
        // loadV2WriteContext always locks Match before actor and revalidates both
        // from the transaction snapshot.
        const context = await loadV2WriteContext(
          tx,
          command.matchId,
          command.actor,
        );
        const match = await tx.match.findUnique({
          where: { id: command.matchId },
          select: {
            id: true,
            title: true,
            description: true,
            location: true,
            dateTime: true,
            updatedAt: true,
            engineVersion: true,
            isQuickMatch: true,
            type: true,
            format: true,
            status: true,
            createdBy: true,
            createdAt: true,
            registrationDeadline: true,
            teamRegistrationStart: true,
            teamRegistrationDeadline: true,
            teamMinMembers: true,
            teamMaxMembers: true,
            groupingGeneratedAt: true,
          },
        });
        if (!match) {
          fail("MATCH_NOT_FOUND", "The locked match disappeared.", {
            matchId: command.matchId,
          });
        }
        if (
          match.engineVersion !== "V2" ||
          match.isQuickMatch ||
          !isSupportedFormalType(match.type) ||
          !isSupportedFormalFormat(match.format)
        ) {
          fail(
            "FORBIDDEN",
            "This settings command accepts formal V2 matches only.",
            { matchId: match.id },
          );
        }
        if (context.actor.id !== match.createdBy) {
          fail("FORBIDDEN", "Only the match creator can edit these settings.", {
            actorId: context.actor.id,
            matchId: match.id,
          });
        }

        const now = clock();
        if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
          fail("INVALID_INPUT", "The match settings clock is invalid.");
        }

        let authoritativeRegistrationDeadline = match.registrationDeadline;
        let immutableTeamRegistrationStart: Date | null = null;
        if (match.type === "team") {
          const teamRegistrationStart = match.teamRegistrationStart;
          const teamRegistrationDeadline = match.teamRegistrationDeadline;
          const teamMinMembers = match.teamMinMembers;
          const teamMaxMembers = match.teamMaxMembers;
          if (
            teamRegistrationStart === null ||
            teamRegistrationDeadline === null ||
            teamMinMembers === null ||
            teamMaxMembers === null ||
            match.registrationDeadline.getTime() !==
              teamRegistrationDeadline.getTime() ||
            teamRegistrationStart.getTime() >=
              teamRegistrationDeadline.getTime() ||
            teamMinMembers < V2_TEAM_MATCH_MEMBER_LIMITS.minimum ||
            teamMaxMembers > V2_TEAM_MATCH_MEMBER_LIMITS.maximum ||
            teamMaxMembers < teamMinMembers
          ) {
            fail(
              "PERSISTENCE_CONFLICT",
              "The TEAM registration policy is incomplete or inconsistent.",
              { matchId: match.id },
            );
          }
          authoritativeRegistrationDeadline = teamRegistrationDeadline;
          immutableTeamRegistrationStart = teamRegistrationStart;
        }
        if (
          match.status !== "registration" ||
          now < match.createdAt ||
          now >= authoritativeRegistrationDeadline ||
          match.groupingGeneratedAt !== null
        ) {
          fail(
            "FORBIDDEN",
            "Match settings can be edited only during registration and before grouping is published.",
            { matchId: match.id },
          );
        }
        if (
          command.registrationDeadline.getTime() <= now.getTime() ||
          command.registrationDeadline.getTime() >= command.dateTime.getTime() ||
          (immutableTeamRegistrationStart !== null &&
            command.registrationDeadline.getTime() <=
              immutableTeamRegistrationStart.getTime())
        ) {
          fail(
            "INVALID_INPUT",
            "The new registration deadline must be in the future, after the immutable TEAM registration start when applicable, and earlier than the match start time.",
            { matchId: match.id },
          );
        }

        const grouping = await tx.matchGrouping.findUnique({
          where: { matchId: match.id },
          select: { id: true },
        });
        const fixtureCount = await tx.matchFixture.count({
          where: { matchId: match.id },
        });
        const relationalGroupCount = await tx.matchGroup.count({
          where: { matchId: match.id },
        });
        const qualificationSnapshotCount =
          await tx.matchQualificationSnapshot.count({
            where: { matchId: match.id },
          });
        if (
          grouping ||
          fixtureCount > 0 ||
          relationalGroupCount > 0 ||
          qualificationSnapshotCount > 0
        ) {
          fail(
            "FORBIDDEN",
            "Grouping, qualification, or fixture state makes match settings immutable.",
            {
              matchId: match.id,
              fixtureCount,
              relationalGroupCount,
              qualificationSnapshotCount,
              hasCompatibilityGrouping: grouping !== null,
            },
          );
        }

        if (sameSettings(match, command)) {
          return {
            matchId: match.id,
            title: match.title,
            description: match.description,
            location: command.location,
            dateTime: new Date(match.dateTime),
            registrationDeadline: new Date(match.registrationDeadline),
            updatedAt: match.updatedAt,
            changed: false,
          };
        }
        if (match.updatedAt.getTime() !== command.expectedUpdatedAt.getTime()) {
          fail(
            "CONCURRENT_WRITE_CONFLICT",
            "The match settings changed after the form was loaded.",
            {
              matchId: match.id,
              expectedUpdatedAt: command.expectedUpdatedAt,
              actualUpdatedAt: match.updatedAt,
            },
          );
        }

        const updated = await tx.match.update({
          where: {
            id: match.id,
            updatedAt: command.expectedUpdatedAt,
          },
          data: {
            title: command.title,
            description: command.description,
            location: command.location,
            dateTime: command.dateTime,
            registrationDeadline: command.registrationDeadline,
            ...(match.type === "team"
              ? { teamRegistrationDeadline: command.registrationDeadline }
              : {}),
          },
          select: {
            id: true,
            title: true,
            description: true,
            location: true,
            dateTime: true,
            registrationDeadline: true,
            teamRegistrationDeadline: true,
            type: true,
            format: true,
            updatedAt: true,
          },
        });
        if (
          updated.type === "team" &&
          (updated.teamRegistrationDeadline === null ||
            updated.registrationDeadline.getTime() !==
              updated.teamRegistrationDeadline.getTime())
        ) {
          fail(
            "PERSISTENCE_CONFLICT",
            "The TEAM registration deadlines diverged during the settings update.",
            { matchId: match.id },
          );
        }
        await tx.auditLog.create({
          data: {
            actorId: context.actor.id,
            action: "v2_match_settings_update",
            entityType: "Match",
            entityId: match.id,
            details: {
              targetLabel: updated.title,
              engineVersion: "V2",
              type: updated.type,
              format: updated.format,
              before: {
                title: match.title,
                description: match.description,
                location: match.location,
                dateTime: match.dateTime.toISOString(),
                registrationDeadline: match.registrationDeadline.toISOString(),
                teamRegistrationDeadline:
                  match.teamRegistrationDeadline?.toISOString() ?? null,
              },
              after: {
                title: updated.title,
                description: updated.description,
                location: updated.location,
                dateTime: updated.dateTime.toISOString(),
                registrationDeadline: updated.registrationDeadline.toISOString(),
                teamRegistrationDeadline:
                  updated.teamRegistrationDeadline?.toISOString() ?? null,
              },
            },
          },
        });

        return {
          matchId: updated.id,
          title: updated.title,
          description: updated.description,
          location: updated.location ?? command.location,
          dateTime: new Date(updated.dateTime),
          registrationDeadline: new Date(updated.registrationDeadline),
          updatedAt: updated.updatedAt,
          changed: true,
        };
      });
    },
  });
}

/** Backwards-compatible facade retained for the original SINGLE settings API. */
export function createV2SingleMatchSettingsApplicationService(
  dependencies: V2SingleMatchSettingsApplicationServiceDependencies,
): V2SingleMatchSettingsApplicationService {
  return createV2MatchSettingsApplicationService(dependencies);
}
