import assert from "node:assert/strict";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import {
  createV2TeamGroupingActionHandlers,
} from "../adapters/team-grouping-actions";
import type {
  PublishV2TeamGroupingCommand,
  V2TeamGroupingApplicationService,
} from "./team-grouping";

const manager = {
  id: "manager-1",
  role: "user" as const,
  isBanned: false,
  emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
};

function activeTeamEntry(teamIndex: number, version: number, elo: number) {
  const sourceId = `source-${teamIndex}`;
  const members = Array.from({ length: 3 }, (_, memberIndex) => {
    const userId = `team-${teamIndex}-user-${memberIndex + 1}`;
    return {
      id: `member-${teamIndex}-${memberIndex + 1}`,
      userId,
      role: memberIndex === 0 ? ("captain" as const) : ("player" as const),
      slot: memberIndex + 1,
      rosterVersion: 1,
      user: {
        id: userId,
        nickname: `Player ${teamIndex}-${memberIndex + 1}`,
        points: 10 + teamIndex,
        eloRating: elo + memberIndex,
        isBanned: false,
        emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    };
  });
  return {
    id: `entry-${teamIndex}`,
    version,
    kind: "TEAM",
    sourceKey: `team:${sourceId}`,
    sourceUserId: null,
    sourceDoublesTeamId: null,
    sourceMatchTeamId: sourceId,
    displayNameSnapshot: `Team ${teamIndex}`,
    sourceUser: null,
    sourceDoublesTeam: null,
    sourceMatchTeam: {
      id: sourceId,
      matchId: "match-1",
      status: "approved",
      captainId: members[0].userId,
      members: members.map((member) => ({
        userId: member.userId,
        matchId: "match-1",
      })),
    },
    members,
  };
}

function groupingMatch(
  format: "group_only" | "group_then_knockout" = "group_only",
) {
  return {
    id: "match-1",
    createdBy: manager.id,
    engineVersion: "V2",
    isQuickMatch: false,
    type: "team",
    status: "registration",
    format,
    registrationDeadline: new Date("2026-09-01T00:00:00.000Z"),
    teamRegistrationDeadline: new Date("2026-09-02T00:00:00.000Z"),
    teamMinMembers: 3,
    teamMaxMembers: 6,
    entries: [activeTeamEntry(1, 2, 1_500), activeTeamEntry(2, 4, 1_300)],
  };
}

function previewForm() {
  const value = new FormData();
  value.set("csrfToken", "token");
  value.set("groupCount", "1");
  value.set("seedMethod", "snake");
  return value;
}

test("TEAM action adapter previews authoritative Entries and publishes only identity", async () => {
  const commands: PublishV2TeamGroupingCommand[] = [];
  const service: V2TeamGroupingApplicationService = {
    publish: async (command) => {
      commands.push(command);
      return {
        matchId: command.matchId,
        created: true,
        publishedAt: new Date("2026-09-05T09:00:00.000Z"),
        groupCount: command.draft.groups.length,
        fixtureCount: 1,
      };
    },
  };
  const revalidated: string[][] = [];
  const handlers = createV2TeamGroupingActionHandlers({
    db: {
      match: { findUnique: async () => groupingMatch() },
      user: { findUnique: async () => manager },
    } as unknown as PrismaClient,
    groupingService: service,
    clock: () => new Date("2026-09-05T09:00:00.000Z"),
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: manager.id, role: manager.role }),
    revalidatePaths: async (paths) => {
      revalidated.push([...paths]);
    },
  });

  const previewState = await handlers.previewGrouping("match-1", previewForm());
  assert.equal(previewState.error, undefined);
  if (!previewState.previewJson) assert.fail("TEAM preview JSON was not returned");
  const preview = JSON.parse(previewState.previewJson) as {
    competitorType: string;
    groups: Array<{
      name: string;
      players: Array<{ id: string; nickname: string }>;
    }>;
    v2Preview: { expectedEntries: Array<{ entryId: string; version: number }> };
  };
  assert.equal(preview.competitorType, "team");
  assert.deepEqual(preview.v2Preview.expectedEntries, [
    { entryId: "entry-1", version: 2 },
    { entryId: "entry-2", version: 4 },
  ]);
  preview.groups[0].name = "客户端伪造组名";
  for (const player of preview.groups[0].players) {
    player.nickname = "客户端伪造队名";
  }

  const publish = new FormData();
  publish.set("csrfToken", "token");
  publish.set("previewJson", JSON.stringify(preview));
  assert.deepEqual(await handlers.publishGrouping("match-1", publish), {
    success: "团体分组结果已确认并发布。",
  });
  assert.deepEqual(commands, [
    {
      actor: { id: manager.id, role: "user" },
      matchId: "match-1",
      expectedEntries: [
        { entryId: "entry-1", version: 2 },
        { entryId: "entry-2", version: 4 },
      ],
      draft: {
        format: "group_only",
        groups: [{ entryIds: ["entry-1", "entry-2"] }],
        seedMethod: "snake",
      },
    },
  ]);
  assert.equal(JSON.stringify(commands[0]).includes("客户端伪造"), false);
  assert.deepEqual(revalidated, [[
    "/",
    "/matchs",
    "/matchs/match-1",
    "/matchs/match-1/grouping",
  ]]);
});

