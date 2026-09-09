import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import {
  createV2CertificateApplicationService,
  V2CertificateApplicationError,
  type V2CertificateMatchSource,
} from "./certificates";

const NOW = new Date("2026-09-05T08:00:00.000Z");

function eligibleSource(): V2CertificateMatchSource {
  const entryA = {
    id: "entry-a",
    kind: "INDIVIDUAL" as const,
    status: "ACTIVE" as const,
    version: 0,
    members: [{
      id: "member-a",
      matchId: "match-1",
      entryId: "entry-a",
      userId: "user-a",
      role: "player" as const,
      status: "ACTIVE" as const,
      slot: 1,
      rosterVersion: 1,
      effectiveUntil: null,
    }],
  };
  const entryB = {
    id: "entry-b",
    kind: "INDIVIDUAL" as const,
    status: "ACTIVE" as const,
    version: 0,
    members: [{
      id: "member-b",
      matchId: "match-1",
      entryId: "entry-b",
      userId: "user-b",
      role: "player" as const,
      status: "ACTIVE" as const,
      slot: 1,
      rosterVersion: 1,
      effectiveUntil: null,
    }],
  };
  return {
    id: "match-1",
    title: "V2 单打赛",
    engineVersion: "V2",
    isQuickMatch: false,
    type: "single",
    format: "group_only",
    groupingGeneratedAt: NOW,
    teamMinMembers: null,
    teamMaxMembers: null,
    groupingResult: {
      id: "grouping-1",
      matchId: "match-1",
      v2SchemaVersion: 1,
      seedMethod: "MIN_DIFF",
      standingsPolicyVersion: 1,
      qualifiersPerGroup: null,
      bracketPolicyVersion: null,
      createdAt: NOW,
      qualificationSnapshot: null,
    },
    matchGroups: [{
      id: "group-1",
      matchId: "match-1",
      groupingId: "grouping-1",
      groupKey: "group:0001",
      position: 1,
      entries: [entryA, entryB].map((entry, index) => ({
        id: `membership-${entry.id}`,
        matchId: "match-1",
        groupId: "group-1",
        entryId: entry.id,
        position: index + 1,
        globalSeedRank: index + 1,
        entryVersion: 0,
        rosterVersion: 1,
      })),
    }],
    entries: [entryA, entryB],
    fixtures: [{
      id: "fixture-1",
      matchId: "match-1",
      fixtureKey: "group:0001:pair:0001-0002",
      stage: "GROUP",
      status: "COMPLETED",
      groupId: "group-1",
      groupKey: "group:0001",
      roundNumber: null,
      position: null,
      sideAEntryId: entryA.id,
      sideBEntryId: entryB.id,
      sideARosterVersion: 1,
      sideBRosterVersion: 1,
      completedAt: NOW,
      lineupMembers: [
        {
          id: "lineup-a",
          matchId: "match-1",
          fixtureId: "fixture-1",
          entryId: entryA.id,
          entryMemberId: "member-a",
          side: "SIDE_A",
          position: 1,
        },
        {
          id: "lineup-b",
          matchId: "match-1",
          fixtureId: "fixture-1",
          entryId: entryB.id,
          entryMemberId: "member-b",
          side: "SIDE_B",
          position: 1,
        },
      ],
      resultRevisions: [{
        id: "revision-1",
        matchId: "match-1",
        fixtureId: "fixture-1",
        revisionNumber: 1,
        status: "CONFIRMED",
        resolutionKind: "PLAYED",
        winnerEntryId: entryA.id,
        loserEntryId: entryB.id,
        score: { bestOf: 3, winnerScore: 2, loserScore: 0 },
        reason: null,
        verifiedById: "user-b",
        supersedesRevisionId: null,
        resolvedAt: NOW,
        settlementEvents: [{
          id: "settlement-1",
          kind: "RESULT_APPLY",
          status: "APPLIED",
          resultRevisionId: "revision-1",
          matchEntryId: null,
          reversesEventId: null,
          failureReason: null,
          appliedAt: NOW,
          effects: [{ userId: "user-a" }, { userId: "user-b" }],
        }],
      }],
    }],
    fixtureDependencies: [],
  };
}

