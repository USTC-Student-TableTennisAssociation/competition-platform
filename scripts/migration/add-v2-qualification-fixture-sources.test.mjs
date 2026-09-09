import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../prisma/migrations/20260905140000_add_v2_qualification_fixture_sources/migration.sql",
  import.meta.url,
);
const migrationSql = await readFile(migrationUrl, "utf8");

test("qualification fixture sources preserve every existing dependency row", () => {
  assert.match(migrationSql, /BEGIN;/);
  assert.match(migrationSql, /COMMIT;/);
  assert.doesNotMatch(migrationSql, /DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM/i);
  assert.match(
    migrationSql,
    /ALTER COLUMN "source_fixture_id" DROP NOT NULL/,
  );
  assert.match(migrationSql, /ALTER COLUMN "source_outcome" DROP NOT NULL/);
  assert.match(
    migrationSql,
    /ADD COLUMN "source_qualification_standing_id" TEXT/,
  );
});

test("one dependency row has exactly one typed source", () => {
  assert.match(migrationSql, /fixture_dependency_source_union_check/);
  assert.match(
    migrationSql,
    /"source_fixture_id" IS NOT NULL[\s\S]*"source_outcome" IS NOT NULL[\s\S]*"source_qualification_standing_id" IS NULL/,
  );
  assert.match(
    migrationSql,
    /"source_fixture_id" IS NULL[\s\S]*"source_outcome" IS NULL[\s\S]*"source_qualification_standing_id" IS NOT NULL/,
  );
});

test("qualification and fixture sources are unique and match-scoped", () => {
  assert.match(migrationSql, /fixture_dependency_qualification_source_key/);
  assert.doesNotMatch(
    migrationSql,
    /DROP\s+INDEX[\s\S]*(?:fixture_dependency_source_outcome_key|fixture_dependency_target_side_key)/i,
  );
  assert.match(
    migrationSql,
    /FOREIGN KEY \("source_fixture_id", "match_id"\)[\s\S]*REFERENCES "match_fixture"\("id", "match_id"\)/,
  );
  assert.match(
    migrationSql,
    /FOREIGN KEY \("source_qualification_standing_id", "match_id"\)[\s\S]*REFERENCES "match_qualification_standing"\("id", "match_id"\)/,
  );
});

test("the migration cannot silently cascade-delete bracket history", () => {
  assert.match(
    migrationSql,
    /fixture_dependency_source_match_fkey[\s\S]*ON DELETE RESTRICT/,
  );
  assert.match(
    migrationSql,
    /fixture_dependency_qualification_match_fkey[\s\S]*ON DELETE RESTRICT/,
  );
});
