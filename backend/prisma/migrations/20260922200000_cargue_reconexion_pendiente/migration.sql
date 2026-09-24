-- Reconexión del cargue de pagos que quedó sin correr (reinicio a mitad de tanda).
ALTER TABLE "PaymentImportRow" ADD COLUMN "reconexionPendienteDesde" TIMESTAMP(3);
CREATE INDEX "PaymentImportRow_reconexionPendienteDesde_idx" ON "PaymentImportRow"("reconexionPendienteDesde");
