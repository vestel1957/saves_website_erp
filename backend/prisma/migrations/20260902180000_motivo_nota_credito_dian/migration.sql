-- El motivo de la nota crédito electrónica, a la vista (2026-09-02).
--
-- La nota crédito DIAN siempre se emitió con un motivo (se le pide a quien la
-- emite y viaja a Siigo dentro del payload), pero sólo quedaba dentro del JSON
-- crudo: en la factura se veía "NOTA_CREDITO · N° DIAN 123" y nadie sabía por qué
-- se había anulado. Se guarda en su propia columna para poder mostrarlo.
--
-- Nullable a propósito: las notas crédito ya emitidas conservan su motivo dentro
-- de `payloadJson` y no se intenta reconstruir aquí.
ALTER TABLE "ElectronicInvoice" ADD COLUMN "reason" TEXT;
