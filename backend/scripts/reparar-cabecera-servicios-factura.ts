/**
 * Devuelve a la ÚLTIMA FACTURA el servicio que un prorrateo le borró.
 *
 * `invoices.combo` / `television` no son "lo que este documento cobra": son el
 * snapshot de lo que el cliente TIENE contratado. De ahí lo leen la ficha, el
 * contrato en PDF y —cuando no hay renglones de los que deducirlo— la corrida del
 * mes (la de aquí y la del legacy, `Invoices_model.php:1130`). La factura de
 * prorrateo de reconexión nacía nombrando sólo el servicio que se devolvía, así
 * que al combo internet+TV le desaparecía la mitad: el abonado 56720 quedó el
 * 08-09-2026 con "servicio de internet" a secas después de reconectarle sólo el
 * internet, y esa factura truncada viajó igual al legacy (`television = ''`).
 *
 * Desde el arreglo de `cabeceraDeProrrateo` las facturas nuevas ya nacen enteras;
 * esto repara las que se escribieron antes.
 *
 * QUÉ TOCA. Sólo facturas PARCIALES: las que nombran un servicio y dejan el otro
 * en NULL teniendo el abonado ese otro servicio en su factura recurrente anterior.
 * Las que no nombran ninguno (traslados, 'Agregar Internet') se quedan como están:
 * ésas no engañan a nadie, la ficha ya las salta y busca el plan en los renglones.
 * Un 'no' del legacy —"este servicio no lo tiene"— se respeta siempre.
 *
 * QUÉ ESCRIBE en la factura del cliente:
 *   · el nombre del servicio que faltaba y sus puntos, copiados de su factura
 *     recurrente anterior;
 *   · el estado de ese servicio: se arrastra el corte que traía SALVO que después
 *     de esa factura se le haya cerrado una reconexión de ese servicio (entonces
 *     ya volvió y va al aire, que es la convención del legacy: NULL = al aire);
 *   · `serviceAssignedAt` / `serviceAssignedBy`, que es lo que hace que el arreglo
 *     dure: sin esa marca la ida del sync le devuelve el plan del legacy en la
 *     siguiente pasada, y el writeback (`pushServicioAsignado`) no lo empujaría
 *     allá — donde la columna quedó igual de vacía.
 *
 * DESPUÉS DE APLICAR hay que correr el writeback para que el legacy quede igual,
 * o su corrida del mes facturará media mensualidad:
 *   node scripts/writeback-legacy.js --solo=servicio --dry   (mirar el plan)
 *   node scripts/writeback-legacy.js --solo=servicio         (empujar)
 *
 *   npx ts-node --transpile-only scripts/reparar-cabecera-servicios-factura.ts
 *   npx ts-node --transpile-only scripts/reparar-cabecera-servicios-factura.ts --aplicar
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const APLICAR = process.argv.includes('--aplicar');
const AUTOR = 'Sistema (reparación de cabecera)';

/** Estados de abonado a los que ya no les cambia nada esto. */
const MUERTOS = ['RETIRADO', 'DEPURADO', 'INACTIVO'];

/** 'no' y '-' son como el legacy escribe "este servicio no lo tiene". */
const nombra = (s: string | null) => {
  const t = (s ?? '').trim().toLowerCase();
  return !!t && t !== 'no' && t !== '-';
};

type Fila = {
  id: string;
  tid: number;
  abonado: number;
  subscriberId: string;
  invoiceDate: Date;
  serviceCombo: string | null;
  serviceTv: string | null;
  puntos: number | null;
  estadoCombo: string | null;
  estadoTv: string | null;
  notes: string | null;
  pcombo: string | null;
  ptv: string | null;
  ppuntos: number | null;
  pec: string | null;
  pet: string | null;
};

