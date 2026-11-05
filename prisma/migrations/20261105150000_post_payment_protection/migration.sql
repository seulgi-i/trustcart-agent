-- Post-payment protection: a signed intent mandate per paid order, and refund drafts per billing mismatch.

-- CreateTable
CREATE TABLE "Mandate" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "publicKeyFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Mandate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundRequest" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "scenario" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "evidenceJson" TEXT NOT NULL,
    "suggestedCents" INTEGER NOT NULL,
    "capturedCents" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "mode" TEXT,
    "amountCents" INTEGER,
    "providerRefundId" TEXT,
    "providerStatus" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RefundRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Mandate_orderId_key" ON "Mandate"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "RefundRequest_idempotencyKey_key" ON "RefundRequest"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "RefundRequest_providerRefundId_key" ON "RefundRequest"("providerRefundId");

-- CreateIndex
CREATE INDEX "RefundRequest_sessionId_idx" ON "RefundRequest"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "RefundRequest_orderId_scenario_key" ON "RefundRequest"("orderId", "scenario");

-- AddForeignKey
ALTER TABLE "Mandate" ADD CONSTRAINT "Mandate_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DemoSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundRequest" ADD CONSTRAINT "RefundRequest_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A signed mandate is immutable: the database refuses UPDATE (DELETE stays possible for the session cascade).
CREATE FUNCTION "Mandate_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Mandate is immutable';
END;
$$;

CREATE TRIGGER "Mandate_no_update" BEFORE UPDATE ON "Mandate"
  FOR EACH ROW EXECUTE FUNCTION "Mandate_immutable"();