test("TEAM action adapter supports the group-then-knockout group phase", async () => {
  const commands: PublishV2TeamGroupingCommand[] = [];
  const handlers = createV2TeamGroupingActionHandlers({
    db: {
      match: {
        findUnique: async () => groupingMatch("group_then_knockout"),
      },
      user: { findUnique: async () => manager },
    } as unknown as PrismaClient,
    groupingService: {
      publish: async (command) => {
        commands.push(command);
        return {
          matchId: command.matchId,
          created: true,
          publishedAt: new Date("2026-09-05T09:00:00.000Z"),
          groupCount: 1,
          fixtureCount: 1,
        };
      },
    },
    clock: () => new Date("2026-09-05T09:00:00.000Z"),
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: manager.id, role: manager.role }),
  });
  const preview = previewForm();
  preview.set("qualifiersPerGroup", "2");
  const previewState = await handlers.previewGrouping("match-1", preview);
  if (!previewState.previewJson) {
    assert.fail(`TEAM knockout preview failed: ${previewState.error}`);
  }
  const parsed = JSON.parse(previewState.previewJson) as {
    format: string;
    config: { qualifiersPerGroup?: number };
  };
  assert.equal(parsed.format, "group_then_knockout");
  assert.equal(parsed.config.qualifiersPerGroup, 2);
  const publish = new FormData();
  publish.set("csrfToken", "token");
  publish.set("previewJson", previewState.previewJson);
  assert.equal(
    (await handlers.publishGrouping("match-1", publish)).error,
    undefined,
  );
  assert.equal(commands[0].draft.format, "group_then_knockout");
  assert.equal(commands[0].draft.qualifiersPerGroup, 2);
});

test("TEAM action adapter fails closed before preview for wrong match type or form", async () => {
  let userReads = 0;
  const handlers = createV2TeamGroupingActionHandlers({
    db: {
      match: {
        findUnique: async () => ({ ...groupingMatch(), type: "double" }),
      },
      user: {
        findUnique: async () => {
          userReads += 1;
          return manager;
        },
      },
    } as unknown as PrismaClient,
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: manager.id, role: manager.role }),
    logError: async () => undefined,
  });
  const wrongType = await handlers.previewGrouping("match-1", previewForm());
  assert.equal(typeof wrongType.error, "string");
  assert.equal(wrongType.previewJson, undefined);
  assert.equal(userReads, 1);

  const protectedForm = previewForm();
  protectedForm.set("expectedEntries", "forged");
  const protectedResult = await handlers.previewGrouping(
    "match-1",
    protectedForm,
  );
  assert.equal(typeof protectedResult.error, "string");
});
