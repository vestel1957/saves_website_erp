-- Paridad con `transactions/cargar_desde_excel` del legacy.
--
-- `cashAccountId` es el que faltaba de verdad: en el legacy la columna D del Excel
-- es el NOMBRE de la cuenta (`accounts.holder` = "BANCOLOMBIA TELECOMUNICACIONES",
-- "BANCOLOMBIA TV", "EFECTY"), y ahí es donde entra la plata. Sin ella los recaudos
-- del cargue quedaban sin cuenta y no cuadraban con el banco.
ALTER TABLE "PaymentImportBatch" ADD COLUMN "storedFile" TEXT;
ALTER TABLE "PaymentImportBatch" ADD COLUMN "uploadedByName" TEXT;
ALTER TABLE "PaymentImportBatch" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'pagos';

ALTER TABLE "PaymentImportRow" ADD COLUMN "subscriberName" TEXT;
ALTER TABLE "PaymentImportRow" ADD COLUMN "cashAccountId" INTEGER;
