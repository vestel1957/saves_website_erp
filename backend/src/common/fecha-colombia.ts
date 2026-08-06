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

/** Colombia no tiene horario de verano: siempre UTC-5, todo el año y desde siempre. */
const OFFSET_COLOMBIA_MS = 5 * 60 * 60 * 1000;

const SOLO_FECHA = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `'YYYY-MM-DD'` → el INSTANTE en que empieza ese día en Colombia.
 *
 * Ojo con la diferencia respecto de `hoyEnColombia()`, que es la que se cuela sola:
 * aquella devuelve la medianoche *UTC* porque las columnas `date` de Prisma no
 * guardan hora y hay que atarlas a ese punto exacto. Esta devuelve un instante de
 * verdad —las 00:00 de Colombia son las 05:00 UTC— y es la que sirve para acotar
 * columnas con hora (`CalendarEvent.start`). Usar la otra aquí corre el rango cinco
 * horas: el filtro de la agenda dejaba fuera lo de la mañana y colaba lo de la tarde
 * del día anterior.
 *
 * @returns `null` si el texto no es una fecha `YYYY-MM-DD` válida (incluye cosas
 *          como `2026-02-31`, que `new Date()` acepta rodando al mes siguiente).
 */
export function inicioDelDiaColombia(fecha: string): Date | null {
  const m = SOLO_FECHA.exec(fecha.trim());
  if (!m) return null;
  const [y, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = new Date(Date.UTC(y, mes - 1, d));
  // `Date.UTC(2026, 1, 31)` no falla: devuelve el 3 de marzo. Se comprueba que el
  // día no se haya movido, o "31 de febrero" filtraría por una fecha que no se pidió.
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mes - 1 || utc.getUTCDate() !== d) return null;
  return new Date(utc.getTime() + OFFSET_COLOMBIA_MS);
}

/**
 * Rango de instantes de un filtro "Desde / Hasta" escrito en días de Colombia.
 *
 * El extremo derecho es **exclusivo** y cae en la medianoche del día SIGUIENTE, que
 * es lo que hace que "hasta el 4" incluya el 4 entero. Con el `lte` a la medianoche
 * del propio día —lo que había— un rango de un solo día no devolvía nada y el
 * filtro parecía roto; en realidad pedía los eventos que empezaran exactamente a las
 * 00:00:00.000.
 *
 * @returns `null` si alguna fecha es inválida o el rango está invertido; el llamador
 *          decide cómo se lo cuenta al usuario (aquí no hay excepciones de Nest).
 */
export function rangoDeDiasColombia(
  desde?: string | null,
  hasta?: string | null,
): { gte?: Date; lt?: Date } | null {
  const d = desde?.trim() ? inicioDelDiaColombia(desde) : undefined;
  if (d === null) return null;
  const h = hasta?.trim() ? inicioDelDiaColombia(hasta) : undefined;
  if (h === null) return null;
  const lt = h ? new Date(h.getTime() + 24 * 60 * 60 * 1000) : undefined;
  if (d && lt && d.getTime() >= lt.getTime()) return null;
  return { ...(d ? { gte: d } : {}), ...(lt ? { lt } : {}) };
}
