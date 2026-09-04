/**
 * A QUÉ redes del CPE se le escribe el nombre/clave del WiFi, y con qué valor.
 *
 * Vive aparte del servicio y sin nada de red porque es la parte que se puede
 * equivocar en silencio: escribir la clave nueva en la red que el cliente NO usa
 * deja al cliente con su clave vieja y al sistema diciendo "listo, ya quedó". Aquí
 * es lógica pura sobre el árbol TR-069 que ya trajo el ACS, y se prueba con casos
 * reales del parque (ver el spec).
 *
 * El problema real: **el índice no significa lo mismo en cada marca**. En el parque
 * de Vestel (1.367 equipos, 34 modelos) conviven:
 *
 *   BCD-FD702XW-X-R410 → 1 «VESTEL_MAIK» · 2-4 «AP-1111/2222/3333»
 *   BCD-FD702GW-DX-R471 → 1 «FLIA-PACHECO-5G» · 2-5 «HGW-737719-5G-N» · 6 «FAMILIA-…» · 7-10 «HGW-737719-N»
 *   HG102WT → 1 «FLORAMARILLO» · 2-5 «FTTH1-27B411»…
 *
 * O sea: la del cliente puede ser la 1 o la 6, la 5G puede ir antes que la 2.4, y el
 * resto son SSIDs de fábrica que vienen apagados. Lo único estable en todo el parque
 * es que **la red del cliente tiene nombre de persona y las de fábrica tienen nombre
 * de fábrica**, así que ese es el criterio: se descarta lo que se llama como salió de
 * la caja y se escribe sobre lo que alguien bautizó.
 */

/** Un nodo del árbol tal como lo devuelve el NBI: `{ _value, _writable, … }`. */
interface Nodo {
  _value?: unknown;
  _writable?: boolean;
  [k: string]: unknown;
}

/** Una red (instancia de WLANConfiguration) elegida para escribir. */
export interface RedObjetivo {
  /** Índice de la instancia dentro de WLANConfiguration (1, 5, 6…). */
  instancia: string;
  /** Cómo se llama HOY. */
  ssidActual: string;
  /** true si es la banda de 5 GHz (por el nombre o por el estándar que declara). */
  esCincoGhz: boolean;
  /** Parámetros de clave escribibles que expone esta instancia. */
  paramsClave: string[];
  /** Parámetro del nombre, si es escribible. */
  paramSsid: string | null;
}

export interface PlanWifi {
  objetivos: RedObjetivo[];
  /** Pares [parámetro, valor] listos para un setParameterValues. */
  pares: Array<[string, string]>;
  /** Cómo quedaría cada red, para contárselo a quien lo pidió (sin la clave). */
  resumen: string[];
  /**
   * Redes elegidas a las que NO se les puede escribir la clave (el equipo solo deja
   * tocarles el nombre). Se saca aparte porque decide la honestidad del resultado:
   * si una de las dos bandas se queda con la clave vieja, "listo, ya quedó" es
   * mentira a medias y el cliente vuelve a llamar.
   */
  sinClave: string[];
}

/**
 * Nombres que puso la fábrica, no el cliente. Salen de un censo del parque vivo:
 * son los SSIDs de las redes secundarias que ningún abonado usa (vienen apagadas y
 * numeradas). Se escriben pegados a `^…$` a propósito: «FLIA-PACHECO-5G» empieza
 * distinto pero «AP-1111» es exactamente eso y nada más.
 */
const DE_FABRICA: RegExp[] = [
  /^AP-\d+$/i,
  /^HGW-[0-9A-Z]{4,10}(-5G)?-\d+$/i,
  /^FTTH\d+-[0-9A-Z]{4,10}$/i,
  /^(ONU|ONT|GPON|EPON|XPON|WLAN|SSID)[-_ ]?[0-9A-Z]{2,10}(-\d+)?$/i,
  /^(TP-LINK|TENDA|REALTEK|MERCUSYS)[-_ ][0-9A-Z]{2,10}$/i,
];

/** Marcas de que un SSID es el de 5 GHz. */
const MARCA_5G = /[-_ ]?5\s?G(HZ)?$/i;

export function esDeFabrica(ssid: string): boolean {
  return DE_FABRICA.some((re) => re.test(ssid.trim()));
}

/** Rango imprimible ASCII: lo único que todos los CPEs del parque aceptan sin romperse. */
const IMPRIMIBLE = /^[\x20-\x7E]+$/;

/**
 * ¿Sirve esta clave? Las reglas son de WPA (8 a 63 caracteres), no nuestras: una
 * clave de 7 la rechaza el equipo y el cliente se queda sin WiFi y sin saber por qué.
 * Devuelve el motivo en texto (para decírselo tal cual) o null si está bien.
 */
export function validarClave(clave: string): string | null {
  if (clave.length < 8) return 'La clave del WiFi debe tener al menos 8 caracteres.';
  if (clave.length > 63) return 'La clave del WiFi no puede pasar de 63 caracteres.';
  if (!IMPRIMIBLE.test(clave)) {
    return 'La clave solo puede llevar letras, números y signos normales (sin tildes, ñ ni emojis): ' +
      'muchos equipos no los aceptan y el cliente se quedaría sin poder conectarse.';
  }
  return null;
}

