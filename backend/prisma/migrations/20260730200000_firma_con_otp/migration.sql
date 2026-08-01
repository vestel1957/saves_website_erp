-- Firma con código de un solo uso (OTP) — 2026-07-30.
--
-- Hasta ahora la sesión abierta ERA la firma: con un portátil sin bloquear se podía
-- aprobar una orden de compra a nombre de otro, y la doble firma por monto dejaba dos
-- nombres en el rastro sin que nadie hubiera demostrado estar ahí. Ahora el sistema
-- manda un código al WhatsApp del firmante y sin ese código no hay firma.
--
-- 1) `User.signaturePhone` — a dónde le llegan los códigos. Campo aparte de
--    `whatsappPhone` a propósito: ése es la identidad del chatbot (hereda los permisos
--    RBAC de la cuenta) y lo administra sistemas; este lo define el propio usuario en
--    /perfil. Si está vacío se hereda el vinculado, que ya está probado.
-- 2) `SignatureOtp` — un código por firma. El código NO se guarda: va hasheado con
--    scrypt (`salt:hash`, igual que las contraseñas). Las filas se conservan tras
--    consumirse porque son el rastro de la firma: a qué número salió, cuándo, cuántos
--    intentos costó y si fue en modo simulación.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "signaturePhone" TEXT,
                   ADD COLUMN "signaturePhoneVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SignatureOtp" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "targetId" TEXT,
    "codeHash" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignatureOtp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SignatureOtp_userId_purpose_targetId_createdAt_idx" ON "SignatureOtp"("userId", "purpose", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "SignatureOtp_expiresAt_idx" ON "SignatureOtp"("expiresAt");

-- AddForeignKey
ALTER TABLE "SignatureOtp" ADD CONSTRAINT "SignatureOtp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
