-- V2 competition core (expand phase only).
-- This migration deliberately does not backfill V2 rows or switch any Match to V2.

BEGIN;

-- CreateEnum
CREATE TYPE "MatchEngineVersion" AS ENUM ('LEGACY', 'V2');

-- CreateEnum
CREATE TYPE "MatchEntryKind" AS ENUM ('INDIVIDUAL', 'DOUBLES', 'TEAM');

-- CreateEnum
CREATE TYPE "MatchEntryStatus" AS ENUM ('DRAFT', 'ACTIVE', 'WITHDRAWN', 'DISQUALIFIED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MatchEntryMemberStatus" AS ENUM ('ACTIVE', 'WITHDRAWN', 'REMOVED', 'DISQUALIFIED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "MatchFixtureStage" AS ENUM ('GROUP', 'KNOCKOUT', 'FREE_PLAY');

-- CreateEnum
CREATE TYPE "MatchFixtureStatus" AS ENUM ('SCHEDULED', 'READY', 'COMPLETED', 'VOIDED');

-- CreateEnum
CREATE TYPE "MatchFixtureSide" AS ENUM ('SIDE_A', 'SIDE_B');

-- CreateEnum
CREATE TYPE "MatchFixtureOutcome" AS ENUM ('WINNER', 'LOSER');

-- CreateEnum
CREATE TYPE "ResultRevisionStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED', 'VOIDED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "SettlementEventKind" AS ENUM ('RESULT_APPLY', 'RESULT_REVERSAL', 'REGISTRATION_APPLY', 'REGISTRATION_REVERSAL');

-- CreateEnum
CREATE TYPE "SettlementEventStatus" AS ENUM ('PENDING', 'APPLIED', 'REVERSED', 'FAILED');

-- AlterTable
-- The default preserves every existing match as LEGACY without a separate backfill.
ALTER TABLE "Match"
ADD COLUMN "engine_version" "MatchEngineVersion" NOT NULL DEFAULT 'LEGACY';

-- CreateTable
CREATE TABLE "match_entry" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "kind" "MatchEntryKind" NOT NULL,
    "status" "MatchEntryStatus" NOT NULL DEFAULT 'DRAFT',
    "source_key" TEXT NOT NULL,
    "source_user_id" TEXT,
    "source_doubles_team_id" TEXT,
    "source_match_team_id" TEXT,
    "display_name_snapshot" TEXT NOT NULL,
    "seed" INTEGER,
    "withdrawn_at" TIMESTAMP(3),
    "disqualified_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "match_entry_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "match_entry_version_check" CHECK ("version" >= 0),
    CONSTRAINT "match_entry_source_key_check" CHECK (
        ("kind" = 'INDIVIDUAL' AND "source_key" LIKE 'individual:%' AND length("source_key") > length('individual:'))
        OR ("kind" = 'DOUBLES' AND "source_key" LIKE 'doubles:%' AND length("source_key") > length('doubles:'))
        OR ("kind" = 'TEAM' AND "source_key" LIKE 'team:%' AND length("source_key") > length('team:'))
    ),
    CONSTRAINT "match_entry_source_kind_check" CHECK (
        num_nonnulls("source_user_id", "source_doubles_team_id", "source_match_team_id") <= 1
        AND ("source_user_id" IS NULL OR "kind" = 'INDIVIDUAL')
        AND ("source_doubles_team_id" IS NULL OR "kind" = 'DOUBLES')
        AND ("source_match_team_id" IS NULL OR "kind" = 'TEAM')
        AND ("source_user_id" IS NULL OR "source_key" = 'individual:' || "source_user_id")
        AND ("source_doubles_team_id" IS NULL OR "source_key" = 'doubles:' || "source_doubles_team_id")
        AND ("source_match_team_id" IS NULL OR "source_key" = 'team:' || "source_match_team_id")
    )
);

