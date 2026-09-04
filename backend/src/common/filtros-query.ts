/**
 * Filtros de listado que admiten VARIOS valores.
 *
 * Los desplegables de las barras de filtros pasaron a ser de selección múltiple
 * ("pendientes Y realizando"), y lo elegido viaja en el MISMO parámetro de siempre
 * separado por comas: `?status=PENDIENTE,REALIZANDO`. Así un solo valor sigue
 * significando exactamente lo que significaba —los enlaces guardados, el "volver"
 * de una ficha y el export a Excel siguen sirviendo— y no hace falta duplicar
 * parámetros en el contrato HTTP.
 *
 * Se quitan espacios, vacíos y repetidos, y se topa la cantidad: el valor llega de
 * la URL y nadie tiene por qué poder pedir un `IN` de diez mil elementos.
 */
const MAX_VALORES = 50;

export function variosDeQuery(crudo?: string | string[]): string[] {
  if (!crudo) return [];
  // Express también entrega un array cuando el parámetro viene repetido
  // (`?status=A&status=B`): se acepta esa forma sin tener que cambiar de llamada.
  const partes = (Array.isArray(crudo) ? crudo : [crudo]).flatMap((v) => String(v).split(','));
  return [...new Set(partes.map((s) => s.trim()).filter(Boolean))].slice(0, MAX_VALORES);
}
