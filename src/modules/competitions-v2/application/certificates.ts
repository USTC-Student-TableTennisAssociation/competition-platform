import { Prisma, type PrismaClient } from "@prisma/client";

import {
  generateCertificateNumber,
  hashIdentityValue,
  verifyIdentityValue,
} from "../../../lib/certificate-identity";
import {
  evaluateV2CertificateEligibility,
  type V2CertificateCompetitionSnapshot,
  type V2CertificateEligibility,
} from "./certificate-eligibility";

const V2_CERTIFICATE_MATCH_SELECT = Prisma.validator<Prisma.MatchSelect>()({
  id: true,
  title: true,
  engineVersion: true,
  isQuickMatch: true,
  type: true,
  format: true,
  groupingGeneratedAt: true,
  teamMinMembers: true,
  teamMaxMembers: true,
  groupingResult: {
    select: {
      id: true,
      matchId: true,
      v2SchemaVersion: true,
      seedMethod: true,
      standingsPolicyVersion: true,
      qualifiersPerGroup: true,
      bracketPolicyVersion: true,
      createdAt: true,
      qualificationSnapshot: {
        select: { id: true, matchId: true, groupingId: true },
      },
    },
  },
  matchGroups: {
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: {
      id: true,
      matchId: true,
      groupingId: true,
      groupKey: true,
      position: true,
      entries: {
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: {
          id: true,
          matchId: true,
          groupId: true,
          entryId: true,
          position: true,
          globalSeedRank: true,
          entryVersion: true,
          rosterVersion: true,
        },
      },
    },
  },
  entries: {
    orderBy: { id: "asc" },
    select: {
      id: true,
      kind: true,
      status: true,
      version: true,
      members: {
        orderBy: [{ rosterVersion: "asc" }, { slot: "asc" }, { id: "asc" }],
        select: {
          id: true,
          matchId: true,
          entryId: true,
          userId: true,
          role: true,
          status: true,
          slot: true,
          rosterVersion: true,
          effectiveUntil: true,
        },
      },
    },
  },
  fixtures: {
    orderBy: { id: "asc" },
    select: {
      id: true,
      matchId: true,
      fixtureKey: true,
      stage: true,
      status: true,
      groupId: true,
      groupKey: true,
      roundNumber: true,
      position: true,
      sideAEntryId: true,
      sideBEntryId: true,
      sideARosterVersion: true,
      sideBRosterVersion: true,
      completedAt: true,
      lineupMembers: {
        orderBy: [{ side: "asc" }, { position: "asc" }, { id: "asc" }],
        select: {
          id: true,
          matchId: true,
          fixtureId: true,
          entryId: true,
          entryMemberId: true,
          side: true,
          position: true,
        },
      },
      resultRevisions: {
        orderBy: [{ revisionNumber: "asc" }, { id: "asc" }],
        select: {
          id: true,
          matchId: true,
          fixtureId: true,
          revisionNumber: true,
          status: true,
          resolutionKind: true,
          winnerEntryId: true,
          loserEntryId: true,
          score: true,
          reason: true,
          verifiedById: true,
          supersedesRevisionId: true,
          resolvedAt: true,
          settlementEvents: {
            orderBy: { id: "asc" },
            select: {
              id: true,
              kind: true,
              status: true,
              resultRevisionId: true,
              matchEntryId: true,
              reversesEventId: true,
              failureReason: true,
              appliedAt: true,
              effects: {
                orderBy: { userId: "asc" },
                select: { userId: true },
              },
            },
          },
        },
      },
    },
  },
});

const V2_CERTIFICATE_DEPENDENCY_SELECT =
  Prisma.validator<Prisma.MatchFixtureDependencySelect>()({
    id: true,
    matchId: true,
    sourceFixtureId: true,
    sourceOutcome: true,
    sourceQualificationStandingId: true,
    targetFixtureId: true,
    targetSide: true,
  });

export type V2CertificateMatchSource = Prisma.MatchGetPayload<{
  select: typeof V2_CERTIFICATE_MATCH_SELECT;
}> & Readonly<{
  fixtureDependencies: readonly Prisma.MatchFixtureDependencyGetPayload<{
    select: typeof V2_CERTIFICATE_DEPENDENCY_SELECT;
  }>[];
}>;

export type V2CertificateDatabase = Pick<PrismaClient, "$transaction">;

export type IssueV2CertificateCommand = Readonly<{
  matchId: string;
  actorId: string;
  fullName: string;
  studentId: string;
}>;

export type IssuedV2Certificate = Readonly<{
  matchId: string;
  matchTitle: string;
  userId: string;
  email: string;
  certificateNo: string;
  created: boolean;
}>;

