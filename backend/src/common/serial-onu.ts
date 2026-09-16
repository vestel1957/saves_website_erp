/**
 * Los tres traductores del serial de una ONU.
 *
 * Viven aquí y no en `support/onu-provision.service.ts` (donde nacieron) porque
 * también los necesita la red: la ficha del cliente busca la ONU del abonado
 * cruzando el serial ROTULADO del inventario con el SN en HEX que hablan la OLT
 * y la tabla `OltOnu`, y que el módulo de red importara el de soporte cerraba un
 * ciclo (soporte ya depende de `OltService`).
 */

/** Serial comparable: mayúsculas y sin signos (el inventario trae espacios y guiones). */
export function normalizarSerial(s: string | null | undefined): string {
  return String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Las formas con las que un mismo equipo puede estar escrito en el inventario.
 *
 * La OLT reporta el SN en 16 hex (`47504F4E120278E5`), pero en el inventario los
 * seriales suelen venir como los imprime el fabricante en la etiqueta: los 4
 * primeros bytes son el OUI en ASCII (`GPON`, `HWTC`, `XPON`, `XGTC`) seguidos
 * de los 8 hex restantes → `GPON120278E5`. Sin esta traducción el cruce
 * inventario↔OLT pasa de 424 equipos a 90: la mayoría de los que SÍ casan lo
 * hacen por esta vía.
 */
export function formasDeSerial(sn: string | null | undefined): string[] {
  const hex = normalizarSerial(sn);
  if (!hex) return [];
  const formas = new Set<string>([hex]);
  if (/^[0-9A-F]{16}$/.test(hex)) {
    const ascii = (hex.slice(0, 8).match(/../g) ?? [])
      .map((par) => String.fromCharCode(parseInt(par, 16)))
      .join('');
    // Solo si los 4 bytes son texto imprimible: hay ONUs cuyo prefijo es binario
    // y convertirlo produciría un serial fantasma que casaría con cualquier cosa.
    if (/^[A-Z0-9]{4}$/.test(ascii)) formas.add(ascii + hex.slice(8));
  }
  return [...formas];
}

/**
 * La forma HEX de un serial rotulado (`ZTEGDE519D2C` -> `5A544547DE519D2C`).
 *
 * Es el camino contrario a `formasDeSerial` y hace falta para preguntar por un
 * equipo del inventario en las tablas que hablan el idioma de la OLT (`OltOnu`,
 * el autofind): allí el SN siempre viene en 16 hex. null = ese serial no tiene
 * pinta de ONU (un deco, un "solicitar", una etiqueta EoC).
 */
export function formaHex(sn: string | null | undefined): string | null {
  const s = normalizarSerial(sn);
  if (/^[0-9A-F]{16}$/.test(s)) {
    // 16 hex NO basta: la etiqueta de un puente EoC (`BA1305-1704003199`) también
    // los da al quitarle el guion. En un SN GPON los 4 primeros bytes son el
    // fabricante en ASCII (`ZTEG`, `HWTC`); `BA 13 05 17` no lo es.
    const ascii = (s.slice(0, 8).match(/../g) ?? []).map((par) => String.fromCharCode(parseInt(par, 16))).join('');
    return /^[A-Z0-9]{4}$/.test(ascii) ? s : null;
  }
  if (/^[A-Z0-9]{4}[0-9A-F]{8}$/.test(s)) {
    return [...s.slice(0, 4)].map((ch) => ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('') + s.slice(4);
  }
  return null;
}
