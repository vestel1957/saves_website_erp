-- Carpeta de documentos del funcionario.
--
-- Cuelga de "Staff" y no de "Employee": ese último es el modelo del módulo de
-- RRHH y tiene 0 filas, mientras que los 115 empleados reales están en "Staff".
-- La tabla "EmployeeDocument" queda como estaba (vacía y sin código); no se
-- borra en esta migración porque eso es una decisión del módulo de RRHH.
CREATE TYPE "StaffDocumentKind" AS ENUM ('CV', 'IDENTITY', 'CONTRACT', 'CERTIFICATE', 'OTHER');

CREATE TABLE "StaffDocument" (
    "id"           TEXT NOT NULL,
    "staffId"      TEXT NOT NULL,
    "kind"         "StaffDocumentKind" NOT NULL DEFAULT 'OTHER',
    "fileName"     TEXT NOT NULL,
    "storedName"   TEXT NOT NULL,
    "mimeType"     TEXT NOT NULL,
    "size"         INTEGER NOT NULL,
    "description"  TEXT,
    "uploadedById" TEXT,
    "uploadedBy"   TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffDocument_pkey" PRIMARY KEY ("id")
);

-- Borrar al funcionario se lleva sus documentos: no tiene sentido conservar la
-- hoja de vida de una ficha que ya no existe, y son datos personales.
ALTER TABLE "StaffDocument" ADD CONSTRAINT "StaffDocument_staffId_fkey"
  FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- La consulta real es "documentos de este funcionario, del más reciente".
CREATE INDEX "StaffDocument_staffId_createdAt_idx" ON "StaffDocument"("staffId", "createdAt");
CREATE INDEX "StaffDocument_kind_idx" ON "StaffDocument"("kind");
