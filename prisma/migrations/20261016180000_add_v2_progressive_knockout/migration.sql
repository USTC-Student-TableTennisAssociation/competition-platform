-- Additive support for a fixed bracket and independently confirmed groups.
BEGIN;

-- AlterTable
ALTER TABLE "match_fixture_dependency" ADD COLUMN     "source_group_id" TEXT,
ADD COLUMN     "source_group_rank" INTEGER;

ALTER TABLE "match_fixture_dependency"
DROP CONSTRAINT "fixture_dependency_source_union_check",
ADD CONSTRAINT "fixture_dependency_source_union_check" CHECK (
  ("source_fixture_id" IS NOT NULL AND "source_outcome" IS NOT NULL
   AND "source_qualification_standing_id" IS NULL AND "source_group_id" IS NULL AND "source_group_rank" IS NULL)
  OR
  ("source_fixture_id" IS NULL AND "source_outcome" IS NULL
   AND "source_qualification_standing_id" IS NOT NULL AND "source_group_id" IS NULL AND "source_group_rank" IS NULL)
  OR
  ("source_fixture_id" IS NULL AND "source_outcome" IS NULL AND "source_qualification_standing_id" IS NULL
   AND "source_group_id" IS NOT NULL AND "source_group_rank" IS NOT NULL AND "source_group_rank" >= 1)
);

-- CreateTable
CREATE TABLE "match_knockout_schedule" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "grouping_id" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "bracket_policy_version" INTEGER NOT NULL DEFAULT 2,
    "layout_fingerprint" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_knockout_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_group_qualification_snapshot" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "standings_policy_version" INTEGER NOT NULL DEFAULT 1,
    "source_revision_fingerprint" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_group_qualification_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_group_qualification_standing" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "snapshot_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "played" INTEGER NOT NULL,
    "wins" INTEGER NOT NULL,
    "losses" INTEGER NOT NULL,
    "score_for" INTEGER NOT NULL,
    "score_against" INTEGER NOT NULL,
    "score_differential" INTEGER NOT NULL,
    "qualified" BOOLEAN NOT NULL,
    "qualification_order" INTEGER,
    "ineligibility_reason" TEXT,
    "entry_version" INTEGER NOT NULL,
    "roster_version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_group_qualification_standing_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "knockout_schedule_match_key" ON "match_knockout_schedule"("match_id");

-- CreateIndex
CREATE UNIQUE INDEX "knockout_schedule_grouping_key" ON "match_knockout_schedule"("grouping_id");

-- CreateIndex
CREATE UNIQUE INDEX "knockout_schedule_id_match_key" ON "match_knockout_schedule"("id", "match_id");

-- CreateIndex
CREATE UNIQUE INDEX "knockout_schedule_grouping_match_key" ON "match_knockout_schedule"("grouping_id", "match_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_qualification_snapshot_group_key" ON "match_group_qualification_snapshot"("group_id");

-- CreateIndex
CREATE INDEX "group_qualification_snapshot_match_idx" ON "match_group_qualification_snapshot"("match_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_qualification_snapshot_id_match_key" ON "match_group_qualification_snapshot"("id", "match_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_qualification_snapshot_identity_key" ON "match_group_qualification_snapshot"("id", "group_id", "match_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_qualification_snapshot_group_match_key" ON "match_group_qualification_snapshot"("group_id", "match_id");

-- CreateIndex
CREATE INDEX "group_qualification_standing_match_idx" ON "match_group_qualification_standing"("match_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_qualification_standing_id_match_key" ON "match_group_qualification_standing"("id", "match_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_qualification_standing_snapshot_entry_key" ON "match_group_qualification_standing"("snapshot_id", "entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "group_qualification_standing_group_rank_key" ON "match_group_qualification_standing"("group_id", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "group_qualification_standing_order_key" ON "match_group_qualification_standing"("match_id", "qualification_order");

-- CreateIndex
CREATE INDEX "fixture_dependency_group_match_idx" ON "match_fixture_dependency"("source_group_id", "match_id");

-- CreateIndex
CREATE UNIQUE INDEX "fixture_dependency_group_rank_key" ON "match_fixture_dependency"("source_group_id", "source_group_rank");

-- AddForeignKey
ALTER TABLE "match_fixture_dependency" ADD CONSTRAINT "fixture_dependency_group_match_fkey" FOREIGN KEY ("source_group_id", "match_id") REFERENCES "match_group"("id", "match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_knockout_schedule" ADD CONSTRAINT "knockout_schedule_match_fkey" FOREIGN KEY ("match_id") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_knockout_schedule" ADD CONSTRAINT "knockout_schedule_grouping_match_fkey" FOREIGN KEY ("grouping_id", "match_id") REFERENCES "MatchGrouping"("id", "matchId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_group_qualification_snapshot" ADD CONSTRAINT "group_qualification_snapshot_match_fkey" FOREIGN KEY ("match_id") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_group_qualification_snapshot" ADD CONSTRAINT "group_qualification_snapshot_group_match_fkey" FOREIGN KEY ("group_id", "match_id") REFERENCES "match_group"("id", "match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_group_qualification_standing" ADD CONSTRAINT "group_qualification_standing_match_fkey" FOREIGN KEY ("match_id") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_group_qualification_standing" ADD CONSTRAINT "group_qualification_standing_snapshot_fkey" FOREIGN KEY ("snapshot_id", "group_id", "match_id") REFERENCES "match_group_qualification_snapshot"("id", "group_id", "match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_group_qualification_standing" ADD CONSTRAINT "group_qualification_standing_group_fkey" FOREIGN KEY ("group_id", "match_id") REFERENCES "match_group"("id", "match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_group_qualification_standing" ADD CONSTRAINT "group_qualification_standing_entry_fkey" FOREIGN KEY ("entry_id", "match_id") REFERENCES "match_entry"("id", "match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_group_qualification_standing" ADD CONSTRAINT "group_qualification_standing_membership_fkey" FOREIGN KEY ("group_id", "entry_id", "match_id") REFERENCES "match_group_entry"("group_id", "entry_id", "match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "match_knockout_schedule" ADD CONSTRAINT "knockout_schedule_policy_check"
CHECK ("schema_version" = 1 AND "bracket_policy_version" = 2 AND "layout_fingerprint" ~ '^[a-f0-9]{64}$');
ALTER TABLE "match_group_qualification_snapshot" ADD CONSTRAINT "group_qualification_snapshot_policy_check"
CHECK ("schema_version" = 1 AND "standings_policy_version" = 1 AND "source_revision_fingerprint" ~ '^[a-f0-9]{64}$');
ALTER TABLE "match_group_qualification_standing" ADD CONSTRAINT "group_qualification_standing_values_check"
CHECK ("rank" >= 1 AND "played" >= 0 AND "wins" >= 0 AND "losses" >= 0
  AND "played" = "wins" + "losses" AND "score_for" >= 0 AND "score_against" >= 0
  AND "score_differential" = "score_for" - "score_against"
  AND "entry_version" >= 0 AND "roster_version" >= 1
  AND (("qualified" AND "qualification_order" IS NOT NULL AND "qualification_order" >= 1 AND "ineligibility_reason" IS NULL)
    OR (NOT "qualified" AND "qualification_order" IS NULL)));

COMMIT;
