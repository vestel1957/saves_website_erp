-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "scheduledAt" TIMESTAMP(3),
ADD COLUMN     "scheduledById" TEXT,
ADD COLUMN     "scheduledByName" TEXT,
ADD COLUMN     "scheduledFor" DATE,
ADD COLUMN     "scheduledSeq" INTEGER;

-- CreateIndex
CREATE INDEX "Ticket_scheduledFor_assignedStaffId_scheduledSeq_idx" ON "Ticket"("scheduledFor", "assignedStaffId", "scheduledSeq");
