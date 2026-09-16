-- POR QUÉ se emitió la factura (motivo: mensualidad/afiliacion/traslado/reconexion/venta/otro).
-- Columna de este sistema: el legacy no tiene dónde guardarla, así que es opcional y
-- las facturas importadas y las de la corrida mensual la dejan en NULL.
ALTER TABLE "SubInvoice" ADD COLUMN "purpose" TEXT;

-- Orden de trabajo que espera a que se pague SU factura (hoy, el traslado).
CREATE TABLE "PendingOrder" (
    "id" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "motivo" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "resumen" TEXT,
    "context" TEXT,
    "ticketId" TEXT,
    "ticketCode" INTEGER,
    "fulfilledAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingOrder_pkey" PRIMARY KEY ("id")
);

-- Una factura dispara UNA orden: es el candado contra la orden duplicada.
CREATE UNIQUE INDEX "PendingOrder_invoiceId_key" ON "PendingOrder"("invoiceId");
CREATE INDEX "PendingOrder_subscriberId_idx" ON "PendingOrder"("subscriberId");
-- El barrido de los 5 minutos sólo mira las que siguen pendientes.
CREATE INDEX "PendingOrder_fulfilledAt_idx" ON "PendingOrder"("fulfilledAt");

ALTER TABLE "PendingOrder" ADD CONSTRAINT "PendingOrder_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PendingOrder" ADD CONSTRAINT "PendingOrder_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SubInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
