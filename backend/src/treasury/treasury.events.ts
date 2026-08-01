/**
 * Eventos de tesorería para que otros módulos reaccionen sin que tesorería los
 * conozca. Archivo sin imports, igual que `support/support.events.ts`.
 */

/** Se registró un pago de un abonado (y, si estaba cortado, se intentó reconectarlo). */
export const PAGO_APLICADO_EVENT = 'treasury.pago.aplicado';

export interface PagoAplicadoEvent {
  subscriberId: string;
  /** Lo que efectivamente se aplicó a facturas. */
  monto: number;
  /**
   * Resultado de la reconexión automática:
   *   'reconectado' — estaba cortado y volvió el servicio,
   *   'no-aplica'   — no estaba cortado, no había nada que reconectar,
   *   'fallo'       — se intentó y los equipos no respondieron.
   * Solo el primero da pie a avisarle al cliente: los otros dos no son noticia para él.
   */
  reconexion: 'reconectado' | 'no-aplica' | 'fallo';
}
