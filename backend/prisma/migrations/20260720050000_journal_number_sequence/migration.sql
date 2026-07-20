-- Secuencia para el consecutivo de asientos contables (`JournalEntry.number`).
--
-- Es la carrera gemela de la del `tid` de facturas, y se quedó sin ver en el barrido
-- anterior porque no usa `aggregate({_max})` sino `findFirst({orderBy:{number:'desc'}})`.
-- El efecto es idéntico: dos asientos simultáneos leen el mismo último número, y como
-- `number` es `@unique` (`schema.prisma:327`), el segundo falla con P2002.
--
-- Importa más de lo que parece: la contabilización automática de facturas y recaudos
-- pasa por aquí, y su fallo se traga a propósito (`PostingService.safePost`), así que
-- una colisión no rompería la factura — la dejaría sin asiento y sólo aparecería como
-- un pendiente contable. Silencioso, que es lo peor que puede ser.

CREATE SEQUENCE IF NOT EXISTS "JournalEntry_number_seq" AS integer;
SELECT setval(
  '"JournalEntry_number_seq"',
  COALESCE((SELECT MAX(number) FROM "JournalEntry"), 1),
  (SELECT COUNT(*) FROM "JournalEntry") > 0
);
