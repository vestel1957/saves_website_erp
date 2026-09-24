/**
 * Reglas compartidas para traer a la pestaña Cobranza del cliente la BITÁCORA DE
 * LLAMADAS del legacy (`llamadas` → `CallLog`).
 *
 * Allá es el listado de `/llamadas/index?id=<cliente>`: tipo de atención, respuesta,
 * detalle, quién la registró, fecha/hora, vencimiento del acuerdo y las notas.
 * `etl-soporte.js` las copiaba a un modelo `Call` que ya no existe, así que las
 * ~110.000 históricas nunca llegaron a la pestaña (2026-09-23).
 *
 * Lo usan el volcado histórico (`etl-llamadas-legacy.js`) y la pasada incremental
 * (`sync-legacy-vivo.js`): una sola fuente de reglas para que se vean igual.
 */

/** 'YYYY-MM-DD' → Date para una columna `@db.Date` (medianoche UTC: no corre el día). */
function fechaDate(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || s.startsWith('0000')) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `hra` llega como 'HH:MM:SS'; aquí se guarda 'HH:mm', como la registra la pantalla. */
function hora(v) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v || ''));
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

function texto(v) {
  const s = String(v ?? '').trim();
  return s || null;
}

/** Fila de `llamadas` → datos de `CallLog` (null si no se puede ubicar). */
function mapLlamada(row, subscriberId, nombreDe) {
  if (!subscriberId) return null;
  const date = fechaDate(row.fcha);
  if (!date) return null;
  const usuario = texto(row.responsable);
  return {
    legacyId: row.id,
    subscriberId,
    callType: texto(row.tllamada),
    responseType: texto(row.trespuesta),
    responseDetail: texto(row.drespuesta),
    // El legacy guarda el usuario ('DanielaBermeoCartera'); las llamadas registradas
    // aquí llevan el nombre completo. Se traduce para que la columna no mezcle ambos.
    responsible: usuario && nombreDe ? nombreDe(usuario) : usuario,
    date,
    time: hora(row.hra),
    // '0000-00-00' en todo lo que no es Acuerdo de Pago.
    dueDate: fechaDate(row.fecha_vence),
    notes: texto(row.notes),
  };
}

const COLUMNAS_LLAMADAS = 'id,iduser,tllamada,trespuesta,drespuesta,responsable,fcha,hra,fecha_vence,notes';

module.exports = { mapLlamada, COLUMNAS_LLAMADAS };
