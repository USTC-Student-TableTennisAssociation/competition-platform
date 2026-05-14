-- CreateTable
CREATE TABLE "UserIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nameHash" TEXT NOT NULL,
    "studentIdHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParticipationCertificate" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "certificateNo" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParticipationCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserIdentity_userId_key" ON "UserIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ParticipationCertificate_certificateNo_key" ON "ParticipationCertificate"("certificateNo");

-- CreateIndex
CREATE INDEX "ParticipationCertificate_userId_createdAt_idx" ON "ParticipationCertificate"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ParticipationCertificate_matchId_userId_key" ON "ParticipationCertificate"("matchId", "userId");

-- AddForeignKey
ALTER TABLE "UserIdentity" ADD CONSTRAINT "UserIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipationCertificate" ADD CONSTRAINT "ParticipationCertificate_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParticipationCertificate" ADD CONSTRAINT "ParticipationCertificate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