/** Igual que `validarClave` pero para el nombre de la red. */
export function validarSsid(ssid: string): string | null {
  if (!ssid.trim()) return 'El nombre de la red no puede ir vacío.';
  if (ssid.length > 32) return 'El nombre de la red no puede pasar de 32 caracteres.';
  if (!IMPRIMIBLE.test(ssid)) {
    return 'El nombre de la red solo puede llevar letras, números y signos normales (sin tildes, ñ ni emojis).';
  }
  return null;
}

const leaf = (n: unknown): string => {
  const v = (n as Nodo | undefined)?._value;
  return v === undefined || v === null ? '' : String(v);
};
const escribible = (n: unknown): boolean => !!(n as Nodo | undefined)?._writable;

/**
 * Elige las redes del cliente dentro del subárbol WLANConfiguration.
 *
 * Orden de preferencia, de más a menos fiable:
 *  1. redes encendidas con nombre puesto por alguien (lo normal);
 *  2. si TODAS se llaman como de fábrica, la de menor índice encendida — el cliente
 *     nunca le cambió el nombre y sigue usando esa;
 *  3. si nada tiene nombre, la instancia 1.
 */
export function elegirRedes(wlan: Record<string, unknown> | undefined | null): RedObjetivo[] {
  const instancias = Object.keys(wlan ?? {})
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b));

  const leer = (k: string): RedObjetivo | null => {
    const nodo = (wlan as Record<string, any>)[k] ?? {};
    const ssid = leaf(nodo.SSID).trim();
    const paramsClave: string[] = [];
    const base = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${k}`;
    if (escribible(nodo.KeyPassphrase)) paramsClave.push(`${base}.KeyPassphrase`);
    if (escribible(nodo.PreSharedKey?.['1']?.KeyPassphrase)) {
      paramsClave.push(`${base}.PreSharedKey.1.KeyPassphrase`);
    }
    if (!paramsClave.length && !escribible(nodo.SSID)) return null;
    const estandar = leaf(nodo.Standard) + ' ' + leaf(nodo.X_HW_WlanMode) + ' ' + leaf(nodo.OperatingFrequencyBand);
    return {
      instancia: k,
      ssidActual: ssid,
      esCincoGhz: MARCA_5G.test(ssid) || /\b5\s?ghz\b|\ba\b/i.test(estandar.trim()),
      paramsClave,
      paramSsid: escribible(nodo.SSID) ? `${base}.SSID` : null,
    };
  };

  const apagada = (k: string) => leaf((wlan as Record<string, any>)[k]?.Enable).toLowerCase() === 'false';

  const encendidas = instancias.filter((k) => !apagada(k));
  const conNombre = encendidas.map(leer).filter((r): r is RedObjetivo => !!r && !!r.ssidActual);

  const delCliente = conNombre.filter((r) => !esDeFabrica(r.ssidActual));
  if (delCliente.length) return delCliente;
  if (conNombre.length) return [conNombre[0]];

  const primera = instancias.length ? leer(instancias[0]) : null;
  return primera ? [primera] : [];
}

/**
 * Arma el setParameterValues a partir de las redes elegidas.
 *
 * El nombre nuevo se le pone a la red de 2.4 y a la de 5 GHz con el sufijo «-5G», que
 * es como venían nombradas en el parque: si se le pusiera el mismo nombre exacto a las
 * dos, el cliente perdería la forma de elegir banda desde el celular sin haberlo pedido.
 */
export function planWifi(
  redes: RedObjetivo[],
  cambio: { ssid?: string; clave?: string },
): PlanWifi {
  const pares: Array<[string, string]> = [];
  const resumen: string[] = [];
  const sinClave: string[] = [];

  for (const r of redes) {
    const nombreNuevo = cambio.ssid
      ? r.esCincoGhz
        ? `${cambio.ssid}-5G`.slice(0, 32)
        : cambio.ssid
      : null;
    if (nombreNuevo && r.paramSsid) pares.push([r.paramSsid, nombreNuevo]);
    if (cambio.clave) for (const p of r.paramsClave) pares.push([p, cambio.clave]);

    const partes: string[] = [];
    if (nombreNuevo && r.paramSsid) partes.push(`nombre → «${nombreNuevo}»`);
    else if (nombreNuevo) partes.push('el equipo no deja cambiarle el nombre');
    if (cambio.clave) {
      partes.push(r.paramsClave.length ? 'clave nueva' : 'el equipo no deja cambiarle la clave');
      if (!r.paramsClave.length) sinClave.push(r.ssidActual || `red ${r.instancia}`);
    }
    resumen.push(`${r.ssidActual || `red ${r.instancia}`}${r.esCincoGhz ? ' (5 GHz)' : ''}: ${partes.join(' · ')}`);
  }

  return { objetivos: redes, pares, resumen, sinClave };
}
