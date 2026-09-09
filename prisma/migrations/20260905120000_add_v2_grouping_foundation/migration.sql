-- Relational V2 grouping and qualification foundation (expand phase only).
-- Existing Legacy/V2 rows remain valid: grouping metadata and Fixture.group_id
-- are nullable, while historical result revisions become PLAYED by default.

BEGIN;

-- CreateEnum
CREATE TYPE "MatchGroupingSeedMethod" AS ENUM ('MIN_DIFF', 'SNAKE');

-- CreateEnum
CREATE TYPE "ResultResolutionKind" AS ENUM ('PLAYED', 'FORFEIT');

-- AlterTable
ALTER TABLE "MatchGrouping"
ADD COLUMN "v2_schema_version" INTEGER,
ADD COLUMN "seed_method" "MatchGroupingSeedMethod",
ADD COLUMN "standings_policy_version" INTEGER,
ADD COLUMN "qualifiers_per_group" INTEGER,
ADD COLUMN "bracket_policy_version" INTEGER,
ADD CONSTRAINT "match_grouping_v2_version_check" CHECK (
    ("v2_schema_version" IS NULL OR "v2_schema_version" >= 1)
    AND ("standings_policy_version" IS NULL OR "standings_policy_version" >= 1)
    AND ("qualifiers_per_group" IS NULL OR "qualifiers_per_group" >= 1)
    AND ("bracket_policy_version" IS NULL OR "bracket_policy_version" >= 1)
),
ADD CONSTRAINT "match_grouping_v2_field_set_check" CHECK (
    num_nonnulls(
        "v2_schema_version",
        "seed_method",
        "standings_policy_version",
        "qualifiers_per_group",
        "bracket_policy_version"
    ) = 0
    OR (
        "v2_schema_version" IS NOT NULL
        AND "seed_method" IS NOT NULL
        AND "standings_policy_version" IS NOT NULL
        AND (
            ("qualifiers_per_group" IS NULL AND "bracket_policy_version" IS NULL)
            OR
            ("qualifiers_per_group" IS NOT NULL AND "bracket_policy_version" IS NOT NULL)
        )
    )
);

-- AlterTable
ALTER TABLE "match_fixture"
ADD COLUMN "group_id" TEXT,
ADD CONSTRAINT "match_fixture_group_stage_check" CHECK (
    "group_id" IS NULL OR "stage" = 'GROUP'
);

-- AlterTable
-- The default classifies all existing played-result history without a backfill.
ALTER TABLE "result_revision"
ADD COLUMN "resolution_kind" "ResultResolutionKind" NOT NULL DEFAULT 'PLAYED';

-- CreateTable
CREATE TABLE "match_group" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "grouping_id" TEXT NOT NULL,
    "group_key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_group_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "match_group_key_check" CHECK (btrim("group_key") <> ''),
    CONSTRAINT "match_group_display_name_check" CHECK (btrim("display_name") <> ''),
    CONSTRAINT "match_group_position_check" CHECK ("position" >= 1)
);

-- CreateTable
CREATE TABLE "match_group_entry" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "global_seed_rank" INTEGER NOT NULL,
    "seed_elo" INTEGER NOT NULL,
    "seed_points" INTEGER NOT NULL,
    "entry_version" INTEGER NOT NULL,
    "roster_version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_group_entry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "match_group_entry_position_check" CHECK ("position" >= 1),
    CONSTRAINT "match_group_entry_global_seed_rank_check" CHECK ("global_seed_rank" >= 1),
    CONSTRAINT "match_group_entry_seed_points_check" CHECK ("seed_points" >= 0),
    CONSTRAINT "match_group_entry_entry_version_check" CHECK ("entry_version" >= 0),
    CONSTRAINT "match_group_entry_roster_version_check" CHECK ("roster_version" >= 1)
);

-- CreateTable
CREATE TABLE "match_qualification_snapshot" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "grouping_id" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "standings_policy_version" INTEGER NOT NULL,
    "source_revision_fingerprint" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_qualification_snapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "match_qualification_snapshot_schema_version_check" CHECK ("schema_version" >= 1),
    CONSTRAINT "match_qualification_snapshot_policy_version_check" CHECK ("standings_policy_version" >= 1),
    CONSTRAINT "match_qualification_snapshot_fingerprint_check" CHECK (
        btrim("source_revision_fingerprint") <> ''
    )
);

