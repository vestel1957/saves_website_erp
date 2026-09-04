-- Observaciones y archivos del perfil del cliente que vienen del legacy.
--   · SubscriberNote.legacyId  = historiales.idn
--   · SubscriberNote.kind      = historiales.tipos (Compromiso, Traslado, ...)
--   · SubscriberFile.legacyId  = meta_data.id (type = 6)
-- El índice único es lo que hace repetible la importación y la sincronización.
ALTER TABLE "SubscriberNote" ADD COLUMN "legacyId" INTEGER;
ALTER TABLE "SubscriberNote" ADD COLUMN "kind" TEXT;
ALTER TABLE "SubscriberFile" ADD COLUMN "legacyId" INTEGER;

CREATE UNIQUE INDEX "SubscriberNote_legacyId_key" ON "SubscriberNote"("legacyId");
CREATE UNIQUE INDEX "SubscriberFile_legacyId_key" ON "SubscriberFile"("legacyId");
