import { Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extensionDeAudio, mimeBase } from '../uploads';

/**
 * Almacén en disco de las notas de voz que mandan los clientes por WhatsApp.
 *
 * Vive en su propio archivo —sin dependencias de servicios— porque lo necesitan los
 * DOS lados del canal: `WhatsappLogService` para guardar el binario cuando entra, y
 * `WhatsappInboxService` para servirlo cuando alguien le da a reproducir. Como el
 * primero ya importa al segundo, dejar estas constantes en cualquiera de los dos
 * cerraría un ciclo de imports, y un `const` atrapado en un ciclo llega `undefined` en
 * runtime aunque `tsc` no se queje (el mismo motivo por el que `SAVES_TRANSPORT_NAME`
 * vive en `chatbot.identity`).
 *
 * Por qué se guarda y no se re-descarga de Meta a demanda: el media de la Cloud API
 * caduca (Meta lo borra a los 30 días, y la URL firmada de Kapso a los pocos minutos),
 * así que esta es la única copia. Son decenas de KB por nota: el histórico completo de
 * un año de notas de voz cabe de sobra donde ya viven los adjuntos del ERP.
 */
export const AUDIO_ROOT = join(process.cwd(), 'uploads', 'whatsapp-audio');

const logger = new Logger('WhatsappAudio');

/**
 * Deja la nota de voz en disco y devuelve el nombre del archivo (relativo a
 * `AUDIO_ROOT`) junto al MIME ya normalizado.
 *
 * Relativo y no absoluto a propósito: guardar `/home/dev/saves/backend/uploads/…` en
 * la BD ataría el histórico a la ruta de despliegue de hoy, y mover el proyecto o
 * montar los uploads en otro volumen dejaría cada fila apuntando al vacío.
 *
 * El nombre es aleatorio y la extensión sale del MIME **validado**, nunca de nada que
 * venga del otro lado: misma regla que `nombreEnDisco` en `common/uploads.ts`, que
 * existe porque por ahí entró una vez un `.html` ejecutable.
 */
export function guardarNotaDeVoz(audio: { data: Buffer; mimetype?: string }): { path: string; mime: string } | null {
  try {
    const ext = extensionDeAudio(audio.mimetype);
    if (!ext) {
      logger.warn(`Nota de voz con tipo no soportado (${audio.mimetype ?? 'sin tipo'}): no se guarda.`);
      return null;
    }
    if (!audio.data?.byteLength) return null;
    if (!existsSync(AUDIO_ROOT)) mkdirSync(AUDIO_ROOT, { recursive: true });
    const nombre = `${randomUUID()}${ext}`;
    writeFileSync(join(AUDIO_ROOT, nombre), audio.data);
    return { path: nombre, mime: mimeBase(audio.mimetype) || 'audio/ogg' };
  } catch (e) {
    // Nunca propaga: perder el audio es malo, pero perder el MENSAJE por no poder
    // escribir un archivo sería mucho peor. Queda la fila, con su transcripción.
    logger.warn(`No se pudo guardar la nota de voz: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Ruta absoluta de una nota de voz ya guardada, o null si el nombre no tiene la forma
 * que este módulo escribe o el archivo ya no está.
 *
 * La validación del nombre es defensa en profundidad: hoy `audioPath` solo lo escribe
 * `guardarNotaDeVoz` (un UUID), pero es lo único que separa un id de la URL de un
 * `../../.env` si algún día esa columna se llenara desde otra parte.
 */
export function rutaDeNotaDeVoz(nombreArchivo: string): string | null {
  if (!/^[A-Za-z0-9-]+\.[a-z0-9]{2,5}$/.test(nombreArchivo)) {
    logger.warn(`Nombre de nota de voz no válido: ${nombreArchivo}`);
    return null;
  }
  const ruta = join(AUDIO_ROOT, nombreArchivo);
  return existsSync(ruta) ? ruta : null;
}
