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

/**
 * Una cajera abrió su caja en este sistema. Lo escucha el writeback para reflejar la
 * apertura en el legacy EN EL ACTO: mientras los dos convivan, una caja abierta aquí
 * y cerrada allá deja a la cajera sin poder facturar en el sistema que hoy manda, y
 * el menú de "Apertura" del legacy sólo se enseña de 5:00 a 7:59 am — pasada esa hora
 * ya no puede abrirla ella sola.
 */
export const CAJA_ABIERTA_EVENT = 'treasury.caja.abierta';

export interface CajaAbiertaEvent {
  /** `CashAccount.legacyId` de la caja que se abrió. */
  cashAccountId: number;
  /** Nombre con el que se firmó la apertura (el puente con el usuario del legacy). */
  openedBy: string;
}
