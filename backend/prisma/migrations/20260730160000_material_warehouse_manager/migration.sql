-- Encargado de la bodega de material: quien recibe y firma los traspasos que
-- entran. Las bodegas de técnico no lo usan (allí manda "technicianRef").

-- AlterTable
ALTER TABLE "MaterialWarehouse" ADD COLUMN "managerId" TEXT;

-- CreateIndex
CREATE INDEX "MaterialWarehouse_managerId_idx" ON "MaterialWarehouse"("managerId");

-- AddForeignKey
ALTER TABLE "MaterialWarehouse" ADD CONSTRAINT "MaterialWarehouse_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
