-- CreateTable
CREATE TABLE "AdminTrustedDevice"
(
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminTrustedDevice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminTrustedDevice_tokenHash_key" ON "AdminTrustedDevice"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminTrustedDevice_userId_expiresAt_idx" ON "AdminTrustedDevice"("userId", "expiresAt");

-- AddForeignKey
ALTER TABLE "AdminTrustedDevice" ADD CONSTRAINT "AdminTrustedDevice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
