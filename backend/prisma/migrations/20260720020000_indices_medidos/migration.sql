-- Índices elegidos POR MEDICIÓN, no por inventario. De los 11 que proponía la
-- auditoría sólo estos 3 mejoran algo hoy; el resto ya iba por índice o sobre tablas
-- pequeñas (AuditLog tiene 280 filas, no las decenas de miles que se suponía).
--
--   Ticket    status + orden por fecha : 309 ms
--   Transaction  una caja por fecha    :  73 ms
--   SubInvoice   cartera vencida       :  58 ms
--
-- Crear un índice que no se usa no es gratis: ocupa disco y encarece cada escritura.

-- CreateIndex
CREATE INDEX "SubInvoice_status_dueDate_idx" ON "SubInvoice"("status", "dueDate");

-- CreateIndex
CREATE INDEX "Ticket_status_created_idx" ON "Ticket"("status", "created");

-- CreateIndex
CREATE INDEX "Transaction_cashAccountId_date_idx" ON "Transaction"("cashAccountId", "date");


-- Retirada de 5 índices GIN DUPLICADOS creados a mano en la época de
-- `optimize-search.sql`. Son idénticos (misma columna, mismos ops) a los que ya
-- gestiona Prisma sobre `Subscriber`, así que sólo suman ~3,5 MB y duplican el
-- mantenimiento GIN en cada alta o edición de cliente. Prisma no los ve porque no
-- están declarados en el schema, por eso van a mano aquí.
DROP INDEX IF EXISTS "trgm_sub_first";
DROP INDEX IF EXISTS "trgm_sub_last1";
DROP INDEX IF EXISTS "trgm_sub_company";
DROP INDEX IF EXISTS "trgm_sub_doc";
DROP INDEX IF EXISTS "trgm_sub_phone";
