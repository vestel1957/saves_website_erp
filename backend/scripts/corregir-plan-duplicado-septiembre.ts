#!/usr/bin/env ts-node
/**
 * Quita el PLAN COBRADO DOS VECES de las facturas ya emitidas (2026-09).
 *
 * El catálogo `Plan` tiene el mismo plan escrito con distinta caja ('10MegasF' y
 * '10megasF', $48.000 los dos) y el respaldo `planDeUltimaFactura` casaba el
 * renglón de la factura con las DOS filas, así que devolvía el plan por duplicado
 * y cada fila que sale de ahí es un renglón que se cobra. Ver
 * [[plan-duplicado-doble-cobro]]. El código ya está arreglado (deduplicación en el
 * SQL y cinturón en JS); esto limpia lo que la corrida del 01-09 alcanzó a emitir.
 *
 * QUÉ HACE, por factura y por `Plan.kind` (INTERNET / TV):
 *   · Un solo renglón de ese tipo → no se toca.
 *   · Varios con el MISMO nombre normalizado → se deja uno (el de menor `legacyId`,
 *     que es el que ya existe en el legacy) y se borran los demás.
 *   · Varios con nombres DISTINTOS (le facturaron el plan viejo y el nuevo juntos)
 *     → se deja el que trae la última factura recurrente ANTERIOR del abonado, que
 *     es el plan que viene pagando, y se corrige `serviceCombo`/`serviceTv` de la
 *     cabecera —que salió con el nombre equivocado por el mismo bug— sellando
 *     `serviceAssignedAt` para que el writeback lo empuje al legacy.
 *     Si esa factura anterior no resuelve el empate, la factura se SALTA y se
 *     reporta: preferible dejarla mal y a la vista que adivinar un plan.
 *
 * Lo que NO es plan (Punto Adicional, Traslado, Nota Credito/Debito…) no se toca
 * nunca: un "Punto Adicional" repetido son puntos de verdad.
 *
 * Después se recalculan subtotal/IVA/total/itemsCount/estado y se sella `editedAt`,
 * que es lo que impide que el sync de ida devuelva los renglones viejos y lo que
 * hace que el writeback reescriba la factura en el legacy (gate EDICIONES_LIVE).
 * Queda `AuditLog` con el antes/después, igual que una edición hecha a mano.
 *
 *   node -r ts-node/register/transpile-only scripts/corregir-plan-duplicado-septiembre.ts            # simulacro
 *   node -r ts-node/register/transpile-only scripts/corregir-plan-duplicado-septiembre.ts --apply    # escribe
 *
 *   --desde=YYYY-MM-DD  (por defecto 2026-09-01)   --tid=500683,500769  acota a esas facturas
 */
import { PrismaClient, Prisma } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const APLICA = args.includes('--apply');
const DESDE = (args.find((a) => a.startsWith('--desde=')) || '--desde=2026-09-01').split('=')[1];
const SOLO_TIDS = (args.find((a) => a.startsWith('--tid=')) || '').split('=')[1]
  ?.split(',').map((t) => Number(t.trim())).filter(Boolean) ?? [];
const AUTOR = 'Corrección plan duplicado (script)';
const MOTIVO = 'Plan cobrado dos veces por nombre repetido en el catálogo (10MegasF/10megasF)';

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (d: Prisma.Decimal | number | null) => (d == null ? 0 : Number(d));

type Item = {
  id: string; legacyId: number | null; productName: string | null; description: string | null;
  qty: number; price: Prisma.Decimal; taxRate: Prisma.Decimal; subtotal: Prisma.Decimal; taxTotal: Prisma.Decimal;
};

