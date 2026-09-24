-- Seguimiento mensual de la cartera: foto del día 1 + cierre congelado. Aditiva.
-- Ver backend/src/reports/cartera-seguimiento.ts.
CREATE TABLE "CarteraSeguimiento" (
    "id" TEXT NOT NULL,
    "mes" DATE NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "branchId" TEXT,
    "estadoInicial" "SubscriberStatus" NOT NULL,
    "deudaInicial" DECIMAL(18,2) NOT NULL,
    "facturasInicial" INTEGER NOT NULL DEFAULT 0,
    "reconstruido" BOOLEAN NOT NULL DEFAULT false,
    "pagado" DECIMAL(18,2),
    "pagos" INTEGER,
    "deudaFinal" DECIMAL(18,2),
    "estadoFinal" "SubscriberStatus",
    "categoria" TEXT,
    "cerradoEn" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CarteraSeguimiento_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CarteraSeguimiento_mes_subscriberId_key" ON "CarteraSeguimiento"("mes", "subscriberId");
CREATE INDEX "CarteraSeguimiento_mes_categoria_idx" ON "CarteraSeguimiento"("mes", "categoria");
CREATE INDEX "CarteraSeguimiento_subscriberId_idx" ON "CarteraSeguimiento"("subscriberId");
