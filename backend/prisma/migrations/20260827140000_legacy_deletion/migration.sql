-- CreateTable
CREATE TABLE "LegacyDeletion" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "legacyId" INTEGER NOT NULL,
    "label" TEXT,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedBy" TEXT,
    "pushedAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "LegacyDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LegacyDeletion_entity_legacyId_key" ON "LegacyDeletion"("entity", "legacyId");

-- CreateIndex
CREATE INDEX "LegacyDeletion_pushedAt_idx" ON "LegacyDeletion"("pushedAt");
