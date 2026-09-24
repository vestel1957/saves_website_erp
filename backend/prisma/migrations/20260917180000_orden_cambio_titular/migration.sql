-- Orden 'Cambio de titular': datos del nuevo titular y foto del anterior.
ALTER TABLE "Ticket" ADD COLUMN "holderTo" JSONB,
ADD COLUMN "holderToText" TEXT,
ADD COLUMN "holderFrom" JSONB,
ADD COLUMN "holderFromText" TEXT,
ADD COLUMN "holderAppliedAt" TIMESTAMP(3);
