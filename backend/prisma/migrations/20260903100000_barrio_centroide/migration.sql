-- Centroide de barrio: el punto con el que se ordena el recorrido de un técnico
-- cuando el abonado no tiene GPS (75% de las órdenes de campo abiertas).
ALTER TABLE "Neighborhood" ADD COLUMN "lat" DOUBLE PRECISION;
ALTER TABLE "Neighborhood" ADD COLUMN "lng" DOUBLE PRECISION;
ALTER TABLE "Neighborhood" ADD COLUMN "geoSource" TEXT;
ALTER TABLE "Neighborhood" ADD COLUMN "geoPoints" INTEGER;
ALTER TABLE "Neighborhood" ADD COLUMN "geoAt" TIMESTAMP(3);
