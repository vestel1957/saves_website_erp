/**
 * Datos de conexión que el alta ya NO pregunta: los deduce del propio cliente.
 *
 * En Vestel el secret del Mikrotik NUNCA fue un dato que se inventara: la
 * convención de siempre —y la que traen los 8.000 abonados importados del
 * legacy— es `NOMBRECOMPLETOPEGADO` en mayúsculas como usuario y el número de
 * documento como clave. Escribirlo a mano en el alta sólo servía para
 * equivocarse (tildes, espacios, la Ñ) y para dejar clientes sin secret cuando
 * el campo se quedaba vacío.
 *
 * Aquí se deriva una sola vez y el alta lo usa tal cual, así que el formulario
 * ya no pregunta por ello.
 */

/**
 * Deja el texto como lo espera un secret PPPoE: sin tildes, sin Ñ, sin espacios
 * ni signos, y en mayúsculas. `MUÑOZ` → `MUNOZ`, `CAPACITACIÓN` → `CAPACITACION`
 * (exactamente lo que hay guardado en los abonados que ya existen).
 */
function soloLetrasYNumeros(v: string): string {
  return v
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // tildes, diéresis y la virgulilla de la Ñ
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

/** Partes del nombre que forman el usuario PPPoE. */
export type PartesNombre = {
  firstName?: string | null;
  secondName?: string | null;
  lastName1?: string | null;
  lastName2?: string | null;
  companyName?: string | null;
};

/**
 * Usuario PPPoE: los cuatro trozos del nombre pegados y en mayúsculas. Si el
 * cliente es una empresa (no tiene nombre de persona) se usa la razón social,
 * que es lo único que la identifica.
 */
export function usuarioPppDe(p: PartesNombre): string {
  const persona = [p.firstName, p.secondName, p.lastName1, p.lastName2]
    .map((s) => soloLetrasYNumeros((s ?? '').trim()))
    .join('');
  return persona || soloLetrasYNumeros((p.companyName ?? '').trim());
}

/** Clave PPPoE: el número de documento, sin puntos ni espacios. */
export function clavePppDe(docNumber?: string | null): string {
  return (docNumber ?? '').replace(/[^A-Za-z0-9]/g, '');
}

/**
 * Variante nº `n` del usuario (1 = sin sufijo). Dos hermanos con el mismo
 * nombre existen, y el secret tiene que ser único: `JUANPEREZ`, `JUANPEREZ2`…
 */
export function variantePpp(base: string, n: number): string {
  return n <= 1 ? base : `${base}${n}`;
}

/**
 * Tecnología de instalación de todo cliente nuevo.
 *
 * Desde 2026-08 sólo se vende fibra óptica (FTTH), así que el alta dejó de
 * preguntarla. En el sistema "FTTH" no es un valor del enum `InstallTech`: es el
 * conjunto GPON/EPON/FIBRA (así lo filtra el listado de abonados) y `GPON` es la
 * tecnología con la que están etiquetados los Mikrotik de fibra de cada sede
 * —de ahí sale el router al que se le escribe el secret—.
 */
export const TECNOLOGIA_FTTH = 'GPON';

/** Etiqueta comercial de esa tecnología, para lo que ve el usuario. */
export const ETIQUETA_FTTH = 'FTTH (fibra óptica)';

/**
 * ¿Este `pppUsername` sirve para crear un secret, o es relleno del legacy?
 *
 * El sistema viejo escribía un carácter cualquiera cuando el cliente no tenía
 * internet —'0', '-', y en algunos casos el texto 'null'—, así que la columna no
 * vacía NO significa que haya usuario: el abonado 2169 llegó con `name_s = '0'` y
 * `perfil = '-'`. Provisionar con eso crearía en el router un secret llamado "0",
 * que además colisionaría con todos los demás rellenos.
 */
export function esUsuarioPppUtil(v?: string | null): boolean {
  const s = (v ?? '').trim();
  if (!s) return false;
  return !['0', '-', '--', 'null', 'undefined', 'n/a', 'na'].includes(s.toLowerCase());
}
