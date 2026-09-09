import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("TEAM Server Actions compose the strict TEAM adapter for every group result command", () => {
  const source = read("src/app/matchs/v2-actions.ts");
  assert.match(source, /createV2TeamResultActionHandlers/);
  for (const action of [
    "voidV2TeamUnplayedFixtureAction",
    "submitV2TeamResultAction",
    "submitV2TeamResultCorrectionAction",
    "confirmV2TeamResultAction",
    "rejectV2TeamResultAction",
    "voidV2TeamResultAction",
    "confirmV2TeamForfeitAction",
    "correctV2TeamForfeitAction",
  ]) {
    assert.match(source, new RegExp(`export async function ${action}\\(`));
  }
  assert.doesNotMatch(source, /requiredFixtureStage:\s*formData/);
});

test("TEAM forms never expose actor or stage and reuse the loser-free forfeit form", () => {
  const source = read(
    "src/components/match/v2/V2TeamResultActionForms.tsx",
  );
  assert.doesNotMatch(
    source,
    /name=["'](?:actor|actorId|role|stage|requiredFixtureStage)["']/,
  );
  assert.match(source, /max=\{V2_MAX_TEAM_SCORE_PER_FIXTURE\}/);
  const forfeitStart = source.indexOf("export function V2TeamForfeitForm");
  assert.ok(forfeitStart >= 0);
  const forfeitSource = source.slice(forfeitStart);
  assert.match(forfeitSource, /V2GroupOnlyForfeitForm/);
  assert.doesNotMatch(forfeitSource, /name=["']loserEntryId["']/);

  const sharedForfeit = read(
    "src/components/match/v2/V2GroupOnlyResultActionForms.tsx",
  );
  const sharedStart = sharedForfeit.indexOf(
    "export function V2GroupOnlyForfeitForm",
  );
  assert.ok(sharedStart >= 0);
  assert.doesNotMatch(
    sharedForfeit.slice(sharedStart),
    /name=["'](?:actor|actorId|role|stage|requiredFixtureStage|loserEntryId)["']/,
  );
});

test("TEAM result slice contains no Legacy registration writes or remote rollout toggles", () => {
  for (const path of [
    "src/modules/competitions-v2/adapters/team-result-boundary.ts",
    "src/modules/competitions-v2/adapters/team-result-actions.ts",
    "src/components/match/v2/V2TeamResultActionForms.tsx",
    "src/components/match/v2/V2TeamMatchDetail.tsx",
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /\.registration\.(?:create|update|delete|upsert)/);
    assert.doesNotMatch(source, /registeredAt|DATABASE_URL|Neon|process\.env/);
  }
});
