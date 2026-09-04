-- AlterTable
ALTER TABLE "SubscriberService" ADD COLUMN     "bundleId" TEXT;

-- CreateTable
CREATE TABLE "PlanBundle" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanBundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanBundleItem" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "kind" "ServiceKind" NOT NULL,
    "price" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "PlanBundleItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlanBundle_active_idx" ON "PlanBundle"("active");

-- CreateIndex
CREATE INDEX "PlanBundleItem_planId_idx" ON "PlanBundleItem"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanBundleItem_bundleId_kind_key" ON "PlanBundleItem"("bundleId", "kind");

-- CreateIndex
CREATE INDEX "SubscriberService_bundleId_idx" ON "SubscriberService"("bundleId");

-- AddForeignKey
ALTER TABLE "SubscriberService" ADD CONSTRAINT "SubscriberService_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "PlanBundle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanBundleItem" ADD CONSTRAINT "PlanBundleItem_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "PlanBundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanBundleItem" ADD CONSTRAINT "PlanBundleItem_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
