import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  resolveAdminBulkRegistrationPolicy,
  resolveMatchListRegistrationSummary,
} from "../read-model/match-list-registration";

const listSurfaceSources = [
  "src/app/matchs/page.tsx",
  "src/app/page.tsx",
  "src/app/admin/actions.ts",
].map((file) => ({
  file,
  source: readFileSync(resolve(process.cwd(), file), "utf8"),
}));

const BASE = {
  isQuickMatch: false,
  format: "group_only" as const,
  legacyParticipantCount: 7,
  legacyCurrentUserRegistered: true,
  activeEntryCount: 3,
  currentUserActiveEntryKinds: [] as const,
};

for (const type of ["single", "double", "team"] as const) {
  test(`Legacy ${type} list facts remain unchanged`, () => {
    assert.deepEqual(
      resolveMatchListRegistrationSummary({
        ...BASE,
        engineVersion: "LEGACY",
        type,
      }),
      {
        participants: 7,
        participantUnit: type === "team" ? "teams" : "people",
        isCurrentUserRegistered: true,
      },
    );
  });
}

test("all six formal V2 slices count ACTIVE competitor Entries", () => {
  for (const [type, kind, participantUnit] of [
    ["single", "INDIVIDUAL", "people"],
    ["double", "DOUBLES", "pairs"],
    ["team", "TEAM", "teams"],
  ] as const) {
    for (const format of ["group_only", "group_then_knockout"] as const) {
      assert.deepEqual(
        resolveMatchListRegistrationSummary({
          ...BASE,
          engineVersion: "V2",
          type,
          format,
          currentUserActiveEntryKinds: [kind],
        }),
        { participants: 3, participantUnit, isCurrentUserRegistered: true },
      );
    }
  }
});

test("V2 registration identity fails closed on quick or mismatched Entry kinds", () => {
  for (const input of [
    {
      type: "single" as const,
      format: "group_only" as const,
      isQuickMatch: true,
      currentUserActiveEntryKinds: ["INDIVIDUAL" as const],
      participantUnit: "people" as const,
    },
    {
      type: "double" as const,
      format: "group_only" as const,
      isQuickMatch: false,
      currentUserActiveEntryKinds: ["INDIVIDUAL" as const],
      participantUnit: "pairs" as const,
    },
    {
      type: "team" as const,
      format: "group_then_knockout" as const,
      isQuickMatch: false,
      currentUserActiveEntryKinds: ["TEAM" as const, "TEAM" as const],
      participantUnit: "teams" as const,
    },
  ]) {
    const actual = resolveMatchListRegistrationSummary({
      ...BASE,
      engineVersion: "V2",
      type: input.type,
      format: input.format,
      isQuickMatch: input.isQuickMatch,
      currentUserActiveEntryKinds: input.currentUserActiveEntryKinds,
    });
    assert.deepEqual(
      actual,
      {
        participants: input.isQuickMatch ? 0 : 3,
        participantUnit: input.participantUnit,
        isCurrentUserRegistered: false,
      },
    );
  }
});

test("admin bulk registration is exposed for formal singles in either engine", () => {
  for (const engineVersion of ["LEGACY", "V2"] as const) {
    for (const format of ["group_only", "group_then_knockout"] as const) {
      assert.deepEqual(
        resolveAdminBulkRegistrationPolicy({
          engineVersion,
          isQuickMatch: false,
          type: "single",
          format,
          status: "registration",
          groupingGeneratedAt: null,
        }),
        engineVersion === "LEGACY" ? { canBulkRegister: false, disabledReason: "历史比赛已归档，不能追加报名" } : { canBulkRegister: true, disabledReason: null },
      );
    }
  }

  const unsupported = [
    {
      identity: {
        engineVersion: "V2",
        isQuickMatch: false,
        type: "single",
        format: "group_then_knockout",
        status: "ongoing",
        groupingGeneratedAt: "2026-09-07T00:00:00.000Z",
      },
      reason: "V2 比赛分组发布后不能追加报名",
    },
    {
      identity: {
        engineVersion: "LEGACY",
        isQuickMatch: true,
        type: "single",
        format: "group_only",
      },
      reason: "快速比赛不支持后台批量报名",
    },
    {
      identity: {
        engineVersion: "LEGACY",
        isQuickMatch: false,
        type: "double",
        format: "group_only",
      },
      reason: "双打比赛需先确定搭档并完成组队",
    },
    {
      identity: {
        engineVersion: "LEGACY",
        isQuickMatch: false,
        type: "team",
        format: "group_only",
      },
      reason: "团体赛请使用队伍报名",
    },
  ] as const;

  for (const { identity, reason } of unsupported) {
    assert.deepEqual(resolveAdminBulkRegistrationPolicy(identity), {
      canBulkRegister: false,
      disabledReason: identity.engineVersion === "LEGACY" && !identity.isQuickMatch ? "历史比赛已归档，不能追加报名" : reason,
    });
  }
});

