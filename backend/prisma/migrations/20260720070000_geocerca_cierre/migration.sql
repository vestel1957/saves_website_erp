-- Geo-cerca del cierre de órdenes: evidencia de dónde estaba quien cerró.
ALTER TABLE "Ticket" ADD COLUMN "closeLat" DOUBLE PRECISION;
ALTER TABLE "Ticket" ADD COLUMN "closeLng" DOUBLE PRECISION;
ALTER TABLE "Ticket" ADD COLUMN "closeAccuracyM" DOUBLE PRECISION;
ALTER TABLE "Ticket" ADD COLUMN "closeDistanceM" DOUBLE PRECISION;
ALTER TABLE "Ticket" ADD COLUMN "closeGeoOk" BOOLEAN;
ALTER TABLE "Ticket" ADD COLUMN "closeGeoReason" TEXT;

-- El informe pregunta "cierres fuera de rango en el último mes": (closeGeoOk, finalDate).
CREATE INDEX "Ticket_closeGeoOk_finalDate_idx" ON "Ticket"("closeGeoOk", "finalDate");
