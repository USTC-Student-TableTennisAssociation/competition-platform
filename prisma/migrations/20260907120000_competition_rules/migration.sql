BEGIN;
ALTER TABLE "Match"
  ADD COLUMN "group_best_of" INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN "knockout_best_of" INTEGER NOT NULL DEFAULT 5,
  ADD CONSTRAINT "match_group_best_of_check" CHECK ("group_best_of" IN (3, 5, 7)),
  ADD CONSTRAINT "match_knockout_best_of_check" CHECK ("knockout_best_of" IN (3, 5, 7));
ALTER TABLE "match_fixture"
  ADD COLUMN "best_of" INTEGER NOT NULL DEFAULT 5,
  ADD CONSTRAINT "fixture_best_of_check" CHECK ("best_of" IN (3, 5, 7));
-- Preserve the declared rules of pre-release fixtures with recorded results.
UPDATE "match_fixture" AS fixture SET "best_of" = score."bestOf"
FROM (
  SELECT DISTINCT ON ("fixture_id") "fixture_id", ("score"->>'bestOf')::integer AS "bestOf"
  FROM "result_revision"
  WHERE "resolution_kind" = 'PLAYED' AND "score"->>'bestOf' IN ('3', '5', '7')
  ORDER BY "fixture_id", "revision_number" DESC
) AS score WHERE fixture."id" = score."fixture_id";
COMMIT;
