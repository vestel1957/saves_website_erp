-- Reserva de equipo al abrir la orden: la unidad que el sistema aparta de la bodega
-- de la sede para una instalación/cambio/migración/traslado, para que al autenticar
-- la ONU sea "el equipo que el cliente tiene asignado".
ALTER TABLE "Equipment" ADD COLUMN "reservedTicketId" TEXT;
CREATE INDEX "Equipment_reservedTicketId_idx" ON "Equipment"("reservedTicketId");
