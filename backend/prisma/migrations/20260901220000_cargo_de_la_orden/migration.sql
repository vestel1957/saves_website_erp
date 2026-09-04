-- Cargo de la orden (ver billing/cargos-orden.ts).
--
-- Hasta hoy el único trabajo que se facturaba solo al abrirlo era el traslado, y su
-- factura se anotaba en `moveInvoiceTid`, una columna con "move" en el nombre. Al
-- entrar 'AgregarInternet' —pago único de 30.000— hacen falta las dos columnas
-- genéricas. `moveInvoiceTid` se queda: en un traslado lleva el mismo número.
ALTER TABLE "Ticket" ADD COLUMN "chargeInvoiceTid" INTEGER;
ALTER TABLE "Ticket" ADD COLUMN "chargeConcept" TEXT;

-- Los traslados ya cobrados arrancan con el dato que ya tenían, para que la orden
-- siga diciendo con qué factura se cobró aunque se lea por la columna nueva.
UPDATE "Ticket"
   SET "chargeInvoiceTid" = "moveInvoiceTid",
       "chargeConcept"    = 'Traslado'
 WHERE "moveInvoiceTid" IS NOT NULL;
