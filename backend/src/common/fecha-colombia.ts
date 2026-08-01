/**
 * Hoy a medianoche, en hora de COLOMBIA y expresado en UTC — que es como Prisma
 * lee y escribe las columnas `date` (`Ticket.created`, `finalDate`, `scheduledFor`).
 *
 * Con `Date.UTC` sobre la fecha UTC, entre las 7 PM y la medianoche de Colombia el
 * "hoy" del panel ya era mañana: el técnico que cerraba una orden a las 8 PM la veía
 * desaparecer de "resueltas hoy". Misma zona que los cron y los PDF.
 *
 * Vive en `common/` desde 2026-07-31: lo necesitan el panel del técnico y la agenda,
 * y dos copias de esto es exactamente cómo empiezan los desfases de un día.
 */
export function hoyEnColombia(): Date {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const parte = (tipo: string) => Number(partes.find((p) => p.type === tipo)?.value);
  return new Date(Date.UTC(parte('year'), parte('month') - 1, parte('day')));
}
