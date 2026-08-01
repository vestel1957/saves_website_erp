-- CreateEnum
CREATE TYPE "ChatAccessLevel" AS ENUM ('NINGUNO', 'BASICO', 'COMPLETO');

-- CreateTable
CREATE TABLE "ChatAccessVerification" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "subscriberId" TEXT,
    "nivel" "ChatAccessLevel" NOT NULL DEFAULT 'NINGUNO',
    "verificadoAt" TIMESTAMP(3),
    "expiraAt" TIMESTAMP(3),
    "otpHash" TEXT,
    "otpExpiraAt" TIMESTAMP(3),
    "otpIntentos" INTEGER NOT NULL DEFAULT 0,
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "bloqueadoHasta" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatAccessVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChatAccessVerification_phone_key" ON "ChatAccessVerification"("phone");

-- CreateIndex
CREATE INDEX "ChatAccessVerification_subscriberId_idx" ON "ChatAccessVerification"("subscriberId");

-- CreateIndex
CREATE INDEX "ChatAccessVerification_expiraAt_idx" ON "ChatAccessVerification"("expiraAt");

-- AddForeignKey
ALTER TABLE "ChatAccessVerification" ADD CONSTRAINT "ChatAccessVerification_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;
