import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * QUÉ TIENE CONTRATADO EL ABONADO: sólo televisión, sólo internet, o los dos.
 *
 * Nació el 2026-09-10 para el cartel de la lista de órdenes. La primera versión de
 * ese cartel leía el NOMBRE DE LA ORDEN ('Reconexion Television' → TV), y eso
 * contesta otra pregunta: 33 de las 38 'Reconexion Television2' abiertas ese día
 * eran de clientes que TAMBIÉN tienen internet, así que la lista los marcaba de
 * televisión y quien repartía el trabajo los daba por "de solo TV" hasta abrirlos.
 * Lo que hacía falta saber de un barrido es qué tiene el cliente, no cómo se llama
 * el detalle — el detalle ya está escrito al lado, en su columna.
 *
 * LA FUENTE ES LA FACTURA, no `SubscriberService`. Es la misma decisión (y la misma
 * consulta) que toma la ficha del cliente en `SubscribersService.estadoPorServicio`,
 * y por los mismos dos motivos:
 *   - `SubscriberService` está incompleto: se materializó de una pasada sólo para
 *     los ACTIVO que casaban con el catálogo, y 2.350 clientes vivos no tienen ni
 *     una fila.
 *   - el legacy lee el plan de `invoices.combo` / `invoices.television` (aquí
 *     `SubInvoice.serviceCombo` / `serviceTv`), así que lo que se enseña coincide
 *     con lo que se le está cobrando.
 * `SubscriberService` sí entra como RESPALDO para el que no tiene ni una factura
 * recurrente (los 55 ACTIVO recién dados de alta): ahí es la única fuente que hay.
 */
export type MixDeServicios = 'TV' | 'INTERNET' | 'COMBO';

/**
 * ¿La factura NOMBRA ese servicio? Es el candado imprescindible al leer
 * `serviceTv`/`serviceCombo`: el legacy deja el campo en `'no'` —y a veces vacío o
 * en `'-'`— para el servicio que el abonado no tiene, y sin este filtro los 9.223
 * `'no'` de la base pasarían por planes contratados.
 *
 * Vive aquí porque lo preguntan dos sitios sobre la misma columna: este cartel y el
 * estado por servicio de la ficha (`estadoPorServicio`, que sin el candado le
 * inventaba un internet cortado a los abonados de solo televisión).
 */
export function contratadoEnFactura(v?: string | null): boolean {
  const t = (v ?? '').trim().toLowerCase();
  return !!t && t !== 'no' && t !== '-';
}

/** Los tres valores, para validar lo que llegue por la URL. */
export const MIXES: readonly MixDeServicios[] = ['TV', 'INTERNET', 'COMBO'];

export const esMixDeServicios = (v: unknown): v is MixDeServicios =>
  typeof v === 'string' && (MIXES as readonly string[]).includes(v.trim().toUpperCase());

/**
 * Cómo se escribe el cartel donde no cabe un icono: el Excel del listado y el del
 * agendamiento. En pantalla lo pinta el frontend con su icono al lado (ver
 * `ChipServicio`), pero el papel se lee sin colores, y "TV" a secas en una columna
 * llamada Servicio no dice si el internet también entra — que es justo lo que hay
 * que poder ver.
 */
export const ETIQUETA_MIX: Record<MixDeServicios, string> = {
  TV: 'Solo televisión',
  INTERNET: 'Solo internet',
  COMBO: 'TV + internet',
};

type FilaDeFactura = { subscriberId: string; serviceTv: string | null; serviceCombo: string | null };

const mixDe = (tv: boolean, internet: boolean): MixDeServicios | null =>
  tv && internet ? 'COMBO' : tv ? 'TV' : internet ? 'INTERNET' : null;

/**
 * La última factura RECURRENTE viva de cada abonado, que es la que dicta el plan.
 *
 * Recurrente y no la última a secas: una FIJA posterior (una instalación, un
 * traslado) arrastra el snapshot viejo de los campos de servicio. Y sin las
 * CANCELED, que son facturas fantasma y decidían el corte de 11 abonados cuando la
 * ficha las miraba.
 *
 * `ORDER BY "invoiceDate" DESC` va sin `NULLS LAST` a propósito: la columna es NOT
 * NULL (`DateTime @db.Date`), y escrito así el orden es exactamente el del índice
 * `SubInvoice_subscriberId_invoiceDate_tid_idx`, que es lo que convierte el barrido
 * de las 445.000 facturas en un recorrido de índice.
 */
async function ultimaRecurrente(prisma: PrismaService, ids?: string[]): Promise<FilaDeFactura[]> {
  const soloEsos = ids?.length ? Prisma.sql`AND i."subscriberId" IN (${Prisma.join(ids)})` : Prisma.empty;
  return prisma.$queryRaw<FilaDeFactura[]>`
    SELECT DISTINCT ON (i."subscriberId")
           i."subscriberId", i."serviceTv", i."serviceCombo"
      FROM "SubInvoice" i
     WHERE i.kind = 'RECURRENTE'
       AND i.status <> 'CANCELED'
       ${soloEsos}
     ORDER BY i."subscriberId", i."invoiceDate" DESC, i.tid DESC`;
}

