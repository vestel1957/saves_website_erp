-- Quién creó cada tarea. Hasta ahora sólo estaba `employeeId` (el eid del legacy):
-- quien no tiene ficha de empleado la creaba con 0 y la tarea quedaba sin autor, y
-- además la pantalla nunca lo mostraba. Mismos nombres que en `Ticket`, a propósito.
-- AlterTable
ALTER TABLE "TodoTask" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "createdByName" TEXT,
ADD COLUMN     "createdBySource" TEXT;
