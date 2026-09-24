-- Tipo de venta del alta: Oficina / Redes sociales (Facebook, Instagram, TikTok) /
-- Referido (Familiar, Amigo, Funcionario). Ver backend/src/subscribers/canal-venta.ts.
ALTER TABLE "Subscriber" ADD COLUMN "saleChannel" TEXT,
ADD COLUMN "saleSubchannel" TEXT;
CREATE INDEX "Subscriber_saleChannel_saleSubchannel_idx" ON "Subscriber"("saleChannel", "saleSubchannel");
