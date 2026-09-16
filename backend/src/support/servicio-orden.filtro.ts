import type { Prisma } from '@prisma/client';
import { esMixDeServicios, mixDeTodos, type MixDeServicios } from '../common/servicios-del-abonado';
import type { PrismaService } from '../prisma/prisma.service';
import { FRAGMENTOS_SERVICIO } from './order-types';

/**
 * El filtro "Servicio" de las listas de órdenes, traducido a Prisma.
 *
 * La pantalla enseña en cada fila QUÉ TIENE CONTRATADO EL CLIENTE —Solo TV, Solo
 * internet o Combo— y al lado ofrece filtrar por eso mismo. Las dos cosas TIENEN
 * que decir lo mismo: un filtro que decidiera por su cuenta enseñaría filas sin el
 * cartel que se acaba de marcar, o escondería otras que sí lo llevan.
 *
 * Son DOS condiciones, las mismas dos que deciden si se pinta el cartel:
 *   1. que la orden VAYA DE UN SERVICIO (que su detalle nombre televisión,
 *      internet o combo). Una 'Instalacion' o un 'Cambio de equipo' no llevan
 *      cartel —colgárselo a media lista no distinguiría nada—, así que tampoco
 *      tienen por qué salir al filtrar por él.
 *   2. que el CLIENTE sea de los elegidos, que es lo que dice el cartel.
 *
 * La segunda no se puede escribir en Prisma: lo contratado sale de la ÚLTIMA
 * factura recurrente de cada abonado y eso no es un `where` de una relación. Se
 * resuelve con el mapa de `mixDeTodos` —toda la base, con caché de 5 minutos— y
 * viaja como una lista de ids. Va en SQL y no sobre lo ya cargado porque las dos
 * listas paginan en el servidor: filtrar en el navegador dejaría fuera todo lo que
 * no esté en la página que se está mirando.
 *
 * `servicio-orden.spec.ts` corre esta regla y la de memoria sobre el catálogo
 * entero y sobre los detalles que hay en la base, y exige que coincidan.
 */

const contiene = (fragmento: string): Prisma.TicketWhereInput => ({
  type: { contains: fragmento, mode: 'insensitive' },
});

/**
 * "Esta orden va de un servicio": su detalle nombra la televisión, el internet o el
 * combo, con cualquiera de las formas que usa el legacy ('televi', 'tv',
 * 'internet', 'combo'). Es el mismo puñado de fragmentos que lee
 * `servicioNombradoEnOrden` en memoria, y viven juntos en `order-types.ts` para que
 * no puedan separarse.
 */
export const ORDEN_DE_SERVICIO: Prisma.TicketWhereInput = {
  OR: [...new Set(Object.values(FRAGMENTOS_SERVICIO).flat())].map(contiene),
};

/**
 * Condición para los servicios elegidos, o `null` si no se eligió ninguno válido.
 *
 * Selección múltiple, como el resto de la barra: lo marcado dentro del filtro suma
 * (Solo TV o Combo) y lo que llegue sin sentido por la URL se ignora, que es lo que
 * hacen los demás filtros — no vale devolver cero órdenes por un parámetro raro.
 */
export async function whereDeServicios(
  prisma: PrismaService,
  crudos: readonly string[],
): Promise<Prisma.TicketWhereInput | null> {
  const elegidos = new Set<MixDeServicios>(
    crudos
      .map((v) => v.trim().toUpperCase())
      .filter(esMixDeServicios)
      .map((v) => v as MixDeServicios),
  );
  if (!elegidos.size) return null;
  const mapa = await mixDeTodos(prisma);
  const ids: string[] = [];
  for (const [id, mix] of mapa) if (elegidos.has(mix)) ids.push(id);
  // Lista vacía = ningún abonado es de ese tipo, y entonces no hay órdenes que
  // enseñar. Es la respuesta correcta, no un filtro que se cae.
  return { AND: [ORDEN_DE_SERVICIO, { subscriberId: { in: ids } }] };
}
