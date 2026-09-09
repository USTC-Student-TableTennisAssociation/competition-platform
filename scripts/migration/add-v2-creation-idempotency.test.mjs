import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../prisma/migrations/20260905090000_add_v2_match_creation_idempotency/migration.sql",
  import.meta.url,
);
const migrationSql = await readFile(migrationUrl, "utf8");

test("the V2 creation idempotency migration is expand-only", () => {
  assert.doesNotMatch(
    migrationSql,
    /^\s*(?:DROP\b|TRUNCATE\b|DELETE\s+FROM\b|UPDATE\s+|ALTER\s+TABLE[^;]+\bRENAME\b)/im,
  );
  assert.doesNotMatch(migrationSql, /\bINSERT\s+INTO\b/i);
  assert.match(migrationSql, /ADD COLUMN "creation_request_key" TEXT/);
  assert.match(
    migrationSql,
    /ADD COLUMN "creation_request_fingerprint" TEXT/,
  );
});

test("legacy rows keep nullable request identity while V2 identities are paired", () => {
  assert.match(migrationSql, /"creation_request_key" IS NULL[^]*"creation_request_fingerprint" IS NULL/);
  assert.match(migrationSql, /"engine_version" = 'V2'/);
  assert.match(migrationSql, /"creation_request_key" IS NOT NULL/);
  assert.match(migrationSql, /"creation_request_fingerprint" IS NOT NULL/);
  assert.match(migrationSql, /char_length\("creation_request_key"\) BETWEEN 16 AND 128/);
  assert.match(migrationSql, /"creation_request_fingerprint" ~ '\^\[0-9a-f\]\{64\}\$'/);
});

test("one creator and request key identify at most one match", () => {
  assert.match(
    migrationSql,
    /CREATE UNIQUE INDEX "match_creator_creation_request_key_unique"\s+ON "Match"\("createdBy", "creation_request_key"\)/,
  );
});

test("the V2 creation idempotency migration is atomic", () => {
  assert.match(migrationSql, /^--[^]*\nBEGIN;/);
  assert.match(migrationSql, /COMMIT;\s*$/);
});
