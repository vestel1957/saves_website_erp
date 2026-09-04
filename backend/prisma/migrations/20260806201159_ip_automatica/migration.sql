-- CreateTable
CREATE TABLE "IpAssignment" (
    "id" TEXT NOT NULL,
    "routerHost" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "subscriberId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'RESERVADA',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IpAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IpAssignment_subscriberId_idx" ON "IpAssignment"("subscriberId");

-- CreateIndex
CREATE INDEX "IpAssignment_state_idx" ON "IpAssignment"("state");

-- CreateIndex
CREATE UNIQUE INDEX "IpAssignment_routerHost_ip_key" ON "IpAssignment"("routerHost", "ip");

-- AddForeignKey
ALTER TABLE "IpAssignment" ADD CONSTRAINT "IpAssignment_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;
