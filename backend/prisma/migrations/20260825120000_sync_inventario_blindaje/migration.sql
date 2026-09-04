-- Blindaje contra la sincronización del legacy (ver scripts/sync-legacy-vivo.js).
-- `equipos` y `purchase` pasan a sincronizarse desde el MySQL vivo; estas marcas
-- señalan las filas que NEXUS ya movió (devolución de equipo, recepción o pago de
-- una orden) para que la pasada no se las devuelva al valor del legacy.
ALTER TABLE "Equipment"   ADD COLUMN "editedAt" TIMESTAMP(3);
ALTER TABLE "SupplyOrder" ADD COLUMN "editedAt" TIMESTAMP(3);

CREATE INDEX "Equipment_editedAt_idx" ON "Equipment"("editedAt");
