-- Quién generó la orden de servicio. Hasta ahora sólo estaba `col` (texto libre
-- heredado del legacy: el username de allá, vacío en 135.153 órdenes viejas).
-- AlterTable
ALTER TABLE "Ticket" ADD COLUMN     "createdByName" TEXT,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "createdBySource" TEXT;
