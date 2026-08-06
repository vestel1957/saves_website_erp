/**
 * Cuánto vale cada tipo de orden, de 1 a 5.
 *
 * La decisión de fondo (2026-08-04): el puntaje NO lo pone una persona al cerrar.
 * Nadie califica al técnico visita por visita — eso convierte cada cierre en una
 * negociación y termina siendo un 5 para todos. Lo que se decide, una sola vez y
 * arriba, es cuánto pesa cada TIPO de trabajo; al cerrar, el sistema copia ese
 * peso en la orden y no pregunta nada.
 *
 * Esta lista es el punto de partida, no la verdad: gerencia la ajusta desde
 * Configuración ▸ Puntaje de órdenes y lo que ajuste manda sobre lo de aquí
 * (ver `TicketTypeScore`). Existe para que el sistema reparta puntos sensatos
 * desde el primer día, con la tabla vacía, en vez de darle 3 a todo.
 *
 * LA ESCALA, en horas de trabajo, no en importancia:
 *   5 · jornada completa con obra: instalación desde cero.
 *   4 · varias horas, con desplazamiento y equipo: traslado, punto nuevo, red.
 *   3 · una visita normal de resolución.
 *   2 · visita corta o verificación.
 *   1 · trámite de escritorio: el sistema o la oficina lo hacen sin salir.
 *
 * Un corte vale 1 y no 0 a propósito: el trabajo administrativo también se hace.
 * Lo que evita que un cortador encabece el tablero no es el puntaje, es el filtro
 * de trabajo de campo (ver field-work.policy.ts), que es donde ese problema ya
 * está resuelto.
 */

import { normalizarTipo } from './geofence.policy';

export const PUNTAJE_MIN = 1;
export const PUNTAJE_MAX = 5;

/** Lo que vale un tipo del que no sabemos nada. Una visita normal. */
export const PUNTAJE_POR_DEFECTO = 3;

/**
 * Patrones contra `Ticket.type` normalizado (sin tildes ni mayúsculas), EN ORDEN:
 * gana el primero que calce. El orden importa — 'reinstalac' tiene que ir antes
 * que 'instalac' o una reinstalación se cobraría como una instalación nueva.
 */
const SUGERIDOS: [patron: string, puntos: number][] = [
  // --- Obra ---
  ['reinstalac', 4], // vuelve a montar sobre acometida existente
  ['instalac', 5], // 'Instalacion' y 'Instalación y/o Mantenimiento de Equipos Activos'
  ['punto nuevo', 4],
  ['traslado', 4],
  ['mantenimiento', 4], // 'Mejoramiento y/o Mantenimiento Red Fibra Óptica'
  ['toma adicional', 3],
  ['equipo adicional', 3],
  ['agregarinternet', 3],
  ['agregartelevision', 3],
  ['cambio de equipo', 3],
  ['servicio adicional', 3],
  ['migracion', 3],
  ['configuracion de equipos', 3], // 'Revisión y/o Configuración De Equipos De Red Lan'
  // --- Visita de resolución ---
  ['revision', 2],
  ['recuperacion cable modem', 2],
  ['viabilidad', 2],
  ['levantamiento', 2],
  ['veeduria', 2],
  ['soporte acceso', 2],
  ['intermitencia', 2],
  ['entrega de servicio', 1],
  // --- Escritorio: los ejecuta el sistema o la oficina, sin salir ---
  ['corte', 1],
  ['reconex', 1],
  ['suspension', 1],
  ['autenticacion', 1],
  ['activacion', 1],
  ['cambio de clave', 1],
  ['subir megas', 1],
  ['bajar megas', 1],
  ['retiro voluntario', 1],
];

/** El puntaje que este tipo tendría si nadie lo configura. */
export function puntajeSugerido(type: string | null | undefined): number {
  const t = normalizarTipo(type);
  if (!t) return PUNTAJE_POR_DEFECTO;
  for (const [patron, puntos] of SUGERIDOS) if (t.includes(patron)) return puntos;
  return PUNTAJE_POR_DEFECTO;
}

/** ¿Es un puntaje válido? Entero dentro de la escala. */
export function esPuntajeValido(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= PUNTAJE_MIN && v <= PUNTAJE_MAX;
}
