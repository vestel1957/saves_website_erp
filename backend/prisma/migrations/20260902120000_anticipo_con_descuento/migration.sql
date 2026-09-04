-- Mes adelantado con descuento: el cliente paga en ventanilla el mes que todavía no
-- se ha facturado, ya rebajado. Como la factura no existe, el descuento queda
-- PROMETIDO en el anticipo y se concede (nota crédito) cuando la factura nace.
ALTER TABLE "CustomerAdvance"
  ADD COLUMN "discountPct"     DECIMAL(5,2),
  ADD COLUMN "discountAmount"  DECIMAL(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN "discountApplied" DECIMAL(18,2) NOT NULL DEFAULT 0,
  ADD COLUMN "months"          INTEGER,
  ADD COLUMN "monthlyNet"      DECIMAL(18,2);
