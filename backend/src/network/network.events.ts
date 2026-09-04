/**
 * Eventos de red. Archivo sin imports, igual que `treasury/treasury.events.ts`.
 */

/**
 * Se le devolvió el servicio a un abonado DE VERDAD (no en dry-run).
 *
 * Lo escucha el writeback para contárselo al legacy en el acto. No es un adorno: la
 * ida del sync vuelve a traer `customers.usu_estado` cada 15 minutos, así que una
 * reconexión que no llegue allá antes de esa pasada se borra sola y el abonado —que
 * está navegando— vuelve a aparecer cortado en las dos pantallas.
 *
 * Se emite desde `ReconexionService`, que es por donde pasan los dos caminos (pago de
 * mostrador y cargue de pagos), y también cuando la reconexión termina en segundo
 * plano tras el tope de espera de la caja.
 */
export const RECONEXION_APLICADA_EVENT = 'network.reconexion.aplicada';

export interface ReconexionAplicadaEvent {
  /** Abonados a los que les volvió algún servicio en esta tanda. */
  subscriberIds: string[];
  /** Qué se devolvió (para el log; el writeback lo deduce de las órdenes). */
  servicios: Array<'INTERNET' | 'TV'>;
}
