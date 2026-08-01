-- CreateEnum
CREATE TYPE "SubscriberContactStatus" AS ENUM ('PENDIENTE', 'ACTIVO', 'REVOCADO');

-- CreateTable
CREATE TABLE "SubscriberContact" (
    "id" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "relation" TEXT,
    "status" "SubscriberContactStatus" NOT NULL DEFAULT 'PENDIENTE',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriberContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SubscriberContact_phone_key" ON "SubscriberContact"("phone");

-- CreateIndex
CREATE INDEX "SubscriberContact_subscriberId_idx" ON "SubscriberContact"("subscriberId");

-- CreateIndex
CREATE INDEX "SubscriberContact_status_idx" ON "SubscriberContact"("status");

-- AddForeignKey
ALTER TABLE "SubscriberContact" ADD CONSTRAINT "SubscriberContact_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;
