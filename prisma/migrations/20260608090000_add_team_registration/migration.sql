-- CreateEnum
CREATE TYPE "TeamRegistrationStatus" AS ENUM ('draft', 'submitted', 'approved', 'rejected', 'waitlisted', 'cancelled');

-- AlterTable
ALTER TABLE "Match"
  ADD COLUMN "teamRegistrationStart" TIMESTAMP(3),
  ADD COLUMN "teamRegistrationDeadline" TIMESTAMP(3),
  ADD COLUMN "teamMinMembers" INTEGER,
  ADD COLUMN "teamMaxMembers" INTEGER;

-- CreateTable
CREATE TABLE "match_team" (
  "id" TEXT NOT NULL,
  "match_id" TEXT NOT NULL,
  "captain_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "invite_code" TEXT NOT NULL,
  "contact" TEXT,
  "remark" TEXT,
  "review_note" TEXT,
  "status" "TeamRegistrationStatus" NOT NULL DEFAULT 'draft',
  "submitted_at" TIMESTAMP(3),
  "reviewed_at" TIMESTAMP(3),
  "reviewed_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "match_team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_team_member" (
  "id" TEXT NOT NULL,
  "team_id" TEXT NOT NULL,
  "match_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "match_team_member_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "match_team_invite_code_key" ON "match_team"("invite_code");

-- CreateIndex
CREATE INDEX "match_team_match_id_status_idx" ON "match_team"("match_id", "status");

-- CreateIndex
CREATE INDEX "match_team_captain_id_idx" ON "match_team"("captain_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_team_member_match_id_user_id_key" ON "match_team_member"("match_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_team_member_team_id_user_id_key" ON "match_team_member"("team_id", "user_id");

-- CreateIndex
CREATE INDEX "match_team_member_team_id_joined_at_idx" ON "match_team_member"("team_id", "joined_at");

-- CreateIndex
CREATE INDEX "match_team_member_user_id_idx" ON "match_team_member"("user_id");

-- AddForeignKey
ALTER TABLE "match_team" ADD CONSTRAINT "match_team_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_team" ADD CONSTRAINT "match_team_captain_id_fkey" FOREIGN KEY ("captain_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_team" ADD CONSTRAINT "match_team_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_team_member" ADD CONSTRAINT "match_team_member_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "match_team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_team_member" ADD CONSTRAINT "match_team_member_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_team_member" ADD CONSTRAINT "match_team_member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
