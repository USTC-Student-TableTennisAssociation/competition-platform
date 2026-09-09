-- Keep every doubles/team source edge inside one Match. This replaces four
-- single-column foreign keys with composite same-match constraints; no data or
-- columns are removed.

BEGIN;

ALTER TABLE "match_team"
ADD CONSTRAINT "match_team_id_match_id_key" UNIQUE ("id", "match_id");

ALTER TABLE "match_doubles_team"
ADD CONSTRAINT "match_doubles_team_id_match_id_key" UNIQUE ("id", "match_id");

ALTER TABLE "match_team_member"
DROP CONSTRAINT "match_team_member_team_id_fkey",
ADD CONSTRAINT "match_team_member_team_id_match_id_fkey"
FOREIGN KEY ("team_id", "match_id")
REFERENCES "match_team"("id", "match_id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "match_doubles_team_member"
DROP CONSTRAINT "match_doubles_team_member_team_id_fkey",
ADD CONSTRAINT "match_doubles_team_member_team_id_match_id_fkey"
FOREIGN KEY ("team_id", "match_id")
REFERENCES "match_doubles_team"("id", "match_id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "match_entry"
DROP CONSTRAINT "match_entry_source_doubles_team_id_fkey",
ADD CONSTRAINT "match_entry_source_doubles_team_id_fkey"
FOREIGN KEY ("source_doubles_team_id", "match_id")
REFERENCES "match_doubles_team"("id", "match_id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "match_entry"
DROP CONSTRAINT "match_entry_source_match_team_id_fkey",
ADD CONSTRAINT "match_entry_source_match_team_id_fkey"
FOREIGN KEY ("source_match_team_id", "match_id")
REFERENCES "match_team"("id", "match_id")
ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
