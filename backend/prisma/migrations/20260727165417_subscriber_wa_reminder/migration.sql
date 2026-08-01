-- AlterTable
ALTER TABLE "Subscriber" ADD COLUMN     "lastWaReminderAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Subscriber_lastWaReminderAt_idx" ON "Subscriber"("lastWaReminderAt");
