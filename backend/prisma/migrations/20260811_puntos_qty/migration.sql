-- Cantidad por línea de servicio. Nace para los PUNTOS (decos de TV adicionales),
-- que el legacy cobraba como un renglón con qty=N y que la corrida mensual no
-- sabía facturar: internet y TV siguen siendo 1 y por eso ese es el default.
ALTER TABLE "SubscriberService" ADD COLUMN "qty" INTEGER NOT NULL DEFAULT 1;