async function main() {
  // Catálogo de planes normalizado: nombre → kind. Es lo que decide qué renglón
  // es un plan (y de qué tipo) y qué renglón es otra cosa que no se toca.
  const planes = await prisma.plan.findMany({ select: { name: true, kind: true } });
  const kindDe = new Map<string, string>();
  for (const p of planes) if (!kindDe.has(norm(p.name))) kindDe.set(norm(p.name), String(p.kind));

  const facturas = await prisma.subInvoice.findMany({
    where: {
      invoiceDate: { gte: new Date(`${DESDE}T00:00:00Z`) },
      status: { not: 'CANCELED' },
      ...(SOLO_TIDS.length ? { tid: { in: SOLO_TIDS } } : {}),
    },
    include: {
      items: { orderBy: { id: 'asc' } },
      subscriber: { select: { abonado: true, firstName: true, lastName1: true } },
      electronicInvoices: { select: { type: true, dianNumber: true } },
    },
    orderBy: { tid: 'asc' },
  });

  const plan: any[] = [];
  const saltadas: any[] = [];

  for (const f of facturas) {
    // Renglones de plan agrupados por tipo de servicio.
    const porKind = new Map<string, Item[]>();
    for (const it of f.items as unknown as Item[]) {
      const kind = kindDe.get(norm(it.productName ?? it.description));
      if (!kind || kind === 'PUNTOS') continue;
      const arr = porKind.get(kind) ?? [];
      arr.push(it);
      porKind.set(kind, arr);
    }

    const aBorrar: Item[] = [];
    const revividos: string[] = [];
    const cabecera: { serviceCombo?: string; serviceTv?: string } = {};
    let indecisa: string | null = null;

    // La última recurrente ANTERIOR: es el plan que el abonado viene pagando y lo
    // que decide todos los empates de aquí abajo.
    let previaCargada = false;
    let previa: { tid: number; serviceCombo: string | null; serviceTv: string | null } | null = null;
    const laPrevia = async () => {
      if (!previaCargada) {
        previaCargada = true;
        previa = await prisma.subInvoice.findFirst({
          where: {
            subscriberId: f.subscriberId, kind: 'RECURRENTE', status: { not: 'CANCELED' },
            invoiceDate: { lt: f.invoiceDate },
          },
          orderBy: [{ invoiceDate: 'desc' }, { tid: 'desc' }],
          select: { tid: true, serviceCombo: true, serviceTv: true },
        });
      }
      return previa;
    };
    const servicioPrevio = (kind: string) => {
      const p = previa;
      return norm(kind === 'TV' ? p?.serviceTv : p?.serviceCombo);
    };

    for (const [kind, items] of porKind) {
      if (items.length <= 1) continue;
      const nombres = new Set(items.map((it) => norm(it.productName ?? it.description)));

      if (nombres.size === 1) {
        // Mismo plan repetido por la caja del catálogo: se deja el que ya existe
        // en el legacy (menor legacyId) para no romper el vínculo del sync.
        const [queda, ...sobran] = [...items].sort(
          (a, b) => (a.legacyId ?? Number.MAX_SAFE_INTEGER) - (b.legacyId ?? Number.MAX_SAFE_INTEGER),
        );
        void queda;
        aBorrar.push(...sobran);
        continue;
      }

      // Planes DISTINTOS del mismo tipo: manda el de la última recurrente anterior.
      const prev = await laPrevia();
      const vigente = servicioPrevio(kind);
      const queda = items.find((it) => norm(it.productName ?? it.description) === vigente);
      if (!queda) {
        indecisa = `${kind}: ${[...nombres].join(' / ')} — la anterior (#${prev?.tid ?? '—'}) dice `
          + `"${(kind === 'TV' ? prev?.serviceTv : prev?.serviceCombo) ?? '—'}"`;
        break;
      }
      aBorrar.push(...items.filter((it) => it.id !== queda.id));
      const nombre = (queda.productName ?? queda.description ?? '').trim();
      if (kind === 'TV') cabecera.serviceTv = nombre; else cabecera.serviceCombo = nombre;
    }

    if (indecisa) {
      saltadas.push({ tid: f.tid, abonado: f.subscriber?.abonado, motivo: indecisa });
      continue;
    }
    if (!aBorrar.length) continue;

    // SERVICIO REVIVIDO. Mismo bug, otra cara: al abonado que cambió de plan la
    // corrida le resucitó un servicio que ya no tiene (el que pasó a "solo
    // internet" en junio apareció en septiembre con la TV de mayo). Se quita sólo
    // cuando la factura anterior dice EXPRESAMENTE que no lo tiene ('no' / vacío),
    // y sólo en facturas que ya entraron aquí por tener un plan duplicado: no es
    // una batida sobre las 5.000 de la corrida.
    const prev = await laPrevia();
    if (prev) {
      for (const [kind, items] of porKind) {
        if (items.length !== 1 || aBorrar.some((b) => b.id === items[0].id)) continue;
        const antes = servicioPrevio(kind);
        if (antes !== 'no' && antes !== '') continue;
        aBorrar.push(items[0]);
        revividos.push(`${items[0].productName ?? items[0].description} (la anterior #${prev.tid} no lo tiene)`);
        if (kind === 'TV') cabecera.serviceTv = 'no'; else cabecera.serviceCombo = 'no';
      }
    }

    // Una factura ya timbrada ante la DIAN no se toca: eso va por nota crédito.
    if (f.electronicInvoices.some((e) => e.type === 'FACTURADA' && e.dianNumber)) {
      saltadas.push({ tid: f.tid, abonado: f.subscriber?.abonado, motivo: 'ya timbrada ante la DIAN → nota crédito' });
      continue;
    }

    const quedan = (f.items as unknown as Item[]).filter((it) => !aBorrar.some((b) => b.id === it.id));
    if (!quedan.length) {
      saltadas.push({ tid: f.tid, abonado: f.subscriber?.abonado, motivo: 'quedaría sin conceptos' });
      continue;
    }
    const subtotal = round2(quedan.reduce((s, it) => s + num(it.subtotal), 0));
    const tax = round2(quedan.reduce((s, it) => s + num(it.taxTotal), 0));
    const total = round2(subtotal + tax);
    const pagado = num(f.paidAmount);

    if (total < pagado) {
      saltadas.push({ tid: f.tid, abonado: f.subscriber?.abonado, motivo: `ya tiene ${pagado} pagados y quedaría en ${total}` });
      continue;
    }

    plan.push({
      id: f.id, tid: f.tid, abonado: f.subscriber?.abonado,
      cliente: `${(f.subscriber?.firstName ?? '').trim()} ${(f.subscriber?.lastName1 ?? '').trim()}`.trim(),
      antes: { subtotal: num(f.subtotal), tax: num(f.tax), total: num(f.total), items: f.items.length },
      despues: { subtotal, tax, total, items: quedan.length },
      quita: aBorrar.map((it) => `${it.productName ?? it.description} $${num(it.price)}`),
      revividos,
      cabecera: Object.keys(cabecera).length ? cabecera : null,
      _borrar: aBorrar.map((it) => it.id),
      _status: (total <= pagado ? 'PAID' : pagado > 0 ? 'PARTIAL' : 'DUE') as 'PAID' | 'PARTIAL' | 'DUE',
      _before: {
        subtotal: num(f.subtotal), tax: num(f.tax), total: num(f.total), status: f.status,
        serviceCombo: f.serviceCombo, serviceTv: f.serviceTv,
        items: (f.items as unknown as Item[]).map((it) => ({
          product: it.productName, description: it.description, qty: it.qty,
          price: num(it.price), taxRate: num(it.taxRate), subtotal: num(it.subtotal),
        })),
      },
      _editCount: ((f as any).editCount ?? 0) + 1,
      _cabecera: cabecera,
    });
  }

  const deMas = plan.reduce((s, p) => s + (p.antes.total - p.despues.total), 0);
  console.log(`\nFacturas desde ${DESDE} revisadas: ${facturas.length}`);
  console.log(`Con plan duplicado: ${plan.length}   ·   cobrado de más: $${deMas.toLocaleString('es-CO')}`);
  for (const p of plan) {
    console.log(`  #${p.tid} ab.${p.abonado} ${p.cliente.padEnd(22)} `
      + `$${p.antes.total.toLocaleString('es-CO')} → $${p.despues.total.toLocaleString('es-CO')}`
      + `   quita: ${p.quita.join(', ')}${p.cabecera ? `   cabecera: ${JSON.stringify(p.cabecera)}` : ''}`
      + (p.revividos.length ? `\n      ↑ servicio revivido: ${p.revividos.join('; ')}` : ''));
  }
  if (saltadas.length) {
    console.log(`\nSALTADAS (${saltadas.length}) — hay que mirarlas a mano:`);
    for (const s of saltadas) console.log(`  #${s.tid} ab.${s.abonado}: ${s.motivo}`);
  }

  if (!plan.length) return;

  const respaldo = path.join(__dirname, `_respaldo-plan-duplicado-${new Date().toISOString().slice(0, 10)}.json`);
  fs.writeFileSync(respaldo, JSON.stringify({ generado: new Date().toISOString(), plan, saltadas }, null, 2));
  console.log(`\nRespaldo del estado actual: ${respaldo}`);

  if (!APLICA) {
    console.log('\nSIMULACRO: no se escribió nada. Repetir con --apply para corregir.');
    return;
  }

  for (const p of plan) {
    await prisma.$transaction(async (tx) => {
      await tx.subInvoiceItem.deleteMany({ where: { id: { in: p._borrar } } });
      await tx.subInvoice.update({
        where: { id: p.id },
        data: {
          subtotal: p.despues.subtotal, tax: p.despues.tax, total: p.despues.total,
          status: p._status, itemsCount: p.despues.items,
          // `editedAt` es lo que aparta esta factura del sync de ida y lo que hace
          // que el writeback la reescriba en el legacy.
          editedAt: new Date(), editedBy: AUTOR, editCount: p._editCount,
          ...(p._cabecera.serviceCombo ? { serviceCombo: p._cabecera.serviceCombo } : {}),
          ...(p._cabecera.serviceTv ? { serviceTv: p._cabecera.serviceTv } : {}),
          // Sólo cuando se corrigió el plan de la cabecera: es la marca que empuja
          // combo/television al legacy (gate SERVICIO_LIVE).
          ...(Object.keys(p._cabecera).length ? { serviceAssignedAt: new Date() } : {}),
        },
      });
      await tx.auditLog.create({
        data: {
          action: 'UPDATE', entity: 'SubInvoice', entityId: p.id,
          before: p._before,
          after: {
            subtotal: p.despues.subtotal, tax: p.despues.tax, total: p.despues.total, status: p._status,
            serviceCombo: p._cabecera.serviceCombo ?? p._before.serviceCombo,
            serviceTv: p._cabecera.serviceTv ?? p._before.serviceTv,
            reason: MOTIVO, by: AUTOR,
            quitados: p.quita,
          },
        },
      });
    });
    console.log(`  ✓ #${p.tid} corregida`);
  }
  console.log(`\n${plan.length} facturas corregidas · $${deMas.toLocaleString('es-CO')} devueltos al cliente.`);
  console.log('El writeback (cron :07/:22/:37/:52) las reescribe en el legacy.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
