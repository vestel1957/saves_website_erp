-- AlterTable
ALTER TABLE "SupplyOrder" ADD COLUMN     "approved2At" TIMESTAMP(3),
ADD COLUMN     "approved2ById" TEXT,
ADD COLUMN     "approved2ByName" TEXT,
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "approvedByName" TEXT,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "createdByName" TEXT;

-- CreateTable
CREATE TABLE "SupplyOrderEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "detail" TEXT,
    "userId" TEXT,
    "userName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplyOrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupplyOrderFile" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplyOrderFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplyOrderEvent_orderId_idx" ON "SupplyOrderEvent"("orderId");

-- CreateIndex
CREATE INDEX "SupplyOrderFile_orderId_idx" ON "SupplyOrderFile"("orderId");

-- AddForeignKey
ALTER TABLE "SupplyOrderEvent" ADD CONSTRAINT "SupplyOrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SupplyOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplyOrderFile" ADD CONSTRAINT "SupplyOrderFile_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "SupplyOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
