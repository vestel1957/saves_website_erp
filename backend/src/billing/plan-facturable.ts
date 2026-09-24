import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ivaDe, num, round2 } from '../common/money';

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
 * ÚLTIMO ESCALÓN — la CABECERA (`planDeCabecera`): si de los ítems no sale nada,
 *   el plan se lee de `serviceCombo`/`serviceTv` de la última recurrente y el
 *   precio del catálogo `Plan`. Es exactamente lo que hace el legacy en
 *   `generar_facturas_logica` (lee `invoices.combo`/`television`, no los
 *   renglones), y es lo único que alcanza a un abonado RECIÉN INSTALADO: su mes
 *   de instalación se factura en $0, así que no tiene un solo ítem con precio del
 *   que deducir nada. Sin este escalón cae en `NO_SERVICES` y la corrida del mes
 *   lo salta EN SILENCIO (2026-09-01: 29 instalaciones de agosto sin facturar).
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
    WITH apagados AS (
      -- Lo que la factura VIGENTE da por quitado (el 'no' del legacy, que es lo que
      -- deja removeService). Sin esto, quitarle la televisión a un abonado sin fila
      -- en SubscriberService —la mitad de la base, cuyo plan sale derivado— no servía
      -- de nada: los renglones de los meses anteriores se la volvían a cobrar al mes
      -- siguiente. Vacío NO cuenta: es "esta factura no lo dice" (las emitidas a mano
      -- en ventanilla salen así), sólo el 'no' explícito tapa.
      SELECT DISTINCT ON (i."subscriberId")
             i."subscriberId",
             lower(btrim(coalesce(i."serviceCombo", ''))) AS combo,
             lower(btrim(coalesce(i."serviceTv", ''))) AS tv
        FROM "SubInvoice" i
       WHERE i."subscriberId" IN (${Prisma.join(ids)}) ${corte}
         AND i.kind = 'RECURRENTE' AND i.status <> 'CANCELED'
       ORDER BY i."subscriberId", i."invoiceDate" DESC, i.tid DESC
    ),
    con_plan AS (
      SELECT i."subscriberId", i.id,
             dense_rank() OVER (PARTITION BY i."subscriberId" ORDER BY i."invoiceDate" DESC, i.tid DESC) AS rk
        FROM "SubInvoice" i
       WHERE i."subscriberId" IN (${Prisma.join(ids)}) ${corte}
         AND EXISTS (SELECT 1 FROM "SubInvoiceItem" it JOIN "Plan" pl
                       ON lower(btrim(pl.name)) = lower(btrim(COALESCE(it."productName", it.description)))
                     WHERE it."invoiceId" = i.id AND it.price > 0)
    ),
    candidatos AS (
      -- UNA fila por plan, aunque el catálogo tenga el mismo nombre repetido con
      -- distinta caja: '10MegasF' y '10megasF' son dos filas de Plan y el ítem
      -- de la factura casa con las DOS, así que sin este DISTINCT ON el mismo
      -- internet salía dos veces. En la corrida del 01-09-2026 eso fueron 35
      -- facturas con el internet cobrado por duplicado (+$1.668.800), y en el
      -- prorrateo de reconexión los $73.600 del abonado 4286. El nombre que se
      -- conserva es el del plan más caro, igual que en planDeCabecera.
      SELECT DISTINCT ON (c."subscriberId", pl.kind, lower(btrim(pl.name)))
             c."subscriberId", pl.kind::text AS kind, pl.name
        FROM con_plan c
        JOIN "SubInvoiceItem" it ON it."invoiceId" = c.id
        JOIN "Plan" pl ON lower(btrim(pl.name)) = lower(btrim(COALESCE(it."productName", it.description)))
       -- Los PUNTOS salen SIEMPRE de SubscriberService, que es donde vive la
       -- cantidad. Derivarlos de la factura los traería con qty=1 y con el IVA
       -- en 0 que traen los renglones viejos del legacy.
       WHERE c.rk <= 2 AND it.price > 0 AND pl.kind <> 'PUNTOS'
         AND NOT EXISTS (
           SELECT 1 FROM apagados a
            WHERE a."subscriberId" = c."subscriberId"
              AND ((pl.kind::text = 'INTERNET' AND a.combo = 'no')
                OR (pl.kind::text = 'TV' AND a.tv = 'no')))
       ORDER BY c."subscriberId", pl.kind, lower(btrim(pl.name)), pl.price DESC, pl.name
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
  // Cinturón del mismo caso, ya fuera del SQL: el mismo plan no se devuelve dos
  // veces por diferencias de caja o de espacios en el nombre. Quien consume esto
  // convierte cada fila en un RENGLÓN de factura, así que un duplicado aquí es
  // plata cobrada de más.
  const vistos = new Set<string>();
  for (const f of filas) {
    const clave = `${f.subscriberId}|${f.kind}|${(f.name ?? '').trim().toLowerCase()}`;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    const arr = porAbonado.get(f.subscriberId) ?? [];
    const esProrrateoDeAlta = Number(f.veces) <= 1 && num(f.planPrice) > num(f.price);
    arr.push({ kind: f.kind, planName: f.name, price: esProrrateoDeAlta ? num(f.planPrice) : num(f.price), taxRate: num(f.taxRate) });
    porAbonado.set(f.subscriberId, arr);
  }

  // Los que de los ítems no dieron NADA (típicamente el recién instalado, cuyo mes
  // de alta va en $0) se resuelven por la cabecera. A los que sí dieron algo NO se
  // les toca: el precio real que paga el cliente manda sobre el de catálogo.
  const huerfanos = ids.filter((id) => !porAbonado.has(id));
  for (const [id, servicios] of await planDeCabecera(prisma, huerfanos, before)) {
    porAbonado.set(id, servicios);
  }
  return porAbonado;
}

