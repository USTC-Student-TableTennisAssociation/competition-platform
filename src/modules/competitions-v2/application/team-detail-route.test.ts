import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("match detail dispatches TEAM V2 through its authoritative reader before Legacy", () => {
  const source = read("src/app/matchs/[id]/page.tsx");
  const dispatcher = source.indexOf("getV2CompetitionDetailReadModel(");
  const teamBranch = source.indexOf(
    "return renderV2TeamMatchDetail(",
    dispatcher,
  );
  const legacySearch = source.indexOf("const archiveParams", dispatcher);
  assert.ok(dispatcher >= 0 && dispatcher < teamBranch);
  assert.ok(teamBranch < legacySearch);

  const renderStart = source.indexOf("async function renderV2TeamMatchDetail");
  const renderEnd = source.indexOf(
    "export default async function MatchDetailPage",
    renderStart,
  );
  const render = source.slice(renderStart, renderEnd);
  assert.match(render, /<V2TeamMatchDetail/);
  assert.match(render, /model=\{model\}/);
  assert.doesNotMatch(render, /getV2TeamRegistrationReadState/);
  assert.doesNotMatch(render, /\.registration\.|registeredAt|teamRegistrations/);
});

test("TEAM detail reuses source UI and exposes only the shared V2 group result panel", () => {
  const source = read("src/components/match/v2/V2TeamMatchDetail.tsx");
  assert.match(source, /<TeamRegistrationPanel/);
  assert.match(source, /allowCancellation=\{!grouping\.published\}/);
  assert.match(source, /captainCancellationOpen=\{!grouping\.published\}/);
  assert.match(source, /const \{ match, grouping \} = model/);
  assert.match(source, /\/grouping/);
  assert.match(source, /V2CompetitionPhases/);
  assert.match(source, /grouping=\{grouping\}/);
  assert.match(source, /competitionType="team"/);
  assert.match(source, /ExportCertificateSection/);
  assert.doesNotMatch(source, /V2GroupOnlyFixtureResultPanel/);
  assert.doesNotMatch(source, /submitV2|confirmV2|cancelMatchTeamAction/);
});

test("TEAM read and grouping action slices never touch Legacy registration identities", () => {
  for (const path of [
    "src/modules/competitions-v2/read-model/team-registration.ts",
    "src/modules/competitions-v2/adapters/team-grouping-actions.ts",
    "src/modules/competitions-v2/application/team-matches.ts",
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /\.registration\.(?:create|update|delete|find|count)/);
    assert.doesNotMatch(source, /registeredAt/);
  }
});
