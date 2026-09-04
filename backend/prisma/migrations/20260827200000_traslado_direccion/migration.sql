-- La orden de 'Traslado' pasa a portar A DÓNDE se muda el cliente y con qué factura
-- se cobró el traslado. Antes la orden solo decía "traslado" y la dirección destino
-- no estaba en ninguna parte: el técnico salía sin ella y el cargo de 30.000
-- (producto 'Traslado' del catálogo) se facturaba a mano o se quedaba sin cobrar.
ALTER TABLE "Ticket" ADD COLUMN "moveTo" JSONB;
ALTER TABLE "Ticket" ADD COLUMN "moveToText" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "moveFromText" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "moveInvoiceTid" INTEGER;
ALTER TABLE "Ticket" ADD COLUMN "moveAppliedAt" TIMESTAMP(3);
