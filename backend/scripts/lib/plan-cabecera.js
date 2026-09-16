/**
 * El PLAN del abonado según la CABECERA de su factura recurrente del legacy.
 *
 * Allá el plan no vive en el cliente: la corrida mensual lo lee de `combo` (internet),
 * `television` y `puntos` de la última RECURRENTE (`Invoices_model.php`, ver
 * `plan-facturable.ts`) y lo tarifa con el catálogo por nombre. Cerrar un 'Subir megas'
 * o una 'Migración' reescribe `combo` y no toca el total; editar la factura en
 * "ASIGNAR SERVICIO" igual. Nada de eso bajaba: la huella del sync no miraba esas
 * columnas y `SubscriberService` —lo que factura este sistema— nunca se enteraba
 * (2026-09-14: 22 combos y 4 TV desfasados en facturas, 37/46 fichas con el plan viejo).
 *
 * Aquí sólo las reglas, sin BD, para poder probarlas.
 */
const { norm } = require('./vestel-map');

const clave = (s) => norm(s).toLowerCase();

/**
 * Lo que dice UNA columna de la cabecera sobre su servicio.
 *   · vacío / '-'  → 'nada': la factura no lo dice (las de ventanilla salen así).
 *   · 'no'         → 'quitar': el servicio no se contrata.
 *   · internet 'SoloTelevision…' → 'quitar': así lo lee la corrida del legacy.
 *   · otro texto   → 'plan' con ese nombre.
 */
function leerColumna(kind, valor) {
  const v = norm(valor);
  const k = v.toLowerCase();
  if (!v || k === '-') return { que: 'nada' };
  if (k === 'no') return { que: 'quitar' };
  if (kind === 'INTERNET' && k.includes('solotelevision')) return { que: 'quitar' };
  return { que: 'plan', nombre: v };
}

/** Columna de la cabecera de cada servicio (`tv`/`combo` con los nombres de aquí o de allá). */
const COLUMNA = { INTERNET: 'combo', TV: 'tv' };

/**
 * Qué servicios cambió la cabecera `nueva` respecto de la `vieja`. Sin distinguir
 * mayúsculas ni espacios: aquí hay 524 'SoloTelevision ' con espacio al final que no son
 * ningún cambio. Los puntos no cuentan: su cantidad vive en `SubscriberService`.
 */
function serviciosMovidos(vieja, nueva) {
  return Object.keys(COLUMNA).filter((kind) => clave(vieja?.[COLUMNA[kind]]) !== clave(nueva?.[COLUMNA[kind]]));
}

/** ¿Las dos cabeceras dicen lo mismo (plan y puntos)? */
function mismaCabecera(a, b) {
  return serviciosMovidos(a, b).length === 0 && Number(a?.puntos || 0) === Number(b?.puntos || 0);
}

/**
 * Catálogo `Plan` por tipo y nombre exacto (sin caja ni espacios), con la misma regla de
 * `planDeCabecera`: sólo con precio y, con nombres duplicados, el más caro. NO se
 * colapsan grafías: '300 Megas F-26' y '300Megas26F' son planes distintos con precios
 * distintos.
 */
function armarCatalogo(planes) {
  const out = new Map();
  for (const p of planes) {
    if (!(Number(p.price) > 0)) continue;
    const k = `${p.kind}|${clave(p.name)}`;
    const previo = out.get(k);
    if (!previo || Number(p.price) > Number(previo.price)) out.set(k, p);
  }
  return out;
}

/**
 * Los cambios que hay que hacerle a `SubscriberService` para que diga lo mismo que la
 * cabecera, sólo en los `kinds` indicados.
 *
 * @returns {{tipo:'cambiar'|'crear'|'quitar'|'sinCatalogo', kind:string, id?:string, de?:string, plan?:object, nombre?:string}[]}
 */
function cambiosDePlan({ cabecera, servicios, catalogo, kinds = Object.keys(COLUMNA) }) {
  const out = [];
  // Sin ninguna fila de internet ni TV el plan de este abonado sale DERIVADO de sus
  // facturas (`plan-facturable.ts`), al precio que de verdad paga. Sembrarle la tarifa de
  // catálogo le cambiaría la mensualidad (la dry-run del 14-09 iba a crear 919 filas así).
  if (!servicios.some((s) => s.kind !== 'PUNTOS')) return kinds.length ? [{ tipo: 'derivado' }] : out;
  for (const kind of kinds) {
    const col = leerColumna(kind, cabecera?.[COLUMNA[kind]]);
    const actual = servicios.find((s) => s.kind === kind);
    if (col.que === 'nada') continue;
    if (col.que === 'quitar') {
      if (actual) out.push({ tipo: 'quitar', kind, id: actual.id, de: actual.planName });
      continue;
    }
    if (actual && clave(actual.planName) === clave(col.nombre)) continue;
    // La pata que la ficha no tiene NO se crea: la cabecera del legacy dice planes que allá
    // no se cobran (internet cortado: la #455067 lleva '5MegasV' y sólo factura la TV), y
    // la corrida ya deriva esa pata de las facturas, al precio que se paga.
    if (!actual) { out.push({ tipo: 'pataFaltante', kind, nombre: col.nombre }); continue; }
    const plan = catalogo.get(`${kind}|${clave(col.nombre)}`);
    // Sin tarifa no se inventa una: se reporta y la ficha se queda como está.
    if (!plan) { out.push({ tipo: 'sinCatalogo', kind, nombre: col.nombre, de: actual.planName }); continue; }
    out.push({ tipo: 'cambiar', kind, id: actual.id, de: actual.planName, plan });
  }
  return out;
}

module.exports = { leerColumna, serviciosMovidos, mismaCabecera, armarCatalogo, cambiosDePlan };
