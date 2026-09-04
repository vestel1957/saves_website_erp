-- AlterTable
ALTER TABLE "SubscriberFile" ADD COLUMN     "kind" TEXT;

-- CreateIndex
CREATE INDEX "SubscriberFile_subscriberId_kind_createdAt_idx" ON "SubscriberFile"("subscriberId", "kind", "createdAt");
