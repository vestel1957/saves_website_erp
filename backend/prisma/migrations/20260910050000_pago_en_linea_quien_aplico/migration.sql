-- Quién imputó la plata de un pago del portal: NEXUS o LEGACY.
--
-- Hasta el 2026-09-10 la imputaba SIEMPRE el legacy (el portal le hablaba a él) y desde
-- ese día la imputa este sistema. Saber cuál de los dos fue no se puede deducir del
-- movimiento: el writeback adopta el gemelo del legacy y le estampa su `legacyId`, con
-- lo que un recaudo nacido aquí acaba pareciendo traído de allá.
ALTER TABLE "PaymentOrder" ADD COLUMN "appliedBy" TEXT;

-- Todo lo que ya estaba aplicado antes de la columna es del legacy, por definición.
UPDATE "PaymentOrder" SET "appliedBy" = 'LEGACY' WHERE "appliedAt" IS NOT NULL;
