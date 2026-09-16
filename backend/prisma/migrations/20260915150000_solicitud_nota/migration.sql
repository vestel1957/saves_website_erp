-- Solicitud de nota crédito/débito desde la pestaña Cobranza del cliente.
--
-- Emitir notas es nominal (billing.notes.emit): quien atiende la llamada la PIDE y
-- se la asigna a una persona autorizada, a quien le llega el aviso. Pedirla no mueve
-- cartera. Tabla nueva: ninguna fila existente cambia. No viaja al legacy.

CREATE TABLE "NoteRequest" (
    "id" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(14,2),
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDIENTE',
    "requestedById" TEXT,
    "requestedByName" TEXT NOT NULL,
    "assignedToId" TEXT NOT NULL,
    "response" TEXT,
    "resolvedByName" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoteRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "NoteRequest_subscriberId_createdAt_idx" ON "NoteRequest"("subscriberId", "createdAt");
CREATE INDEX "NoteRequest_assignedToId_status_idx" ON "NoteRequest"("assignedToId", "status");

ALTER TABLE "NoteRequest" ADD CONSTRAINT "NoteRequest_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "Subscriber"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NoteRequest" ADD CONSTRAINT "NoteRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NoteRequest" ADD CONSTRAINT "NoteRequest_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
