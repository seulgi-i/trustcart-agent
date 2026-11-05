-- Additive: the payment decision snapshot (evaluated cart, effective policy, Layer-1 limits) taken when an order is
-- approved for payment, which the mandate is built from at capture. Existing rows keep NULL.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "paymentSnapshotJson" TEXT;
