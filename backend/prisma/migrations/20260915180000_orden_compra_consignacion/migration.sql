-- Datos de la consignación en la orden de compra: a qué cuenta se le paga al proveedor.
ALTER TABLE "SupplyOrder" ADD COLUMN "payBank" TEXT,
ADD COLUMN "payAccountType" TEXT,
ADD COLUMN "payAccount" TEXT,
ADD COLUMN "payHolder" TEXT,
ADD COLUMN "payHolderDoc" TEXT;
