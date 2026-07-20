-- Señales de ubicación simulada (ver spoof.policy.ts). Son indicios para revisar,
-- no pruebas: por eso viven como lista de etiquetas y no como un booleano "hizo trampa".
ALTER TABLE "Ticket" ADD COLUMN "closeFlags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "GeoPing" ADD COLUMN "flags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
