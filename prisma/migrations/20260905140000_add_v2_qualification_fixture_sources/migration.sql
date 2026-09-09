-- Make every knockout side source relational. Existing fixture-to-fixture
-- dependencies remain valid; first-round sides may instead point at one frozen
-- qualification standing from the same Match.

BEGIN;

ALTER TABLE "match_fixture_dependency"
DROP CONSTRAINT "fixture_dependency_source_match_fkey";

ALTER TABLE "match_fixture_dependency"
ALTER COLUMN "source_fixture_id" DROP NOT NULL,
ALTER COLUMN "source_outcome" DROP DEFAULT,
ALTER COLUMN "source_outcome" DROP NOT NULL,
ADD COLUMN "source_qualification_standing_id" TEXT,
ADD CONSTRAINT "fixture_dependency_source_union_check" CHECK (
    (
        "source_fixture_id" IS NOT NULL
        AND "source_outcome" IS NOT NULL
        AND "source_qualification_standing_id" IS NULL
    )
    OR
    (
        "source_fixture_id" IS NULL
        AND "source_outcome" IS NULL
        AND "source_qualification_standing_id" IS NOT NULL
    )
);

CREATE UNIQUE INDEX "fixture_dependency_qualification_source_key"
ON "match_fixture_dependency"("source_qualification_standing_id");

CREATE INDEX "fixture_dependency_qualification_match_idx"
ON "match_fixture_dependency"("source_qualification_standing_id", "match_id");

ALTER TABLE "match_fixture_dependency"
ADD CONSTRAINT "fixture_dependency_source_match_fkey"
FOREIGN KEY ("source_fixture_id", "match_id")
REFERENCES "match_fixture"("id", "match_id")
ON DELETE RESTRICT
ON UPDATE CASCADE,
ADD CONSTRAINT "fixture_dependency_qualification_match_fkey"
FOREIGN KEY ("source_qualification_standing_id", "match_id")
REFERENCES "match_qualification_standing"("id", "match_id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

COMMIT;
