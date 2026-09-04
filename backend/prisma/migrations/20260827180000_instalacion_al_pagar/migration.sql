-- La orden de instalación deja de nacer en el alta: se abre sola cuando se paga
-- la factura de afiliación. Aquí queda lo que espera en medio.
CREATE TABLE "PendingInstall" (
    "id" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "context" TEXT,
    "assigned" TEXT,
    "scheduledFor" DATE,
    "ticketId" TEXT,
    "ticketCode" INTEGER,
    "fulfilledAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingInstall_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PendingInstall_invoiceId_key" ON "PendingInstall"("invoiceId");
CREATE INDEX "PendingInstall_subscriberId_idx" ON "PendingInstall"("subscriberId");
CREATE INDEX "PendingInstall_fulfilledAt_idx" ON "PendingInstall"("fulfilledAt");

ALTER TABLE "PendingInstall" ADD CONSTRAINT "PendingInstall_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PendingInstall" ADD CONSTRAINT "PendingInstall_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "SubInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
