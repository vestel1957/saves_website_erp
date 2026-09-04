-- Devolución de material del técnico a la bodega principal de su sede.
--
-- La bodega de material no tenía sede (la de equipos sí, `EquipmentWarehouse.branchLegacy`),
-- así que no había forma de saber a DÓNDE devuelve un técnico ni QUIÉN responde por
-- esa bodega. Se le añade la sede y la marca de "principal", y al acta la sede cuya
-- cajera firma el recibido.
--
-- El mapeo de las 61 bodegas existentes lo hace, y lo reporta,
-- `prisma/migrate-bodegas-material-sede-2026-09.ts`.
ALTER TABLE "MaterialWarehouse" ADD COLUMN "branchLegacy" INTEGER;
ALTER TABLE "MaterialWarehouse" ADD COLUMN "isMain" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "MaterialWarehouse_branchLegacy_idx" ON "MaterialWarehouse"("branchLegacy");

ALTER TABLE "MaterialActa" ADD COLUMN "assignedBranchLegacy" INTEGER;
