-- CreateTable
CREATE TABLE "MetricPoint" (
    "id" TEXT NOT NULL,
    "fecha" DATE NOT NULL,
    "periodo" TEXT NOT NULL DEFAULT 'D',
    "metrica" TEXT NOT NULL,
    "sede" TEXT NOT NULL DEFAULT '',
    "valor" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetricPoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MetricPoint_metrica_fecha_idx" ON "MetricPoint"("metrica", "fecha");

-- CreateIndex
CREATE INDEX "MetricPoint_fecha_idx" ON "MetricPoint"("fecha");

-- CreateIndex
CREATE UNIQUE INDEX "MetricPoint_fecha_periodo_metrica_sede_key" ON "MetricPoint"("fecha", "periodo", "metrica", "sede");
