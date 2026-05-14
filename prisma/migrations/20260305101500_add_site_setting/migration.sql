-- CreateTable
CREATE TABLE "SiteSetting"
(
    "id" INTEGER NOT NULL DEFAULT 1,
    "isClosed" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteSetting_pkey" PRIMARY KEY ("id")
);