-- CreateTable
CREATE TABLE "match_qualification_standing" (
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
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_qualification_standing_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "match_qualification_standing_rank_check" CHECK ("rank" >= 1),
    CONSTRAINT "match_qualification_standing_record_check" CHECK (
        "played" >= 0
        AND "wins" >= 0
        AND "losses" >= 0
        AND "played" = "wins" + "losses"
    ),
    CONSTRAINT "match_qualification_standing_score_check" CHECK (
        "score_for" >= 0
        AND "score_against" >= 0
        AND "score_differential" = "score_for" - "score_against"
    ),
    CONSTRAINT "match_qualification_standing_order_check" CHECK (
        "qualification_order" IS NULL OR "qualification_order" >= 1
    ),
    CONSTRAINT "match_qualification_standing_reason_check" CHECK (
        "ineligibility_reason" IS NULL OR btrim("ineligibility_reason") <> ''
    ),
    CONSTRAINT "match_qualification_standing_decision_check" CHECK (
        (
            "qualified" = TRUE
            AND "qualification_order" IS NOT NULL
            AND "ineligibility_reason" IS NULL
        )
        OR
        (
            "qualified" = FALSE
            AND "qualification_order" IS NULL
        )
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "match_grouping_id_match_id_key"
ON "MatchGrouping"("id", "matchId");

-- CreateIndex
CREATE UNIQUE INDEX "match_group_id_match_id_key"
ON "match_group"("id", "match_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_group_grouping_key_key"
ON "match_group"("grouping_id", "group_key");

-- CreateIndex
CREATE UNIQUE INDEX "match_group_grouping_position_key"
ON "match_group"("grouping_id", "position");

-- CreateIndex
CREATE INDEX "match_group_match_id_idx" ON "match_group"("match_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_group_entry_id_match_id_key"
ON "match_group_entry"("id", "match_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_group_entry_group_entry_key"
ON "match_group_entry"("group_id", "entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_group_entry_membership_identity_key"
ON "match_group_entry"("group_id", "entry_id", "match_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_group_entry_group_position_key"
ON "match_group_entry"("group_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "match_group_entry_match_entry_key"
ON "match_group_entry"("match_id", "entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_group_entry_match_seed_rank_key"
ON "match_group_entry"("match_id", "global_seed_rank");

-- CreateIndex
CREATE INDEX "match_group_entry_entry_id_idx"
ON "match_group_entry"("entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_qualification_snapshot_grouping_id_key"
ON "match_qualification_snapshot"("grouping_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_qualification_snapshot_id_match_id_key"
ON "match_qualification_snapshot"("id", "match_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_qualification_snapshot_grouping_match_key"
ON "match_qualification_snapshot"("grouping_id", "match_id");

-- CreateIndex
CREATE INDEX "match_qualification_snapshot_match_id_idx"
ON "match_qualification_snapshot"("match_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_qualification_standing_id_match_id_key"
ON "match_qualification_standing"("id", "match_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_qualification_standing_snapshot_membership_key"
ON "match_qualification_standing"("snapshot_id", "group_id", "entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_qualification_standing_snapshot_entry_key"
ON "match_qualification_standing"("snapshot_id", "entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_qualification_standing_snapshot_group_rank_key"
ON "match_qualification_standing"("snapshot_id", "group_id", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "match_qualification_standing_snapshot_order_key"
ON "match_qualification_standing"("snapshot_id", "qualification_order");

-- CreateIndex
CREATE INDEX "match_qualification_standing_match_id_idx"
ON "match_qualification_standing"("match_id");

-- CreateIndex
CREATE INDEX "match_qualification_standing_membership_idx"
ON "match_qualification_standing"("group_id", "entry_id", "match_id");

-- CreateIndex
CREATE INDEX "match_qualification_standing_entry_id_idx"
ON "match_qualification_standing"("entry_id");

-- CreateIndex
CREATE INDEX "match_fixture_group_match_idx"
ON "match_fixture"("group_id", "match_id");

-- AddForeignKey
ALTER TABLE "match_group" ADD CONSTRAINT "match_group_match_id_fkey"
FOREIGN KEY ("match_id") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_group" ADD CONSTRAINT "match_group_grouping_match_fkey"
FOREIGN KEY ("grouping_id", "match_id") REFERENCES "MatchGrouping"("id", "matchId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_group_entry" ADD CONSTRAINT "match_group_entry_match_id_fkey"
FOREIGN KEY ("match_id") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_group_entry" ADD CONSTRAINT "match_group_entry_group_match_fkey"
FOREIGN KEY ("group_id", "match_id") REFERENCES "match_group"("id", "match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_group_entry" ADD CONSTRAINT "match_group_entry_entry_match_fkey"
FOREIGN KEY ("entry_id", "match_id") REFERENCES "match_entry"("id", "match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_qualification_snapshot" ADD CONSTRAINT "match_qualification_snapshot_match_id_fkey"
FOREIGN KEY ("match_id") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_qualification_snapshot" ADD CONSTRAINT "match_qualification_snapshot_grouping_match_fkey"
FOREIGN KEY ("grouping_id", "match_id") REFERENCES "MatchGrouping"("id", "matchId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_qualification_standing" ADD CONSTRAINT "match_qualification_standing_match_id_fkey"
FOREIGN KEY ("match_id") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_qualification_standing" ADD CONSTRAINT "match_qualification_standing_snapshot_match_fkey"
FOREIGN KEY ("snapshot_id", "match_id") REFERENCES "match_qualification_snapshot"("id", "match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_qualification_standing" ADD CONSTRAINT "match_qualification_standing_group_match_fkey"
FOREIGN KEY ("group_id", "match_id") REFERENCES "match_group"("id", "match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_qualification_standing" ADD CONSTRAINT "match_qualification_standing_entry_match_fkey"
FOREIGN KEY ("entry_id", "match_id") REFERENCES "match_entry"("id", "match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_qualification_standing" ADD CONSTRAINT "match_qualification_standing_membership_fkey"
FOREIGN KEY ("group_id", "entry_id", "match_id") REFERENCES "match_group_entry"("group_id", "entry_id", "match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_fixture" ADD CONSTRAINT "match_fixture_group_match_fkey"
FOREIGN KEY ("group_id", "match_id") REFERENCES "match_group"("id", "match_id") ON DELETE NO ACTION ON UPDATE CASCADE;

COMMIT;
