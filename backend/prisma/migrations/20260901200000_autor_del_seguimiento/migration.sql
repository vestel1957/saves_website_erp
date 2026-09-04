-- Quién escribió cada renglón del seguimiento de una orden. Hasta ahora sólo estaba
-- `employeeId` (el eid del legacy): todo lo documentado desde el ERP se guardaba con
-- 0 y la orden lo mostraba como "Sistema", aunque lo hubiera escrito una persona.
-- AlterTable
ALTER TABLE "TicketThread" ADD COLUMN     "authorId" TEXT,
ADD COLUMN     "authorName" TEXT;
