-- ESTADO DE SERVICIO (estado_tv / estado_combo) movido DESDE AQUÍ sobre la factura.
-- Gemela de `serviceAssignedAt`, pero para el corte y no para el plan: mientras esté
-- puesta, la ida no pisa esas dos columnas y el writeback las empuja al legacy; en
-- cuanto los dos lados coinciden, la marca se borra y el legacy vuelve a mandar.
ALTER TABLE "SubInvoice" ADD COLUMN "serviceStatusAt" TIMESTAMP(3);
ALTER TABLE "SubInvoice" ADD COLUMN "serviceStatusBy" TEXT;