/**
 * Plan leído de la CABECERA de la última factura recurrente (`serviceCombo` =
 * internet, `serviceTv` = TV), tarifado con el catálogo `Plan`. Es la regla del
 * legacy y el único camino para un abonado sin histórico de precios.
 *
 * Dos candados contra la basura que traen esos campos del legacy:
 *   · el nombre tiene que existir en `Plan` **y con el kind del hueco** (un
 *     "Diseno e Importacion de Datos" en `serviceCombo` no es un plan de internet);
 *   · `no` / vacío es cómo el legacy dice "este servicio no lo tiene".
 * Con nombres duplicados en `Plan` (los hay, con precios distintos) gana el mayor,
 * igual que en el resto del módulo.
 *
 * TODO o NADA: si el abonado tiene los dos servicios y uno de los nombres no está en
 * el catálogo, no se devuelve el otro. Facturarle media mensualidad es peor que no
 * facturarle: sale un documento con pinta de correcto y nadie lo revisa. Sin plan cae
 * en `NO_SERVICES`, que es la lista que sí se mira. Caso real: "300 Megas F-26" no
 * existe en `Plan` (y NO es el "300Megas26F" de $58.500: en el legacy vale $131.500).
 */
async function planDeCabecera(
  prisma: PrismaService,
  ids: string[],
  before?: Date,
): Promise<Map<string, ServicioDerivado[]>> {
  const out = new Map<string, ServicioDerivado[]>();
  if (!ids.length) return out;
  const corte = before ? Prisma.sql`AND i."invoiceDate" < ${before}` : Prisma.empty;

  const filas = await prisma.$queryRaw<
    { subscriberId: string; kind: string; name: string; price: Prisma.Decimal; taxRate: Prisma.Decimal | null }[]
  >`
    WITH ult AS (
      SELECT DISTINCT ON (i."subscriberId")
             i."subscriberId", i."serviceCombo" AS combo, i."serviceTv" AS tv
        FROM "SubInvoice" i
       WHERE i."subscriberId" IN (${Prisma.join(ids)}) ${corte}
         AND i.kind = 'RECURRENTE' AND i.status <> 'CANCELED'
       ORDER BY i."subscriberId", i."invoiceDate" DESC, i.tid DESC
    ),
    huecos AS (
      SELECT "subscriberId", 'INTERNET' AS kind, btrim(combo) AS name FROM ult
       WHERE combo IS NOT NULL AND lower(btrim(combo)) NOT IN ('', 'no')
      UNION ALL
      SELECT "subscriberId", 'TV', btrim(tv) FROM ult
       WHERE tv IS NOT NULL AND lower(btrim(tv)) NOT IN ('', 'no')
    ),
    tarifado AS (
      SELECT DISTINCT ON (h."subscriberId", h.kind)
             h."subscriberId", h.kind, pl.name, pl.price, pl."taxRate"
        FROM huecos h
        LEFT JOIN "Plan" pl ON lower(btrim(pl.name)) = lower(h.name)
                           AND pl.kind::text = h.kind AND pl.price > 0
       ORDER BY h."subscriberId", h.kind, pl.price DESC NULLS LAST
    )
    SELECT t."subscriberId", t.kind, t.name, t.price, t."taxRate"
      FROM tarifado t
     WHERE t.name IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM tarifado x
                        WHERE x."subscriberId" = t."subscriberId" AND x.name IS NULL)`;

  for (const f of filas) {
    const arr = out.get(f.subscriberId) ?? [];
    arr.push({ kind: f.kind, planName: f.name, price: num(f.price), taxRate: num(f.taxRate) });
    out.set(f.subscriberId, arr);
  }
  return out;
}

