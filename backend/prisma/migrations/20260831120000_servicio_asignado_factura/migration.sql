-- "Servicio asignado" sobre la factura (el ASIGNAR SERVICIO del legacy).
-- Marca las facturas cuyo snapshot de servicio se puso a mano: el writeback empuja
-- television/combo/puntos de ESAS al legacy y el sync de ida deja de pisarlas.
ALTER TABLE "SubInvoice" ADD COLUMN "serviceAssignedAt" TIMESTAMP(3);
ALTER TABLE "SubInvoice" ADD COLUMN "serviceAssignedBy" TEXT;