test("admin selector carries engine identity and shows unsupported matches disabled", () => {
  const actions = listSurfaceSources.find(
    ({ file }) => file === "src/app/admin/actions.ts",
  )?.source;
  const client = readFileSync(
    resolve(process.cwd(), "src/app/admin/AdminDashboardClient.tsx"),
    "utf8",
  );
  assert.ok(actions);

  const dto = actions.match(
    /export type AdminDashboardMatch = \{([\s\S]*?)\n\}/,
  )?.[1];
  assert.ok(dto);
  for (const field of [
    "engineVersion",
    "isQuickMatch",
    "type",
    "format",
    "participantUnit",
    "canBulkRegister",
    "bulkRegisterDisabledReason",
  ]) {
    assert.match(dto, new RegExp(`\\b${field}:`));
  }

  assert.match(
    actions,
    /resolveAdminBulkRegistrationPolicy\(\{\s*\.\.\.identity,\s*status:\s*match\.status,\s*groupingGeneratedAt:\s*match\.groupingGeneratedAt,/,
  );
  assert.match(
    actions,
    /lockedMatch\.engineVersion === ['"]V2['"][\s\S]*?createV2EntryInTransaction\(tx,\s*\{[\s\S]*?kind:\s*['"]INDIVIDUAL['"][\s\S]*?status:\s*['"]ACTIVE['"][\s\S]*?adminOverride:\s*true/,
  );
  assert.match(actions, /overrideReason:\s*['"]管理员控制台批量代报名['"]/);
  assert.match(
    actions,
    /lockedMatch\.engineVersion === ['"]V2['"][\s\S]*?emailVerifiedAt:\s*\{ not:\s*null \}/,
  );
  assert.doesNotMatch(
    client,
    /state\.matches\s*\.filter\(\(match\) => match\.canBulkRegister\)/,
  );
  assert.match(client, /disabled=\{!match\.canBulkRegister\}/);
  assert.match(client, /match\.bulkRegisterDisabledReason/);
});

test("admin activity uses reporter revisions from all formal V2 competition stages", () => {
  const actions = listSurfaceSources.find(
    ({ file }) => file === "src/app/admin/actions.ts",
  )?.source;
  assert.ok(actions);

  assert.match(
    actions,
    /resultRevisionsReported:\s*\{\s*where:\s*\{\s*fixture:\s*\{\s*stage:\s*\{ in:\s*\[["']GROUP["'],\s*["']KNOCKOUT["']\] \},\s*match:\s*\{\s*engineVersion:\s*["']V2["'],\s*isQuickMatch:\s*false,/,
  );
  assert.match(
    actions,
    /resultRevisionsReported:\s*\{[\s\S]*?orderBy:\s*\{ createdAt:\s*["']desc["'] \}/,
  );
  assert.match(actions, /user\.resultRevisionsReported\[0\]\?\.createdAt/);
});

test("all shared match lists count ACTIVE V2 competitor Entries", () => {
  for (const { file, source } of listSurfaceSources) {
    assert.match(
      source,
      /resolveMatchListRegistrationSummary\(\{/,
      `${file} must use the shared engine-aware projection`,
    );
    assert.match(
      source,
      /entries:\s*\{\s*where:\s*\{ status:\s*["']ACTIVE["'] \},\s*\}/,
      `${file} must count active competitor entries`,
    );
  }
});

test("the home registration marker selects only a current Entry membership", () => {
  const home = listSurfaceSources.find(
    ({ file }) => file === "src/app/page.tsx",
  )?.source;
  assert.ok(home);

  assert.match(
    home,
    /entries:\s*\{\s*where:\s*\{\s*status:\s*"ACTIVE",\s*members:\s*\{\s*some:\s*\{\s*userId:\s*openRegistrationUserId,\s*status:\s*"ACTIVE",\s*effectiveUntil:\s*null,/,
  );
  assert.doesNotMatch(home, /entries:[\s\S]{0,220}metadata:\s*true/);
});