/**
 * La MENSUALIDAD ENTERA de cada abonado, con IVA: lo que la corrida del mes le
 * facturaría hoy. Es la vara para decir que una factura recurrente es "completa" y
 * no un prorrateo (el mes de la instalación o de una reconexión sale como
 * RECURRENTE por $161 o $13.100 y, sin esta vara, cuenta como un mes debido).
 *
 * Se arma igual que en `FacturasService.generate`, para que "su plan" signifique lo
 * mismo aquí que en la corrida: sus `SubscriberService` ACTIVO con precio, y lo que
 * le falte de INTERNET/TV sale de sus facturas (`planDeUltimaFactura`); los puntos
 * se suman. El total va renglón a renglón, como `computeTotals`.
 *
 * Quien no tiene plan (ni propio ni deducible) NO sale en el mapa: sin saber cuánto
 * es su mes no hay con qué comparar, y eso no puede leerse como "debe completo".
 */
export async function mensualidadesCompletas(
  prisma: PrismaService,
  ids: string[],
  monthStart: Date,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!ids.length) return out;
  type Renglon = { kind: string; price: number; taxRate: number; qty: number };
  const propios = new Map<string, Renglon[]>();
  for (const s of await prisma.subscriberService.findMany({
    where: { subscriberId: { in: ids }, status: 'ACTIVO', price: { gt: 0 } },
    select: { subscriberId: true, kind: true, price: true, taxRate: true, qty: true },
  })) {
    const arr = propios.get(s.subscriberId) ?? [];
    arr.push({ kind: s.kind, price: num(s.price), taxRate: num(s.taxRate), qty: s.qty });
    propios.set(s.subscriberId, arr);
  }
  const planDe = (id: string) => new Set((propios.get(id) ?? []).filter((r) => r.kind !== 'PUNTOS').map((r) => r.kind));
  const leFalta = ids.filter((id) => { const k = planDe(id); return !k.has('INTERNET') || !k.has('TV'); });
  const derivados = await planDeUltimaFactura(prisma, leFalta, monthStart);

  for (const id of ids) {
    const suyos = planDe(id);
    const extra = (derivados.get(id) ?? []).filter((d) => {
      if (suyos.has(d.kind)) return false;
      suyos.add(d.kind);
      return true;
    });
    if (!suyos.size) continue; // sólo puntos, o nada: no hay plan
    const renglones: Renglon[] = [...(propios.get(id) ?? []), ...extra.map((d) => ({ ...d, qty: 1 }))];
    const total = renglones.reduce((acc, r) => {
      const subtotal = round2(Math.max(0, Math.round(r.qty)) * round2(r.price));
      return acc + subtotal + ivaDe(subtotal, r.taxRate);
    }, 0);
    out.set(id, round2(total));
  }
  return out;
}
