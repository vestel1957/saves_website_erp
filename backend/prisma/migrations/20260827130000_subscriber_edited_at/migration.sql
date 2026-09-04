-- AlterTable
ALTER TABLE "Subscriber" ADD COLUMN     "editedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Subscriber_editedAt_idx" ON "Subscriber"("editedAt");
