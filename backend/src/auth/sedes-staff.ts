/**
 * Las sedes de una cuenta, escritas como las guarda la ficha del empleado.
 *
 * Hay DOS columnas con la sede de una misma persona y nadie las cruzaba:
 *   · `User.sedesAccede` (int[]) — a qué sedes LLEGA esa cuenta cuando mira.
 *   · `Staff.sedeAccede`  (CSV legacy '-3-,-4-') — de qué sede ES ese empleado,
 *     que es lo que miran la agenda (`support/agenda-sede.ts`) y el traspaso de
 *     material (`inventory.service.ts`) para decidir a qué técnicos le ofrecen a
 *     una cajera.
 *
 * La ficha (/configuracion/empleados/[id]) sólo escribía la primera, así que
 * mover a un técnico de sede lo dejaba invisible para la cajera de su sede nueva
 * y visible para la de la vieja (Cristhian Mahecha, 2026-09-03). De ahí que al
 * guardar las sedes de la cuenta se refleje también en la ficha.
 *
 * Se conserva el formato del legacy ('-3-') porque esa columna nació allá y la
 * leen dos parsers que ya lo esperan.
 *
 * Lista vacía = SIN restricción en las dos convenciones (la cuenta ve todas las
 * sedes; el empleado no está atado a ninguna y lo ven todas las cajeras), y por
 * eso se guarda NULL y no la cadena vacía.
 */
export function csvSedesLegacy(sedes: number[] | null | undefined): string | null {
  const ids = [...new Set((sedes ?? []).filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
  return ids.length ? ids.map((n) => `-${n}-`).join(',') : null;
}

/**
 * El camino inverso: '-3-,-4-' → [3, 4]. Lo usa `createAccount` para que la cuenta
 * de acceso NUEVA de un empleado que ya tenía sede en su ficha nazca acotada a
 * ella, en vez de nacer sin restricción (mismo parser que `support/agenda-sede.ts`,
 * duplicado a propósito para no acoplar `staff` con `support`).
 */
export function sedesDeCsvLegacy(csv: string | null | undefined): number[] {
  if (!csv) return [];
  const ids = csv.split(',').map((p) => Number(p.replace(/-/g, '').trim())).filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(ids)].sort((a, b) => a - b);
}
