import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sql=await readFile(new URL("../../prisma/migrations/20261016180000_add_v2_progressive_knockout/migration.sql",import.meta.url),"utf8");
test("progressive migration preserves all existing publications and result history",()=>{
  assert.match(sql,/BEGIN;/);assert.match(sql,/COMMIT;/);
  assert.doesNotMatch(sql,/DROP\s+(?:TABLE|COLUMN)|TRUNCATE|DELETE\s+FROM|UPDATE\s+"(?:Match|match_fixture|result_revision|match_qualification_snapshot)"/i);
  for(const table of ["match_knockout_schedule","match_group_qualification_snapshot","match_group_qualification_standing"])assert.match(sql,new RegExp(`CREATE TABLE "${table}"`));
});
test("each group-rank source is unique and scoped to its own competition",()=>{
  assert.match(sql,/CREATE UNIQUE INDEX "fixture_dependency_group_rank_key"/);
  assert.match(sql,/FOREIGN KEY \("source_group_id", "match_id"\) REFERENCES "match_group"\("id", "match_id"\) ON DELETE RESTRICT/);
  assert.match(sql,/"source_group_id" IS NOT NULL AND "source_group_rank" IS NOT NULL AND "source_group_rank" >= 1/);
  assert.match(sql,/"source_qualification_standing_id" IS NOT NULL AND "source_group_id" IS NULL AND "source_group_rank" IS NULL/);
});
test("frozen progressive standings cannot invent a cross-group competitor or invalid statistic",()=>{
  assert.match(sql,/FOREIGN KEY \("snapshot_id", "group_id", "match_id"\) REFERENCES "match_group_qualification_snapshot"/);
  assert.match(sql,/FOREIGN KEY \("group_id", "entry_id", "match_id"\) REFERENCES "match_group_entry"/);
  assert.match(sql,/"played" = "wins" \+ "losses"/);
  assert.match(sql,/"score_differential" = "score_for" - "score_against"/);
});
