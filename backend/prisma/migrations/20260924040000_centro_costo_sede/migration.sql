-- Centro de costo por sede (contabilidad de gestión). Aditiva.
-- Ver docs/centros-de-costo/PLAN.md (fase 1) y scripts/sembrar-centros-costo.ts.
-- Hecha a mano: `migrate dev` quería además borrar las tablas Pqr* (deriva ajena a esto).

-- CreateEnum
CREATE TYPE "CostCenterKind" AS ENUM ('SEDE', 'GENERAL', 'OTRO');

-- AlterTable
ALTER TABLE "CostCenter" ADD COLUMN "kind" "CostCenterKind" NOT NULL DEFAULT 'OTRO';

-- AlterTable
ALTER TABLE "Branch" ADD COLUMN "costCenterId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Branch_costCenterId_key" ON "Branch"("costCenterId");

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_costCenterId_fkey" FOREIGN KEY ("costCenterId") REFERENCES "CostCenter"("id") ON DELETE SET NULL ON UPDATE CASCADE;
