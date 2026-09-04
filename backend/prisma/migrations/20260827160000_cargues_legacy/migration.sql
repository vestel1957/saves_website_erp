-- Historial de cargues hechos en el legacy (`files_carga_transaccional` /
-- `datos_archivo_excel_cargue`): sin estas columnas la pantalla de Importar pagos
-- arrancaba vacía, con los 914 archivos del legacy fuera del sistema.
ALTER TABLE "PaymentImportBatch" ADD COLUMN "legacyId" INTEGER;
ALTER TABLE "PaymentImportRow" ADD COLUMN "legacyId" INTEGER;

CREATE UNIQUE INDEX "PaymentImportBatch_legacyId_key" ON "PaymentImportBatch"("legacyId");
CREATE UNIQUE INDEX "PaymentImportRow_legacyId_key" ON "PaymentImportRow"("legacyId");
