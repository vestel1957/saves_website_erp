-- AlterTable
ALTER TABLE "FiscalPeriod" ADD COLUMN     "closedBy" TEXT;

-- CreateTable
CREATE TABLE "FiscalPeriodBalance" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "opening" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "debit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "closing" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FiscalPeriodBalance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FiscalPeriodBalance_accountId_idx" ON "FiscalPeriodBalance"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "FiscalPeriodBalance_periodId_accountId_key" ON "FiscalPeriodBalance"("periodId", "accountId");

-- AddForeignKey
ALTER TABLE "FiscalPeriodBalance" ADD CONSTRAINT "FiscalPeriodBalance_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "FiscalPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FiscalPeriodBalance" ADD CONSTRAINT "FiscalPeriodBalance_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
