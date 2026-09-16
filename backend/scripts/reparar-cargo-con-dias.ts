import 'reflect-metadata';
/**
 * Saca los DÍAS de reconexión que se colaron dentro de una factura de cobro puntual.
 *
 * El prorrateo de reconexión colgaba su renglón de «la última factura del mes», y en
 * un traslado esa es justo la de los 30.000 recién emitida: la factura 500029
 * (28-08-2026) acabó con 'Traslado 30.000' + '10Megas(F) · reconexión 28–31 ago
 * 5.161' = 35.161, y el cliente que pagó su traslado quedó debiendo 5.161 que nunca
 * pidió. La regla del usuario (08-09-2026) es que el traslado son 30.000 y ya.
 *
 * El código ya no lo vuelve a hacer (`ProrrateoReconexionService.esCobroPuntual`);
 * esto es sólo para lo que quedó escrito antes del arreglo.
 *
 * QUÉ TOCA. Nada más que las facturas que, quitándoles los renglones del prorrateo,
 * son un cobro puntual (traslado, 'Agregar Internet', afiliación). La factura que
 * además lleva la mensualidad del cliente NO se toca: ahí los días están en su sitio
 * (p. ej. la 505017, con 'Agregar Internet' + la televisión del mes + el internet
 * nuevo prorrateado).
 *
 * CÓMO. Por `FacturasService.updateInvoice`, el mismo camino que la pantalla «Editar
 * factura»: recalcula totales y estado, respeta las notas crédito, deja auditoría,
 * hace el ajuste contable y marca `editedAt` — sin esa marca el sync de ida devolvería
 * el total viejo en 15 minutos y el writeback nunca lo subiría al legacy.
 *
 * Uso:  npx ts-node scripts/reparar-cargo-con-dias.ts [--aplicar]
 * Sin `--aplicar` sólo dice qué haría.
 */
import { prismaService, facturasService, prorrateoReconexionService } from '../src/core/contenedor';
import type { AuthUser } from '../src/auth/current-user.decorator';

/** La firma que deja el prorrateo en la descripción del renglón (`etiquetaProrrateo`). */
const HUELLA = '· reconexión ';

const USUARIO: AuthUser = {
  id: 'script-cargo-dias', name: 'Corrección cargo con días', email: 'soporte@vestel.com.co',
  areas: [], sedes: [], superuser: true,
} as unknown as AuthUser;

const APLICAR = process.argv.includes('--aplicar');
const pesos = (n: number) => `$${n.toLocaleString('es-CO')}`;

async function main() {
  const candidatas = await prismaService.subInvoice.findMany({
    where: {
      status: { not: 'CANCELED' },
      items: { some: { description: { contains: HUELLA } } },
    },
    select: {
      id: true, tid: true, total: true, paidAmount: true, status: true,
      items: { select: { id: true, productId: true, productName: true, description: true, qty: true, price: true, taxRate: true, subtotal: true } },
      electronicInvoices: { select: { type: true, dianNumber: true } },
    },
    orderBy: { tid: 'asc' },
  });

  console.log(`${candidatas.length} factura(s) con renglón de prorrateo.\n`);
  let tocadas = 0;

  for (const inv of candidatas) {
    const dias = inv.items.filter((it) => (it.description ?? '').includes(HUELLA));
    const resto = inv.items.filter((it) => !dias.includes(it));
    const esNota = (n: string | null) => n === 'Nota Credito' || n === 'Nota Debito';
    const conceptos = resto.filter((it) => !esNota(it.productName));

    if (!conceptos.length) {
      console.log(`· #${inv.tid}: sólo tiene los días (es la factura del prorrateo). Se deja.`);
      continue;
    }
    if (!(await prorrateoReconexionService.esCobroPuntualDeFactura(conceptos))) {
      console.log(`· #${inv.tid}: lleva la mensualidad del cliente, los días están en su sitio. Se deja.`);
      continue;
    }
    // Sólo el TRASLADO se limpia. Es lo que decidió el usuario —«el traslado son
    // 30.000 y ya»— y es el caso en el que los días sobran: el cliente pagó una
    // mudanza. En un 'Agregar Internet' esos días SON el servicio que estrena, así
    // que quitarlos sería dejar de cobrar algo que se prestó; con el código nuevo
    // habrían nacido en factura aparte, y rehacer eso hacia atrás es una decisión
    // de contabilidad, no de este script. Se listan y se dejan.
    if (!conceptos.some((it) => (it.productName || '').trim().toLowerCase() === 'traslado')) {
      const que = conceptos.map((it) => it.productName).join(' + ');
      console.log(`⚠️  #${inv.tid}: cargo «${que}» con días pegados — NO es un traslado: decidir a mano.`);
      continue;
    }
    if (inv.electronicInvoices.some((e) => e.type === 'FACTURADA' && e.dianNumber)) {
      console.log(`⚠️  #${inv.tid}: timbrada ante la DIAN — hay que ajustarla con nota crédito, no editándola.`);
      continue;
    }

    const quita = dias.map((d) => `${d.productName} ${pesos(Number(d.subtotal))}`).join(' + ');
    console.log(
      `→ #${inv.tid}: ${pesos(Number(inv.total))} (${inv.status}, pagado ${pesos(Number(inv.paidAmount))}) — se quita ${quita}`,
    );
    tocadas++;
    if (!APLICAR) continue;

    const r = await facturasService.updateInvoice(
      inv.id,
      {
        items: conceptos.map((it) => ({
          productId: it.productId ?? 0,
          productName: it.productName ?? undefined,
          description: it.description || it.productName || 'Concepto',
          qty: it.qty || 1,
          price: Number(it.price),
          taxRate: Number(it.taxRate ?? 0),
        })),
        reason: 'Los días de reconexión no van dentro de un cobro puntual: el traslado se cobra por su valor cerrado.',
      } as never,
      USUARIO,
    );
    console.log(`   ✅ queda en ${pesos(r.total)} (${r.status}, saldo ${pesos(r.balance)}).`);
  }

  console.log(`\n${tocadas} factura(s) ${APLICAR ? 'corregidas' : 'por corregir'}.${APLICAR ? '' : ' Corre con --aplicar.'}`);
  await prismaService.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prismaService.$disconnect();
  process.exit(1);
});
