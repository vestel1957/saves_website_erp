/**
 * Qué técnicos se pintan como columna en la agenda, según la sede de quien agenda.
 *
 * Vive aparte de `agenda.service.ts` por dos razones: la regla la usan las tres
 * vistas (día, semana, calendario) más el Excel, y es la única pieza del alcance por
 * sede que se puede probar sin base de datos.
 *
 * `Staff.sedeAccede` es el CSV del legacy ('-3-,-4-'), no un id limpio.
 */

/** '-3-,-4-' → [3, 4]. Vacío o basura → `[]`, que aquí significa "todas las sedes". */
export function sedesDelStaff(csv: string | null | undefined): number[] {
  if (!csv) return [];
  const ids = csv
    .split(',')
    .map((p) => Number(p.replace(/-/g, '').trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(ids)];
}

/**
 * ¿Este técnico entra en la agenda de quien tiene `mias` como alcance?
 *
 * Las dos convenciones que hay que respetar, porque son opuestas y se cruzan aquí:
 *  · `mias` vacío = quien mira NO está acotado (gerencia, superusuario) → ve a todos.
 *  · `sedeAccede` vacío = el técnico no está atado a una sede → lo ve todo el mundo.
 *    Son 0 hoy, pero el legacy deja la columna vacía y dejarlos fuera los volvería
 *    invisibles para todas las cajeras a la vez.
 */
export function esDeMisSedes(csv: string | null | undefined, mias: number[]): boolean {
  if (!mias.length) return true;
  const suyas = sedesDelStaff(csv);
  return suyas.length === 0 || suyas.some((s) => mias.includes(s));
}
