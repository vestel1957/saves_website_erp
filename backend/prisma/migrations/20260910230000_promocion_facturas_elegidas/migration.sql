-- Promociones: facturas elegidas A MANO.
--
-- "También las atrasadas" es de todo o nada: al cliente que debe cinco facturas no
-- había forma de rebajarle sólo tres. `invoiceIds` guarda las facturas elegidas
-- (SubInvoice.id); con alguna puesta, la promoción rebaja exactamente esas y el tipo
-- y la antigüedad dejan de contar. Sólo se admite con UN cliente de público.
--
-- Vacío para todas las que existen: ninguna cambia de conducta.

ALTER TABLE "Promotion" ADD COLUMN "invoiceIds" TEXT[];
UPDATE "Promotion" SET "invoiceIds" = ARRAY[]::TEXT[];
