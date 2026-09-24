-- Código de afiliado: cada funcionario tiene uno fijo y el cliente que se da de alta
-- con él queda a su nombre (reporte /reportes/afiliados).
ALTER TABLE "Staff" ADD COLUMN "affiliateCode" TEXT;
CREATE UNIQUE INDEX "Staff_affiliateCode_key" ON "Staff"("affiliateCode");

ALTER TABLE "Subscriber" ADD COLUMN "affiliateStaffId" TEXT,
ADD COLUMN "affiliateCode" TEXT,
ADD COLUMN "affiliateAt" TIMESTAMP(3),
ADD COLUMN "affiliateBy" TEXT;
CREATE INDEX "Subscriber_affiliateStaffId_affiliateAt_idx" ON "Subscriber"("affiliateStaffId", "affiliateAt");
ALTER TABLE "Subscriber" ADD CONSTRAINT "Subscriber_affiliateStaffId_fkey" FOREIGN KEY ("affiliateStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;
