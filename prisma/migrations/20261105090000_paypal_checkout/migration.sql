-- AlterTable
ALTER TABLE "Order" ADD COLUMN "approvalUrl" TEXT;
ALTER TABLE "Order" ADD COLUMN "failureReason" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Order_providerOrderId_key" ON "Order"("providerOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_captureId_key" ON "Order"("captureId");
