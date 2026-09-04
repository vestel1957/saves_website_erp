import { BadRequestException } from '../core/http/errores';

/**
 * PARA QUÉ ES cada adjunto de la ficha del cliente (`SubscriberFile.kind`).
 *
 * En la BD es una columna de texto suelta a propósito (ver el modelo): el legacy
 * no clasifica sus 14.420 archivos —bajan con `kind = null`— y un enum de Prisma
 * obligaría a migrar cada vez que la ventanilla necesita una etiqueta nueva. Este
 * catálogo es la lista blanca que sí se acepta al SUBIR; `null` sigue significando
 * "sin clasificar" y es lo que tienen los archivos heredados.
 *
 * Dos entradas no son etiquetas cualquiera y por eso salen de aquí como
 * constantes con nombre:
 *
 * - `CARTA_RETIRO` es uno de los cuatro requisitos del paz y salvo
 *   (`SubscribersService.statement`): sin ella no se expide el certificado.
 * - `VIVIENDA` es la foto que la ficha enseña arriba (la última que se suba).
 *
 * Las dos tienen además su propia ruta de subida (`POST /:id/carta-retiro` y
 * `POST /:id/house-photo`) porque admiten menos formatos que un adjunto suelto:
 * la carta hay que poder abrirla para leerla y la foto hay que poder pintarla.
 */

/** Marca de la CARTA DE RETIRO O SUSPENSIÓN: el papel firmado con el que el cliente pide la baja. */
export const KIND_CARTA_RETIRO = 'CARTA_RETIRO';

/** Marca de la foto de la casa del abonado (la portada de la ficha). */
export const KIND_VIVIENDA = 'VIVIENDA';

/** Tipos de documento que puede llevar un adjunto del cliente, en el orden del desplegable. */
export const TIPOS_ARCHIVO_ABONADO = [
  { kind: KIND_CARTA_RETIRO, label: 'Carta de retiro' },
  { kind: 'SUSPENSION', label: 'Solicitud de suspensión' },
  { kind: 'SOLICITUD', label: 'Solicitud / petición' },
  { kind: 'RECLAMO', label: 'Reclamo (PQR)' },
  { kind: 'CONTRATO', label: 'Contrato o anexo' },
  { kind: 'IDENTIDAD', label: 'Documento de identidad' },
  { kind: 'SOPORTE_PAGO', label: 'Soporte de pago' },
  { kind: 'TRASLADO', label: 'Traslado' },
  { kind: 'CAMBIO_TITULAR', label: 'Cambio de titular' },
  { kind: 'DEVOLUCION_EQUIPO', label: 'Devolución de equipo' },
  { kind: 'ACTA', label: 'Acta o constancia' },
  { kind: KIND_VIVIENDA, label: 'Foto de la vivienda' },
  { kind: 'OTRO', label: 'Otro documento' },
] as const;

/** Las claves válidas, para validar en O(1). */
export const KINDS_ARCHIVO_ABONADO: ReadonlySet<string> = new Set(
  TIPOS_ARCHIVO_ABONADO.map((t) => t.kind),
);

/** Etiqueta legible de un tipo (para PDFs, avisos y el bot). */
export function etiquetaTipoArchivo(kind?: string | null): string | null {
  if (!kind) return null;
  return TIPOS_ARCHIVO_ABONADO.find((t) => t.kind === kind)?.label ?? kind;
}

/**
 * Normaliza el tipo que llega del formulario de subida.
 *
 * Vacío = adjunto sin clasificar (`null`), que es lo que había hasta ahora y lo
 * que baja del legacy. Cualquier otra cosa tiene que estar en el catálogo: si se
 * aceptara texto libre, la carta que habilita el paz y salvo se podría guardar
 * como `carta_retiro` o `Carta Retiro` y el requisito dejaría de encontrarla.
 */
export function normalizarTipoArchivo(kind?: string | null): string | null {
  const v = (kind ?? '').trim().toUpperCase();
  if (!v) return null;
  if (!KINDS_ARCHIVO_ABONADO.has(v)) throw new BadRequestException(`Tipo de documento no válido: ${kind}`);
  return v;
}
