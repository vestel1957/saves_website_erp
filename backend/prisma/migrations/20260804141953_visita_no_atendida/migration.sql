-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "skippedAt" TIMESTAMP(3),
ADD COLUMN     "skippedById" TEXT,
ADD COLUMN     "skippedByName" TEXT,
ADD COLUMN     "skippedReason" TEXT;
