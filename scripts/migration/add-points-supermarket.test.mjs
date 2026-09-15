import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../../prisma/migrations/20260916100000_add_points_supermarket/migration.sql",
    import.meta.url,
  ),
  "utf8",
);
const schema = readFileSync(
  new URL("../../prisma/schema.prisma", import.meta.url),
  "utf8",
);

test("supermarket migration is transactional and creates no destructive statements", () => {
  assert.match(migration, /BEGIN;/);
  assert.match(migration, /COMMIT;/);
  // The only permitted destructive statements are the unused placeholder
  // reward tables, which no code path ever wrote to.
  const drops = migration.match(/DROP\s+TABLE[^;]*;/gi) ?? [];
  assert.equal(drops.length, 2);
  for (const drop of drops) {
    assert.match(drop, /"RewardRedemption"|"Reward"/);
  }
  assert.doesNotMatch(migration, /DROP\s+(?:TYPE|INDEX|CONSTRAINT)/i);
  assert.doesNotMatch(migration, /DELETE\s+FROM|TRUNCATE/i);
});

test("at most one period can be open at a time", () => {
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "supermarket_period_single_open_key"[\s\S]*?WHERE "status" = 'OPEN'/,
  );
});

test("supermarket points can never become a debt", () => {
  assert.match(
    migration,
    /CONSTRAINT "supermarket_balance_non_negative_check" CHECK \("balance" >= 0\)/,
  );
  assert.match(
    migration,
    /CONSTRAINT "supermarket_balance_entry_after_check" CHECK \("balance_after" >= 0\)/,
  );
});

test("redemption resolution metadata cannot contradict its status", () => {
  assert.match(
    migration,
    /CONSTRAINT "supermarket_redemption_resolution_check" CHECK \([\s\S]*?"status" = 'PENDING' AND "resolved_at" IS NULL AND "resolved_by_id" IS NULL[\s\S]*?"status" <> 'PENDING' AND "resolved_at" IS NOT NULL/,
  );
});

test("redemptions keep prize name and cost as snapshots, not lookups", () => {
  assert.match(migration, /"prize_name"\s+TEXT NOT NULL/);
  assert.match(migration, /"points_spent"\s+INTEGER NOT NULL/);
  assert.match(schema, /prizeName\s+String\s+@map\("prize_name"\)/);
  assert.match(schema, /pointsSpent\s+Int\s+@map\("points_spent"\)/);
});

test("prizes and stock are scoped to a single period, not shared across them", () => {
  assert.match(
    migration,
    /ALTER TABLE "supermarket_prize"[\s\S]*?FOREIGN KEY \("period_id"\) REFERENCES "supermarket_period"\("id"\) ON DELETE RESTRICT/,
  );
  assert.match(
    schema,
    /period\s+SupermarketPeriod\s+@relation\(fields: \[periodId\], references: \[id\], onDelete: Restrict\)/,
  );
});

test("match points stay untouched by the supermarket ledger", () => {
  // Settlement is the only bridge between the two ledgers, and it is recorded
  // as its own batch rather than by mutating PointsTransaction semantics.
  assert.match(migration, /CREATE TABLE "supermarket_settlement"/);
  assert.doesNotMatch(migration, /ALTER TABLE "PointsTransaction"/);
  assert.doesNotMatch(migration, /ALTER TABLE "User"/);
});

test("closing a period cannot delete the history it produced", () => {
  for (const table of [
    "supermarket_balance",
    "supermarket_prize",
    "supermarket_redemption",
    "supermarket_settlement",
  ]) {
    assert.match(
      migration,
      new RegExp(
        `ALTER TABLE "${table}"[\\s\\S]*?FOREIGN KEY \\("period_id"\\) REFERENCES "supermarket_period"\\("id"\\) ON DELETE RESTRICT`,
      ),
    );
  }
});
