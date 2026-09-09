import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sql = readFileSync(
  new URL(
    "../../prisma/migrations/20260907100000_add_v2_knockout_admin_resolution/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

test("administrative knockout outcomes are relational, settlement-free, and fixture-unique", () => {
  assert.match(
    sql,
    /CREATE TYPE "MatchFixtureAdministrativeResolutionKind" AS ENUM \('NO_CONTEST', 'ADMIN_BYE'\)/,
  );
  assert.match(sql, /CREATE TABLE "match_fixture_administrative_resolution"/);
  assert.match(sql, /fixture_administrative_resolution_payload_check/);
  assert.match(sql, /"kind" = 'NO_CONTEST'[\s\S]*"advancing_entry_id" IS NULL/);
  assert.match(sql, /"kind" = 'ADMIN_BYE'[\s\S]*"advancing_roster_version" >= 1/);
  assert.match(sql, /fixture_administrative_resolution_fixture_key/);
  assert.match(sql, /fixture_administrative_resolution_fixture_match_fkey/);
  assert.match(sql, /fixture_administrative_resolution_advancing_entry_fkey/);
  assert.doesNotMatch(sql, /settlement_event|settlement_effect|result_revision/i);
});
