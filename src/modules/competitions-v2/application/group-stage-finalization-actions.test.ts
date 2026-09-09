import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import type { PrismaClient } from "@prisma/client";

import {
  createV2GroupStageFinalizationActionHandler,
} from "../adapters/group-stage-finalization-actions";
import type {
  FreezeAndPublishV2KnockoutCommand,
  V2QualificationAndKnockoutPublicationApplicationService,
} from "./qualification-and-knockout-publication";

function csrfForm() {
  const value = new FormData();
  value.set("csrfToken", "csrf-token");
  return value;
}

function result(created: boolean) {
  const at = new Date("2026-09-05T12:00:00.000Z");
  return {
    matchId: "match-1",
    qualification: {
      matchId: "match-1",
      groupingId: "grouping-1",
      snapshotId: "snapshot-1",
      created,
      frozenAt: at,
      sourceRevisionFingerprint: "a".repeat(64),
      qualificationCount: 4,
      standings: [],
    },
    knockout: {
      matchId: "match-1",
      qualificationSnapshotId: "snapshot-1",
      sourceRevisionFingerprint: "a".repeat(64),
      created,
      publishedAt: at,
      qualificationCount: 4,
      roundCount: 2,
      fixtureCount: 3,
    },
  };
}

test("production finalization composes only the atomic freeze-and-publish service", () => {
  const source = readFileSync(
    resolve(
      process.cwd(),
      "src/modules/competitions-v2/adapters/group-stage-finalization-actions.ts",
    ),
    "utf8",
  );
  assert.match(
    source,
    /createV2QualificationAndKnockoutPublicationApplicationService/,
  );
  assert.match(source, /service\.freezeAndPublish\(/);
  assert.doesNotMatch(
    source,
    /createV2QualificationSnapshotApplicationService|createV2KnockoutPublicationApplicationService|\.freeze\(|\.publish\(/,
  );
});

test("finalize group stage derives actor and delegates only to the atomic orchestrator", async () => {
  const commands: FreezeAndPublishV2KnockoutCommand[] = [];
  const revalidated: string[][] = [];
  const service: V2QualificationAndKnockoutPublicationApplicationService = {
    freezeAndPublish: async (command) => {
      commands.push(command);
      return result(true);
    },
  };
  const handler = createV2GroupStageFinalizationActionHandler({
    db: {} as Pick<PrismaClient, "$transaction">,
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "manager-1", role: "user" }),
    finalizationService: service,
    revalidatePaths: async (paths) => {
      revalidated.push([...paths]);
    },
  });

  assert.deepEqual(await handler("match-1", csrfForm()), {
    success: "小组排名已冻结，淘汰签表已生成。",
  });
  assert.deepEqual(commands, [
    { actor: { id: "manager-1", role: "user" }, matchId: "match-1" },
  ]);
  assert.deepEqual(revalidated, [[
    "/",
    "/matchs",
    "/matchs/match-1",
    "/matchs/match-1/grouping",
    "/profile",
  ]]);
});

test("finalize group stage reports an exact replay without accepting identities", async () => {
  let calls = 0;
  const handler = createV2GroupStageFinalizationActionHandler({
    db: {} as Pick<PrismaClient, "$transaction">,
    validateCsrfToken: async () => null,
    getCurrentUser: async () => ({ id: "admin-1", role: "admin" }),
    finalizationService: {
      freezeAndPublish: async () => {
        calls += 1;
        return result(false);
      },
    },
  });
  assert.deepEqual(await handler("match-1", csrfForm()), {
    success: "淘汰签表已生成，无需重复操作。",
  });
  assert.equal(calls, 1);
});

test("finalize group stage rejects every client-owned publication field before auth", async () => {
  const forbiddenFields = [
    "actor",
    "snapshotId",
    "expectedQualificationSnapshotId",
    "sourceRevisionFingerprint",
    "tableAssignments",
    "knockout",
    "fingerprint",
  ];
  let authCalls = 0;
  let serviceCalls = 0;
  const handler = createV2GroupStageFinalizationActionHandler({
    db: {} as Pick<PrismaClient, "$transaction">,
    validateCsrfToken: async () => null,
    getCurrentUser: async () => {
      authCalls += 1;
      return { id: "manager-1", role: "user" };
    },
    finalizationService: {
      freezeAndPublish: async () => {
        serviceCalls += 1;
        return result(true);
      },
    },
  });

  for (const field of forbiddenFields) {
    const formData = csrfForm();
    formData.set(field, "attacker-controlled");
    assert.deepEqual(await handler("match-1", formData), {
      error: "提交的数据无效，请检查后重试。",
    });
  }
  const duplicate = csrfForm();
  duplicate.append("csrfToken", "duplicate");
  assert.deepEqual(await handler("match-1", duplicate), {
    error: "安全校验失败，请刷新页面后重试。",
  });
  assert.equal(authCalls, 0);
  assert.equal(serviceCalls, 0);
});
