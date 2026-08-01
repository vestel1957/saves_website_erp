-- CreateTable
CREATE TABLE "ScheduledPayment" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "cashAccountId" INTEGER NOT NULL,
    "dayOfMonth" INTEGER NOT NULL DEFAULT 1,
    "beneficiary" TEXT,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdByName" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledPaymentRun" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "transactionId" TEXT,
    "executedById" TEXT,
    "executedByName" TEXT,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledPaymentRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledPayment_cashAccountId_active_idx" ON "ScheduledPayment"("cashAccountId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledPaymentRun_paymentId_period_key" ON "ScheduledPaymentRun"("paymentId", "period");

-- AddForeignKey
ALTER TABLE "ScheduledPaymentRun" ADD CONSTRAINT "ScheduledPaymentRun_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "ScheduledPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
