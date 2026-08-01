-- Acta de traspaso de material: envío automático + firma de quien recibe (2026-07-30).
--
-- El acta se emite, sale en PDF al WhatsApp del encargado que recibe, y él la cierra
-- firmando con un código de un solo uso (`SignatureOtp`, propósito `material.receive`).
-- Aquí solo queda el RASTRO: quién firmó, con qué (a qué número salió el código) y
-- cuándo se le mandó el acta.

-- AlterTable
ALTER TABLE "MaterialActa" ADD COLUMN "receivedById" TEXT,
                           ADD COLUMN "receivedSignature" TEXT,
                           ADD COLUMN "notifiedAt" TIMESTAMP(3),
                           ADD COLUMN "notifiedTo" TEXT;
