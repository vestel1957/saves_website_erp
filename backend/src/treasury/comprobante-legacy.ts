import { existsSync, mkdirSync, statSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { NotFoundException } from '../core/http/errores';

/**
 * El comprobante que se enseña de un movimiento, venga de donde venga.
 *
 * Hay dos fuentes y para la pantalla son la misma cosa: `attach` es lo subido aquí y
 * `legacyAttach` lo subido en el legacy (26.153 soportes que el sync enlaza; ver
 * `syncComprobantes`). Sin unificarlas, la caja veía "Adjuntar" sobre egresos que
 * llevaban su factura escaneada desde 2022.
 *
 * Vive aquí —y no en `treasury.service`— porque los pagos de una orden de compra
 * enseñan su soporte desde la ficha de la orden con exactamente el mismo criterio.
 */
export const comprobanteDe = (t: { attach: string | null; attachName: string | null; legacyAttach?: string | null }) => ({
  attach: t.attach ?? t.legacyAttach ?? null,
  attachName: t.attachName ?? t.legacyAttach ?? null,
});

/** Carpeta de comprobantes/evidencia subidos AQUÍ (uploads/treasury). */
export const TREASURY_ROOT = join(process.cwd(), 'uploads', 'treasury');

/**
 * Dónde están los comprobantes que se subieron EN EL LEGACY.
 *
 * Allá viven en `userfiles/attach/` del servidor web, y de esa carpeta hay una copia
 * en esta máquina con el 96,7 % de ellos (25.286 de 26.152, 5,8 GB). No se copian a
 * `uploads/treasury`: duplicar 5,8 GB para servir el mismo byte no tiene sentido, así
 * que se leen donde están. Los 866 que faltan —los subidos después de sacar la copia—
 * se bajan del legacy vivo la primera vez que alguien los abre y quedan cacheados en
 * `uploads/treasury/legacy/`.
 *
 * Mismas variables que usa el sync (`scripts/lib/archivos-legacy.js`) para no tener
 * dos verdades sobre dónde está el legacy.
 */
const LEGACY_DIR = process.env.LEGACY_ATTACH_DIR || '/home/dev/saves-vestel-src/userfiles/attach';
const LEGACY_URL = (process.env.LEGACY_ATTACH_URL || 'https://vestel.saves.com.co/userfiles/attach/').replace(/\/?$/, '/');
const CACHE_DIR = join(TREASURY_ROOT, 'legacy');
const TIMEOUT_MS = Number(process.env.LEGACY_ATTACH_TIMEOUT_MS || 30_000);
/** Un comprobante no pasa de unos pocos MB; más que esto es un error, no un archivo. */
const MAX_BYTES = Number(process.env.LEGACY_ATTACH_MAX_BYTES || 60 * 1024 * 1024);

const pesa = (ruta: string) => { try { return statSync(ruta).size; } catch { return 0; } };

/**
 * Ruta en disco del comprobante `nombre` del legacy, bajándolo si hace falta.
 *
 * El nombre sale de la BD del legacy, no de la URL, pero igual se acota a un nombre
 * de fichero pelado: un `../` guardado allá no puede sacar la lectura de su carpeta.
 */
export async function rutaDeComprobanteLegacy(nombre: string): Promise<string> {
  const limpio = String(nombre || '').trim();
  if (!limpio || limpio !== basename(limpio)) throw new NotFoundException('Comprobante no encontrado');

  const enCopia = join(LEGACY_DIR, limpio);
  if (pesa(enCopia) > 0) return enCopia;

  const enCache = join(CACHE_DIR, limpio);
  if (pesa(enCache) > 0) return enCache;

  const ctrl = new AbortController();
  const reloj = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // encodeURIComponent y no encodeURI: hay nombres con '#' y '?', y ahí el servidor
    // cortaría la ruta y devolvería el índice del directorio.
    const res = await fetch(LEGACY_URL + encodeURIComponent(limpio), { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) throw new Error('tamaño inesperado');
    // Si el fichero ya no está, algunos servidores contestan 200 con su página de
    // error: se descarta lo que llegue como HTML sin serlo.
    const tipo = (res.headers.get('content-type') || '').toLowerCase();
    if (tipo.includes('text/html') && !/\.html?$/i.test(limpio)) throw new Error('el servidor devolvió HTML');
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(enCache, buf);
    return enCache;
  } catch {
    // Que el legacy esté caído o el fichero se haya perdido allá no es un 500: para
    // quien mira el cierre es, exactamente, un comprobante que no se puede abrir.
    throw new NotFoundException('El comprobante está en el legacy y no se pudo recuperar');
  } finally {
    clearTimeout(reloj);
  }
}
