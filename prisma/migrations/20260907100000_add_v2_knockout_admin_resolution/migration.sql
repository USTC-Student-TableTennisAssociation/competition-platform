CREATE TYPE "MatchFixtureAdministrativeResolutionKind" AS ENUM ('NO_CONTEST', 'ADMIN_BYE');

CREATE TABLE "match_fixture_administrative_resolution" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "fixture_id" TEXT NOT NULL,
    "kind" "MatchFixtureAdministrativeResolutionKind" NOT NULL,
    "advancing_entry_id" TEXT,
    "advancing_roster_version" INTEGER,
    "resolved_by_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_fixture_administrative_resolution_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fixture_administrative_resolution_reason_check"
      CHECK (char_length(btrim("reason")) BETWEEN 1 AND 500 AND "reason" = btrim("reason")),
    CONSTRAINT "fixture_administrative_resolution_payload_check"
      CHECK (
        ("kind" = 'NO_CONTEST' AND "advancing_entry_id" IS NULL AND "advancing_roster_version" IS NULL)
        OR
        ("kind" = 'ADMIN_BYE' AND "advancing_entry_id" IS NOT NULL AND "advancing_roster_version" >= 1)
      )
);

CREATE UNIQUE INDEX "fixture_administrative_resolution_fixture_key"
  ON "match_fixture_administrative_resolution"("fixture_id");
CREATE UNIQUE INDEX "fixture_administrative_resolution_identity_key"
  ON "match_fixture_administrative_resolution"("id", "fixture_id", "match_id");
CREATE UNIQUE INDEX "fixture_administrative_resolution_fixture_match_key"
  ON "match_fixture_administrative_resolution"("fixture_id", "match_id");
CREATE INDEX "fixture_administrative_resolution_match_kind_idx"
  ON "match_fixture_administrative_resolution"("match_id", "kind");
CREATE INDEX "fixture_administrative_resolution_advancing_entry_idx"
  ON "match_fixture_administrative_resolution"("advancing_entry_id");
CREATE INDEX "fixture_administrative_resolution_resolved_by_idx"
  ON "match_fixture_administrative_resolution"("resolved_by_id");

ALTER TABLE "match_fixture_administrative_resolution"
  ADD CONSTRAINT "fixture_administrative_resolution_match_fkey"
  FOREIGN KEY ("match_id") REFERENCES "Match"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "match_fixture_administrative_resolution"
  ADD CONSTRAINT "fixture_administrative_resolution_fixture_match_fkey"
  FOREIGN KEY ("fixture_id", "match_id") REFERENCES "match_fixture"("id", "match_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "match_fixture_administrative_resolution"
  ADD CONSTRAINT "fixture_administrative_resolution_advancing_entry_fkey"
  FOREIGN KEY ("advancing_entry_id", "match_id") REFERENCES "match_entry"("id", "match_id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "match_fixture_administrative_resolution"
  ADD CONSTRAINT "fixture_administrative_resolution_resolved_by_fkey"
  FOREIGN KEY ("resolved_by_id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
