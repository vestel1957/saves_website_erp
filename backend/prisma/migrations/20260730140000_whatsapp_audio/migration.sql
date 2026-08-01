-- Nota de voz entrante guardada en disco, para poder escucharla desde la bandeja.
-- Antes el audio se transcribía en memoria y se descartaba: solo quedaba "(nota de voz)".
ALTER TABLE "WhatsappMessage" ADD COLUMN     "audioPath" TEXT,
ADD COLUMN     "audioMime" TEXT;
