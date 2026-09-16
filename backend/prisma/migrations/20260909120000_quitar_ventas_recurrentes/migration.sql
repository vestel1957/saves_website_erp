-- Se retira el módulo "Ventas recurrentes" (plantillas de factura, legacy `rec_invoices`).
--
-- Nunca entró en uso: el ETL del legacy jamás trajo `rec_invoices`, así que la tabla
-- solo llegó a tener 1 fila de prueba del 2026-07-02 (tid 1001, sin ítems). Quien
-- factura la mensualidad es la corrida del día 1 (`facturas.generate`, cron
-- RECURRING_BILLING) — que se llama parecido pero no toca estas tablas.
DROP TABLE IF EXISTS "RecurringInvoiceItem";
DROP TABLE IF EXISTS "RecurringInvoice";
DROP SEQUENCE IF EXISTS "RecurringInvoice_tid_seq";
