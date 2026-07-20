-- Huella de posición de funcionarios, grabada por acción (ver modelo GeoPing).
CREATE TABLE "GeoPing" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "staffId" TEXT,
    "lat" DOUBLE PRECISION NOT NULL,
    "lng" DOUBLE PRECISION NOT NULL,
    "accuracy" DOUBLE PRECISION,
    "reason" TEXT NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeoPing_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GeoPing_userId_createdAt_idx" ON "GeoPing"("userId", "createdAt");
CREATE INDEX "GeoPing_createdAt_idx" ON "GeoPing"("createdAt");

-- El mapa de abonados filtra por coordenadas presentes; sin esto son 21.772 filas
-- escaneadas para devolver 1.882.
CREATE INDEX IF NOT EXISTS "Subscriber_gpsLat_idx" ON "Subscriber"("gpsLat");
