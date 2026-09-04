-- Marca de "esta orden se tocó en nexus": quién manda cuando los dos sistemas la mueven.
-- Sin esto la vuelta no es bidireccional: al empujar la orden recibe su legacyId, entra
-- en la ventana del sync de ida y el legacy le devuelve el estado viejo cada 15 min.
ALTER TABLE "Ticket" ADD COLUMN "editedAt" TIMESTAMP(3);
ALTER TABLE "Ticket" ADD COLUMN "editedBy" TEXT;

-- El sync de ida filtra por esta columna en cada pasada (WHERE ... editedAt IS NULL).
CREATE INDEX "Ticket_editedAt_idx" ON "Ticket"("editedAt");
