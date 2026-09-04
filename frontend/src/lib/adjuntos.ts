/**
 * Valores de `accept` para los `<input type="file">` del sistema.
 *
 * Por qué existe este fichero (y por qué NO se pone la lista a mano en cada
 * pantalla): en el móvil, un `accept` construido SÓLO con extensiones
 * (`.jpg,.png,.pdf`) hace que el selector de Android ofrezca únicamente el
 * explorador de archivos — la **Galería no aparece**. De ahí la queja de los
 * funcionarios de que "hay que convertir la foto en archivo" para poder subirla:
 * no era un problema de tamaño ni de permisos, era el `accept`.
 *
 * Regla, y hay que respetarla al añadir uno nuevo:
 *  1. El tipo MIME va SIEMPRE primero (`image/*`). Es lo que hace que el selector
 *     liste Galería/Fotos junto al explorador.
 *  2. Las extensiones van detrás, sólo como respaldo de escritorio: Windows filtra
 *     por extensión y hay tipos de Office que algunos navegadores no reconocen por
 *     MIME.
 *
 * Y una advertencia sobre `capture`: `capture="environment"` abre la cámara
 * DIRECTAMENTE y se salta el selector, así que con él la galería es inalcanzable.
 * Donde haga falta la cámara de un toque (técnico en campo), se ponen dos botones
 * —Cámara y Galería— en vez de forzar `capture` en el único que hay.
 */

/** Sólo imágenes: fotos de evidencia, huella, foto de perfil. */
export const ACCEPT_IMAGEN = 'image/*';

/** Comprobantes de caja: foto del recibo o el PDF del banco. */
export const ACCEPT_IMAGEN_PDF = 'image/*,application/pdf,.pdf';

/** Documentos de funcionario: lo anterior más Word (hojas de vida, contratos). */
export const ACCEPT_DOCUMENTO = [
  'image/*',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf,.doc,.docx',
].join(',');

/** Adjunto general (órdenes de compra, archivos del cliente): todo lo anterior + hoja de cálculo, texto y ZIP. */
export const ACCEPT_ADJUNTO = [
  'image/*',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
  'application/zip',
  '.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip',
].join(',');