-- CreateTable
CREATE TABLE "match_entry_member" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "display_name_snapshot" TEXT NOT NULL,
    "role" "RegistrationRole" NOT NULL DEFAULT 'player',
    "status" "MatchEntryMemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "slot" INTEGER NOT NULL,
    "roster_version" INTEGER NOT NULL DEFAULT 1,
    "effective_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_until" TIMESTAMP(3),
    "end_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_entry_member_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "match_entry_member_slot_check" CHECK ("slot" >= 1),
    CONSTRAINT "match_entry_member_roster_version_check" CHECK ("roster_version" >= 1),
    CONSTRAINT "match_entry_member_effective_range_check" CHECK (
        "effective_until" IS NULL OR "effective_until" >= "effective_from"
    ),
    CONSTRAINT "match_entry_member_status_range_check" CHECK (
        ("status" = 'ACTIVE' AND "effective_until" IS NULL)
        OR ("status" <> 'ACTIVE' AND "effective_until" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "match_fixture" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "fixture_key" TEXT NOT NULL,
    "stage" "MatchFixtureStage" NOT NULL,
    "status" "MatchFixtureStatus" NOT NULL DEFAULT 'SCHEDULED',
    "group_key" TEXT,
    "round_number" INTEGER,
    "position" INTEGER,
    "side_a_entry_id" TEXT,
    "side_b_entry_id" TEXT,
    "side_a_roster_version" INTEGER,
    "side_b_roster_version" INTEGER,
    "scheduled_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "match_fixture_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "match_fixture_key_check" CHECK (btrim("fixture_key") <> ''),
    CONSTRAINT "match_fixture_version_check" CHECK ("version" >= 0),
    CONSTRAINT "match_fixture_round_number_check" CHECK ("round_number" IS NULL OR "round_number" >= 1),
    CONSTRAINT "match_fixture_position_check" CHECK ("position" IS NULL OR "position" >= 1),
    CONSTRAINT "match_fixture_distinct_sides_check" CHECK (
        "side_a_entry_id" IS NULL OR "side_b_entry_id" IS NULL OR "side_a_entry_id" <> "side_b_entry_id"
    ),
    CONSTRAINT "match_fixture_side_a_roster_check" CHECK (
        (("side_a_entry_id" IS NULL) = ("side_a_roster_version" IS NULL))
        AND ("side_a_roster_version" IS NULL OR "side_a_roster_version" >= 1)
    ),
    CONSTRAINT "match_fixture_side_b_roster_check" CHECK (
        (("side_b_entry_id" IS NULL) = ("side_b_roster_version" IS NULL))
        AND ("side_b_roster_version" IS NULL OR "side_b_roster_version" >= 1)
    ),
    CONSTRAINT "match_fixture_stage_fields_check" CHECK (
        ("stage" = 'GROUP' AND "group_key" IS NOT NULL AND btrim("group_key") <> '')
        OR ("stage" = 'KNOCKOUT' AND "round_number" IS NOT NULL AND "position" IS NOT NULL)
        OR "stage" = 'FREE_PLAY'
    ),
    CONSTRAINT "match_fixture_ready_sides_check" CHECK (
        "status" NOT IN ('READY', 'COMPLETED')
        OR ("side_a_entry_id" IS NOT NULL AND "side_b_entry_id" IS NOT NULL)
    ),
    CONSTRAINT "match_fixture_completed_at_check" CHECK (
        "status" <> 'COMPLETED' OR "completed_at" IS NOT NULL
    )
);

-- CreateTable
CREATE TABLE "match_fixture_lineup_member" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "fixture_id" TEXT NOT NULL,
    "entry_id" TEXT NOT NULL,
    "entry_member_id" TEXT NOT NULL,
    "side" "MatchFixtureSide" NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_fixture_lineup_member_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fixture_lineup_position_check" CHECK ("position" >= 1)
);

-- CreateTable
CREATE TABLE "match_fixture_dependency" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "source_fixture_id" TEXT NOT NULL,
    "source_outcome" "MatchFixtureOutcome" NOT NULL DEFAULT 'WINNER',
    "target_fixture_id" TEXT NOT NULL,
    "target_side" "MatchFixtureSide" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_fixture_dependency_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fixture_dependency_distinct_fixture_check" CHECK ("source_fixture_id" <> "target_fixture_id")
);

-- CreateTable
CREATE TABLE "result_revision" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "fixture_id" TEXT NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "status" "ResultRevisionStatus" NOT NULL DEFAULT 'PENDING',
    "winner_entry_id" TEXT,
    "loser_entry_id" TEXT,
    "score" JSONB NOT NULL,
    "reported_by_id" TEXT NOT NULL,
    "verified_by_id" TEXT,
    "supersedes_revision_id" TEXT,
    "reason" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "result_revision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "result_revision_number_check" CHECK ("revision_number" >= 1),
    CONSTRAINT "result_revision_not_self_supersession_check" CHECK (
        "supersedes_revision_id" IS NULL OR "supersedes_revision_id" <> "id"
    ),
    CONSTRAINT "result_revision_participants_check" CHECK (
        (("winner_entry_id" IS NULL) = ("loser_entry_id" IS NULL))
        AND ("winner_entry_id" IS NULL OR "winner_entry_id" <> "loser_entry_id")
        AND ("status" = 'VOIDED' OR "winner_entry_id" IS NOT NULL)
    ),
    CONSTRAINT "result_revision_resolution_check" CHECK (
        ("status" = 'PENDING' AND "resolved_at" IS NULL)
        OR ("status" <> 'PENDING' AND "resolved_at" IS NOT NULL)
    ),
    CONSTRAINT "result_revision_verifier_check" CHECK (
        "status" NOT IN ('CONFIRMED', 'SUPERSEDED') OR "verified_by_id" IS NOT NULL
    )
);

