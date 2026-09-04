/**
 * Reglas compartidas para traer al perfil del cliente las OBSERVACIONES y los
 * ARCHIVOS que el legacy pinta al pie de su ficha.
 *
 *   · Observaciones → `historiales` (idn, id_user, tipos, observacion, fecha,
 *     colaborador, y para "Cambio Titular" el detalle vive en nombres/documento).
 *   · Archivos      → `meta_data` type = 6 (rid = cliente, col1 = nombre del
 *     fichero dentro de `userfiles/attach/`).
 *
 * Lo usan el volcado histórico (`etl-notas-archivos-legacy.js`) y la pasada
 * incremental (`sync-legacy-vivo.js`): una sola fuente de reglas para que lo que
 * importó el volcado y lo que trae el sync se vean exactamente igual.
 */
const ENTIDADES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&aacute;': 'á', '&eacute;': 'é', '&iacute;': 'í',
  '&oacute;': 'ó', '&uacute;': 'ú', '&ntilde;': 'ñ', '&Ntilde;': 'Ñ', '&uuml;': 'ü',
};

/**
 * El legacy escribe las observaciones con un editor WYSIWYG (summernote): 9.831 de
 * las 28.087 traen `<p>`, `<br>`, `&nbsp;` y hasta `<div>` anidados. Aquí se guarda
 * TEXTO, no HTML — pintarlo crudo en el nuevo perfil sería o etiquetas a la vista o
 * una inyección de HTML ajeno en la ficha.
 */
function limpiarHtml(texto) {
  if (!texto) return '';
  let s = String(texto);
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');
  s = s.replace(/&[a-zA-Z#0-9]+;/g, (e) => ENTIDADES[e] ?? ENTIDADES[e.toLowerCase()] ?? e);
  s = s.replace(/[ \t ]+/g, ' ');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.split('\n').map((l) => l.trim()).join('\n').trim();
}

/**
 * Texto de la observación tal y como la lee un funcionario en el legacy.
 *
 * "Cambio Titular" es el caso raro: allá la columna Detalle NO muestra
 * `observacion` sino el titular nuevo (nombres + tipo y número de documento), así
 * que esas 766 filas quedarían en blanco si se copiara el campo a secas.
 */
function cuerpoObservacion(row) {
  const obs = limpiarHtml(row.observacion);
  if (String(row.tipos || '').trim() === 'Cambio Titular') {
    const doc = [row.tdocumento, row.documento2].map((v) => String(v ?? '').trim()).filter((v) => v && v !== '0');
    const partes = [String(row.nombres || '').trim(), doc.join(': ')].filter(Boolean);
    const titular = partes.join(', ');
    if (titular && obs) return `${titular}\n${obs}`;
    if (titular) return titular;
  }
  return obs;
}

/** Fila de `historiales` → datos de `SubscriberNote` (null si no se puede ubicar). */
function mapObservacion(row, subscriberId, nombreDe) {
  if (!subscriberId) return null;
  const body = cuerpoObservacion(row);
  const kind = String(row.tipos || '').trim() || null;
  // Sin texto y sin tipo no hay nada que mostrar; con tipo, la fila sigue diciendo
  // algo ("Devolucion Equipo" en tal fecha) y se conserva.
  if (!body && !kind) return null;
  const usuario = String(row.colaborador || '').trim();
  return {
    legacyId: row.idn,
    subscriberId,
    kind,
    body: body || kind,
    authorName: (usuario && nombreDe ? nombreDe(usuario) : usuario) || null,
    // `historiales.fecha` es DATE (sin hora): la nota queda a las 00:00 de su día.
    createdAt: fechaDia(row.fecha),
  };
}

/** 'YYYY-MM-DD' (o Date) → Date a medianoche hora Colombia, sin correr el día. */
function fechaDia(v) {
  if (!v) return new Date(0);
  const s = typeof v === 'string' ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10);
  const d = new Date(`${s}T00:00:00-05:00`);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

const MIME_POR_EXT = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.sjpeg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain', '.csv': 'text/csv', '.rtf': 'application/rtf',
  '.zip': 'application/zip', '.ogg': 'audio/ogg', '.url': 'text/plain',
};

/** Extensión en minúsculas de un nombre de fichero ('' si no tiene). */
function extensionDe(nombre) {
  const m = /\.[A-Za-z0-9]{1,6}$/.exec(String(nombre || ''));
  return m ? m[0].toLowerCase() : '';
}

function mimeDe(nombre) {
  return MIME_POR_EXT[extensionDe(nombre)] || 'application/octet-stream';
}

/**
 * Nombre para mostrar. El legacy antepone `rand(99999,999999)` al nombre original
 * (`Uploadhandler_generic`), así que el fichero se llama "657200cartaderetiro.pdf".
 * Se le quita ese prefijo SOLO si lo que queda empieza por letra: hay adjuntos que
 * son todo dígitos ("1000487449.pdf", una cédula escaneada) y ahí recortar seis
 * cifras inventaría un nombre falso.
 */
function nombreVisible(col1) {
  const bruto = String(col1 || '').trim();
  const m = /^\d{5,6}(.+)$/.exec(bruto);
  if (m && /^[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(m[1])) return m[1];
  return bruto;
}

/**
 * Nombre en disco dentro de `uploads/subscribers/<id>/`. Determinista a propósito:
 * volver a correr la importación reescribe el mismo fichero en vez de sembrar copias.
 */
function nombreEnDisco(metaId, col1) {
  return `legacy-${metaId}${extensionDe(col1)}`;
}

/**
 * username del legacy → nombre completo del funcionario. `historiales.colaborador`
 * guarda el usuario ('WindyMunozATE'), y el sistema ya no muestra nombres de usuario
 * (misma regla que `nombre-tecnico.ts`). Lo que no cruce con ninguna ficha se deja
 * tal cual: peor que un username es una observación sin autor.
 */
async function traductorDeNombres(prisma) {
  const filas = await prisma.staff.findMany({ select: { username: true, name: true } });
  const porUsuario = new Map();
  for (const f of filas) {
    const u = (f.username || '').trim().toLowerCase();
    const n = (f.name || '').trim();
    if (u && n) porUsuario.set(u, n);
  }
  return (texto) => porUsuario.get(String(texto).trim().toLowerCase()) ?? texto;
}

module.exports = {
  limpiarHtml, cuerpoObservacion, mapObservacion, fechaDia, traductorDeNombres,
  mimeDe, extensionDe, nombreVisible, nombreEnDisco,
};
