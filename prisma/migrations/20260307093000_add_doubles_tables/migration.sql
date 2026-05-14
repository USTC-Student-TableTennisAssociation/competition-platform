-- CreateTable
CREATE TABLE "match_doubles_team"
(
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registered_at" TIMESTAMP(3),

    CONSTRAINT "match_doubles_team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_doubles_team_member"
(
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,

    CONSTRAINT "match_doubles_team_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_doubles_invite"
(
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "inviter_id" TEXT NOT NULL,
    "invitee_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_doubles_invite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "match_doubles_team_match_id_created_at_idx" ON "match_doubles_team"("match_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "match_doubles_team_member_team_id_slot_key" ON "match_doubles_team_member"("team_id", "slot");

-- CreateIndex
CREATE UNIQUE INDEX "match_doubles_team_member_team_id_user_id_key" ON "match_doubles_team_member"("team_id", "user_id");

-- CreateIndex
CREATE INDEX "match_doubles_team_member_match_id_user_id_idx" ON "match_doubles_team_member"("match_id", "user_id");

-- CreateIndex
CREATE INDEX "match_doubles_invite_match_id_status_idx" ON "match_doubles_invite"("match_id", "status");

-- CreateIndex
CREATE INDEX "match_doubles_invite_invitee_id_status_idx" ON "match_doubles_invite"("invitee_id", "status");

-- CreateIndex
CREATE INDEX "match_doubles_invite_inviter_id_status_idx" ON "match_doubles_invite"("inviter_id", "status");

-- AddForeignKey
ALTER TABLE "match_doubles_team" ADD CONSTRAINT "match_doubles_team_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_doubles_team" ADD CONSTRAINT "match_doubles_team_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_doubles_team_member" ADD CONSTRAINT "match_doubles_team_member_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "match_doubles_team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_doubles_team_member" ADD CONSTRAINT "match_doubles_team_member_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_doubles_team_member" ADD CONSTRAINT "match_doubles_team_member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_doubles_invite" ADD CONSTRAINT "match_doubles_invite_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_doubles_invite" ADD CONSTRAINT "match_doubles_invite_inviter_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_doubles_invite" ADD CONSTRAINT "match_doubles_invite_invitee_id_fkey" FOREIGN KEY ("invitee_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
