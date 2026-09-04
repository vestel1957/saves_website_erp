-- AlterTable
ALTER TABLE "Equipment" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Las filas que ya existían no se dieron de alta "ahora": sellarlas con una fecha vieja
-- es lo que hace que el corte del writeback de inventario las deje fuera. Sin esto, abrir
-- el gate le volcaría al legacy los 12.361 equipos importados y las unidades de prueba.
UPDATE "Equipment" SET "createdAt" = '2020-01-01 00:00:00';
