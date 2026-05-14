-- Add persistent quick-match marker.
ALTER TABLE "Match" ADD COLUMN "isQuickMatch" BOOLEAN NOT NULL DEFAULT false;

-- Backfill existing quick-match records.
UPDATE "Match"
SET "isQuickMatch" = true
WHERE
  "title" LIKE '[快速比赛]%'
    OR "description" IN ('由快速比赛功能创建', '由快速比赛功能创建（已作废）')
    OR "location" = '快速比赛';

CREATE INDEX "Match_isQuickMatch_idx" ON "Match"("isQuickMatch");
