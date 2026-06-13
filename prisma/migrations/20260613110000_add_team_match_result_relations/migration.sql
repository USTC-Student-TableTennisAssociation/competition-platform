-- AlterTable
ALTER TABLE "MatchResult"
  ADD COLUMN "winner_match_team_id" TEXT,
  ADD COLUMN "loser_match_team_id" TEXT;

-- CreateIndex
CREATE INDEX "MatchResult_winner_match_team_id_idx" ON "MatchResult"("winner_match_team_id");

-- CreateIndex
CREATE INDEX "MatchResult_loser_match_team_id_idx" ON "MatchResult"("loser_match_team_id");

-- AddForeignKey
ALTER TABLE "MatchResult" ADD CONSTRAINT "MatchResult_winner_match_team_id_fkey" FOREIGN KEY ("winner_match_team_id") REFERENCES "match_team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchResult" ADD CONSTRAINT "MatchResult_loser_match_team_id_fkey" FOREIGN KEY ("loser_match_team_id") REFERENCES "match_team"("id") ON DELETE SET NULL ON UPDATE CASCADE;
