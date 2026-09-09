import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const ROUTE_PATH = "src/app/matchs/[id]/grouping/page.tsx";

function routeSource() {
  return readFileSync(resolve(process.cwd(), ROUTE_PATH), "utf8");
}

function routeSlices(source: string) {
  const discriminatorStart = source.indexOf("const [engineDiscriminator");
  const authorizationStart = source.indexOf("!currentUser ||", discriminatorStart);
  const v2Start = source.indexOf(
    'if (engineDiscriminator.engineVersion === "V2")',
    authorizationStart,
  );
  const legacyStart = source.lastIndexOf('redirect(`/matchs/${id}`);');

  assert.ok(discriminatorStart >= 0, "missing engine discriminator");
  assert.ok(authorizationStart > discriminatorStart, "auth must follow lookup");
  assert.ok(v2Start > authorizationStart, "V2 branch must follow auth");
  assert.ok(legacyStart > v2Start, "Legacy branch must follow the V2 return");

  return {
    discriminator: source.slice(discriminatorStart, authorizationStart),
    v2: source.slice(v2Start, legacyStart),
    legacy: source.slice(legacyStart),
  };
}

test("the grouping route discriminates V2 before any Legacy aggregate read", () => {
  const source = routeSource();
  const slices = routeSlices(source);

  assert.match(slices.discriminator, /engineVersion:\s*true/);
  assert.match(slices.discriminator, /createdBy:\s*true/);
  assert.match(slices.discriminator, /type:\s*true/);
  assert.match(slices.discriminator, /format:\s*true/);
  assert.doesNotMatch(
    slices.discriminator,
    /registrations|groupingResult|getApprovedTeamGroupingCompetitors|generateGroupingPayload/,
  );

  assert.match(slices.legacy, /redirect/);
  assert.doesNotMatch(slices.legacy, /GroupingAdminPanel|generateGroupingPayload|prisma/);
});

test("the V2 grouping route uses one fail-closed relational reader for SINGLE, DOUBLE, and TEAM", () => {
  const source = routeSource();
  const slices = routeSlices(source);

  assert.match(slices.v2, /getV2GroupOnlyGroupingReadModel/);
  assert.match(slices.v2, /V2GroupOnlyGroupingReadIntegrityError/);
  assert.match(slices.v2, /V2_SINGLE_GROUPING_READ_PROFILE/);
  assert.match(slices.v2, /V2_DOUBLE_GROUPING_READ_PROFILE/);
  assert.match(slices.v2, /V2_TEAM_GROUPING_READ_PROFILE/);
  assert.match(slices.v2, /readModel\.kind === "MATCH_NOT_FOUND"/);
  assert.match(slices.v2, /readModel\.kind !== "GROUP_ONLY_V2_MATCH"/);
  assert.match(
    slices.v2,
    /readModel\.kind !== "GROUP_THEN_KNOCKOUT_V2_MATCH"/,
  );
  assert.match(slices.v2, /readModel\.activeEntries/);
  assert.match(slices.v2, /readModel\.published/);
  assert.match(slices.v2, /participantCount={activeEntries\.length}/);
  assert.match(slices.v2, /published={published}/);
  assert.match(slices.v2, /format={readModel\.match\.format}/);
  assert.match(slices.v2, /readModel\.managementState/);
  assert.match(slices.v2, /readModel\.knockout/);
  assert.match(slices.v2, /readModel\.qualifiersPerGroup/);
  assert.match(slices.v2, /<V2SingleGroupingPanel/);
  assert.match(slices.v2, /<V2DoubleGroupingPanel/);
  assert.match(slices.v2, /<V2TeamGroupingPanel/);
  assert.doesNotMatch(
    slices.v2,
    /GroupingAdminPanel|getApprovedTeamGroupingCompetitors|generateGroupingPayload|\.registrations|groupingResult/,
  );

  assert.match(
    source,
    /currentUser\.id !== engineDiscriminator\.createdBy[\s\S]*currentUser\.role !== "admin"/,
  );
  assert.match(
    slices.v2,
    /currentUser\.id !== readModel\.match\.createdBy[\s\S]*currentUser\.role !== "admin"/,
  );
  assert.doesNotMatch(source, /cookies|ADMIN_MODE_COOKIE|adminViewEnabled/);
});
