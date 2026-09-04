-- Día en que el equipo se recogió del cliente. Nace en null a propósito: de las
-- devoluciones anteriores (y de las 12.361 filas importadas del legacy) no hay
-- fecha de recogida en ninguna parte, y ponerles una inventada haría pasar por
-- dato lo que es un hueco. Se llena de aquí en adelante.
-- AlterTable
ALTER TABLE "Equipment" ADD COLUMN     "returnedAt" DATE;

-- CreateIndex
CREATE INDEX "Equipment_returnedAt_idx" ON "Equipment"("returnedAt");
