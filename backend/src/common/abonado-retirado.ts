import { Prisma } from '@prisma/client';
import { rangoDeDiasColombia } from './fecha-colombia';

/**
 * Qué es un "retiro" y en qué día cuenta. Una sola definición para el panel ejecutivo y
 * la capa `analitica` de Metabase (vista `retiros_diarios` en backend/analitica/vistas.sql).
 *
 * - Sale de la FICHA: abonado real (`legacyId`) que HOY está RETIRADO, en el día en que
 *   pasó a ese estado (`statusChangedAt`, hora de Colombia). No del historial de estados:
 *   cada retiro deja ahí dos filas (la de SAVES y la del sync) y hay rutas que no lo
 *   escriben (ver la memoria "historial-estados-no-fiable").
 * - Un retiro que se deshizo no cuenta (21390: retirado el 15-sep, hoy CORTADO).
 * - Cuenta todo retiro, con o sin orden: retiro voluntario, devolución de equipo tipo
 *   "Retiro", cambio manual y las limpiezas masivas de la base (249 en tres días de
 *   marzo de 2025). La vista de Metabase los separa por tipo.
 * - Los DEPURADOS (baja desde cartera) no entran aquí: son otro estado.
 * - 438 retirados antiguos no tienen fecha de cambio y no caen en ningún mes.
 */
export function whereRetiro(desde: string, hasta: string): Prisma.SubscriberWhereInput {
  return {
    legacyId: { not: null },
    status: 'RETIRADO',
    statusChangedAt: rangoDeDiasColombia(desde, hasta) ?? {},
  };
}
