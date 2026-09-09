import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("match detail dispatches DOUBLE V2 before any branch-specific or Legacy query", () => {
  const source = read("src/app/matchs/[id]/page.tsx");
  const dispatcher = source.indexOf("getV2CompetitionDetailReadModel(");
  const doubleBranch = source.indexOf(
    'if (competitionDetail.kind === "DOUBLE_V2_DETAIL")',
    dispatcher,
  );
  const doubleSearch = source.indexOf("const doubleSearchParams", doubleBranch);
  const legacySearch = source.indexOf("const archiveParams", dispatcher);
  const legacyAggregate = source.indexOf("<ArchivedMatchDetail", legacySearch);
  assert.ok(dispatcher >= 0 && dispatcher < doubleBranch);
  assert.ok(doubleBranch < doubleSearch);
  assert.ok(doubleSearch < legacySearch && legacySearch < legacyAggregate);
  assert.match(source.slice(doubleBranch, legacySearch), /renderV2DoubleMatchDetail/);
});

test("DOUBLE detail exposes registration and shared relational group result actions", () => {
  const source = read("src/components/match/v2/V2DoubleMatchDetail.tsx");
  assert.match(source, /V2DoubleRegistrationForm/);
  assert.match(source, /sendDoublesInviteAction/);
  assert.match(source, /接受/);
  assert.match(source, /报名/);
  assert.match(source, /已报名小队/);
  assert.match(source, /V2CompetitionPhases/);
  assert.match(source, /grouping=\{model\.grouping\}/);
  assert.match(source, /competitionType="double"/);
  assert.match(source, /ExportCertificateSection/);
  assert.doesNotMatch(source, /V2SingleGroupingPanel|GroupingResultSection/);
  assert.doesNotMatch(source, /V2GroupOnlyFixtureResultPanel/);
});

test("DOUBLE V2 mutation/read files never touch Legacy registration identities", () => {
  for (const path of [
    "src/modules/competitions-v2/adapters/double-actions.ts",
    "src/modules/competitions-v2/read-model/double-registration.ts",
    "src/modules/competitions-v2/read-model/group-only-grouping.ts",
    "src/modules/competitions-v2/application/double-matches.ts",
    "src/modules/competitions-v2/application/group-only-match-creation.ts",
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /\.registration\.(?:create|update|delete|find|count)/);
    assert.doesNotMatch(source, /registeredAt/);
  }
});