async function main() {
  // La última factura de cada abonado vivo y la recurrente anterior, que es la que
  // sabe qué tiene contratado.
  const filas = await prisma.$queryRaw<Fila[]>`
    WITH ult AS (
      SELECT DISTINCT ON (i."subscriberId")
             i.id, i.tid, i."subscriberId", i."invoiceDate", i."serviceCombo", i."serviceTv",
             i.puntos, i."estadoCombo"::text AS "estadoCombo", i."estadoTv"::text AS "estadoTv",
             i.notes, i."serviceAssignedAt"
        FROM "SubInvoice" i
       WHERE i.status <> 'CANCELED'
       ORDER BY i."subscriberId", i."invoiceDate" DESC NULLS LAST, i.tid DESC
    ),
    prev AS (
      SELECT DISTINCT ON (i."subscriberId")
             i."subscriberId", i."serviceCombo" AS pcombo, i."serviceTv" AS ptv, i.puntos AS ppuntos,
             i."estadoCombo"::text AS pec, i."estadoTv"::text AS pet
        FROM "SubInvoice" i
        JOIN ult u ON u."subscriberId" = i."subscriberId" AND i.tid <> u.tid
       WHERE i.kind = 'RECURRENTE' AND i.status <> 'CANCELED'
       ORDER BY i."subscriberId", i."invoiceDate" DESC NULLS LAST, i.tid DESC
    )
    SELECT u.id, u.tid, u."subscriberId", u."invoiceDate", u."serviceCombo", u."serviceTv",
           u.puntos, u."estadoCombo", u."estadoTv", u.notes,
           pv.pcombo, pv.ptv, pv.ppuntos, pv.pec, pv.pet, s.abonado
      FROM ult u
      JOIN prev pv USING ("subscriberId")
      JOIN "Subscriber" s ON s.id = u."subscriberId"
     WHERE u."serviceAssignedAt" IS NULL
       AND s.status::text NOT IN (${Prisma.join(MUERTOS)})
     ORDER BY u."invoiceDate" DESC`;

  // Parciales: nombra uno y deja el otro en NULL teniendo el abonado ese otro.
  const rotas = filas.filter((f) => {
    const faltaTv = f.serviceTv === null && nombra(f.ptv);
    const faltaInternet = f.serviceCombo === null && nombra(f.pcombo);
    const nombraAlgo = nombra(f.serviceCombo) || nombra(f.serviceTv);
    return nombraAlgo && (faltaTv || faltaInternet);
  });

  console.log(`Facturas parciales (nombran un servicio y le borran el otro): ${rotas.length}`);
  if (!rotas.length) return;

  // ¿Se le devolvió ese servicio DESPUÉS de esta factura? Entonces está al aire y no
  // se le arrastra el corte viejo.
  const reconexiones = await prisma.ticket.findMany({
    where: {
      subscriberId: { in: [...new Set(rotas.map((f) => f.subscriberId))] },
      status: { not: 'ANULADA' },
      type: { startsWith: 'Reconexion' },
    },
    select: { subscriberId: true, type: true, created: true },
  });
  const volvio = (f: Fila, servicio: 'INTERNET' | 'TV') =>
    reconexiones.some(
      (t) =>
        t.subscriberId === f.subscriberId
        && !!t.created && t.created >= f.invoiceDate
        && (servicio === 'TV' ? /television|combo/i : /internet|combo/i).test(t.type || ''),
    );

  let escritas = 0;
  for (const f of rotas) {
    const data: Record<string, unknown> = {};
    if (f.serviceTv === null && nombra(f.ptv)) {
      data.serviceTv = f.ptv;
      if (f.pet && !volvio(f, 'TV')) data.estadoTv = f.pet;
      if (f.puntos === null && f.ppuntos) data.puntos = f.ppuntos;
    }
    if (f.serviceCombo === null && nombra(f.pcombo)) {
      data.serviceCombo = f.pcombo;
      if (f.pec && !volvio(f, 'INTERNET')) data.estadoCombo = f.pec;
    }
    if (!Object.keys(data).length) continue;

    const que = Object.entries(data).map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(`  abonado ${f.abonado} · factura #${f.tid} (${f.invoiceDate.toISOString().slice(0, 10)}) → ${que}`);
    if (!APLICAR) continue;
    await prisma.subInvoice.update({
      where: { id: f.id },
      data: { ...data, serviceAssignedAt: new Date(), serviceAssignedBy: AUTOR },
    });
    escritas++;
  }

  console.log(
    APLICAR
      ? `\n${escritas} factura(s) reparadas. Ahora: node scripts/writeback-legacy.js --solo=servicio --dry`
      : '\nEnsayo: no se escribió nada. Repite con --aplicar.',
  );
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
