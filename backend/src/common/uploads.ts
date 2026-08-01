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
  // Ofimática: solo la aceptan los documentos de funcionario (hojas de vida y
  // contratos llegan en Word). Que estén en este mapa NO los habilita en los
  // demás módulos — eso lo decide la lista que cada uno pase a `mimeAceptado`.
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

/**
 * Notas de voz de WhatsApp. Van en un mapa APARTE de `EXT_POR_MIME` y no en las listas
 * `MIMES_*` por lo mismo que advierte el comentario de abajo: estos tipos NO los sube
 * un usuario por un formulario — los entrega Kapso al recibir un mensaje, y solo los
 * consume el reproductor de la bandeja. Meterlos en la lista compartida los habilitaría
 * de golpe como comprobante de caja o evidencia de una orden, que no es lo que se quiere.
 *
 * El MIME llega con parámetros (`audio/ogg; codecs=opus`): se compara por el tipo base.
 */
const EXT_POR_MIME_AUDIO: Record<string, string> = {
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/amr': '.amr',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/webm': '.webm',
};

/** Tipo base de un MIME, sin parámetros ni espacios (`audio/ogg; codecs=opus` → `audio/ogg`). */
export function mimeBase(mimetype?: string | null): string {
  return String(mimetype ?? '').split(';')[0].trim().toLowerCase();
}

/** Extensión con la que se guarda una nota de voz. `null` si el tipo no es de audio. */
export function extensionDeAudio(mimetype?: string | null): string | null {
  return EXT_POR_MIME_AUDIO[mimeBase(mimetype)] ?? null;
}

/** Content-Type con el que se devuelve cada extensión almacenada. */
const MIME_POR_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // Notas de voz (ver EXT_POR_MIME_AUDIO). Se sirven con `enviarAdjuntoSeguro` como
  // todo lo demás: el reproductor de la bandeja lee los bytes por fetch y arma un
  // blob, así que el `Content-Disposition: attachment` no le estorba y se mantiene la
  // regla de no renderizar nunca contenido de terceros en el origen de la API.
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.amr': 'audio/amr',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

/**
 * Las listas son EXPLÍCITAS, no derivadas de `EXT_POR_MIME`.
 *
 * Antes `MIMES_IMAGEN_Y_PDF` se calculaba con `Object.keys(EXT_POR_MIME)`, así
 * que agregar un tipo al mapa lo habilitaba de golpe en todos los módulos que
 * usan esa lista. Al añadir Word para las hojas de vida, eso habría permitido
 * subir un `.docx` como comprobante de caja o como evidencia de una orden sin
 * que nadie lo decidiera. Ahora cada lista dice exactamente qué acepta.
 */
export const MIMES_IMAGEN = ['image/jpeg', 'image/pjpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif'];
export const MIMES_IMAGEN_Y_PDF = [...MIMES_IMAGEN, 'application/pdf'];
/** Documentos de funcionario: lo anterior más Word. */
export const MIMES_DOCUMENTO = [
  ...MIMES_IMAGEN_Y_PDF,
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

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
 * Cabecera `Content-Disposition` para un adjunto, con el nombre bien codificado.
 *
 * Las cabeceras HTTP son ISO-8859-1: poniendo el nombre tal cual, "Hoja de vida
 * Andrés.pdf" llegaba al navegador como "Hoja de vida Andr?s.pdf" y así se
 * guardaba. La RFC 5987 resuelve esto con dos parámetros: `filename` en ASCII
 * como respaldo para clientes viejos, y `filename*` en UTF-8 porcentual, que es
 * el que usan todos los navegadores actuales cuando está presente.
 */
export function disposicionAdjunto(nombreVisible?: string): string {
  const nombre = (nombreVisible ?? 'adjunto').replace(/[\r\n]/g, '').trim() || 'adjunto';
  // Respaldo ASCII: se sustituye lo no representable en vez de dejarlo romperse.
  const ascii = nombre.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  const utf8 = encodeURIComponent(nombre);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
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
  res.setHeader('Content-Disposition', disposicionAdjunto(nombreVisible));
  // Nada de esto debe quedar cacheado por un proxy compartido.
  res.setHeader('Cache-Control', 'private, no-store');

  return res.sendFile(rutaAbsoluta);
}
