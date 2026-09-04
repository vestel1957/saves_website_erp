/**
 * De dónde salen los binarios de los adjuntos del cliente.
 *
 * El legacy los guarda en `userfiles/attach/` de su servidor web. En esta máquina
 * hay una copia (LEGACY_ATTACH_DIR) que cubre el 96,6 % — le faltan los subidos
 * después de que se sacó. Por eso hay dos caminos y en este orden:
 *
 *   1. disco: la copia local, instantánea y sin tocar la red.
 *   2. http:  el legacy vivo (LEGACY_ATTACH_URL). Es lo que rescata los recientes
 *             y lo que hace que la sincronización de cada 15 minutos funcione, que
 *             ahí SIEMPRE se trata de ficheros que la copia local no tiene.
 *
 * El destino es `uploads/subscribers/<idCliente>/<nombreEnDisco>`, que es donde el
 * backend busca al servir la descarga (`SubscribersController.download`).
 */
const fs = require('fs');
const path = require('path');

// Mismo sitio que usa el backend al servir la descarga: `<backend>/uploads/subscribers`.
// Se calcula desde __dirname y no desde process.cwd() para que la corrida manual
// desde cualquier carpeta escriba donde el backend va a leer.
const UPLOAD_ROOT = path.join(__dirname, '..', '..', 'uploads', 'subscribers');

const ATTACH_DIR = process.env.LEGACY_ATTACH_DIR || '/home/dev/saves-vestel-src/userfiles/attach';
const ATTACH_URL = (process.env.LEGACY_ATTACH_URL || 'https://vestel.saves.com.co/userfiles/attach/').replace(/\/?$/, '/');
const TIMEOUT_MS = Number(process.env.LEGACY_ATTACH_TIMEOUT_MS || 30_000);
/** Un adjunto del legacy no pasa de unos pocos MB; más que esto es un error, no un archivo. */
const MAX_BYTES = Number(process.env.LEGACY_ATTACH_MAX_BYTES || 60 * 1024 * 1024);

/**
 * Deja el adjunto `nombre` del legacy en `destino`.
 * → { ok, origen: 'disco'|'http'|'ya', size } | { ok: false, motivo }
 */
async function traerArchivo(nombre, destino, opts = {}) {
  const limpio = String(nombre || '').trim();
  // El nombre viene de la BD del legacy: si trajera '../' escribiría fuera de la
  // carpeta del cliente. Se acota a un nombre de fichero pelado.
  if (!limpio || limpio !== path.basename(limpio)) return { ok: false, motivo: 'nombre inválido' };

  try {
    const ya = fs.statSync(destino);
    if (ya.size > 0) return { ok: true, origen: 'ya', size: ya.size };
  } catch { /* aún no está */ }

  fs.mkdirSync(path.dirname(destino), { recursive: true });

  const local = path.join(ATTACH_DIR, limpio);
  try {
    const st = fs.statSync(local);
    if (st.isFile() && st.size > 0) {
      fs.copyFileSync(local, destino);
      // La copia del legacy viene con permisos de ejecución (0755): aquí es un
      // adjunto que sólo se lee, y se guarda como tal.
      fs.chmodSync(destino, 0o644);
      return { ok: true, origen: 'disco', size: st.size };
    }
  } catch { /* no está en la copia local: se intenta por HTTP */ }

  if (opts.sinDescarga) return { ok: false, motivo: 'no está en la copia local' };

  try {
    const ctrl = new AbortController();
    const reloj = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    // encodeURIComponent y no encodeURI: el nombre puede traer '#' o '?' y ahí el
    // servidor cortaría la ruta y devolvería el índice del directorio.
    const res = await fetch(ATTACH_URL + encodeURIComponent(limpio), { signal: ctrl.signal });
    clearTimeout(reloj);
    if (!res.ok) return { ok: false, motivo: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { ok: false, motivo: 'respuesta vacía' };
    if (buf.length > MAX_BYTES) return { ok: false, motivo: `pesa ${buf.length} bytes` };
    // Si el fichero no existe, algunos servidores contestan 200 con la página de
    // error: se descarta lo que llegue como HTML sin serlo.
    const tipo = (res.headers.get('content-type') || '').toLowerCase();
    if (tipo.includes('text/html') && !/\.html?$/i.test(limpio)) return { ok: false, motivo: 'el servidor devolvió HTML' };
    fs.writeFileSync(destino, buf);
    return { ok: true, origen: 'http', size: buf.length };
  } catch (e) {
    return { ok: false, motivo: e.name === 'AbortError' ? 'tiempo agotado' : e.message };
  }
}

module.exports = { UPLOAD_ROOT, ATTACH_DIR, ATTACH_URL, traerArchivo };
