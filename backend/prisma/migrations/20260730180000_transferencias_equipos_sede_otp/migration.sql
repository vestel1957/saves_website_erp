-- Transferencias de equipos acotadas por sede + firma con OTP (2026-07-30).
--
-- 1) La bodega de equipos no sabía a qué sede pertenece (el legacy solo guardaba el
--    nombre), así que no había con qué acotar a una cajera. Se añade la sede como
--    `Branch.legacyId`, igual que `CashAccount.branchLegacy`. NULL = bodega sin sede
--    ("Depurados"): esa solo la mueve el jefe de bodega.
-- 2) Entre sedes el equipo no sale hasta que la cajera encargada de la sede origen
--    firma la SALIDA con un código OTP, y entra cuando quien recibe firma la ENTRADA
--    (`received*`, ya existía). El OTP vive en la propia transferencia: una firma a la
--    vez, se limpia al consumirlo y solo lo puede usar el usuario al que se le mandó.

-- AlterTable
ALTER TABLE "EquipmentWarehouse" ADD COLUMN "branchLegacy" INTEGER;

-- CreateIndex
CREATE INDEX "EquipmentWarehouse_branchLegacy_idx" ON "EquipmentWarehouse"("branchLegacy");

-- AlterTable
ALTER TABLE "EquipmentTransfer" ADD COLUMN "signedOutById" TEXT,
                                 ADD COLUMN "signedOutByName" TEXT,
                                 ADD COLUMN "signedOutAt" TIMESTAMP(3),
                                 ADD COLUMN "otpStep" TEXT,
                                 ADD COLUMN "otpHash" TEXT,
                                 ADD COLUMN "otpUserId" TEXT,
                                 ADD COLUMN "otpExpiraAt" TIMESTAMP(3),
                                 ADD COLUMN "otpIntentos" INTEGER NOT NULL DEFAULT 0;
