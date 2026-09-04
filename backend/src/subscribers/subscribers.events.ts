/**
 * Eventos de la ficha del abonado. Archivo sin imports, igual que
 * `network/network.events.ts` y `treasury/treasury.events.ts`.
 */

/**
 * A un abonado se le movió A MANO el estado de UN servicio (su internet o su TV).
 *
 * Lo escucha el writeback para llevárselo al legacy EN EL ACTO, por lo mismo que la
 * reconexión y la baja: `invoices.estado_tv` / `estado_combo` son columnas que la ida
 * vuelve a traer cada 15 minutos, así que una suspensión que no llegue allá antes se
 * deshace sola y el servicio vuelve a pintarse al aire.
 */
export const ESTADO_SERVICIO_EVENT = 'subscribers.estado-servicio.cambiado';

export interface EstadoServicioEvent {
  subscriberId: string;
  /** Qué servicio se movió. */
  servicio: 'INTERNET' | 'TV';
  /** Estado que quedó ('ACTIVO' | 'CORTADO' | 'SUSPENDIDO'). */
  estado: string;
}
