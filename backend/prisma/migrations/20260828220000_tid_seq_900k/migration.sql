-- Consecutivo de factura: el bloque de nexus sube de 500.000 a 900.000.
--
-- El rango partido en 500.000 (20260801, ver [[consecutivos-tid-particionados]]) dejó de
-- estar partido el día que empezamos a EMPUJAR facturas al legacy: él numera con
-- `MAX(tid)+1`, adoptó nuestro máximo y el 2026-08-28 emitió su factura 470663 con tid
-- 500027 — el mismo número que nuestra secuencia acababa de repartir. Su factura no pudo
-- bajar (índice único) y su pago quedó colgando de la nuestra.
--
-- Desde ahora el número de las facturas que VIAJAN lo reparte el legacy (writeback-legacy.js
-- pide su `MAX(tid)+1` bajo GET_LOCK y renumera la nuestra). Esta secuencia solo tiene que
-- dar un número de partida que él no pueda alcanzar mientras siga vivo: a ~5.400 facturas
-- al mes, de 500.028 a 900.000 hay más de seis años.
--
-- GREATEST para que sea idempotente y para no RETROCEDER nunca la secuencia: bajarla
-- repartiría números ya usados.
SELECT setval(
  '"SubInvoice_tid_seq"',
  GREATEST(900000, (SELECT last_value FROM "SubInvoice_tid_seq")),
  true
);
