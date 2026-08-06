-- AlterTable
ALTER TABLE "Subscriber" ADD COLUMN     "fingerprintAt" TIMESTAMP(3),
ADD COLUMN     "fingerprintPath" TEXT,
ADD COLUMN     "signatureAt" TIMESTAMP(3),
ADD COLUMN     "signatureBy" TEXT,
ADD COLUMN     "signaturePath" TEXT;

-- CreateTable
CREATE TABLE "Clausula" (
    "id" TEXT NOT NULL,
    "legacyId" INTEGER,
    "nombre" TEXT NOT NULL,
    "meses" INTEGER NOT NULL,
    "vTotal" INTEGER NOT NULL,
    "valores" INTEGER[],
    "activa" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Clausula_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Clausula_legacyId_key" ON "Clausula"("legacyId");
