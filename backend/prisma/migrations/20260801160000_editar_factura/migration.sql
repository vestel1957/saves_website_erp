-- Edición de facturas desde este sistema.
-- `editedAt` marca la factura como editada aquí para que el sync de ida
-- (scripts/sync-legacy-vivo.js) no le restaure los valores del legacy.
ALTER TABLE "SubInvoice"
  ADD COLUMN "editedAt" TIMESTAMP(3),
  ADD COLUMN "editedBy" TEXT,
  ADD COLUMN "editCount" INTEGER NOT NULL DEFAULT 0;
