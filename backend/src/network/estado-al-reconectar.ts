import { SubscriberStatus } from '@prisma/client';

/**
 * Estados que una reconexión NO pisa, aunque el servicio vuelva de verdad.
 *
 * COMPROMISO no es un estado de corte: es la marca de que el abonado tiene un ACUERDO
 * DE PAGO en curso. Devolverle el servicio y de paso ponerlo en ACTIVO borra el acuerdo
 * de la ficha —nadie vuelve a saber que quedó debiendo a plazo— y es justo lo que pasó
 * el 2026-08-28 con el arrastre del portal de pagos: 39 compromisos amanecieron como
 * activos. El servicio sí se le devuelve; lo que no se toca es su estado.
 *
 * Ojo: esto es distinto de `ESTADOS_SIN_RECONEXION` (retirados y suspendidos), a los
 * que directamente no se les reconecta nada.
 */
export const ESTADOS_QUE_LA_RECONEXION_NO_PISA: SubscriberStatus[] = ['COMPROMISO'];

/**
 * ¿A este abonado se le devuelve el servicio pero se le respeta el estado?
 *
 * Acepta `string` porque los dos llamadores traen el estado de sitios distintos: uno
 * tipado con el enum de Prisma y otro con el `select` crudo del router.
 */
export function conservaEstadoAlReconectar(status: SubscriberStatus | string | null | undefined) {
  return !!status && (ESTADOS_QUE_LA_RECONEXION_NO_PISA as string[]).includes(status);
}
