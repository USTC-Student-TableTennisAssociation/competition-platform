import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../prisma/migrations/20260905120000_add_v2_grouping_foundation/migration.sql",
  import.meta.url,
);
const migrationSql = await readFile(migrationUrl, "utf8");

test("the relational grouping migration is expand-only", () => {
  assert.doesNotMatch(
    migrationSql,
    /^\s*(?:DROP\b|TRUNCATE\b|DELETE\s+FROM\b|UPDATE\s+|ALTER\s+TABLE[^;]+\bRENAME\b)/im,
  );
  assert.doesNotMatch(migrationSql, /\bINSERT\s+INTO\b/i);
  assert.doesNotMatch(migrationSql, /ALTER\s+TABLE\s+"match_fixture_dependency"/i);

  for (const table of ["MatchGrouping", "match_fixture", "result_revision"]) {
    assert.match(migrationSql, new RegExp(`ALTER\\s+TABLE\\s+"${table}"`, "i"));
  }
});

test("legacy grouping rows keep nullable V2 metadata", () => {
  for (const column of [
    "v2_schema_version",
    "seed_method",
    "standings_policy_version",
    "qualifiers_per_group",
    "bracket_policy_version",
  ]) {
    assert.match(migrationSql, new RegExp(`ADD COLUMN "${column}"`));
    assert.doesNotMatch(
      migrationSql,
      new RegExp(`ADD COLUMN "${column}"[^,;]*NOT NULL`),
    );
  }
  assert.match(migrationSql, /match_grouping_v2_field_set_check/);
  assert.match(migrationSql, /num_nonnulls\([^]*\) = 0/);
  assert.match(migrationSql, /match_grouping_id_match_id_key/);
});

test("fixtures gain an optional relational group without invalidating old GROUP rows", () => {
  assert.match(migrationSql, /ADD COLUMN "group_id" TEXT/);
  assert.doesNotMatch(migrationSql, /ADD COLUMN "group_id" TEXT NOT NULL/);
  assert.match(migrationSql, /match_fixture_group_stage_check/);
  assert.match(migrationSql, /"group_id" IS NULL OR "stage" = 'GROUP'/);
  assert.match(migrationSql, /match_fixture_group_match_fkey/);
});

test("result resolution preserves existing revisions as PLAYED", () => {
  assert.match(
    migrationSql,
    /CREATE TYPE "ResultResolutionKind" AS ENUM \('PLAYED', 'FORFEIT'\)/,
  );
  assert.match(
    migrationSql,
    /ADD COLUMN "resolution_kind" "ResultResolutionKind" NOT NULL DEFAULT 'PLAYED'/,
  );
  assert.doesNotMatch(migrationSql, /'WALKOVER'/);
});

test("relational groups freeze reproducible seed inputs", () => {
  for (const table of [
    "match_group",
    "match_group_entry",
    "match_qualification_snapshot",
    "match_qualification_standing",
  ]) {
    assert.match(migrationSql, new RegExp(`CREATE\\s+TABLE\\s+"${table}"`, "i"));
  }
  for (const column of [
    "global_seed_rank",
    "seed_elo",
    "seed_points",
    "entry_version",
    "roster_version",
  ]) {
    assert.match(migrationSql, new RegExp(`"${column}" INTEGER NOT NULL`));
  }
  assert.match(migrationSql, /match_group_entry_match_seed_rank_key/);
  assert.match(migrationSql, /match_group_entry_entry_version_check/);
  assert.match(migrationSql, /"entry_version" >= 0/);
  assert.doesNotMatch(
    migrationSql,
    /seed_elo[^\n]*CHECK|CHECK[^\n]*seed_elo/i,
    "User ELO is not bounded at zero, so a frozen seed must preserve negative values",
  );
});

test("every grouping relation carries and checks match identity", () => {
  assert.match(
    migrationSql,
    /FOREIGN KEY \("grouping_id", "match_id"\) REFERENCES "MatchGrouping"\("id", "matchId"\)/,
  );
  assert.match(
    migrationSql,
    /FOREIGN KEY \("group_id", "match_id"\) REFERENCES "match_group"\("id", "match_id"\)/,
  );
  assert.match(
    migrationSql,
    /FOREIGN KEY \("entry_id", "match_id"\) REFERENCES "match_entry"\("id", "match_id"\)/,
  );
  assert.match(
    migrationSql,
    /FOREIGN KEY \("snapshot_id", "match_id"\) REFERENCES "match_qualification_snapshot"\("id", "match_id"\)/,
  );
  assert.match(
    migrationSql,
    /FOREIGN KEY \("group_id", "entry_id", "match_id"\) REFERENCES "match_group_entry"\("group_id", "entry_id", "match_id"\)/,
  );
});

test("one immutable qualification snapshot records deterministic standings", () => {
  assert.match(migrationSql, /"source_revision_fingerprint" TEXT NOT NULL/);
  assert.match(migrationSql, /match_qualification_snapshot_grouping_id_key/);
  assert.match(migrationSql, /match_qualification_standing_record_check/);
  assert.match(migrationSql, /"played" = "wins" \+ "losses"/);
  assert.match(migrationSql, /match_qualification_standing_score_check/);
  assert.match(
    migrationSql,
    /"score_differential" = "score_for" - "score_against"/,
  );
  assert.match(migrationSql, /match_qualification_standing_reason_check/);
  assert.match(migrationSql, /btrim\("ineligibility_reason"\) <> ''/);
  assert.match(migrationSql, /match_qualification_standing_decision_check/);
  assert.match(migrationSql, /match_qualification_standing_snapshot_entry_key/);
  assert.match(migrationSql, /match_qualification_standing_snapshot_order_key/);
});

test("the relational grouping migration is atomic", () => {
  assert.match(migrationSql, /^--[^]*\nBEGIN;/);
  assert.match(migrationSql, /COMMIT;\s*$/);
});
