-- Índices trigram (pg_trgm) para acelerar las búsquedas ILIKE '%...%'.
-- Idempotente. IMPORTANTE: re-ejecutar tras cada `prisma db push`
-- (db push puede eliminar índices que no están en el schema).
--   psql "$DATABASE_URL" -f scripts/optimize-search.sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Suscriptores (búsqueda usada también por facturas/tickets/transacciones vía join)
CREATE INDEX IF NOT EXISTS trgm_sub_first    ON "Subscriber" USING gin ("firstName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_sub_last1    ON "Subscriber" USING gin ("lastName1" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_sub_company  ON "Subscriber" USING gin ("companyName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_sub_fullname ON "Subscriber" USING gin ("fullName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_sub_doc      ON "Subscriber" USING gin ("docNumber" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_sub_phone    ON "Subscriber" USING gin ("phone1" gin_trgm_ops);

-- Tickets / órdenes
CREATE INDEX IF NOT EXISTS trgm_ticket_subject  ON "Ticket" USING gin ("subject" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_ticket_assigned ON "Ticket" USING gin ("assigned" gin_trgm_ops);

-- Transacciones
CREATE INDEX IF NOT EXISTS trgm_tx_payer   ON "Transaction" USING gin ("payerName" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_tx_note    ON "Transaction" USING gin ("note" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_tx_account ON "Transaction" USING gin ("accountName" gin_trgm_ops);

-- Equipos / ONUs (red)
CREATE INDEX IF NOT EXISTS trgm_equip_mac    ON "Equipment" USING gin ("mac" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_equip_serial ON "Equipment" USING gin ("serial" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_onu_sn       ON "OltOnu" USING gin ("sn" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS trgm_onu_client   ON "OltOnu" USING gin ("clientName" gin_trgm_ops);
