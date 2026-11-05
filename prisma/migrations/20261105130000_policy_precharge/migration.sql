-- Additive: per-session spending policy and pre-charge capture scheduling. No existing column or row changes.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "captureScheduledAt" TIMESTAMP(3),
ADD COLUMN "captureCanceled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SessionPolicy" (
    "sessionId" TEXT NOT NULL,
    "perOrderMaxCents" INTEGER NOT NULL,
    "dailyMaxCents" INTEGER NOT NULL,
    "allowedCategories" TEXT[],
    "requireApprovalAboveCents" INTEGER NOT NULL,
    "maxQuantity" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionPolicy_pkey" PRIMARY KEY ("sessionId")
);

-- AddForeignKey
ALTER TABLE "SessionPolicy" ADD CONSTRAINT "SessionPolicy_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DemoSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
