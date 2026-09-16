-- Promociones: el ALCANCE pasa a ser dos cosas separadas.
--
-- `PromotionInvoiceScope` mezclaba el TIPO de factura con su ANTIGÜEDAD en un solo
-- enum de tres valores, y por eso no había forma de pedir una campaña que rebajara
-- SÓLO los cargos (instalación, traslado, reconexión): toda opción que alcanzaba un
-- cargo alcanzaba también la mensualidad. Ahora son `invoiceKinds` (RECURRENTE y/o
-- FIJA) y `onlyCurrentMonth`.
--
-- Equivalencias exactas de lo que había:
--   MENSUALIDAD_DEL_MES      → [RECURRENTE]        + sólo el mes en curso
--   MENSUALIDADES_PENDIENTES → [RECURRENTE]        + también lo atrasado
--   CUALQUIER_PENDIENTE      → [RECURRENTE, FIJA]  + también lo atrasado

ALTER TABLE "Promotion"
  ADD COLUMN "invoiceKinds" "InvoiceKind"[] DEFAULT ARRAY['RECURRENTE']::"InvoiceKind"[],
  ADD COLUMN "onlyCurrentMonth" BOOLEAN NOT NULL DEFAULT true;

UPDATE "Promotion" SET
  "invoiceKinds" = CASE
    WHEN "invoiceScope" = 'CUALQUIER_PENDIENTE'
      THEN ARRAY['RECURRENTE', 'FIJA']::"InvoiceKind"[]
    ELSE ARRAY['RECURRENTE']::"InvoiceKind"[]
  END,
  "onlyCurrentMonth" = ("invoiceScope" = 'MENSUALIDAD_DEL_MES');

ALTER TABLE "PromotionTemplate"
  ADD COLUMN "invoiceKinds" "InvoiceKind"[] DEFAULT ARRAY['RECURRENTE']::"InvoiceKind"[],
  ADD COLUMN "onlyCurrentMonth" BOOLEAN NOT NULL DEFAULT true;

UPDATE "PromotionTemplate" SET
  "invoiceKinds" = CASE
    WHEN "invoiceScope" = 'CUALQUIER_PENDIENTE'
      THEN ARRAY['RECURRENTE', 'FIJA']::"InvoiceKind"[]
    ELSE ARRAY['RECURRENTE']::"InvoiceKind"[]
  END,
  "onlyCurrentMonth" = ("invoiceScope" = 'MENSUALIDAD_DEL_MES');

ALTER TABLE "Promotion" DROP COLUMN "invoiceScope";
ALTER TABLE "PromotionTemplate" DROP COLUMN "invoiceScope";
DROP TYPE "PromotionInvoiceScope";
