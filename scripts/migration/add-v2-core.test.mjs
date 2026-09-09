import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../prisma/migrations/20260904090000_add_v2_competition_core/migration.sql",
  import.meta.url,
);
const migrationSql = await readFile(migrationUrl, "utf8");

test("the first V2 migration is expand-only", () => {
  assert.doesNotMatch(
    migrationSql,
    /^\s*(?:DROP\b|TRUNCATE\b|DELETE\s+FROM\b|UPDATE\s+|ALTER\s+TABLE[^;]+\bRENAME\b)/im,
  );
  assert.doesNotMatch(migrationSql, /\bINSERT\s+INTO\b/i);

  for (const legacyTable of [
    "User",
    "Registration",
    "MatchResult",
    "EloHistory",
    "PointsTransaction",
    "MatchGrouping",
    "match_team",
    "match_team_member",
    "match_doubles_team",
    "match_doubles_team_member",
  ]) {
    assert.doesNotMatch(
      migrationSql,
      new RegExp(`ALTER\\s+TABLE\\s+"${legacyTable}"`, "i"),
      `${legacyTable} must not be altered by the expand migration`,
    );
  }
});

test("every existing match remains on the legacy engine", () => {
  assert.match(
    migrationSql,
    /ALTER TABLE "Match"\s+ADD COLUMN "engine_version" "MatchEngineVersion" NOT NULL DEFAULT 'LEGACY'/,
  );
  assert.doesNotMatch(migrationSql, /(?:DEFAULT|SET)\s+'?V2'?/i);
});

test("the V2 identity, fixture, result, and settlement tables are present", () => {
  for (const table of [
    "match_entry",
    "match_entry_member",
    "match_fixture",
    "match_fixture_lineup_member",
    "match_fixture_dependency",
    "result_revision",
    "settlement_event",
    "settlement_effect",
  ]) {
    assert.match(
      migrationSql,
      new RegExp(`CREATE\\s+TABLE\\s+"${table}"`, "i"),
      `${table} must be created by the foundation migration`,
    );
  }
});

test("authoritative result and settlement operations are idempotent", () => {
  assert.match(migrationSql, /result_revision_one_pending_per_fixture_key/);
  assert.match(migrationSql, /result_revision_one_confirmed_per_fixture_key/);
  assert.match(migrationSql, /settlement_event_idempotency_key/);
  assert.match(migrationSql, /settlement_effect_event_user_key/);
});

test("fixture rosters and successor membership remain explicit history", () => {
  assert.match(
    migrationSql,
    /CREATE TYPE "MatchEntryMemberStatus" AS ENUM \([^;]*'SUPERSEDED'[^;]*\)/,
  );
  assert.match(migrationSql, /"side_a_roster_version" INTEGER/);
  assert.match(migrationSql, /"side_b_roster_version" INTEGER/);
  assert.match(migrationSql, /match_fixture_side_a_roster_check/);
  assert.match(migrationSql, /match_fixture_side_b_roster_check/);
});

test("registration and result settlements have distinct checked subjects", () => {
  assert.match(
    migrationSql,
    /CREATE TYPE "SettlementEventKind" AS ENUM \([^;]*'RESULT_APPLY'[^;]*'RESULT_REVERSAL'[^;]*'REGISTRATION_APPLY'[^;]*'REGISTRATION_REVERSAL'[^;]*\)/,
  );
  assert.match(migrationSql, /"result_revision_id" TEXT/);
  assert.match(migrationSql, /"match_entry_id" TEXT/);
  assert.match(migrationSql, /settlement_event_subject_check/);
  assert.match(migrationSql, /settlement_event_kind_links_check/);
  assert.match(migrationSql, /settlement_event_reverses_event_id_key/);
});

test("a rejected correction does not permanently consume its predecessor", () => {
  assert.match(migrationSql, /result_revision_supersedes_identity_idx/);
  assert.doesNotMatch(
    migrationSql,
    /CREATE UNIQUE INDEX "result_revision_supersedes_identity_idx"/,
  );
});

test("the migration is atomic", () => {
  assert.match(migrationSql, /^--[^]*\nBEGIN;/);
  assert.match(migrationSql, /COMMIT;\s*$/);
});
