BEGIN;
-- Formal LEGACY competitions are historical, regardless of stale lifecycle flags.
-- Quick matches and all personal aggregates/ledgers retain their existing values.
UPDATE "Match" SET "status" = 'finished'
WHERE "engine_version" = 'LEGACY' AND "isQuickMatch" = false;

-- Keep anomalous reports referenced by a ledger as internal evidence; readers
-- expose only confirmed results. No ledger or its foreign key is rewritten.
DELETE FROM "MatchResult" AS result USING "Match" AS match
WHERE result."matchId" = match."id" AND match."engine_version" = 'LEGACY'
  AND match."isQuickMatch" = false AND result."confirmed" = false
  AND NOT EXISTS (SELECT 1 FROM "EloHistory" WHERE "matchResultId" = result."id")
  AND NOT EXISTS (SELECT 1 FROM "PointsTransaction" WHERE "referenceId" = result."id");

DELETE FROM "MatchGrouping" AS grouping USING "Match" AS match
WHERE grouping."matchId" = match."id" AND match."engine_version" = 'LEGACY'
  AND match."isQuickMatch" = false;
DELETE FROM "match_doubles_invite" AS invite USING "Match" AS match
WHERE invite."match_id" = match."id" AND match."engine_version" = 'LEGACY'
  AND match."isQuickMatch" = false;
COMMIT;
