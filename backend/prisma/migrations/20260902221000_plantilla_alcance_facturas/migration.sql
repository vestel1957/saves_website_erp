-- La plantilla guarda la FORMA de una campaña que se repite, y el alcance es parte de
-- esa forma: una campaña de cartera reutilizada como "sólo la mensualidad del mes"
-- volvería a no descontar nada, y sin decir por qué.
ALTER TABLE "PromotionTemplate"
  ADD COLUMN "invoiceScope" "PromotionInvoiceScope" NOT NULL DEFAULT 'MENSUALIDAD_DEL_MES';
