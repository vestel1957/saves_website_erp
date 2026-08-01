-- CreateEnum
CREATE TYPE "OltProvisionStatus" AS ENUM ('PENDING', 'PROVISIONING', 'DONE', 'REVIEW', 'FAILED', 'CANCELLED');

-- DropIndex
DROP INDEX "Subscriber_gpsLat_idx";

-- CreateTable
CREATE TABLE "PlanOltProfile" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "oltId" TEXT,
    "trafficIn" INTEGER,
    "trafficOut" INTEGER,
    "lineprofile" INTEGER,
    "srvprofile" INTEGER,
    "vlan" INTEGER,
    "gemport" INTEGER,
    "userVlan" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanOltProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OltProvisionRequest" (
    "id" TEXT NOT NULL,
    "sn" TEXT NOT NULL,
    "subscriberId" TEXT,
    "planId" TEXT,
    "oltId" TEXT,
    "status" "OltProvisionStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastTriedAt" TIMESTAMP(3),
    "provisionedOnuId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "doneAt" TIMESTAMP(3),

    CONSTRAINT "OltProvisionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlanOltProfile_planId_idx" ON "PlanOltProfile"("planId");

-- CreateIndex
CREATE INDEX "PlanOltProfile_oltId_idx" ON "PlanOltProfile"("oltId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanOltProfile_planId_oltId_key" ON "PlanOltProfile"("planId", "oltId");

-- CreateIndex
CREATE INDEX "OltProvisionRequest_sn_idx" ON "OltProvisionRequest"("sn");

-- CreateIndex
CREATE INDEX "OltProvisionRequest_status_idx" ON "OltProvisionRequest"("status");

-- CreateIndex
CREATE INDEX "OltProvisionRequest_subscriberId_idx" ON "OltProvisionRequest"("subscriberId");

-- CreateIndex
CREATE INDEX "OltProvisionRequest_oltId_idx" ON "OltProvisionRequest"("oltId");

-- AddForeignKey
ALTER TABLE "PlanOltProfile" ADD CONSTRAINT "PlanOltProfile_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanOltProfile" ADD CONSTRAINT "PlanOltProfile_oltId_fkey" FOREIGN KEY ("oltId") REFERENCES "Olt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OltProvisionRequest" ADD CONSTRAINT "OltProvisionRequest_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OltProvisionRequest" ADD CONSTRAINT "OltProvisionRequest_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OltProvisionRequest" ADD CONSTRAINT "OltProvisionRequest_oltId_fkey" FOREIGN KEY ("oltId") REFERENCES "Olt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
