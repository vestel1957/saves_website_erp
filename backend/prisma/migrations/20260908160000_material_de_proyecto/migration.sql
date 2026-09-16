-- Material cargado a un proyecto.
--
-- Los proyectos no tenían de dónde sacar material: se les podía poner presupuesto,
-- hitos y tareas, pero el cable y los conectores que se van en la obra no salían de
-- ninguna bodega. Esta tabla es el gemelo de "TicketMaterial" para proyectos:
-- descuenta "Material.qty" y guarda copia del nombre, la bodega y el precio del
-- momento, porque el catálogo se edita y el proyecto tiene que poder decir a cuánto
-- se le cargó cada cosa.
CREATE TABLE "ProjectMaterial" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "materialId" TEXT,
    "materialName" TEXT NOT NULL,
    "warehouseId" TEXT,
    "warehouseName" TEXT,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "price" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "employeeName" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMaterial_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProjectMaterial_projectId_idx" ON "ProjectMaterial"("projectId");
CREATE INDEX "ProjectMaterial_materialId_idx" ON "ProjectMaterial"("materialId");

ALTER TABLE "ProjectMaterial" ADD CONSTRAINT "ProjectMaterial_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectMaterial" ADD CONSTRAINT "ProjectMaterial_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;
