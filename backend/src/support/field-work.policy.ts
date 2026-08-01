/**
 * Qué órdenes son TRABAJO DE CAMPO y cuáles son movimientos administrativos.
 *
 * Nace de un número: de las 13.835 órdenes de los últimos 90 días, 11.207 (81%)
 * son cortes y reconexiones que dispara cartera o el propio sistema, sin que
 * nadie salga a la calle. Si el tablero de rendimiento las cuenta, el primer
 * puesto se lo lleva quien ejecuta cortes desde una oficina (1.627 en el
 * periodo) y el técnico que hizo 205 revisiones en poste queda de sexto.
 *
 * Por eso la clasificación no es un detalle de presentación: es la condición
 * para que el ranking signifique algo.
 *
 * La lista se puede ajustar sin tocar código con el AppSetting
 * `tickets.fieldTypes` (nombres de tipo exactos, separados por coma). Si está
 * definido, MANDA sobre los patrones de abajo.
 *
 * NO confundir con `TIPOS_DE_CAMPO_POR_DEFECTO` de geofence.policy.ts. Esa lista
 * es más corta a propósito porque responde otra pregunta: "¿para qué órdenes hay
 * que exigir que el técnico esté EN LA CASA DEL ABONADO al cerrar?". Un
 * mantenimiento de red de fibra es trabajo de campo (cuenta aquí) pero no ocurre
 * en ningún domicilio, así que no puede tener geo-cerca (no cuenta allá). Son dos
 * listas distintas porque son dos preguntas distintas; unificarlas rompe una de
 * las dos.
 */

import { normalizarTipo } from './geofence.policy';

/**
 * Patrones de los tipos que sí implican visita (al domicilio o a la red).
 * Se comparan sin tildes ni mayúsculas contra `Ticket.type`.
 */
const CAMPO = [
  'revision', // Revision de Internet / de television / tv e internet
  'instalac', // Instalacion · Reinstalación · Instalación y/o Mantenimiento de Equipos Activos
  'traslado',
  'punto nuevo',
  'toma adicional',
  'agregartelevision',
  'agregarinternet',
  'equipo adicional',
  'servicio adicional',
  'cambio de equipo',
  'recuperacion cable modem',
  'mantenimiento',
  'migracion',
  'viabilidad',
  'levantamiento',
  'veeduria',
  'entrega de servicio',
];

/**
 * Patrones que NUNCA son campo aunque calcen con los de arriba. Van primero.
 *
 * `Autenticacion` y `Cambio de clave` engañan: suenan a técnico, pero se hacen
 * desde la OLT y el panel, sin moverse. `Retiro voluntario` es la baja
 * administrativa — la visita a recoger el equipo entra como orden aparte
 * ("Recuperación cable modem"), que sí cuenta.
 */
const NO_CAMPO = [
  'corte',
  'reconex',
  'suspension',
  'autenticacion',
  'cambio de clave',
  'subir megas',
  'bajar megas',
  'retiro voluntario',
];

/** ¿Este tipo de orden implica que alguien salió a la calle? */
export function esTrabajoDeCampo(type: string | null | undefined): boolean {
  const t = normalizarTipo(type);
  if (!t) return false;
  if (NO_CAMPO.some((p) => t.includes(p))) return false;
  return CAMPO.some((p) => t.includes(p));
}

/**
 * Filtra una lista de tipos existentes dejando solo los de campo.
 *
 * El tablero llama esto con los tipos DISTINTOS que hay en la base (unas 40
 * filas) y usa el resultado como `type IN (...)`: así el filtro viaja a
 * Postgres y aprovecha el índice de `type`, en vez de traer 314.000 órdenes
 * para clasificarlas en memoria.
 */
export function tiposDeCampo(todos: string[], override?: string | null): string[] {
  const manual = (override ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (manual.length) {
    const set = new Set(manual.map(normalizarTipo));
    return todos.filter((t) => set.has(normalizarTipo(t)));
  }
  return todos.filter(esTrabajoDeCampo);
}

/**
 * ¿Este tipo de orden es una QUEJA, es decir, el cliente volviendo a llamar?
 *
 * Es el evento con el que se mide si un trabajo quedó bien hecho: si un abonado
 * recibe una instalación y a los tres días entra una "Revisión de Internet" a su
 * nombre, algo no quedó. Se cuentan solo las revisiones y no cualquier orden de
 * campo posterior, porque un traslado o una toma adicional a los diez días son
 * el cliente pidiendo algo nuevo, no el trabajo anterior fallando. Cobrarle eso
 * al técnico sería exactamente el tipo de métrica injusta que hace que nadie
 * crea en el tablero.
 */
export function esRevisita(type: string | null | undefined): boolean {
  return normalizarTipo(type).includes('revision');
}

/** Los tipos de queja presentes en el catálogo, para filtrar del lado de Postgres. */
export function tiposDeRevisita(todos: string[]): string[] {
  return todos.filter(esRevisita);
}
