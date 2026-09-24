import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * ¿Qué servicios tiene contratados cada abonado: internet, televisión o los dos?
 *
 * Nació de una queja de Cartera (2026-09-23): "el sistema genera órdenes de internet
 * y de TV sin importar si el cliente sólo tiene TV o sólo tiene internet". Medido en
 * las órdenes automáticas del 21 y 22-09:
 *  · al PAGAR, clientes de SoloTelevision (4375, 4410, 4653, 8013, 8173…) recibían una
 *    "Reconexion Internet" pendiente: su usuario PPPoE es el "0" de relleno del legacy
 *    (o uno viejo que ya no usan) y eso bastaba para "intentar" el internet;
 *  · el CORTE MASIVO de TV cortaba a quien sólo paga internet (53388, 53656) y el de
 *    internet a quien sólo paga TV, porque el lote no preguntaba qué tenía cada uno.
 *
 * La fuente buena son las LÍNEAS de sus facturas de mensualidad, no una sola:
 *  · hay abonados con DOS facturas al mes, una por contrato (el 204 paga internet en
 *    una y SoloTelevision en otra), así que mirar sólo la última ve medio cliente;
 *  · la última puede ser un prorrateo con un solo servicio (52433, 53040, 56779 el
 *    21/22-09: sólo el internet, con la TV cobrada todos los meses), o la de la
 *    corrida del 01-09 que dejó sin internet a ~60 combos (ver septiembre-sin-internet).
 * Por eso cuenta todo lo cobrado en las mensualidades del mes de la última y del
 * mes anterior (desde el día 1: un prorrateo del 22 no puede tapar la del 1.º).
 * Quien dio de baja un servicio lo sigue "teniendo" hasta que pase un mes entero sin
 * cobrárselo; para la reconexión eso lo tapa el veto propio de la TV dada de baja. Sin facturas con líneas de servicio (clientes nuevos, la
 * migración) se pregunta a `SubscriberService`. Sin ninguna de las dos no se sabe, y
 * el abonado NO aparece en el mapa: quien consulta decide qué hacer con la duda (hoy,
 * dejarlo pasar, que es lo que se hacía antes).
 */
export type ServiciosContratados = { internet: boolean; tv: boolean };

/** ¿La línea cobra televisión? (el plan, "SoloTelevision…" o un punto; no la afiliación). */
export const esLineaTv = (nombre: string | null) =>
  /televisi|punto adicional/i.test(nombre ?? '') && !/afiliaci/i.test(nombre ?? '');

/** ¿La línea cobra internet? Los planes de internet se llaman por sus megas ("100 Megas F-26", "5MegasV"). */
export const esLineaInternet = (nombre: string | null) => /megas?/i.test(nombre ?? '');

export async function serviciosContratados(
  prisma: PrismaService,
  ids: string[],
): Promise<Map<string, ServiciosContratados>> {
  const salida = new Map<string, ServiciosContratados>();
  const unicos = [...new Set(ids.filter(Boolean))];
  if (!unicos.length) return salida;

  const lineas = await prisma.$queryRaw<{ subscriberId: string; nombre: string | null }[]>`
    WITH ultima AS (
      SELECT i."subscriberId", max(i."invoiceDate") AS fecha
        FROM "SubInvoice" i
       WHERE i."subscriberId" IN (${Prisma.join(unicos)})
         AND i.kind = 'RECURRENTE' AND i.status <> 'CANCELED'
       GROUP BY i."subscriberId"
    )
    SELECT i."subscriberId", COALESCE(it."productName", it.description) AS nombre
      FROM ultima u
      JOIN "SubInvoice" i ON i."subscriberId" = u."subscriberId"
       AND i.kind = 'RECURRENTE' AND i.status <> 'CANCELED'
       AND i."invoiceDate" >= date_trunc('month', u.fecha) - interval '1 month'
      JOIN "SubInvoiceItem" it ON it."invoiceId" = i.id`;
  for (const l of lineas) {
    const internet = esLineaInternet(l.nombre);
    const tv = esLineaTv(l.nombre);
    // Las notas crédito/débito y los cargos sueltos no dicen nada del servicio.
    if (!internet && !tv) continue;
    const v = salida.get(l.subscriberId) ?? { internet: false, tv: false };
    salida.set(l.subscriberId, { internet: v.internet || internet, tv: v.tv || tv });
  }

  const faltan = unicos.filter((id) => !salida.has(id));
  if (faltan.length) {
    const filas = await prisma.subscriberService.findMany({
      where: { subscriberId: { in: faltan } },
      select: { subscriberId: true, kind: true },
    });
    for (const f of filas) {
      const v = salida.get(f.subscriberId) ?? { internet: false, tv: false };
      salida.set(f.subscriberId, {
        internet: v.internet || f.kind === 'INTERNET',
        tv: v.tv || f.kind === 'TV' || f.kind === 'PUNTOS',
      });
    }
  }
  return salida;
}

/** ¿Tiene este servicio? La duda (sin datos) cuenta como sí: no se le quita a nadie por no saber. */
export function tieneServicio(
  mapa: Map<string, ServiciosContratados>,
  id: string,
  servicio: 'INTERNET' | 'TV',
): boolean {
  const s = mapa.get(id);
  if (!s) return true;
  return servicio === 'INTERNET' ? s.internet : s.tv;
}
