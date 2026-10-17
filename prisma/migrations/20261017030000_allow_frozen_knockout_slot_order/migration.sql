-- Preserve every existing bracket; allow an explicitly frozen slot permutation.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "match_knockout_schedule" DROP CONSTRAINT "knockout_schedule_policy_check";
ALTER TABLE "match_knockout_schedule" ADD CONSTRAINT "knockout_schedule_policy_check"
CHECK ("schema_version" = 1 AND "bracket_policy_version" IN (2, 3) AND "layout_fingerprint" ~ '^[a-f0-9]{64}$');
COMMIT;