export type V2CertificateApplicationErrorCode =
  | "INVALID_INPUT"
  | "MATCH_NOT_FOUND"
  | "ACTOR_NOT_ACTIVE"
  | "NOT_ELIGIBLE"
  | "UNSUPPORTED_MATCH"
  | "INTEGRITY_ERROR"
  | "IDENTITY_MISMATCH"
  | "CONCURRENT_WRITE_CONFLICT"
  | "PERSISTENCE_CONFLICT";

export class V2CertificateApplicationError extends Error {
  readonly code: V2CertificateApplicationErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: V2CertificateApplicationErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "V2CertificateApplicationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export type V2CertificateApplicationService = Readonly<{
  issue(
    command: IssueV2CertificateCommand,
  ): Promise<IssuedV2Certificate>;
}>;

/** Compatibility aliases for callers introduced by the first SINGLE slice. */
export type IssueV2SingleCertificateCommand = IssueV2CertificateCommand;
export type IssuedV2SingleCertificate = IssuedV2Certificate;

export type V2CertificateApplicationServiceDependencies = Readonly<{
  db: V2CertificateDatabase;
  generateNumber?: () => string;
  hashIdentity?: (value: string) => string;
  verifyIdentity?: (value: string, hash: string) => boolean;
  maximumTransactionAttempts?: number;
  maximumNumberAttempts?: number;
}>;

type IssueAttempt = Readonly<{
  state: "ISSUED";
  value: IssuedV2Certificate;
}>;

class FreshSnapshotRetry extends Error {
  constructor() {
    super("Retry the certificate operation from a fresh database snapshot.");
    this.name = "FreshSnapshotRetry";
  }
}

function fail(
  code: V2CertificateApplicationErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new V2CertificateApplicationError(code, message, details);
}

function assertStableIdentifier(value: unknown, field: string): asserts value is string {
  if (
    typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    !value.includes("\u0000")
  ) {
    return;
  }
  fail("INVALID_INPUT", `${field} must be a non-empty stable identifier.`, {
    field,
  });
}

function normalizeCommand(
  command: IssueV2CertificateCommand,
): IssueV2CertificateCommand {
  if (command === null || typeof command !== "object" || Array.isArray(command)) {
    fail("INVALID_INPUT", "The certificate command must be an object.");
  }
  const keys = Object.keys(command as object);
  const allowed = new Set(["matchId", "actorId", "fullName", "studentId"]);
  if (keys.some((key) => !allowed.has(key)) || keys.length !== allowed.size) {
    fail("INVALID_INPUT", "The certificate command contains unsupported fields.");
  }
  assertStableIdentifier(command.matchId, "matchId");
  assertStableIdentifier(command.actorId, "actorId");
  if (
    typeof command.fullName !== "string" ||
    command.fullName.length < 1 ||
    command.fullName.length > 40 ||
    typeof command.studentId !== "string" ||
    command.studentId.length < 1 ||
    command.studentId.length > 32
  ) {
    fail("INVALID_INPUT", "The normalized identity fields are invalid.");
  }
  return {
    matchId: command.matchId,
    actorId: command.actorId,
    fullName: command.fullName,
    studentId: command.studentId,
  };
}

export function toV2CertificateSnapshot(
  source: V2CertificateMatchSource,
): V2CertificateCompetitionSnapshot {
  return {
    match: {
      id: source.id,
      engineVersion: source.engineVersion,
      isQuickMatch: source.isQuickMatch,
      type: source.type,
      format: source.format,
      groupingGeneratedAt: source.groupingGeneratedAt,
      teamMinMembers: source.teamMinMembers,
      teamMaxMembers: source.teamMaxMembers,
    },
    grouping: source.groupingResult,
    groups: source.matchGroups,
    entries: source.entries,
    fixtures: source.fixtures,
    fixtureDependencies: source.fixtureDependencies,
  };
}

export async function loadV2CertificateMatchSource(
  tx: Prisma.TransactionClient,
  matchId: string,
) {
  const source = await tx.match.findUnique({
    where: { id: matchId },
    select: V2_CERTIFICATE_MATCH_SELECT,
  });
  if (!source) return null;
  const fixtureDependencies = await tx.matchFixtureDependency.findMany({
    where: { matchId },
    orderBy: { id: "asc" },
    select: V2_CERTIFICATE_DEPENDENCY_SELECT,
  });
  return { ...source, fixtureDependencies };
}

function throwEligibilityFailure(result: Exclude<V2CertificateEligibility, { state: "ELIGIBLE" }>): never {
  if (result.state === "UNSUPPORTED") {
    fail("UNSUPPORTED_MATCH", result.reason, { eligibilityCode: result.code });
  }
  if (result.state === "INTEGRITY_ERROR") {
    fail("INTEGRITY_ERROR", result.reason, {
      eligibilityCode: result.code,
      entityId: result.entityId,
    });
  }
  fail("NOT_ELIGIBLE", result.reason, { eligibilityCode: result.code });
}

