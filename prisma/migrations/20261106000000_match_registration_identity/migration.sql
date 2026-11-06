ALTER TABLE "Match" ADD COLUMN "collect_identity_info" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "match_registration_identity" (
    "match_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "encrypted_data" TEXT NOT NULL,
    "consented_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "match_registration_identity_pkey" PRIMARY KEY ("match_id", "user_id"),
    CONSTRAINT "match_registration_identity_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "match_registration_identity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "match_registration_identity_user_id_idx" ON "match_registration_identity"("user_id");
