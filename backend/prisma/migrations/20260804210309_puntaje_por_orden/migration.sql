-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "score" INTEGER,
ADD COLUMN     "scoredAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TicketTypeScore" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketTypeScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TicketTypeScore_type_key" ON "TicketTypeScore"("type");
