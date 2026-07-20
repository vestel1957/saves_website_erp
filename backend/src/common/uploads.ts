import { extname } from 'node:path';
import type { Response } from 'express';

/**
 * Manejo seguro de adjuntos subidos por usuarios.
 *
 * El agujero que cierra: los `fileFilter` validaban el MIME **que declara el
 * cliente** (`file.mimetype`), mientras que el nombre en disco tomaba la extensión
 * del `originalname`, también del cliente. Subiendo `payload.html` con
 * `Content-Type: image/png` quedaba un `uuid.html` que Express servía como
 * `text/html` — JavaScript ejecutándose en el origen de la API, y de ahí el token
 * de sesión (que además viaja en una cookie legible por JS y sobre HTTP plano).
 *
 * Dos medidas, porque una sola no basta:
 *  1. La extensión en disco se deriva del MIME **validado**, no del nombre recibido.
 *  2. Al servir: `nosniff` + `Content-Disposition: attachment` + un Content-Type de
 *     lista blanca. Aunque un fichero peligroso llegara a colarse, el navegador no
 *     lo interpretaría como HTML.
 */

/** MIME permitidos → extensión canónica en disco. Todo lo demás se rechaza. */
const EXT_POR_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/pjpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'application/pdf': '.pdf',
};

/** Content-Type con el que se devuelve cada extensión almacenada. */
const MIME_POR_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.pdf': 'application/pdf',
};

export const MIMES_IMAGEN = Object.keys(EXT_POR_MIME).filter((m) => m.startsWith('image/'));
export const MIMES_IMAGEN_Y_PDF = Object.keys(EXT_POR_MIME);

/** ¿Es un MIME que aceptamos? Se usa en el `fileFilter` de multer. */
export function mimeAceptado(mimetype: string, permitidos: string[] = MIMES_IMAGEN_Y_PDF): boolean {
  return permitidos.includes(mimetype);
}

/**
 * Nombre con el que se guarda en disco: identificador aleatorio + extensión derivada
 * del MIME validado. Nunca se usa el `originalname` del cliente para construirlo,
 * que es exactamente por donde entraba el `.html`.
 */
export function nombreEnDisco(id: string, mimetype: string): string {
  return `${id}${EXT_POR_MIME[mimetype] ?? '.bin'}`;
}

/**
 * Envía un adjunto ya almacenado con las cabeceras que impiden que el navegador lo
 * interprete. `descarga` en false sigue mandando `attachment`: la previsualización
 * del frontend lee los bytes por fetch y crea un blob, así que no le afecta.
 */
export function enviarAdjuntoSeguro(res: Response, rutaAbsoluta: string, nombreVisible?: string) {
  const ext = extname(rutaAbsoluta).toLowerCase();
  const tipo = MIME_POR_EXT[ext] ?? 'application/octet-stream';

  res.setHeader('Content-Type', tipo);
  // Sin esto, un navegador puede "adivinar" el tipo mirando el contenido e ignorar
  // el Content-Type que le mandamos.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Aunque algo peligroso hubiera entrado antes de este cambio, no se ejecuta.
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${(nombreVisible ?? 'adjunto').replace(/["\r\n]/g, '')}"`,
  );
  // Nada de esto debe quedar cacheado por un proxy compartido.
  res.setHeader('Cache-Control', 'private, no-store');

  return res.sendFile(rutaAbsoluta);
}
