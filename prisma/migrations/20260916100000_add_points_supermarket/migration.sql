BEGIN;

-- Points supermarket: a periodically opened, periodically expired spending
-- outlet for member points. Match points stay a permanent record; supermarket
-- points are scoped to one period and are zeroed when that period closes.

CREATE TYPE "SupermarketPeriodStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "SupermarketBalanceEntryType" AS ENUM ('SETTLEMENT', 'REDEMPTION', 'ADMIN_ADJUSTMENT');
CREATE TYPE "SupermarketPrizeStatus" AS ENUM ('ACTIVE', 'WITHDRAWN');
CREATE TYPE "SupermarketRedemptionStatus" AS ENUM ('PENDING', 'FULFILLED', 'VOIDED');

CREATE TABLE "supermarket_period" (
  "id"        TEXT NOT NULL,
  "sequence"  INTEGER NOT NULL,
  "status"    "SupermarketPeriodStatus" NOT NULL DEFAULT 'OPEN',
  "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_at" TIMESTAMP(3),

  CONSTRAINT "supermarket_period_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "supermarket_period_sequence_key" ON "supermarket_period"("sequence");
CREATE INDEX "supermarket_period_status_opened_at_idx" ON "supermarket_period"("status", "opened_at");

-- At most one period may be open at a time. This is the invariant every
-- redemption and settlement path depends on, so enforce it in the database
-- rather than trusting the application layer.
CREATE UNIQUE INDEX "supermarket_period_single_open_key"
  ON "supermarket_period"("status")
  WHERE "status" = 'OPEN';

CREATE TABLE "supermarket_settlement" (
  "id"           TEXT NOT NULL,
  "period_id"    TEXT NOT NULL,
  "user_count"   INTEGER NOT NULL,
  "total_points" INTEGER NOT NULL,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "supermarket_settlement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "supermarket_settlement_period_id_created_at_idx" ON "supermarket_settlement"("period_id", "created_at");

CREATE TABLE "supermarket_balance" (
  "id"         TEXT NOT NULL,
  "user_id"    TEXT NOT NULL,
  "period_id"  TEXT NOT NULL,
  "balance"    INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "supermarket_balance_pkey" PRIMARY KEY ("id"),
  -- Supermarket points are a spending allowance, never a debt.
  CONSTRAINT "supermarket_balance_non_negative_check" CHECK ("balance" >= 0)
);

CREATE UNIQUE INDEX "supermarket_balance_user_id_period_id_key" ON "supermarket_balance"("user_id", "period_id");
CREATE INDEX "supermarket_balance_period_id_idx" ON "supermarket_balance"("period_id");

CREATE TABLE "supermarket_balance_entry" (
  "id"            TEXT NOT NULL,
  "balance_id"    TEXT NOT NULL,
  "amount"        INTEGER NOT NULL,
  "balance_after" INTEGER NOT NULL,
  "type"          "SupermarketBalanceEntryType" NOT NULL,
  "reason"        TEXT NOT NULL,
  "actor_id"      TEXT,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "supermarket_balance_entry_pkey" PRIMARY KEY ("id"),
  -- The running balance after any entry can never be negative either.
  CONSTRAINT "supermarket_balance_entry_after_check" CHECK ("balance_after" >= 0)
);

CREATE INDEX "supermarket_balance_entry_balance_id_created_at_idx" ON "supermarket_balance_entry"("balance_id", "created_at");
CREATE INDEX "supermarket_balance_entry_actor_id_idx" ON "supermarket_balance_entry"("actor_id");

CREATE TABLE "supermarket_prize" (
  "id"          TEXT NOT NULL,
  "period_id"   TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "description" TEXT,
  "points_cost" INTEGER NOT NULL,
  "stock"       INTEGER,
  "status"      "SupermarketPrizeStatus" NOT NULL DEFAULT 'ACTIVE',
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMP(3) NOT NULL,

  CONSTRAINT "supermarket_prize_pkey" PRIMARY KEY ("id"),
  -- A prize that costs nothing is a giveaway, not a prize; a negative cost
  -- would credit the redeemer. Stock is null for unlimited supply.
  CONSTRAINT "supermarket_prize_points_cost_check" CHECK ("points_cost" > 0),
  CONSTRAINT "supermarket_prize_stock_check" CHECK ("stock" IS NULL OR "stock" >= 0)
);

CREATE INDEX "supermarket_prize_period_id_status_idx" ON "supermarket_prize"("period_id", "status");

CREATE TABLE "supermarket_redemption" (
  "id"             TEXT NOT NULL,
  "period_id"      TEXT NOT NULL,
  "prize_id"       TEXT NOT NULL,
  "user_id"        TEXT NOT NULL,
  "prize_name"     TEXT NOT NULL,
  "points_spent"   INTEGER NOT NULL,
  "status"         "SupermarketRedemptionStatus" NOT NULL DEFAULT 'PENDING',
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at"    TIMESTAMP(3),
  "resolved_by_id" TEXT,

  CONSTRAINT "supermarket_redemption_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "supermarket_redemption_points_spent_check" CHECK ("points_spent" > 0),
  -- Resolution metadata and status must agree: PENDING has neither, a resolved
  -- redemption has both. Keeps "voided but still pending" unrepresentable.
  CONSTRAINT "supermarket_redemption_resolution_check" CHECK (
    ("status" = 'PENDING' AND "resolved_at" IS NULL AND "resolved_by_id" IS NULL)
    OR
    ("status" <> 'PENDING' AND "resolved_at" IS NOT NULL)
  )
);

CREATE INDEX "supermarket_redemption_period_id_status_idx" ON "supermarket_redemption"("period_id", "status");
CREATE INDEX "supermarket_redemption_user_id_created_at_idx" ON "supermarket_redemption"("user_id", "created_at");
CREATE INDEX "supermarket_redemption_prize_id_idx" ON "supermarket_redemption"("prize_id");

ALTER TABLE "supermarket_settlement"
  ADD CONSTRAINT "supermarket_settlement_period_id_fkey"
  FOREIGN KEY ("period_id") REFERENCES "supermarket_period"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supermarket_balance"
  ADD CONSTRAINT "supermarket_balance_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "supermarket_balance"
  ADD CONSTRAINT "supermarket_balance_period_id_fkey"
  FOREIGN KEY ("period_id") REFERENCES "supermarket_period"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supermarket_balance_entry"
  ADD CONSTRAINT "supermarket_balance_entry_balance_id_fkey"
  FOREIGN KEY ("balance_id") REFERENCES "supermarket_balance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "supermarket_balance_entry"
  ADD CONSTRAINT "supermarket_balance_entry_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "supermarket_prize"
  ADD CONSTRAINT "supermarket_prize_period_id_fkey"
  FOREIGN KEY ("period_id") REFERENCES "supermarket_period"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supermarket_redemption"
  ADD CONSTRAINT "supermarket_redemption_period_id_fkey"
  FOREIGN KEY ("period_id") REFERENCES "supermarket_period"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supermarket_redemption"
  ADD CONSTRAINT "supermarket_redemption_prize_id_fkey"
  FOREIGN KEY ("prize_id") REFERENCES "supermarket_prize"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "supermarket_redemption"
  ADD CONSTRAINT "supermarket_redemption_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "supermarket_redemption"
  ADD CONSTRAINT "supermarket_redemption_resolved_by_id_fkey"
  FOREIGN KEY ("resolved_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The unused placeholder reward tables are superseded by the period-scoped
-- prize model above. They were never written to by any code path, so dropping
-- them loses no data.
DROP TABLE IF EXISTS "RewardRedemption";
DROP TABLE IF EXISTS "Reward";

COMMIT;
