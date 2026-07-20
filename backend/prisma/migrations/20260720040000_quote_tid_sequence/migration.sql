-- Secuencia para el consecutivo de cotizaciones (`Quote.tid`).
--
-- Se quedó fuera de `20260720000000_tid_sequences` porque el barrido de entonces
-- sólo miró los cuatro servicios que declaraban un `nextTid` propio, y `omni`
-- calculaba el suyo en línea. Consecuencia: `omni` seguía con MAX(tid)+1 tanto para
-- cotizaciones como —lo grave— para FACTURAS, insertando un `SubInvoice.tid` sin
-- avanzar `SubInvoice_tid_seq`, con lo que el siguiente `nextval()` habría devuelto
-- un número ya usado y la factura habría fallado con P2002.

CREATE SEQUENCE IF NOT EXISTS "Quote_tid_seq" AS integer;
SELECT setval(
  '"Quote_tid_seq"',
  COALESCE((SELECT MAX(tid) FROM "Quote"), 1001),
  (SELECT COUNT(*) FROM "Quote") > 0
);

-- Resincroniza la secuencia de facturas con el máximo real, por si alguna factura
-- se creó por la vía de `omni` entre aquella migración y esta.
SELECT setval(
  '"SubInvoice_tid_seq"',
  GREATEST(
    (SELECT last_value FROM "SubInvoice_tid_seq"),
    COALESCE((SELECT MAX(tid) FROM "SubInvoice"), 1)
  ),
  true
);
