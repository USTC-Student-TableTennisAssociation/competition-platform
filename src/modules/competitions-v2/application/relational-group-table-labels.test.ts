import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import {
  V2CompetitionApplicationError,
  type V2CompetitionTransaction,
} from "./entries";
import { createV2RelationalGroupTableLabelsApplicationService } from "./relational-group-table-labels";

const GENERATED_AT = new Date("2026-09-07T02:00:00.000Z");

type MatchType = "single" | "double" | "team";
type Format = "group_only" | "group_then_knockout";

function publication(type: MatchType, format: Format) {
  const prefix = type === "single" ? "SINGLE" : type === "double" ? "DOUBLE" : "TEAM";
  return format === "group_only"
    ? `V2_${prefix}_GROUPING`
    : `V2_${prefix}_GROUP_THEN_KNOCKOUT_GROUPING`;
}

function state(type: MatchType, format: Format) {
  const groupKey = "group:0001";
  const fixture = {
    id: "fixture-1",
    matchId: "match-1",
    fixtureKey: `${groupKey}:pair:0001-0002`,
    stage: "GROUP" as const,
    groupId: "group-1",
    groupKey,
    roundNumber: null,
    position: null,
    sideAEntryId: "entry-a",
    sideBEntryId: "entry-b",
    version: 4,
    metadata: {
      publication: publication(type, format),
      publicationVersion: 1,
      groupIndex: 1,
      groupName: "第 1 组",
      format,
      qualifiersPerGroup: format === "group_then_knockout" ? 1 : null,
      seedMethod: "snake",
      sideAPosition: 1,
      sideBPosition: 2,
    } as Record<string, unknown>,
  };
  return {
    actor: {
      id: "manager-1",
      role: "user" as const,
      isBanned: false,
      emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    match: {
      id: "match-1",
      title: "V2 比赛",
      type,
      status: "ongoing" as const,
      engineVersion: "V2" as const,
      isQuickMatch: false,
      format,
      createdBy: "manager-1",
      groupingGeneratedAt: GENERATED_AT,
      groupingResult: {
        id: "grouping-1",
        matchId: "match-1",
        seedMethod: "SNAKE" as const,
        qualifiersPerGroup: format === "group_then_knockout" ? 1 : null,
        createdAt: GENERATED_AT,
      },
    },
    group: {
      id: "group-1",
      matchId: "match-1",
      groupingId: "grouping-1",
      groupKey,
      displayName: "第 1 组",
      position: 1,
      entries: [
        { id: "membership-a", matchId: "match-1", groupId: "group-1", entryId: "entry-a", position: 1 },
        { id: "membership-b", matchId: "match-1", groupId: "group-1", entryId: "entry-b", position: 2 },
      ],
      fixtures: [fixture],
    },
    fixtureWrites: 0,
    audits: [] as Array<{ action: string; details: unknown }>,
  };
}

function fakeDatabase(current: ReturnType<typeof state>) {
  const tx = {
    $queryRaw: async (query: { strings?: readonly string[] }) => {
      const sql = query.strings?.join("?") ?? "";
      if (sql.includes('FROM "Match"')) return [{ id: current.match.id }];
      if (sql.includes('FROM "User"')) return [{ id: current.actor.id }];
      return current.group.fixtures.map((fixture) => ({ id: fixture.id }));
    },
    user: { findUnique: async () => ({ ...current.actor }) },
    match: { findUnique: async () => ({ ...current.match }) },
    matchGroup: { findFirst: async () => current.group },
    matchFixture: {
      updateMany: async (args: {
        where: { id: string; version: number };
        data: { metadata: Record<string, unknown>; version: { increment: number } };
      }) => {
        const fixture = current.group.fixtures.find(
          (candidate) =>
            candidate.id === args.where.id && candidate.version === args.where.version,
        );
        if (!fixture) return { count: 0 };
        fixture.metadata = args.data.metadata;
        fixture.version += args.data.version.increment;
        current.fixtureWrites += 1;
        return { count: 1 };
      },
    },
    auditLog: {
      create: async (args: { data: { action: string; details: unknown } }) => {
        current.audits.push({ action: args.data.action, details: args.data.details });
        return { id: "audit-1" };
      },
    },
  };
  return {
    $transaction: async <T>(operation: (client: V2CompetitionTransaction) => Promise<T>) =>
      operation(tx as unknown as V2CompetitionTransaction),
  } as unknown as Pick<PrismaClient, "$transaction">;
}

function command(current: ReturnType<typeof state>, version = 4) {
  return {
    actor: { id: "manager-1", role: "user" as const },
    matchId: "match-1",
    groupKey: "group:0001",
    expectedFixtures: [{ fixtureId: "fixture-1", version }],
    labels: ["3 号台", "西区馆"],
  };
}

async function expectCode(operation: () => Promise<unknown>, code: string) {
  await assert.rejects(
    operation,
    (error: unknown) =>
      error instanceof V2CompetitionApplicationError && error.code === code,
  );
}

for (const type of ["single", "double", "team"] as const) {
  for (const format of ["group_only", "group_then_knockout"] as const) {
    test(`${type} + ${format} updates the complete relational group atomically`, async () => {
      const current = state(type, format);
      const service = createV2RelationalGroupTableLabelsApplicationService(
        { db: fakeDatabase(current) },
        { matchType: type },
      );

      const result = await service.update(command(current));

      assert.equal(result.changed, true);
      assert.equal(current.fixtureWrites, 1);
      assert.equal(current.group.fixtures[0].version, 5);
      assert.deepEqual(current.group.fixtures[0].metadata.v2Display, {
        schemaVersion: 1,
        tableLabels: ["3 号台", "西区馆"],
      });
      assert.equal(current.audits[0]?.action, `v2_${type}_group_table_labels_update`);
    });
  }
}

test("an incomplete or stale snapshot is rejected even when labels are unchanged", async () => {
  const current = state("double", "group_only");
  current.group.fixtures[0].metadata.v2Display = {
    schemaVersion: 1,
    tableLabels: ["3 号台", "西区馆"],
  };
  const service = createV2RelationalGroupTableLabelsApplicationService(
    { db: fakeDatabase(current) },
    { matchType: "double" },
  );

  await expectCode(
    () => service.update(command(current, current.group.fixtures[0].version - 1)),
    "FIXTURE_VERSION_CONFLICT",
  );
  assert.equal(current.fixtureWrites, 0);
  assert.equal(current.audits.length, 0);
});

test("a service profile cannot mutate another match type", async () => {
  const current = state("team", "group_only");
  const service = createV2RelationalGroupTableLabelsApplicationService(
    { db: fakeDatabase(current) },
    { matchType: "double" },
  );

  await expectCode(
    () => service.update(command(current)),
    "FIXTURE_CREATION_NOT_ALLOWED",
  );
  assert.equal(current.fixtureWrites, 0);
});
