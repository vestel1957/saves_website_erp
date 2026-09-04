/**
 * Fecha y hora de COLOMBIA, en los formatos exactos con los que habla el legacy.
 *
 * Vive aquí y no en cada script porque los dos sentidos de la caja se leen contra el
 * mismo reloj: el writeback escribe `finicial`/`hinicial` en `aauth_users` y la ida los
 * vuelve a leer para crear la apertura de este lado. Si las dos puntas usaran su propia
 * conversión, un desfase de una hora convertiría una apertura en un eco infinito —cada
 * pasada creería que la otra no la ha reflejado.
 *
 * El servidor corre en Europe/Berlin y MySQL estampa local, así que NADA de esto puede
 * salir de `new Date()` a secas: hay que pedir la zona explícitamente.
 *
 * Hermano de `src/common/fecha-colombia.ts`, que hace lo mismo para el backend. Están
 * separados porque los scripts corren en JS sin pasar por el build (el cron los lanza
 * como proceso hijo desde el árbol de fuentes), no porque la regla sea distinta: si
 * cambia el criterio, cambian los dos.
 */
const TZ_CO = 'America/Bogota';

/** 'YYYY-MM-DD' del día colombiano de ese instante. */
const FECHA_CO = (d) => new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ_CO, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(d);

/** 'HH:MM:00' — el legacy nunca guarda segundos en `hinicial`, y aquí se le habla igual. */
const HORA_CO = (d) => new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ_CO, hour: '2-digit', minute: '2-digit', hour12: false,
}).format(d) + ':00';

/** '7:44 am' — el formato exacto con el que el legacy guarda la hora en su historial. */
const HORA_CO_AMPM = (d) => new Intl.DateTimeFormat('en-US', {
  timeZone: TZ_CO, hour: 'numeric', minute: '2-digit', hour12: true,
}).format(d).toLowerCase().replace(/\s/g, ' ');

/** Hora de Colombia con segundos, para el sello `fecha` del historial. */
const HORA_CO_SEG = (d) => new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ_CO, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(d);

/**
 * El camino de vuelta: 'YYYY-MM-DD' + 'HH:MM:SS' de Colombia → el instante real (UTC).
 *
 * Colombia no tiene horario de verano desde 1993, así que el desfase es -05:00 fijo y se
 * escribe literal. Construirlo con `new Date('...T07:22:00')` lo interpretaría en la zona
 * del proceso (Berlín) y guardaría la apertura siete horas antes de que ocurriera.
 *
 * `hora` acepta lo que devuelva el legacy: 'HH:MM', 'HH:MM:SS' o vacío (→ medianoche).
 */
const INSTANTE_CO = (fecha, hora) => {
  const h = String(hora || '00:00:00').trim();
  const partes = h.split(':');
  const hhmmss = [partes[0] ?? '00', partes[1] ?? '00', partes[2] ?? '00']
    .map((x) => String(x).padStart(2, '0')).join(':');
  const d = new Date(`${fecha}T${hhmmss}-05:00`);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Medianoche UTC del día 'YYYY-MM-DD': lo que espera una columna `date` de Postgres. */
const DIA_UTC = (fecha) => new Date(`${fecha}T00:00:00.000Z`);

module.exports = { TZ_CO, FECHA_CO, HORA_CO, HORA_CO_AMPM, HORA_CO_SEG, INSTANTE_CO, DIA_UTC };
