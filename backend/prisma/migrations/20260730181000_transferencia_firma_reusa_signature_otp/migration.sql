-- La firma de la transferencia se cuelga del OTP de firma que ya existe (2026-07-30).
--
-- La migración anterior le puso a `EquipmentTransfer` sus propias columnas de OTP
-- (paso, hash, usuario, vencimiento, intentos) sin ver que el ERP ya tiene
-- `SignatureOtpService` + tabla `SignatureOtp` haciendo exactamente eso para la
-- aprobación de órdenes de compra —con hash scrypt, tope de intentos, tope diario,
-- plantilla aprobada de Meta y modo simulación—. Su propio módulo lo anticipaba:
-- "mañana los egresos de caja o la salida de equipo entre sedes".
--
-- Así que se van esas columnas (nunca se usaron: se crearon hace minutos) y queda
-- solo el RASTRO de cada firma: quién, cuándo y a qué WhatsApp salió el código.
-- Los propósitos nuevos son `equipment.dispatch` (salida) y `equipment.receive`.

-- AlterTable
ALTER TABLE "EquipmentTransfer" DROP COLUMN "otpStep",
                                DROP COLUMN "otpHash",
                                DROP COLUMN "otpUserId",
                                DROP COLUMN "otpExpiraAt",
                                DROP COLUMN "otpIntentos",
                                ADD COLUMN "signedOutSignature" TEXT,
                                ADD COLUMN "receivedSignature" TEXT;
