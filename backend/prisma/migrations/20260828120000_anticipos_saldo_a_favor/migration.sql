-- CreateEnum
CREATE TYPE "AdvanceStatus" AS ENUM ('ABIERTO', 'APLICADO', 'ANULADO');

-- CreateTable
CREATE TABLE "CustomerAdvance" (
    "id" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "applied" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "status" "AdvanceStatus" NOT NULL DEFAULT 'ABIERTO',
    "date" DATE NOT NULL,
    "method" TEXT,
    "sourceInvoiceId" TEXT,
    "transactionId" TEXT,
    "receiptId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerAdvance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerAdvanceApplication" (
    "id" TEXT NOT NULL,
    "advanceId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "date" DATE NOT NULL,
    "transactionId" TEXT,
    "debitTransactionId" TEXT,
    "revertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerAdvanceApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerAdvance_transactionId_key" ON "CustomerAdvance"("transactionId");

-- CreateIndex
CREATE INDEX "CustomerAdvance_subscriberId_status_idx" ON "CustomerAdvance"("subscriberId", "status");

-- CreateIndex
CREATE INDEX "CustomerAdvance_status_idx" ON "CustomerAdvance"("status");

-- CreateIndex
CREATE INDEX "CustomerAdvanceApplication_advanceId_idx" ON "CustomerAdvanceApplication"("advanceId");

-- CreateIndex
CREATE INDEX "CustomerAdvanceApplication_invoiceId_idx" ON "CustomerAdvanceApplication"("invoiceId");

-- AddForeignKey
ALTER TABLE "CustomerAdvance" ADD CONSTRAINT "CustomerAdvance_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAdvance" ADD CONSTRAINT "CustomerAdvance_sourceInvoiceId_fkey" FOREIGN KEY ("sourceInvoiceId") REFERENCES "SubInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAdvance" ADD CONSTRAINT "CustomerAdvance_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAdvanceApplication" ADD CONSTRAINT "CustomerAdvanceApplication_advanceId_fkey" FOREIGN KEY ("advanceId") REFERENCES "CustomerAdvance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAdvanceApplication" ADD CONSTRAINT "CustomerAdvanceApplication_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SubInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAdvanceApplication" ADD CONSTRAINT "CustomerAdvanceApplication_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

