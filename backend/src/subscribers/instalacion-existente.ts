import mysql from 'mysql2/promise';
import { Logger } from '../core/logger';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * ¿ALGUIEN ABRIÓ YA la orden de instalación de esta alta?
 *
 * El candado de `PendingInstall.fulfilledAt` sólo protege a nexus contra sí mismo: el
 * evento del recaudo y el barrido de los 5 minutos no se pisan. Pero el sistema
 * anterior abre SU PROPIA orden por su cuenta —`Invoices_model::validacion_generar_orden_instalacion`,
 * que corre al final de `Customers_model::pay_invoices()`— cada vez que se paga allá una
 * factura que lleva un producto «afiliación». Y allá se paga siempre que el cliente use
 * el PORTAL (PSE/Wompi): el portal le pasa el pago al legacy, no a nexus.
 *
 * Resultado hasta 2026-09-02: el cliente paga la afiliación por PSE, el legacy abre la
 * orden, el sync la trae, y cinco minutos después el barrido abre otra. Dos visitas
 * para la misma casa, y las dos en los dos sistemas (las de nexus viajan allá).
 *
 * La regla, entonces: antes de abrir nada se mira si la orden ya existe. Si existe se
 * ADOPTA —igual que con la ONU ya autenticada de la OLT— en vez de crear una segunda.
 */

/** Clase/detalle con el que los DOS sistemas marcan la instalación. */
export const TIPO_ORDEN_INSTALACION = 'Instalacion';

/** Una orden anulada no cuenta: hay que volver a abrirla. */
export const ESTADO_ORDEN_ANULADA = 'ANULADA';

export type OrdenInstalacion = {
  id: string;
  code: number | null;
  section: string | null;
  problem: string | null;
  invoiceLegacy: number | null;
};

/**
 * La orden de instalación que ya tenga este cliente para esta alta, venga de donde venga.
 *
 * Dos criterios, y basta con uno:
 * - `invoiceLegacy` = el tid de la factura de afiliación. Es el vínculo que usa el propio
 *   legacy (`tickets.id_invoice`) para no duplicar las suyas, así que las nacidas allá
 *   llegan marcadas y se reconocen sin ambigüedad.
 * - creada DESPUÉS del alta. Cubre a la que nació allá sin ese vínculo y a la que abrió
 *   una persona a mano: para un cliente recién dado de alta, cualquier orden de
 *   instalación posterior ES esta instalación.
 *
 * `desde` es el momento en que se guardó la instalación pendiente. No se mira más atrás
 * a propósito: un abonado antiguo arrastra la orden de su instalación original —resuelta
 * hace años— y adoptarla dejaría al técnico sin visita.
 */
export async function buscarOrdenInstalacion(
  prisma: PrismaService,
  datos: { subscriberId: string; invoiceTid: number | null; desde: Date },
): Promise<OrdenInstalacion | null> {
  const orden = await prisma.ticket.findFirst({
    where: {
      subscriberId: datos.subscriberId,
      type: TIPO_ORDEN_INSTALACION,
      status: { not: ESTADO_ORDEN_ANULADA },
      OR: [
        ...(datos.invoiceTid ? [{ invoiceLegacy: datos.invoiceTid }] : []),
        { createdAt: { gte: datos.desde } },
      ],
    },
    select: { id: true, code: true, section: true, problem: true, invoiceLegacy: true },
    orderBy: { createdAt: 'asc' },
  });
  return orden;
}

/**
 * ¿Existe ya la orden EN EL LEGACY, aunque el sync todavía no la haya traído?
 *
 * Tapa la ventana entre los dos relojes: el legacy abre su orden en el instante del
 * pago y la ida la trae cada 15 minutos, mientras el barrido corre cada 5. Sin esta
 * pregunta, un barrido que caiga en medio abriría la segunda orden igual.
 *
 * Es la MISMA consulta con la que el legacy se protege a sí mismo. Sólo lee, y si no se
 * puede leer (no hay credenciales, el MySQL no responde) devuelve `consultado: false`:
 * quedarse sin abrir la orden porque el sistema viejo no contesta sería peor que el
 * duplicado que se está evitando.
 */
export async function ordenInstalacionEnLegacy(
  invoiceTid: number,
  logger?: Logger,
): Promise<{ consultado: boolean; codigo: number | null }> {
  const { LEGACY_DB_HOST, LEGACY_DB_USER, LEGACY_DB_PASSWORD, LEGACY_DB_NAME } = process.env;
  if (!LEGACY_DB_HOST || !LEGACY_DB_USER || !LEGACY_DB_NAME) return { consultado: false, codigo: null };

  let cn: mysql.Connection | null = null;
  try {
    cn = await mysql.createConnection({
      host: LEGACY_DB_HOST,
      port: Number(process.env.LEGACY_DB_PORT || 3306),
      user: LEGACY_DB_USER,
      password: LEGACY_DB_PASSWORD,
      database: LEGACY_DB_NAME,
      connectTimeout: 5_000,
    });
    const [filas] = await cn.query<any[]>(
      'SELECT codigo FROM tickets WHERE id_invoice = ? AND detalle = ? LIMIT 1',
      [invoiceTid, TIPO_ORDEN_INSTALACION],
    );
    return { consultado: true, codigo: filas?.[0]?.codigo != null ? Number(filas[0].codigo) : null };
  } catch (e) {
    logger?.warn(`[instalacion] no se pudo preguntar al sistema anterior por la factura ${invoiceTid}: ${(e as Error).message}`);
    return { consultado: false, codigo: null };
  } finally {
    try { await cn?.end(); } catch { /* noop */ }
  }
}

/**
 * Lo que hay que añadirle a una orden ADOPTADA para que el técnico no salga a ciegas.
 *
 * La que abre el legacy trae en `section` los servicios contratados («TV + 100 MEGAS»)
 * y nada más: ni dirección, ni tecnología, ni usuario PPPoE, ni celular — que es
 * justamente lo que guarda `PendingInstall.context` desde el alta. Se AÑADE debajo, no
 * se pisa: lo que ya escribió el otro sistema también sirve.
 */
export function completarOrdenAdoptada(
  orden: { section: string | null; problem: string | null },
  contexto: string | null,
): { section?: string; problem?: string } {
  const cambios: { section?: string; problem?: string } = {};
  const actual = (orden.section ?? '').trim();
  const nuevo = (contexto ?? '').trim();
  // El legacy escribe `section: '+'` cuando el abonado no tiene ni TV ni plan que
  // enseñar: es su vacío, no un dato.
  const vacio = !actual || actual === '+';
  if (nuevo && !actual.includes(nuevo)) cambios.section = vacio ? nuevo : `${actual}\n${nuevo}`;
  if (!(orden.problem ?? '').trim()) cambios.problem = 'Instalación de servicio nuevo';
  return cambios;
}