/**
 * El respaldo para quien no tiene factura recurrente: sus servicios registrados.
 *
 * No se mira `SubscriberService.status` —dice ACTIVO casi siempre, se materializó
 * de una pasada— sino que EXISTA la fila. 'PUNTOS' es televisión: son los puntos
 * adicionales de TV.
 */
async function serviciosRegistrados(prisma: PrismaService, ids?: string[]) {
  const filas = await prisma.subscriberService.findMany({
    where: { kind: { in: ['TV', 'PUNTOS', 'INTERNET'] }, ...(ids?.length ? { subscriberId: { in: ids } } : {}) },
    select: { subscriberId: true, kind: true },
  });
  const por = new Map<string, { tv: boolean; internet: boolean }>();
  for (const f of filas) {
    const acc = por.get(f.subscriberId) ?? { tv: false, internet: false };
    if (f.kind === 'INTERNET') acc.internet = true;
    else acc.tv = true;
    por.set(f.subscriberId, acc);
  }
  return por;
}

/**
 * Qué tiene contratado cada uno de esos abonados. Los que no se sepan no salen en
 * el mapa: "no consta" no es lo mismo que "no tiene", y un cartel inventado es
 * peor que ningún cartel.
 *
 * `ids` vacío o sin pasar = TODA la base (es lo que usa el filtro; ver `mixDeTodos`).
 */
export async function mixPorAbonado(prisma: PrismaService, ids?: string[]): Promise<Map<string, MixDeServicios>> {
  if (ids && !ids.length) return new Map();
  const porAbonado = new Map<string, MixDeServicios>();
  const facturas = await ultimaRecurrente(prisma, ids);
  for (const f of facturas) {
    const mix = mixDe(contratadoEnFactura(f.serviceTv), contratadoEnFactura(f.serviceCombo));
    if (mix) porAbonado.set(f.subscriberId, mix);
  }
  // El respaldo sólo entra donde la factura no dijo nada: si la factura habla, manda
  // ella (es lo que se le cobra, y es lo que el legacy enseña).
  const sinFactura = (ids ?? []).filter((id) => !porAbonado.has(id));
  if (!ids || sinFactura.length) {
    for (const [id, s] of await serviciosRegistrados(prisma, ids ? sinFactura : undefined)) {
      if (porAbonado.has(id)) continue;
      const mix = mixDe(s.tv, s.internet);
      if (mix) porAbonado.set(id, mix);
    }
  }
  return porAbonado;
}

/**
 * Lo mismo para TODA la base, con caché de 5 minutos.
 *
 * Lo pide el FILTRO de servicio de las listas de órdenes, que necesita el universo
 * entero para traducirse a un `WHERE` (Prisma no sabe preguntar por "la última
 * factura de cada abonado"). Recorrer las 445.000 facturas cuesta ~0,7 s, así que
 * se guarda el resultado y se sirve tibio mientras se refresca por detrás: lo que
 * se está midiendo cambia cuando se emite la facturación del mes o cuando alguien
 * da de alta o de baja un servicio, no de un segundo para otro.
 *
 * Las FILAS de la lista no pasan por aquí: se resuelven en vivo con los cien
 * abonados de la página (`mixPorAbonado`), que es una consulta de milisegundos y
 * siempre exacta. El desfase posible entre las dos —un servicio dado de alta hace
 * menos de cinco minutos— es que esa orden salga o no salga al filtrar; el cartel
 * de la fila ya dice la verdad.
 */
const TTL_MS = 5 * 60 * 1000;
let cache: { at: number; mapa: Map<string, MixDeServicios> } | null = null;
let refrescando: Promise<Map<string, MixDeServicios>> | null = null;

export async function mixDeTodos(prisma: PrismaService): Promise<Map<string, MixDeServicios>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.mapa;
  if (!refrescando) {
    refrescando = mixPorAbonado(prisma)
      .then((mapa) => {
        cache = { at: Date.now(), mapa };
        return mapa;
      })
      .finally(() => { refrescando = null; });
    // Si el refresco falla teniendo algo tibio que servir, el rechazo no puede
    // quedar suelto (nadie va a estar esperando esa promesa).
    if (cache) refrescando.catch(() => undefined);
  }
  // Tibio: mientras se rehace, se contesta con lo anterior antes que hacer esperar.
  return cache ? cache.mapa : refrescando;
}

/** Para los tests y para cualquier trabajo que acabe de mover servicios en bloque. */
export function olvidarMixDeTodos() {
  cache = null;
}