-- CreateTable
CREATE TABLE "settlement_event" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "kind" "SettlementEventKind" NOT NULL,
    "status" "SettlementEventStatus" NOT NULL DEFAULT 'PENDING',
    "result_revision_id" TEXT,
    "match_entry_id" TEXT,
    "reverses_event_id" TEXT,
    "metadata" JSONB,
    "failure_reason" TEXT,
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "settlement_event_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "settlement_event_idempotency_key_check" CHECK (btrim("idempotency_key") <> ''),
    CONSTRAINT "settlement_event_subject_check" CHECK (
        ("kind" IN ('RESULT_APPLY', 'RESULT_REVERSAL') AND "result_revision_id" IS NOT NULL AND "match_entry_id" IS NULL)
        OR
        ("kind" IN ('REGISTRATION_APPLY', 'REGISTRATION_REVERSAL') AND "result_revision_id" IS NULL AND "match_entry_id" IS NOT NULL)
    ),
    CONSTRAINT "settlement_event_kind_links_check" CHECK (
        ("kind" IN ('RESULT_APPLY', 'REGISTRATION_APPLY') AND "reverses_event_id" IS NULL)
        OR
        ("kind" IN ('RESULT_REVERSAL', 'REGISTRATION_REVERSAL') AND "reverses_event_id" IS NOT NULL)
    ),
    CONSTRAINT "settlement_event_not_self_reversal_check" CHECK (
        "reverses_event_id" IS NULL OR "reverses_event_id" <> "id"
    ),
    CONSTRAINT "settlement_event_applied_at_check" CHECK (
        "status" NOT IN ('APPLIED', 'REVERSED') OR "applied_at" IS NOT NULL
    )
);

-- CreateTable
CREATE TABLE "settlement_effect" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "elo_before" INTEGER,
    "elo_after" INTEGER,
    "elo_delta" INTEGER,
    "points_before" INTEGER,
    "points_after" INTEGER,
    "points_delta" INTEGER,
    "wins_delta" INTEGER NOT NULL DEFAULT 0,
    "losses_delta" INTEGER NOT NULL DEFAULT 0,
    "matches_played_delta" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_effect_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "settlement_effect_elo_triplet_check" CHECK (
        ("elo_before" IS NULL AND "elo_after" IS NULL AND "elo_delta" IS NULL)
        OR
        ("elo_before" IS NOT NULL AND "elo_after" IS NOT NULL AND "elo_delta" IS NOT NULL
            AND "elo_after" - "elo_before" = "elo_delta")
    ),
    CONSTRAINT "settlement_effect_points_triplet_check" CHECK (
        ("points_before" IS NULL AND "points_after" IS NULL AND "points_delta" IS NULL)
        OR
        ("points_before" IS NOT NULL AND "points_after" IS NOT NULL AND "points_delta" IS NOT NULL
            AND "points_after" - "points_before" = "points_delta")
    ),
    CONSTRAINT "settlement_effect_match_stats_check" CHECK (
        "matches_played_delta" = "wins_delta" + "losses_delta"
    )
);

