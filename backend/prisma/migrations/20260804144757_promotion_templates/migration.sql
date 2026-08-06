-- CreateTable
CREATE TABLE "PromotionTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "discountFormat" TEXT NOT NULL DEFAULT '%',
    "percentage" INTEGER NOT NULL DEFAULT 0,
    "flatAmount" DECIMAL(18,2),
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromotionTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromotionTemplate_name_key" ON "PromotionTemplate"("name");
