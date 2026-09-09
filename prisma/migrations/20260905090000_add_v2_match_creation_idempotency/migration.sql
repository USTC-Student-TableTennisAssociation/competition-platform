-- Add a durable command identity for future V2 match creation. Legacy rows
-- retain NULL values and are unaffected by the unique constraint.
BEGIN;

ALTER TABLE "Match"
ADD COLUMN "creation_request_key" TEXT,
ADD COLUMN "creation_request_fingerprint" TEXT;

ALTER TABLE "Match"
ADD CONSTRAINT "match_creation_request_identity_check" CHECK (
    ("creation_request_key" IS NULL AND "creation_request_fingerprint" IS NULL)
    OR
    (
        "engine_version" = 'V2'
        AND "creation_request_key" IS NOT NULL
        AND "creation_request_fingerprint" IS NOT NULL
        AND "creation_request_key" = btrim("creation_request_key")
        AND char_length("creation_request_key") BETWEEN 16 AND 128
        AND "creation_request_key" !~ '[[:cntrl:]]'
        AND "creation_request_fingerprint" ~ '^[0-9a-f]{64}$'
    )
);

CREATE UNIQUE INDEX "match_creator_creation_request_key_unique"
ON "Match"("createdBy", "creation_request_key");

COMMIT;