-- CreateIndex
CREATE UNIQUE INDEX "match_entry_id_match_id_key" ON "match_entry"("id", "match_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_entry_match_id_source_key_key" ON "match_entry"("match_id", "source_key");

-- CreateIndex
CREATE UNIQUE INDEX "match_entry_match_source_user_key" ON "match_entry"("match_id", "source_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_entry_match_source_doubles_key" ON "match_entry"("match_id", "source_doubles_team_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_entry_match_source_team_key" ON "match_entry"("match_id", "source_match_team_id");

-- CreateIndex
CREATE INDEX "match_entry_match_id_status_idx" ON "match_entry"("match_id", "status");

-- CreateIndex
CREATE INDEX "match_entry_source_user_id_idx" ON "match_entry"("source_user_id");

-- CreateIndex
CREATE INDEX "match_entry_source_doubles_team_id_idx" ON "match_entry"("source_doubles_team_id");

-- CreateIndex
CREATE INDEX "match_entry_source_match_team_id_idx" ON "match_entry"("source_match_team_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_entry_member_identity_key" ON "match_entry_member"("id", "entry_id", "match_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_entry_member_roster_slot_key" ON "match_entry_member"("entry_id", "roster_version", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "match_entry_member_roster_user_key" ON "match_entry_member"("entry_id", "roster_version", "user_id");

-- At most one live competition identity per user in a match. Historical roster
-- versions remain available after their membership interval has closed.
CREATE UNIQUE INDEX "match_entry_member_one_active_per_match_user_key"
ON "match_entry_member"("match_id", "user_id")
WHERE "status" = 'ACTIVE' AND "effective_until" IS NULL;

-- CreateIndex
CREATE INDEX "match_entry_member_match_user_idx" ON "match_entry_member"("match_id", "user_id");

-- CreateIndex
CREATE INDEX "match_entry_member_user_id_idx" ON "match_entry_member"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_fixture_id_match_id_key" ON "match_fixture"("id", "match_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_fixture_match_id_fixture_key_key" ON "match_fixture"("match_id", "fixture_key");

-- CreateIndex
CREATE INDEX "match_fixture_match_stage_status_idx" ON "match_fixture"("match_id", "stage", "status");

-- CreateIndex
CREATE INDEX "match_fixture_side_a_entry_idx" ON "match_fixture"("side_a_entry_id");

-- CreateIndex
CREATE INDEX "match_fixture_side_b_entry_idx" ON "match_fixture"("side_b_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "fixture_lineup_fixture_side_position_key" ON "match_fixture_lineup_member"("fixture_id", "side", "position");

-- CreateIndex
CREATE UNIQUE INDEX "fixture_lineup_fixture_member_key" ON "match_fixture_lineup_member"("fixture_id", "entry_member_id");

-- CreateIndex
CREATE INDEX "fixture_lineup_entry_id_idx" ON "match_fixture_lineup_member"("entry_id");

-- CreateIndex
CREATE INDEX "fixture_lineup_entry_member_idx" ON "match_fixture_lineup_member"("entry_member_id", "entry_id", "match_id");

-- CreateIndex
CREATE UNIQUE INDEX "fixture_dependency_target_side_key" ON "match_fixture_dependency"("target_fixture_id", "target_side");

-- CreateIndex
CREATE UNIQUE INDEX "fixture_dependency_source_outcome_key" ON "match_fixture_dependency"("source_fixture_id", "source_outcome");

-- CreateIndex
CREATE INDEX "fixture_dependency_match_id_idx" ON "match_fixture_dependency"("match_id");

-- CreateIndex
CREATE UNIQUE INDEX "result_revision_fixture_revision_key" ON "result_revision"("fixture_id", "revision_number");

-- CreateIndex
CREATE UNIQUE INDEX "result_revision_identity_key" ON "result_revision"("id", "fixture_id", "match_id");

-- CreateIndex
CREATE INDEX "result_revision_supersedes_identity_idx" ON "result_revision"("supersedes_revision_id", "fixture_id", "match_id");

-- A correction may coexist with the currently confirmed revision while pending,
-- but each fixture can have only one of each authoritative in-flight state.
CREATE UNIQUE INDEX "result_revision_one_pending_per_fixture_key"
ON "result_revision"("fixture_id") WHERE "status" = 'PENDING';

CREATE UNIQUE INDEX "result_revision_one_confirmed_per_fixture_key"
ON "result_revision"("fixture_id") WHERE "status" = 'CONFIRMED';

-- CreateIndex
CREATE INDEX "result_revision_fixture_status_idx" ON "result_revision"("fixture_id", "status");

-- CreateIndex
CREATE INDEX "result_revision_reported_by_idx" ON "result_revision"("reported_by_id");

-- CreateIndex
CREATE INDEX "result_revision_verified_by_idx" ON "result_revision"("verified_by_id");

-- CreateIndex
CREATE INDEX "result_revision_winner_entry_idx" ON "result_revision"("winner_entry_id");

-- CreateIndex
CREATE INDEX "result_revision_loser_entry_idx" ON "result_revision"("loser_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_event_idempotency_key" ON "settlement_event"("idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_event_revision_kind_key" ON "settlement_event"("result_revision_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_event_reverses_event_id_key" ON "settlement_event"("reverses_event_id");

-- CreateIndex
CREATE INDEX "settlement_event_match_entry_id_idx" ON "settlement_event"("match_entry_id");

-- CreateIndex
CREATE INDEX "settlement_event_status_created_idx" ON "settlement_event"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_effect_event_user_key" ON "settlement_effect"("event_id", "user_id");

-- CreateIndex
CREATE INDEX "settlement_effect_user_created_idx" ON "settlement_effect"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "match_entry" ADD CONSTRAINT "match_entry_match_id_fkey"
FOREIGN KEY ("match_id") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_entry" ADD CONSTRAINT "match_entry_source_user_id_fkey"
FOREIGN KEY ("source_user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_entry" ADD CONSTRAINT "match_entry_source_doubles_team_id_fkey"
FOREIGN KEY ("source_doubles_team_id") REFERENCES "match_doubles_team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_entry" ADD CONSTRAINT "match_entry_source_match_team_id_fkey"
FOREIGN KEY ("source_match_team_id") REFERENCES "match_team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_entry_member" ADD CONSTRAINT "match_entry_member_match_id_fkey"
FOREIGN KEY ("match_id") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_entry_member" ADD CONSTRAINT "match_entry_member_entry_match_fkey"
FOREIGN KEY ("entry_id", "match_id") REFERENCES "match_entry"("id", "match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_entry_member" ADD CONSTRAINT "match_entry_member_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_fixture" ADD CONSTRAINT "match_fixture_match_id_fkey"
FOREIGN KEY ("match_id") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_fixture" ADD CONSTRAINT "match_fixture_side_a_entry_fkey"
FOREIGN KEY ("side_a_entry_id", "match_id") REFERENCES "match_entry"("id", "match_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_fixture" ADD CONSTRAINT "match_fixture_side_b_entry_fkey"
FOREIGN KEY ("side_b_entry_id", "match_id") REFERENCES "match_entry"("id", "match_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_fixture_lineup_member" ADD CONSTRAINT "fixture_lineup_fixture_match_fkey"
FOREIGN KEY ("fixture_id", "match_id") REFERENCES "match_fixture"("id", "match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_fixture_lineup_member" ADD CONSTRAINT "fixture_lineup_entry_match_fkey"
FOREIGN KEY ("entry_id", "match_id") REFERENCES "match_entry"("id", "match_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_fixture_lineup_member" ADD CONSTRAINT "fixture_lineup_entry_member_fkey"
FOREIGN KEY ("entry_member_id", "entry_id", "match_id") REFERENCES "match_entry_member"("id", "entry_id", "match_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_fixture_dependency" ADD CONSTRAINT "fixture_dependency_source_match_fkey"
FOREIGN KEY ("source_fixture_id", "match_id") REFERENCES "match_fixture"("id", "match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_fixture_dependency" ADD CONSTRAINT "fixture_dependency_target_match_fkey"
FOREIGN KEY ("target_fixture_id", "match_id") REFERENCES "match_fixture"("id", "match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_revision" ADD CONSTRAINT "result_revision_fixture_match_fkey"
FOREIGN KEY ("fixture_id", "match_id") REFERENCES "match_fixture"("id", "match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_revision" ADD CONSTRAINT "result_revision_winner_entry_fkey"
FOREIGN KEY ("winner_entry_id", "match_id") REFERENCES "match_entry"("id", "match_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_revision" ADD CONSTRAINT "result_revision_loser_entry_fkey"
FOREIGN KEY ("loser_entry_id", "match_id") REFERENCES "match_entry"("id", "match_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_revision" ADD CONSTRAINT "result_revision_reported_by_fkey"
FOREIGN KEY ("reported_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_revision" ADD CONSTRAINT "result_revision_verified_by_fkey"
FOREIGN KEY ("verified_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "result_revision" ADD CONSTRAINT "result_revision_supersedes_fkey"
FOREIGN KEY ("supersedes_revision_id", "fixture_id", "match_id") REFERENCES "result_revision"("id", "fixture_id", "match_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_event" ADD CONSTRAINT "settlement_event_result_revision_fkey"
FOREIGN KEY ("result_revision_id") REFERENCES "result_revision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_event" ADD CONSTRAINT "settlement_event_match_entry_fkey"
FOREIGN KEY ("match_entry_id") REFERENCES "match_entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_event" ADD CONSTRAINT "settlement_event_reverses_fkey"
FOREIGN KEY ("reverses_event_id") REFERENCES "settlement_event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_effect" ADD CONSTRAINT "settlement_effect_event_id_fkey"
FOREIGN KEY ("event_id") REFERENCES "settlement_event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_effect" ADD CONSTRAINT "settlement_effect_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
