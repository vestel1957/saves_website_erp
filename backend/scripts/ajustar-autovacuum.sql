-- Ajuste de autovacuum para las tablas grandes.
--
-- EL PROBLEMA
-- El valor global `autovacuum_vacuum_scale_factor = 0.2` exige que el 20% de las
-- filas estén muertas antes de actuar. En una tabla de 454.000 filas eso son 90.000
-- filas muertas de margen, así que autovacuum sencillamente no pasa: SubInvoice
-- llevaba desde el 2026-07-02 sin vacuum, con 22.601 muertas (4,7%).
--
-- La consecuencia no es sólo espacio. El mapa de visibilidad se queda obsoleto y los
-- *Index Only Scan* dejan de ser "only": Postgres tiene que ir a la tabla fila por
-- fila. Medido en producción: contar facturas pendientes hacía 23.151 accesos a la
-- tabla y tardaba 15 ms; sobre una copia recién restaurada, 0 accesos y 2,7 ms.
--
-- EL AJUSTE
-- Un factor proporcional no sirve para tablas grandes: hay que pasar a un umbral
-- prácticamente absoluto. Con 0.02 + 1000, una tabla de 500.000 filas se limpia al
-- llegar a ~11.000 muertas en vez de a 100.000.
--
-- `insert_scale_factor` cubre el otro caso: tablas que sólo CRECEN no generan filas
-- muertas, pero sus páginas nuevas quedan marcadas como "no todas visibles" hasta que
-- pasa un vacuum — y eso basta para estropear los Index Only Scan.
--
-- Uso:  psql "$DATABASE_URL" -f scripts/ajustar-autovacuum.sql

ALTER TABLE "SubInvoice"     SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000, autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.02);
ALTER TABLE "SubInvoiceItem" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000, autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.02);
ALTER TABLE "Transaction"    SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000, autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.02);
ALTER TABLE "ElectronicInvoice" SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000, autovacuum_analyze_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.02);

-- Tablas que sólo crecen: no acumulan filas muertas, pero sí páginas sin marcar.
ALTER TABLE "ReceiptTransaction"      SET (autovacuum_vacuum_insert_scale_factor = 0.02);
ALTER TABLE "Ticket"                  SET (autovacuum_vacuum_insert_scale_factor = 0.02);
ALTER TABLE "PaymentReceipt"          SET (autovacuum_vacuum_insert_scale_factor = 0.02);
ALTER TABLE "TicketThread"            SET (autovacuum_vacuum_insert_scale_factor = 0.02);
ALTER TABLE "CalendarEvent"           SET (autovacuum_vacuum_insert_scale_factor = 0.02);
ALTER TABLE "SubscriberStatusHistory" SET (autovacuum_vacuum_insert_scale_factor = 0.02);
ALTER TABLE "Subscriber"              SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 500);
