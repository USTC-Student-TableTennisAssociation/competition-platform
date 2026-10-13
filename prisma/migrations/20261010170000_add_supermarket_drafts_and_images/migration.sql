-- Commit the enum value before using it in a partial index.
BEGIN;
ALTER TYPE "SupermarketPeriodStatus" ADD VALUE 'DRAFT';
COMMIT;

BEGIN;
ALTER TABLE "supermarket_period" ALTER COLUMN "opened_at" DROP NOT NULL;
CREATE UNIQUE INDEX "supermarket_period_single_draft_idx"
  ON "supermarket_period" ("status") WHERE "status" = 'DRAFT';
ALTER TABLE "supermarket_prize" ADD COLUMN "image_url" TEXT;
COMMIT;
