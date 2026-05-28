-- CreateEnum
CREATE TYPE "MatchPostStatus" AS ENUM ('OPEN', 'MATCHED', 'EXPIRED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "MatchApplicationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "MatchPost" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "playAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "location" TEXT NOT NULL,
    "minElo" INTEGER,
    "maxElo" INTEGER,
    "isRatedPreferred" BOOLEAN NOT NULL DEFAULT false,
    "status" "MatchPostStatus" NOT NULL DEFAULT 'OPEN',
    "matchedUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchApplication" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "message" TEXT,
    "status" "MatchApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MatchApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MatchPost_status_playAt_idx" ON "MatchPost"("status", "playAt");

-- CreateIndex
CREATE INDEX "MatchPost_creatorId_idx" ON "MatchPost"("creatorId");

-- CreateIndex
CREATE INDEX "MatchPost_matchedUserId_idx" ON "MatchPost"("matchedUserId");

-- CreateIndex
CREATE UNIQUE INDEX "MatchApplication_postId_applicantId_key" ON "MatchApplication"("postId", "applicantId");

-- CreateIndex
CREATE INDEX "MatchApplication_postId_status_idx" ON "MatchApplication"("postId", "status");

-- CreateIndex
CREATE INDEX "MatchApplication_applicantId_idx" ON "MatchApplication"("applicantId");

-- AddForeignKey
ALTER TABLE "MatchPost" ADD CONSTRAINT "MatchPost_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchPost" ADD CONSTRAINT "MatchPost_matchedUserId_fkey" FOREIGN KEY ("matchedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchApplication" ADD CONSTRAINT "MatchApplication_postId_fkey" FOREIGN KEY ("postId") REFERENCES "MatchPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchApplication" ADD CONSTRAINT "MatchApplication_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
