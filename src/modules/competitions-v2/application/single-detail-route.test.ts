import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(
  resolve(process.cwd(), "src/app/matchs/[id]/page.tsx"),
  "utf8",
);

function section(start: string, end?: string) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = end ? source.indexOf(end, startIndex + start.length) : source.length;
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertBefore(body: string, first: string, second: string) {
  const firstIndex = body.indexOf(first);
  const secondIndex = body.indexOf(second);
  assert.notEqual(firstIndex, -1, `missing expected operation: ${first}`);
  assert.notEqual(secondIndex, -1, `missing expected operation: ${second}`);
  assert.ok(firstIndex < secondIndex, `${first} must run before ${second}`);
}

test("match detail returns through the V2 reader before any legacy aggregate read", () => {
  const body = section("export default async function MatchDetailPage");

  assert.match(body, /competitionDetail = await getV2CompetitionDetailReadModel\(/);
  assertBefore(
    body,
    'if (competitionDetail.kind === "SINGLE_V2_DETAIL")',
    "const archiveParams",
  );
  assertBefore(body, "return renderV2SingleMatchDetail(", "<ArchivedMatchDetail");
});

test("legacy aggregate read is guarded against an engine switch", () => {
  const body = section("export default async function MatchDetailPage");

  const archive = readFileSync(resolve(process.cwd(), "src/components/match/ArchivedMatchDetail.tsx"), "utf8");
  assert.match(archive, /engineVersion: "LEGACY"/);
  assert.match(archive, /confirmed: true/);
  assert.doesNotMatch(body, /prisma\.matchResult|ReportResultForm|RegisterMatchButton/);
});

test("V2 detail accepts only the dispatched SINGLE model and safely handles integrity errors", () => {
  const pageBody = section("export default async function MatchDetailPage");
  const renderBody = section(
    "async function renderV2SingleMatchDetail",
    "async function renderV2DoubleMatchDetail",
  );
  const dispatcher = readFileSync(
    resolve(
      process.cwd(),
      "src/modules/competitions-v2/read-model/competition-detail.ts",
    ),
    "utf8",
  );

  assert.match(pageBody, /error instanceof V2SingleReadModelIntegrityError/);
  assert.match(pageBody, /competitionDetail\.kind === "MATCH_NOT_FOUND"/);
  assert.match(pageBody, /competitionDetail\.kind === "UNSUPPORTED_V2_MATCH"/);
  assert.match(renderBody, /<V2SingleMatchDetail/);
  assert.match(renderBody, /model=\{model\}/);
  assert.doesNotMatch(renderBody, /getSingleCompetitionReadModel/);
  assert.match(dispatcher, /getSingleCompetitionReadModelInTransaction\(tx, matchId\)/);
  assert.match(dispatcher, /isolationLevel:\s*"RepeatableRead"/);
  assert.doesNotMatch(renderBody, /registrations|teamRegistrations|groupingResult|results/);
});
