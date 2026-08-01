"use client";

/**
 * MARCADOR TEMPORAL — pendiente de escribir.
 *
 * `MisOrdenes.tsx` ya importa y pinta `<MiAgendaHoy />` (la agenda que la cajera le
 * dejó al técnico para hoy), pero el componente todavía no existía y eso tumbaba el
 * build entero: sin él, Next no compila NINGUNA pantalla y el sitio se cae.
 *
 * Devuelve null a propósito: no inventa la vista. En cuanto esté la de verdad, este
 * archivo se reemplaza — probablemente listando las visitas con `VisitaAgendada`,
 * que ya está hecho (`./VisitaAgendada.tsx`, exporta `VisitaAgendada({ o })` y el
 * ayudante `visitaLista`).
 */
export function MiAgendaHoy() {
  return null;
}
