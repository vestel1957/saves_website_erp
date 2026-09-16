-- "La última factura recurrente de cada abonado": DISTINCT ON (subscriberId)
-- ORDER BY invoiceDate DESC, tid DESC. Sin este índice ese recorrido ordena en
-- disco las 445.000 facturas (2.0 s); con él es un recorrido de índice (0.7 s).
-- Lo piden el plan contratado de la ficha, el estado por servicio y el cartel de
-- servicio de las listas de órdenes (`common/servicios-del-abonado.ts`).
CREATE INDEX IF NOT EXISTS "SubInvoice_subscriberId_invoiceDate_tid_idx"
    ON "SubInvoice" ("subscriberId", "invoiceDate" DESC, "tid" DESC);
