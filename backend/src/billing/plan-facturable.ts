import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { num } from '../common/money';

/** Un servicio facturable deducido de las facturas del abonado. */
export type ServicioDerivado = { kind: string; planName: string; price: number; taxRate: number };

/**
 * Plan facturable de los abonados SIN fila en SubscriberService, derivado de sus
 * facturas — la migración dejó ese hueco (los mismos clientes cuya ficha ya
 * enseña el plan leído de la factura, ver `subscribers.service.ts`).
 *
 * NO es un clon de la última factura, por dos trampas reales de esos datos:
 *   - La última factura puede ser un PRORRATEO de mes parcial ($8.145 cuando la
 *     mensualidad es $77.000) y hasta omitir un servicio que sí tiene (la TV no
 *     aparece en el prorrateo pero sí todos los meses anteriores).
 *   - Los campos combo/television traen basura del legacy ("Diseno e Importacion
 *     de Datos" por $476.000 NO es una mensualidad).
 *
 * Regla, en una consulta:
 *   QUÉ planes: los ítems de sus últimas 2 facturas de mensualidad (facturas con
 *     al menos un ítem que casa con el catálogo `Plan`, que además da el tipo).
 *     2 y no 1 para que un prorrateo corto no borre un servicio; 2 y no más para
 *     que un servicio retirado de verdad no reviva.
 *   A QUÉ precio: el más repetido de ese plan en los últimos 6 meses (empate lo
 *     gana el mayor: la mensualidad completa siempre supera al prorrateo). Sin
 *     precio en 6 meses no se factura: cobrar de memoria vieja es peor que omitir.
 *   Cliente NUEVO (el precio se vio UNA sola vez y por debajo del catálogo): esa
 *     única vez es el prorrateo del alta, no la mensualidad → manda el precio de
 *     catálogo del plan (con nombres duplicados en `Plan`, el mayor).
 *
 * `before` acota a facturas anteriores al mes (para asIfUnbilled).
 */
export async function planDeUltimaFactura(
  prisma: PrismaService,
  ids: string[],
  monthStart: Date,
  before?: Date,
): Promise<Map<string, ServicioDerivado[]>> {
  const porAbonado = new Map<string, ServicioDerivado[]>();
  if (!ids.length) return porAbonado;
  const corte = before ? Prisma.sql`AND i."invoiceDate" < ${before}` : Prisma.empty;
  const corte2 = before ? Prisma.sql`AND i2."invoiceDate" < ${before}` : Prisma.empty;
  const ventana = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() - 6, 1));

  const filas = await prisma.$queryRaw<
    { subscriberId: string; kind: string; name: string; price: Prisma.Decimal; taxRate: Prisma.Decimal | null; veces: bigint; planPrice: Prisma.Decimal | null }[]
  >`
    WITH con_plan AS (
      SELECT i."subscriberId", i.id,
             dense_rank() OVER (PARTITION BY i."subscriberId" ORDER BY i."invoiceDate" DESC, i.tid DESC) AS rk
        FROM "SubInvoice" i
       WHERE i."subscriberId" IN (${Prisma.join(ids)}) ${corte}
         AND EXISTS (SELECT 1 FROM "SubInvoiceItem" it JOIN "Plan" pl
                       ON lower(btrim(pl.name)) = lower(btrim(COALESCE(it."productName", it.description)))
                     WHERE it."invoiceId" = i.id AND it.price > 0)
    ),
    candidatos AS (
      SELECT DISTINCT c."subscriberId", pl.kind::text AS kind, pl.name
        FROM con_plan c
        JOIN "SubInvoiceItem" it ON it."invoiceId" = c.id
        JOIN "Plan" pl ON lower(btrim(pl.name)) = lower(btrim(COALESCE(it."productName", it.description)))
       -- Los PUNTOS salen SIEMPRE de SubscriberService, que es donde vive la
       -- cantidad. Derivarlos de la factura los traería con qty=1 y con el IVA
       -- en 0 que traen los renglones viejos del legacy.
       WHERE c.rk <= 2 AND it.price > 0 AND pl.kind <> 'PUNTOS'
    )
    SELECT DISTINCT ON (c."subscriberId", c.kind, c.name)
           c."subscriberId", c.kind, c.name, it.price, it."taxRate", count(*) AS veces,
           (SELECT max(p2.price) FROM "Plan" p2
             WHERE lower(btrim(p2.name)) = lower(btrim(c.name))) AS "planPrice"
      FROM candidatos c
      JOIN "SubInvoice" i2 ON i2."subscriberId" = c."subscriberId"
      JOIN "SubInvoiceItem" it ON it."invoiceId" = i2.id
       AND lower(btrim(COALESCE(it."productName", it.description))) = lower(btrim(c.name))
     WHERE it.price > 0 AND i2."invoiceDate" >= ${ventana} ${corte2}
     GROUP BY c."subscriberId", c.kind, c.name, it.price, it."taxRate"
     ORDER BY c."subscriberId", c.kind, c.name, count(*) DESC, it.price DESC`;
  for (const f of filas) {
    const arr = porAbonado.get(f.subscriberId) ?? [];
    const esProrrateoDeAlta = Number(f.veces) <= 1 && num(f.planPrice) > num(f.price);
    arr.push({ kind: f.kind, planName: f.name, price: esProrrateoDeAlta ? num(f.planPrice) : num(f.price), taxRate: num(f.taxRate) });
    porAbonado.set(f.subscriberId, arr);
  }
  return porAbonado;
}
