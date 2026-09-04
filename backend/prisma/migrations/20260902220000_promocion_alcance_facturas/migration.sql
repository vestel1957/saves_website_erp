-- A qué FACTURAS alcanza el descuento automático de una promoción.
--
-- Hasta hoy el descuento al cobrar sólo sabía rebajar la mensualidad del mes en curso
-- (la regla del pronto pago, quemada dentro del módulo). Una campaña de recuperación
-- de cartera no descontaba nunca: lo que debe un cliente de CARTERA es de meses
-- anteriores. El alcance pasa a ser un dato de la promoción.
--
-- El default conserva el comportamiento actual: las promociones existentes siguen
-- rebajando sólo la mensualidad del mes en curso.
CREATE TYPE "PromotionInvoiceScope" AS ENUM ('MENSUALIDAD_DEL_MES', 'CUALQUIER_PENDIENTE');

ALTER TABLE "Promotion"
  ADD COLUMN "invoiceScope" "PromotionInvoiceScope" NOT NULL DEFAULT 'MENSUALIDAD_DEL_MES';
