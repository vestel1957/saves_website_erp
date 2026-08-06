/*
  Warnings:

  - You are about to drop the column `global` on the `Promotion` table. All the data in the column will be lost.
  - You are about to drop the column `subscriberStatus` on the `Promotion` table. All the data in the column will be lost.
  - You are about to drop the `PromotionAssignmentLog` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `_PromotionAssignees` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "PromotionTargetKind" AS ENUM ('ALL', 'STATUS', 'SUBSCRIBER', 'PLAN', 'BRANCH', 'NEIGHBORHOOD');

-- CreateEnum
CREATE TYPE "PromotionTargetAction" AS ENUM ('ADDED', 'REMOVED');

-- DropForeignKey
ALTER TABLE "PromotionAssignmentLog" DROP CONSTRAINT "PromotionAssignmentLog_promotionId_fkey";

-- DropForeignKey
ALTER TABLE "PromotionAssignmentLog" DROP CONSTRAINT "PromotionAssignmentLog_staffId_fkey";

-- DropForeignKey
ALTER TABLE "_PromotionAssignees" DROP CONSTRAINT "_PromotionAssignees_A_fkey";

-- DropForeignKey
ALTER TABLE "_PromotionAssignees" DROP CONSTRAINT "_PromotionAssignees_B_fkey";

-- DropIndex
DROP INDEX "Promotion_subscriberStatus_idx";

-- AlterTable
ALTER TABLE "Promotion" DROP COLUMN "global",
DROP COLUMN "subscriberStatus",
ADD COLUMN     "allSubscribers" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "neighborhoodRefs" TEXT[],
ADD COLUMN     "subscriberStatuses" "SubscriberStatus"[];

-- DropTable
DROP TABLE "PromotionAssignmentLog";

-- DropTable
DROP TABLE "_PromotionAssignees";

-- DropEnum
DROP TYPE "PromotionAssignAction";

-- CreateTable
CREATE TABLE "PromotionTargetLog" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "promotionName" TEXT NOT NULL,
    "kind" "PromotionTargetKind" NOT NULL,
    "targetLabel" TEXT NOT NULL,
    "action" "PromotionTargetAction" NOT NULL,
    "changedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionTargetLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_PromotionBranches" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PromotionBranches_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_PromotionPlans" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PromotionPlans_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_PromotionSubscribers" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PromotionSubscribers_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "PromotionTargetLog_promotionId_idx" ON "PromotionTargetLog"("promotionId");

-- CreateIndex
CREATE INDEX "PromotionTargetLog_createdAt_idx" ON "PromotionTargetLog"("createdAt");

-- CreateIndex
CREATE INDEX "_PromotionBranches_B_index" ON "_PromotionBranches"("B");

-- CreateIndex
CREATE INDEX "_PromotionPlans_B_index" ON "_PromotionPlans"("B");

-- CreateIndex
CREATE INDEX "_PromotionSubscribers_B_index" ON "_PromotionSubscribers"("B");

-- AddForeignKey
ALTER TABLE "PromotionTargetLog" ADD CONSTRAINT "PromotionTargetLog_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PromotionBranches" ADD CONSTRAINT "_PromotionBranches_A_fkey" FOREIGN KEY ("A") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PromotionBranches" ADD CONSTRAINT "_PromotionBranches_B_fkey" FOREIGN KEY ("B") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PromotionPlans" ADD CONSTRAINT "_PromotionPlans_A_fkey" FOREIGN KEY ("A") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PromotionPlans" ADD CONSTRAINT "_PromotionPlans_B_fkey" FOREIGN KEY ("B") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PromotionSubscribers" ADD CONSTRAINT "_PromotionSubscribers_A_fkey" FOREIGN KEY ("A") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PromotionSubscribers" ADD CONSTRAINT "_PromotionSubscribers_B_fkey" FOREIGN KEY ("B") REFERENCES "Subscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;