function makeHarness(options: Readonly<{
  source?: V2CertificateMatchSource;
  identity?: { nameHash: string; studentIdHash: string } | null;
  serializableConflicts?: number;
  invisibleIdentityOnce?: boolean;
  numberCollisions?: readonly string[];
}> = {}) {
  const calls: string[] = [];
  let source = options.source ?? eligibleSource();
  let identity = options.identity ?? null;
  let certificate: { certificateNo: string; matchId: string; userId: string } | null = null;
  let transactionCount = 0;
  let identityCreateCount = 0;
  let certificateCreateCount = 0;
  let invisibleIdentity = options.invisibleIdentityOnce ?? false;
  const numberCollisions = new Set(options.numberCollisions ?? []);

  const tx = {
    $queryRaw: async (query: { strings?: readonly string[] }) => {
      const sql = query.strings?.join("?") ?? "";
      const table = sql.includes('SELECT effect."id"')
        ? '"settlement_effect"'
        : sql.includes('SELECT event."id"')
        ? '"settlement_event"'
        : sql.includes('FROM "User"')
          ? '"User"'
          : [
              '"Match"',
              '"MatchGrouping"',
              '"match_group_entry"',
              '"match_group"',
              '"match_qualification_snapshot"',
              '"match_qualification_standing"',
              '"match_entry"',
              '"match_entry_member"',
              '"match_fixture"',
              '"match_fixture_dependency"',
              '"match_fixture_lineup_member"',
              '"result_revision"',
              '"UserIdentity"',
              '"ParticipationCertificate"',
            ].find((name) => sql.includes(name));
      calls.push(`lock:${table ?? "unknown"}`);
      return table === '"Match"' ? [{ id: source.id }] : [];
    },
    user: {
      findUnique: async () => ({
        id: "user-a",
        email: "user-a@example.test",
        isBanned: false,
        emailVerifiedAt: NOW,
      }),
    },
    match: { findUnique: async () => source },
    matchFixtureDependency: {
      findMany: async () => source.fixtureDependencies,
    },
    userIdentity: {
      findUnique: async () =>
        identity
          ? { id: "identity-1", userId: "user-a", createdAt: NOW, ...identity }
          : null,
      createMany: async (args: {
        data: Array<{ nameHash: string; studentIdHash: string }>;
        skipDuplicates: boolean;
      }) => {
        calls.push("identity:createMany");
        assert.equal(args.skipDuplicates, true);
        if (invisibleIdentity) {
          invisibleIdentity = false;
          return { count: 0 };
        }
        identityCreateCount += 1;
        identity = {
          nameHash: args.data[0].nameHash,
          studentIdHash: args.data[0].studentIdHash,
        };
        return { count: 1 };
      },
    },
    participationCertificate: {
      findUnique: async (args: {
        where: {
          matchId_userId?: { matchId: string; userId: string };
          certificateNo?: string;
        };
      }) => {
        if (args.where.certificateNo) {
          return numberCollisions.has(args.where.certificateNo)
            ? { matchId: "other-match", userId: "other-user" }
            : null;
        }
        return certificate
          ? { id: "certificate-1", createdAt: NOW, ...certificate }
          : null;
      },
      createMany: async (args: {
        data: Array<{ matchId: string; userId: string; certificateNo: string }>;
        skipDuplicates: boolean;
      }) => {
        calls.push("certificate:createMany");
        assert.equal(args.skipDuplicates, true);
        const data = args.data[0];
        if (numberCollisions.has(data.certificateNo)) return { count: 0 };
        certificateCreateCount += 1;
        certificate = data;
        return { count: 1 };
      },
    },
  };

  let conflicts = options.serializableConflicts ?? 0;
  const db = {
    $transaction: async <T>(
      operation: (transaction: typeof tx) => Promise<T>,
      transactionOptions: { isolationLevel: string },
    ) => {
      transactionCount += 1;
      calls.push(`transaction:${transactionOptions.isolationLevel}`);
      if (conflicts > 0) {
        conflicts -= 1;
        throw { code: "P2034" };
      }
      return operation(tx);
    },
  } as unknown as Pick<PrismaClient, "$transaction">;

  return {
    db,
    calls,
    setSource(value: V2CertificateMatchSource) {
      source = value;
    },
    get identityCreateCount() {
      return identityCreateCount;
    },
    get certificateCreateCount() {
      return certificateCreateCount;
    },
    get transactionCount() {
      return transactionCount;
    },
  };
}

function service(harness: ReturnType<typeof makeHarness>, numbers = ["PPC-ONE"]) {
  const queue = [...numbers];
  return createV2CertificateApplicationService({
    db: harness.db,
    generateNumber: () => queue.shift() ?? "PPC-FALLBACK",
    hashIdentity: (value) => `hash:${value}`,
    verifyIdentity: (value, hash) => hash === `hash:${value}`,
  });
}

