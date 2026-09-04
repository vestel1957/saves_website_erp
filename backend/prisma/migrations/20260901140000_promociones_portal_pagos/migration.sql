-- PROMOCIONES EN EL PORTAL DE PAGOS EN LÍNEA (vestel.com.co/crm).
-- El portal lee `promos` del MySQL legacy por fecha + estado del cliente; estas tres
-- columnas son la correa del writeback: qué promoción se publica allá, con qué filas
-- quedó reflejada y cuándo se reflejó por última vez.
ALTER TABLE "Promotion" ADD COLUMN "portalPublish" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Promotion" ADD COLUMN "legacyPromoIds" INTEGER[];
ALTER TABLE "Promotion" ADD COLUMN "portalPublishedAt" TIMESTAMP(3);
