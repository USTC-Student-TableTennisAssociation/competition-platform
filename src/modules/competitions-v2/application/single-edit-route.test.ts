import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(
  resolve(process.cwd(), "src/app/matchs/[id]/edit/page.tsx"),
  "utf8",
);

function assertBefore(first: string, second: string) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.notEqual(firstIndex, -1, `missing expected operation: ${first}`);
  assert.notEqual(secondIndex, -1, `missing expected operation: ${second}`);
  assert.ok(firstIndex < secondIndex, `${first} must run before ${second}`);
}

test("the edit route dispatches V2 before rendering the Legacy form", () => {
  assert.match(
    source,
    /const \[currentUser, matchDiscriminator\][\s\S]*?select:\s*\{[\s\S]*?id:\s*true,[\s\S]*?engineVersion:\s*true,[\s\S]*?createdBy:\s*true,[\s\S]*?\}/,
  );

  assert.ok(source.indexOf("<V2SingleMatchSettingsForm") < source.lastIndexOf('redirect(`/matchs/${id}`);'));
});

test("the V2 edit branch accepts all six formal scopes and stays lifecycle-closed", () => {
  assert.match(
    source,
    /where:\s*\{ id, engineVersion: "V2" \}/,
  );
  for (const guard of [
    "match.isQuickMatch",
    "isSupportedV2MatchSettingsScope(match.type, match.format)",
    "!hasValidTeamPolicy",
    'match.status !== "registration"',
    "now < match.createdAt",
    "now >= authoritativeRegistrationDeadline",
    "match.groupingGeneratedAt !== null",
    "match.groupingResult !== null",
    "match._count.fixtures > 0",
    "match._count.matchGroups > 0",
    "match._count.qualificationSnapshots > 0",
  ]) {
    assertBefore(guard, "<V2SingleMatchSettingsForm");
  }
  assert.match(
    source,
    /type === "single"[\s\S]*?type === "double"[\s\S]*?type === "team"/,
  );
  assert.match(
    source,
    /format === "group_only"[\s\S]*?format === "group_then_knockout"/,
  );
  assert.doesNotMatch(source, /match\.type !== "single"/);
  assert.doesNotMatch(source, /match\.format !== "group_only"/);

  const v2Start = source.indexOf(
    'if (matchDiscriminator.engineVersion === "V2")',
  );
  const legacyStart = source.lastIndexOf('redirect(`/matchs/${id}`);');
  assert.notEqual(v2Start, -1);
  assert.notEqual(legacyStart, -1);
  const v2Branch = source.slice(v2Start, legacyStart);
  assert.match(v2Branch, /<V2SingleMatchSettingsForm/);
  assert.doesNotMatch(v2Branch, /<EditMatchForm/);
  assert.match(v2Branch, /dateTimeIso: match\.dateTime\.toISOString\(\)/);
  assert.match(
    v2Branch,
    /registrationDeadlineIso:\s*authoritativeRegistrationDeadline\.toISOString\(\)/,
  );
  assert.match(
    v2Branch,
    /teamRegistrationStart:\s*true[\s\S]*?teamRegistrationDeadline:\s*true[\s\S]*?teamMinMembers:\s*true[\s\S]*?teamMaxMembers:\s*true/,
  );
});

test("the archive edit route redirects without exposing an old writer", () => {
  assert.doesNotMatch(source, /EditMatchForm|engineVersion: "LEGACY"/);
  assert.match(source, /redirect\(`\/matchs\/\$\{id\}`\)/);
});

test("the existing login and creator-only boundary remains ahead of engine dispatch", () => {
  assertBefore('if (!currentUser) redirect("/auth");', 'if (matchDiscriminator.engineVersion === "V2")');
  assertBefore(
    "currentUser.id !== matchDiscriminator.createdBy",
    'if (matchDiscriminator.engineVersion === "V2")',
  );
});

test("the dedicated V2 form submits only editable settings, schedule, CSRF, and concurrency data", () => {
  const formSource = readFileSync(
    resolve(
      process.cwd(),
      "src/components/match/v2/V2SingleMatchSettingsForm.tsx",
    ),
    "utf8",
  );
  const fields = [...formSource.matchAll(/name=["']([^"']+)["']/g)].map(
    (match) => match[1],
  );

  assert.deepEqual(fields, [
    "csrfToken",
    "expectedUpdatedAt",
    "title",
    "date",
    "time",
    "deadlineDate",
    "deadlineTime",
    "description",
    "location",
  ]);
  assert.match(
    formSource,
    /updateV2SingleMatchSettingsAction\.bind\(null, matchId\)/,
  );
  assert.doesNotMatch(formSource, /updateMatchAction|EditMatchForm/);
  assert.match(
    formSource,
    /比赛类型、赛制、引擎和报名规则不会被此表单修改/,
  );
  assert.match(formSource, /时间设置（北京时间）/);
  assert.doesNotMatch(formSource, /getTimezoneOffset|name=["']timezoneOffset/);
});
