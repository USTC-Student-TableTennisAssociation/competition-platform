import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  getV2CompetitionsCreationMode,
  getV2MatchCreationCapabilities,
  getV2MatchCreationPolicy,
  isV2CompetitionsPublicEnabled,
  isV2DoubleGroupThenKnockoutCreationEnabled,
  isV2DoubleGroupOnlyCreationEnabled,
  isV2SingleGroupThenKnockoutCreationEnabled,
  isV2SingleGroupOnlyCreationEnabled,
  isV2TeamGroupThenKnockoutCreationEnabled,
  isV2TeamGroupOnlyCreationEnabled,
} from "../../../lib/server/match/v2-creation-flag";

const actionSource = readFileSync(
  resolve(process.cwd(), "src/app/matchs/actions.ts"),
  "utf8",
);
const pageSource = readFileSync(
  resolve(process.cwd(), "src/app/matchs/create/page.tsx"),
  "utf8",
);
const formSource = readFileSync(
  resolve(process.cwd(), "src/components/match/CreateMatchForm.tsx"),
  "utf8",
);
const envExampleSource = readFileSync(
  resolve(process.cwd(), ".env.example"),
  "utf8",
);

test("the server-only creation mode accepts only exact LEGACY, PAUSED, or V2", () => {
  const previous = process.env.V2_COMPETITIONS_CREATION_MODE;
  try {
    delete process.env.V2_COMPETITIONS_CREATION_MODE;
    assert.equal(getV2CompetitionsCreationMode(), "V2");
    assert.equal(isV2CompetitionsPublicEnabled(), true);
    for (const invalid of ["", "legacy", "v2", "paused", "TRUE", " V2"]) {
      process.env.V2_COMPETITIONS_CREATION_MODE = invalid;
      assert.equal(getV2CompetitionsCreationMode(), "V2", invalid);
    }
    process.env.V2_COMPETITIONS_CREATION_MODE = "PAUSED";
    assert.equal(getV2CompetitionsCreationMode(), "PAUSED");
    assert.equal(isV2CompetitionsPublicEnabled(), false);
    process.env.V2_COMPETITIONS_CREATION_MODE = "V2";
    assert.equal(getV2CompetitionsCreationMode(), "V2");
    assert.equal(isV2CompetitionsPublicEnabled(), true);
    for (const enabled of [
      isV2SingleGroupOnlyCreationEnabled,
      isV2DoubleGroupOnlyCreationEnabled,
      isV2TeamGroupOnlyCreationEnabled,
      isV2SingleGroupThenKnockoutCreationEnabled,
      isV2DoubleGroupThenKnockoutCreationEnabled,
      isV2TeamGroupThenKnockoutCreationEnabled,
    ]) {
      assert.equal(enabled(), true);
    }
  } finally {
    if (previous === undefined) delete process.env.V2_COMPETITIONS_CREATION_MODE;
    else process.env.V2_COMPETITIONS_CREATION_MODE = previous;
  }

  assert.match(
    envExampleSource,
    /V2_COMPETITIONS_CREATION_MODE=["']V2["']/,
  );
  assert.doesNotMatch(envExampleSource, /V2_.*_CREATION_ENABLED/);
  assert.doesNotMatch(actionSource, /NEXT_PUBLIC_V2/);
  assert.doesNotMatch(pageSource, /NEXT_PUBLIC_V2/);
  assert.doesNotMatch(formSource, /process\.env|CreationEnabled/);
});

test("V2 enables all six cells together while LEGACY and PAUSED enable none", () => {
  const previous = process.env.V2_COMPETITIONS_CREATION_MODE;
  try {
    for (const mode of ["LEGACY", "PAUSED", "V2"] as const) {
      process.env.V2_COMPETITIONS_CREATION_MODE = mode;
      const policy = getV2MatchCreationPolicy();
      assert.equal(policy.mode, mode === "PAUSED" ? "PAUSED" : "V2");
      assert.equal(policy.disabledRoute, "paused");
      const expected = mode !== "PAUSED";
      assert.deepEqual(getV2MatchCreationCapabilities(), {
        single: { group_only: expected, group_then_knockout: expected },
        double: { group_only: expected, group_then_knockout: expected },
        team: { group_only: expected, group_then_knockout: expected },
      });
    }
  } finally {
    if (previous === undefined) delete process.env.V2_COMPETITIONS_CREATION_MODE;
    else process.env.V2_COMPETITIONS_CREATION_MODE = previous;
  }
});

test("the server page owns six request keys and the client selects only the exact slice", () => {
  assert.match(pageSource, /import \{ randomUUID \} from ["']node:crypto["']/);
  assert.match(pageSource, /getV2MatchCreationCapabilities\(\)/);
  const compactPageSource = pageSource.replaceAll(/\s/g, "");
  for (const selector of [
    "capabilities.single.group_only",
    "capabilities.single.group_then_knockout",
    "capabilities.double.group_only",
    "capabilities.double.group_then_knockout",
    "capabilities.team.group_only",
    "capabilities.team.group_then_knockout",
  ]) {
    assert.ok(compactPageSource.includes(selector));
  }
  assert.match(
    pageSource,
    /v2SingleGroupOnlyCreationRequestKey=\{[\s\S]*?v2SingleGroupOnlyCreationRequestKey[\s\S]*?\}/,
  );

  assert.match(
    formSource,
    /useState\([\s\S]*?v2SingleGroupOnlyCreationRequestKey[\s\S]*?useState\([\s\S]*?v2DoubleGroupOnlyCreationRequestKey/,
  );
  assert.match(formSource, /matchType === ["']single["'][\s\S]*?stableV2SingleCreationRequestKey/);
  assert.match(formSource, /matchType === ["']double["'][\s\S]*?stableV2DoubleCreationRequestKey/);
  assert.match(formSource, /stableV2TeamCreationRequestKey/);
  assert.match(formSource, /matchFormat === ["']group_only["']/);
  assert.match(formSource, /stableV2SingleGroupThenKnockoutCreationRequestKey/);
  assert.match(formSource, /stableV2DoubleGroupThenKnockoutCreationRequestKey/);
  assert.match(formSource, /stableV2TeamGroupThenKnockoutCreationRequestKey/);
  assert.match(formSource, /name=["']creationRequestKey["']/);
  assert.match(formSource, /value=\{v2CreationRequestKey\}/);
});

test("the unified action performs one central dispatch before Legacy", () => {
  const start = actionSource.indexOf("export async function createMatchAction");
  const end = actionSource.indexOf(
    "export async function createMatchTeamAction",
    start,
  );
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const createAction = actionSource.slice(start, end);

  assert.match(createAction, /dispatchV2MatchCreation\(\{/);
  assert.match(createAction, /const v2CreationPolicy = getV2MatchCreationPolicy\(\)/);
  assert.match(createAction, /capabilities:\s*v2CreationPolicy\.capabilities/);
  assert.match(createAction, /disabledRoute:\s*v2CreationPolicy\.disabledRoute/);
  assert.match(createAction, /handlers:\s*v2MatchCreationHandlers/);
  assert.match(
    createAction,
    /if \(v2Dispatch\.kind !== ["']legacy["']\)[\s\S]*?redirect\(`\/matchs\/\$\{createdMatchId\}`\)[\s\S]*?return v2Dispatch\.state/,
  );

  assert.doesNotMatch(createAction, /dispatchV2(?:Single|Double|Team)MatchCreation/);
  assert.doesNotMatch(createAction, /prisma\.match\.create/);
  assert.match(createAction, /旧版/);
});
