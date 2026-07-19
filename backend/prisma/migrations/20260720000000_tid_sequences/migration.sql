-- Consecutivos (`tid`) con secuencias de Postgres en vez de MAX(tid)+1.
--
-- MAX(tid)+1 tiene una carrera real: dos procesos que leen a la vez obtienen el
-- mismo número. Como `tid` tiene índice único, no se duplica — revienta. En el cron
-- de facturación recurrente eso se traducía en `failed++` y ese abonado se quedaba
-- sin factura ese mes, sin reintento y sin alerta.
--
-- Se usa el TERCER argumento de setval (`is_called`) para que funcione igual con la
-- tabla llena y vacía:
--   - con filas  -> setval(max, true)   -> el siguiente nextval devuelve max + 1
--   - vacía      -> setval(inicio, false) -> el siguiente nextval devuelve `inicio`
-- No vale `setval(seq, 0)`: el mínimo de una secuencia es 1 y Postgres lo rechaza.
--
-- El valor de arranque en vacío conserva el del código anterior: 1 para las facturas
-- (`(max ?? 0) + 1`) y 1001 para el resto (`(max ?? 1000) + 1`).
--
-- Nota: las secuencias NO son transaccionales. Un rollback consume el número igual,
-- así que puede haber huecos en la numeración. Es el comportamiento correcto: un
-- hueco es inocuo, un duplicado no.

CREATE SEQUENCE IF NOT EXISTS "SubInvoice_tid_seq" AS integer;
SELECT setval(
  '"SubInvoice_tid_seq"',
  COALESCE((SELECT MAX(tid) FROM "SubInvoice"), 1),
  (SELECT COUNT(*) FROM "SubInvoice") > 0
);

CREATE SEQUENCE IF NOT EXISTS "RecurringInvoice_tid_seq" AS integer;
SELECT setval(
  '"RecurringInvoice_tid_seq"',
  COALESCE((SELECT MAX(tid) FROM "RecurringInvoice"), 1001),
  (SELECT COUNT(*) FROM "RecurringInvoice") > 0
);

CREATE SEQUENCE IF NOT EXISTS "StockReturn_tid_seq" AS integer;
SELECT setval(
  '"StockReturn_tid_seq"',
  COALESCE((SELECT MAX(tid) FROM "StockReturn"), 1001),
  (SELECT COUNT(*) FROM "StockReturn") > 0
);

CREATE SEQUENCE IF NOT EXISTS "SupplyOrder_tid_seq" AS integer;
SELECT setval(
  '"SupplyOrder_tid_seq"',
  COALESCE((SELECT MAX(tid) FROM "SupplyOrder"), 1001),
  (SELECT COUNT(*) FROM "SupplyOrder") > 0
);
