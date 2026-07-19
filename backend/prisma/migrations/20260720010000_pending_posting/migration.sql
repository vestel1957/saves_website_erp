-- CreateTable
CREATE TABLE "PendingPosting" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "error" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingPosting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingPosting_resolvedAt_idx" ON "PendingPosting"("resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PendingPosting_sourceType_sourceId_key" ON "PendingPosting"("sourceType", "sourceId");