async function lockAggregateRows(
  tx: Prisma.TransactionClient,
  matchId: string,
  actorId: string,
) {
  const matches = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Match" WHERE "id" = ${matchId} FOR UPDATE
  `);
  if (matches.length === 0) {
    fail("MATCH_NOT_FOUND", "比赛不存在或已删除。", { matchId });
  }

  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "MatchGrouping"
    WHERE "matchId" = ${matchId}
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "match_group"
    WHERE "match_id" = ${matchId}
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "match_group_entry"
    WHERE "match_id" = ${matchId}
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "match_qualification_snapshot"
    WHERE "match_id" = ${matchId}
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "match_qualification_standing"
    WHERE "match_id" = ${matchId}
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "match_entry"
    WHERE "match_id" = ${matchId}
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "match_entry_member"
    WHERE "match_id" = ${matchId}
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "match_fixture"
    WHERE "match_id" = ${matchId}
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "match_fixture_dependency"
    WHERE "match_id" = ${matchId}
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "match_fixture_lineup_member"
    WHERE "match_id" = ${matchId}
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "result_revision"
    WHERE "match_id" = ${matchId}
    ORDER BY "fixture_id", "revision_number", "id" FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT event."id"
    FROM "settlement_event" AS event
    INNER JOIN "result_revision" AS revision
      ON revision."id" = event."result_revision_id"
    WHERE revision."match_id" = ${matchId}
    ORDER BY event."id"
    FOR UPDATE OF event
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT effect."id"
    FROM "settlement_effect" AS effect
    INNER JOIN "settlement_event" AS event
      ON event."id" = effect."event_id"
    INNER JOIN "result_revision" AS revision
      ON revision."id" = event."result_revision_id"
    WHERE revision."match_id" = ${matchId}
    ORDER BY effect."id"
    FOR UPDATE OF effect
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "User"
    WHERE "id" = ${actorId}
    ORDER BY "id"
    FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "UserIdentity"
    WHERE "userId" = ${actorId}
    ORDER BY "id" FOR UPDATE
  `);
  await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "ParticipationCertificate"
    WHERE "matchId" = ${matchId} AND "userId" = ${actorId}
    ORDER BY "id" FOR UPDATE
  `);
}

function persistenceCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "string" ? error.code : null;
}

function postgresCode(error: unknown) {
  if (
    !error ||
    typeof error !== "object" ||
    !("meta" in error) ||
    !error.meta ||
    typeof error.meta !== "object" ||
    !("code" in error.meta)
  ) {
    return null;
  }
  return typeof error.meta.code === "string" ? error.meta.code : null;
}

function isSerializableConflict(error: unknown) {
  const code = persistenceCode(error);
  const databaseCode = postgresCode(error);
  return (
    code === "P2034" ||
    (code === "P2010" && (databaseCode === "40001" || databaseCode === "40P01"))
  );
}

async function issueInTransaction(
  tx: Prisma.TransactionClient,
  command: IssueV2CertificateCommand,
  input: Readonly<{
    nameHash: string;
    studentIdHash: string;
    verifyIdentity: (value: string, hash: string) => boolean;
    generateNumber: () => string;
    maximumNumberAttempts: number;
  }>,
): Promise<IssueAttempt> {
  await lockAggregateRows(tx, command.matchId, command.actorId);

  const actor = await tx.user.findUnique({
    where: { id: command.actorId },
    select: {
      id: true,
      email: true,
      isBanned: true,
      emailVerifiedAt: true,
    },
  });
  if (!actor || actor.isBanned || actor.emailVerifiedAt === null) {
    fail("ACTOR_NOT_ACTIVE", "请使用已验证且状态正常的账号导出证明。", {
      actorId: command.actorId,
    });
  }

  const source = await loadV2CertificateMatchSource(tx, command.matchId);
  if (!source) fail("MATCH_NOT_FOUND", "比赛不存在或已删除。", { matchId: command.matchId });
  const eligibility = evaluateV2CertificateEligibility(
    toV2CertificateSnapshot(source),
    actor.id,
  );
  if (eligibility.state !== "ELIGIBLE") throwEligibilityFailure(eligibility);

  let identity = await tx.userIdentity.findUnique({ where: { userId: actor.id } });
  if (!identity) {
    const inserted = await tx.userIdentity.createMany({
      data: [{
        userId: actor.id,
        nameHash: input.nameHash,
        studentIdHash: input.studentIdHash,
      }],
      skipDuplicates: true,
    });
    identity = await tx.userIdentity.findUnique({ where: { userId: actor.id } });
    if (inserted.count === 0 && !identity) {
      // Throwing is intentional: a fresh-snapshot retry must roll back any
      // earlier write in this attempt instead of committing half an issuance.
      throw new FreshSnapshotRetry();
    }
    if (!identity) {
      fail("PERSISTENCE_CONFLICT", "生成身份绑定记录失败，请稍后重试。");
    }
  }
  if (
    !input.verifyIdentity(command.fullName, identity.nameHash) ||
    !input.verifyIdentity(command.studentId, identity.studentIdHash)
  ) {
    fail("IDENTITY_MISMATCH", "姓名或学号与已绑定信息不一致，请联系乒协干事。");
  }

  const businessKey = {
    matchId_userId: { matchId: source.id, userId: actor.id },
  };
  const existing = await tx.participationCertificate.findUnique({
    where: businessKey,
  });
  if (existing) {
    return {
      state: "ISSUED",
      value: {
        matchId: source.id,
        matchTitle: source.title,
        userId: actor.id,
        email: actor.email,
        certificateNo: existing.certificateNo,
        created: false,
      },
    };
  }

  for (let attempt = 0; attempt < input.maximumNumberAttempts; attempt += 1) {
    const certificateNo = input.generateNumber();
    const inserted = await tx.participationCertificate.createMany({
      data: [{ matchId: source.id, userId: actor.id, certificateNo }],
      skipDuplicates: true,
    });
    const certificate = await tx.participationCertificate.findUnique({
      where: businessKey,
    });
    if (certificate) {
      return {
        state: "ISSUED",
        value: {
          matchId: source.id,
          matchTitle: source.title,
          userId: actor.id,
          email: actor.email,
          certificateNo: certificate.certificateNo,
          created: inserted.count === 1,
        },
      };
    }
    const visibleNumberCollision = await tx.participationCertificate.findUnique({
      where: { certificateNo },
      select: { matchId: true, userId: true },
    });
    if (!visibleNumberCollision) {
      throw new FreshSnapshotRetry();
    }
  }

  fail("PERSISTENCE_CONFLICT", "生成证明编号失败，请稍后重试。", {
    reason: "CERTIFICATE_NUMBER_COLLISION_LIMIT",
  });
}

export function createV2CertificateApplicationService(
  dependencies: V2CertificateApplicationServiceDependencies,
): V2CertificateApplicationService {
  const generateNumber = dependencies.generateNumber ?? (() => generateCertificateNumber());
  const hashIdentity = dependencies.hashIdentity ?? hashIdentityValue;
  const verifyIdentity = dependencies.verifyIdentity ?? verifyIdentityValue;
  const maximumTransactionAttempts = dependencies.maximumTransactionAttempts ?? 3;
  const maximumNumberAttempts = dependencies.maximumNumberAttempts ?? 3;
  if (
    !Number.isSafeInteger(maximumTransactionAttempts) ||
    maximumTransactionAttempts < 1 ||
    !Number.isSafeInteger(maximumNumberAttempts) ||
    maximumNumberAttempts < 1
  ) {
    throw new TypeError("Certificate retry limits must be positive integers.");
  }

  return {
    async issue(rawCommand) {
      const command = normalizeCommand(rawCommand);
      // Expensive salted hashes are prepared before acquiring Match/User locks.
      const nameHash = hashIdentity(command.fullName);
      const studentIdHash = hashIdentity(command.studentId);
      let lastSerializableConflict: unknown = null;

      for (let attempt = 0; attempt < maximumTransactionAttempts; attempt += 1) {
        try {
          const result = await dependencies.db.$transaction(
            (tx) =>
              issueInTransaction(tx, command, {
                nameHash,
                studentIdHash,
                verifyIdentity,
                generateNumber,
                maximumNumberAttempts,
              }),
            {
              isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
              maxWait: 5_000,
              timeout: 15_000,
            },
          );
          return result.value;
        } catch (error) {
          if (error instanceof V2CertificateApplicationError) throw error;
          if (error instanceof FreshSnapshotRetry) {
            lastSerializableConflict = error;
            continue;
          }
          if (isSerializableConflict(error)) {
            lastSerializableConflict = error;
            continue;
          }
          const code = persistenceCode(error);
          if (code === "P2002" || code === "P2003") {
            fail("PERSISTENCE_CONFLICT", "证明记录与现有数据冲突，请稍后重试。", {
              persistenceCode: code,
            });
          }
          throw error;
        }
      }

      fail("CONCURRENT_WRITE_CONFLICT", "比赛数据刚刚发生变化，请刷新后重试。", {
        persistenceCode: persistenceCode(lastSerializableConflict),
        databaseCode: postgresCode(lastSerializableConflict),
      });
    },
  };
}
