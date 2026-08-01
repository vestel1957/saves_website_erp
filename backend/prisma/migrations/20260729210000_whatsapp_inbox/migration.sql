-- CreateEnum
CREATE TYPE "WhatsappConvStatus" AS ENUM ('BOT', 'PENDIENTE', 'ASIGNADA', 'RESUELTA');

-- AlterTable
ALTER TABLE "WhatsappMessage" ADD COLUMN     "sentById" TEXT;

-- CreateTable
CREATE TABLE "WhatsappConversation" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "convKey" TEXT,
    "subscriberId" TEXT,
    "status" "WhatsappConvStatus" NOT NULL DEFAULT 'BOT',
    "handoffReason" TEXT,
    "assignedToId" TEXT,
    "assignedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,
    "lastInboundAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3),
    "lastDirection" TEXT,
    "preview" TEXT,
    "unread" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappConversation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappConversation_phone_key" ON "WhatsappConversation"("phone");

-- CreateIndex
CREATE INDEX "WhatsappConversation_status_lastMessageAt_idx" ON "WhatsappConversation"("status", "lastMessageAt");

-- CreateIndex
CREATE INDEX "WhatsappConversation_assignedToId_status_idx" ON "WhatsappConversation"("assignedToId", "status");

-- CreateIndex
CREATE INDEX "WhatsappConversation_lastMessageAt_idx" ON "WhatsappConversation"("lastMessageAt");

-- CreateIndex
CREATE INDEX "WhatsappConversation_subscriberId_idx" ON "WhatsappConversation"("subscriberId");

-- CreateIndex
CREATE INDEX "WhatsappMessage_phone_createdAt_idx" ON "WhatsappMessage"("phone", "createdAt");

-- AddForeignKey
ALTER TABLE "WhatsappMessage" ADD CONSTRAINT "WhatsappMessage_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappConversation" ADD CONSTRAINT "WhatsappConversation_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappConversation" ADD CONSTRAINT "WhatsappConversation_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappConversation" ADD CONSTRAINT "WhatsappConversation_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

