BEGIN;

ALTER TABLE "supermarket_prize"
  ADD COLUMN "per_user_limit" INTEGER,
  ADD CONSTRAINT "supermarket_prize_per_user_limit_check"
    CHECK ("per_user_limit" IS NULL OR "per_user_limit" > 0);

CREATE INDEX "supermarket_redemption_prize_id_user_id_status_idx"
  ON "supermarket_redemption" ("prize_id", "user_id", "status");

COMMIT;
