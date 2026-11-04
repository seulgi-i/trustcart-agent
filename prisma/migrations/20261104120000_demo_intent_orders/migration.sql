-- DropIndex
DROP INDEX "Approval_sessionId_idx";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Approval";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "Intent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "budgetCents" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Intent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DemoSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "cartJson" TEXT NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "evaluationJson" TEXT NOT NULL,
    "provider" TEXT,
    "providerOrderId" TEXT,
    "captureId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Order_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "DemoSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Order_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "Intent" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DemoSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "cartJson" TEXT NOT NULL DEFAULT '[]'
);
INSERT INTO "new_DemoSession" ("createdAt", "expiresAt", "id") SELECT "createdAt", "expiresAt", "id" FROM "DemoSession";
DROP TABLE "DemoSession";
ALTER TABLE "new_DemoSession" RENAME TO "DemoSession";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Intent_sessionId_idx" ON "Intent"("sessionId");

-- CreateIndex
CREATE INDEX "Order_sessionId_idx" ON "Order"("sessionId");