const COMMAND = {
  matchId: "match-1",
  actorId: "user-a",
  fullName: "张三",
  studentId: "PB00000001",
};

test("issuance locks the V2 aggregate, creates identity/certificate without P2002, and reuses the number", async () => {
  const harness = makeHarness();
  const issuer = service(harness, ["PPC-FIRST", "PPC-UNUSED"]);

  const first = await issuer.issue(COMMAND);
  const retry = await issuer.issue(COMMAND);
  assert.equal(first.certificateNo, "PPC-FIRST");
  assert.equal(first.created, true);
  assert.equal(retry.certificateNo, "PPC-FIRST");
  assert.equal(retry.created, false);
  assert.equal(harness.identityCreateCount, 1);
  assert.equal(harness.certificateCreateCount, 1);
  assert.equal(harness.calls[0], "transaction:Serializable");
  assert.deepEqual(harness.calls.slice(1, 18), [
    'lock:"Match"',
    'lock:"MatchGrouping"',
    'lock:"match_group"',
    'lock:"match_group_entry"',
    'lock:"match_qualification_snapshot"',
    'lock:"match_qualification_standing"',
    'lock:"match_entry"',
    'lock:"match_entry_member"',
    'lock:"match_fixture"',
    'lock:"match_fixture_dependency"',
    'lock:"match_fixture_lineup_member"',
    'lock:"result_revision"',
    'lock:"settlement_event"',
    'lock:"settlement_effect"',
    'lock:"User"',
    'lock:"UserIdentity"',
    'lock:"ParticipationCertificate"',
  ]);
});

test("an invisible ON CONFLICT identity row is resolved only from a fresh transaction", async () => {
  const harness = makeHarness({ invisibleIdentityOnce: true });
  const result = await service(harness).issue(COMMAND);

  assert.equal(result.certificateNo, "PPC-ONE");
  assert.equal(harness.transactionCount, 2);
  assert.equal(harness.identityCreateCount, 1);
});

test("a serializable conflict retries the whole transaction and then succeeds", async () => {
  const harness = makeHarness({ serializableConflicts: 1 });
  const result = await service(harness).issue(COMMAND);

  assert.equal(result.certificateNo, "PPC-ONE");
  assert.equal(harness.transactionCount, 2);
});

test("visible certificate-number collisions have a finite retry and never overwrite another row", async () => {
  const harness = makeHarness({ numberCollisions: ["PPC-COLLISION"] });
  const result = await service(harness, ["PPC-COLLISION", "PPC-AVAILABLE"]).issue(COMMAND);

  assert.equal(result.certificateNo, "PPC-AVAILABLE");
  assert.equal(harness.certificateCreateCount, 1);
});

test("identity mismatch and stale eligibility commit no certificate", async () => {
  const mismatchHarness = makeHarness({
    identity: { nameHash: "hash:李四", studentIdHash: "hash:PB99999999" },
  });
  await assert.rejects(
    service(mismatchHarness).issue(COMMAND),
    (error: unknown) =>
      error instanceof V2CertificateApplicationError &&
      error.code === "IDENTITY_MISMATCH",
  );
  assert.equal(mismatchHarness.certificateCreateCount, 0);

  const pendingSource = eligibleSource();
  const ineligibleHarness = makeHarness({
    source: {
      ...pendingSource,
      fixtures: [{
        ...pendingSource.fixtures[0],
        status: "VOIDED",
        completedAt: null,
        resultRevisions: [],
      }],
    },
  });
  await assert.rejects(
    service(ineligibleHarness).issue(COMMAND),
    (error: unknown) =>
      error instanceof V2CertificateApplicationError &&
      error.code === "NOT_ELIGIBLE",
  );
  assert.equal(ineligibleHarness.identityCreateCount, 0);
  assert.equal(ineligibleHarness.certificateCreateCount, 0);
});

test("exhausted Serializable retries return one stable retryable error", async () => {
  const harness = makeHarness({ serializableConflicts: 3 });
  await assert.rejects(
    service(harness).issue(COMMAND),
    (error: unknown) =>
      error instanceof V2CertificateApplicationError &&
      error.code === "CONCURRENT_WRITE_CONFLICT",
  );
  assert.equal(harness.transactionCount, 3);
});
