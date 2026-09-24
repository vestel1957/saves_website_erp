/**
 * Deja EN PESOS REDONDOS las facturas que arrastran céntimos.
 *
 * El IVA del 19 % parte el peso (22.269 × 19 % = 4.231,11) y hasta hoy ese `,11` se
 * guardaba tal cual en el renglón y de ahí en la cabecera. La ventanilla cobra pesos
 * redondos y el legacy ni siquiera puede guardar céntimos (`invoices.total` es
 * `int(16)`), así que el residuo se quedaba pegado al saldo del cliente para siempre:
 * la abonada 57485 no podía sacar su paz y salvo estando al día.
 *
 * `ivaDe` ya impide que nazcan nuevas (ver `common/money.ts`); esto limpia las viejas.
 *
 * QUÉ TOCA, y sólo eso:
 *   · `SubInvoice.subtotal/tax/total` y `SubInvoiceItem.subtotal/taxTotal` al peso;
 *   · `status`, recalculado contra el total ya redondeado (una PARTIAL que sólo lo
 *     era por céntimos pasa a PAID).
 * NO toca `paidAmount` ni ningún `Transaction`: la plata cobrada no se inventa ni se
 * corrige aquí, y así los cierres de caja quedan intactos.
 *
 * El redondeo CONVERGE con el legacy (que ya tiene el entero), así que no descuadra el
 * sync: al contrario, es lo que `mismoDinero` venía tolerando cada 15 minutos.
 *
 * Sólo se toca lo que difiere del entero en MENOS DE UN PESO. Un peso o más es un
 * cobro corto de verdad y se corrige a mano (ver `legacy-dinero-entero-centimos`).
 *
 *   npx ts-node --transpile-only scripts/sanear-centavos-facturas.ts          # simula
 *   npx ts-node --transpile-only scripts/sanear-centavos-facturas.ts --aplicar
 */
export {};

const APLICAR = process.argv.includes('--aplicar');
const pesos = (n: number) => Math.round(Number(n) || 0);

(async () => {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();

  // Las candidatas, por SQL: Prisma no sabe decir `total <> round(total)`. Entran
  // tanto las que parten el peso en la cabecera como las que sólo lo parten en un
  // renglón (la cabecera se salvó al sumar, pero el renglón sigue sucio).
  const ids: { id: string }[] = await prisma.$queryRawUnsafe(`
    SELECT DISTINCT i.id FROM "SubInvoice" i
    LEFT JOIN "SubInvoiceItem" it ON it."invoiceId" = i.id
    WHERE i.total <> round(i.total) OR i.tax <> round(i.tax) OR i.subtotal <> round(i.subtotal)
       OR it."taxTotal" <> round(it."taxTotal") OR it.subtotal <> round(it.subtotal)`);
  const facturas = await prisma.subInvoice.findMany({
    where: { id: { in: ids.map((r) => r.id) } },
    select: {
      id: true, tid: true, subtotal: true, tax: true, total: true, paidAmount: true, status: true,
      items: { select: { id: true, subtotal: true, taxTotal: true } },
      electronicInvoices: { select: { type: true, dianNumber: true } },
    },
  });
  console.log(`candidatas: ${facturas.length}`);

  const n = (d: unknown) => Number(d ?? 0);
  const parteElPeso = (v: number) => Math.abs(v - Math.round(v)) > 1e-9;

  let cabeceras = 0, renglones = 0, estados = 0, fuera = 0, conDian = 0;
  const muestra: string[] = [];

  for (const f of facturas) {
    // Lo que ya se reportó a la DIAN no se toca: allá quedó con ese total y cambiarlo
    // aquí rompería la pareja. Hoy no hay ninguna, pero el script puede re-correrse.
    if (f.electronicInvoices.some((e) => e.type === 'FACTURADA' && e.dianNumber)) { conDian++; continue; }
    const cambios: Record<string, number | string> = {};
    for (const campo of ['subtotal', 'tax', 'total'] as const) {
      const v = n(f[campo]);
      if (!parteElPeso(v)) continue;
      if (Math.abs(v - Math.round(v)) >= 1) { fuera++; continue; } // no es céntimo: a mano
      cambios[campo] = pesos(v);
    }
    const totalNuevo = (cambios.total as number) ?? n(f.total);
    const pagado = n(f.paidAmount);
    // El estado, contra el total ya redondeado — y con la MISMA tolerancia del peso,
    // no con `<=`. Si no, redondear 29.999,90 a 30.000 dejaría PARTIAL una factura
    // saldada (el cobro real fue 29.999,90) y el cliente volvería a figurar debiendo:
    // justo el daño que este script viene a deshacer. `paidAmount` no se toca nunca —
    // es plata que entró en caja, no un número que podamos redondear.
    // Una anulada sigue anulada.
    if (f.status !== 'CANCELED') {
      const falta = totalNuevo - pagado;
      const st = falta < 1 ? 'PAID' : pagado > 0 ? 'PARTIAL' : 'DUE';
      if (st !== f.status && Object.keys(cambios).length) { cambios.status = st; estados++; }
    }
    const itemsMal = f.items.filter((it) => parteElPeso(n(it.subtotal)) || parteElPeso(n(it.taxTotal)));

    if (!Object.keys(cambios).length && !itemsMal.length) continue;
    if (Object.keys(cambios).length) cabeceras++;
    renglones += itemsMal.length;
    if (muestra.length < 12) {
      muestra.push(`  #${f.tid}: ${JSON.stringify(cambios)}${itemsMal.length ? ` · ${itemsMal.length} renglón(es)` : ''}`);
    }
    if (!APLICAR) continue;

    await prisma.$transaction(async (tx) => {
      if (Object.keys(cambios).length) {
        await tx.subInvoice.update({ where: { id: f.id }, data: cambios as never });
      }
      for (const it of itemsMal) {
        await tx.subInvoiceItem.update({
          where: { id: it.id },
          data: { subtotal: pesos(n(it.subtotal)), taxTotal: pesos(n(it.taxTotal)) },
        });
      }
    });
  }

  console.log(`${APLICAR ? 'APLICADO' : 'SIMULACIÓN'}`);
  console.log(`  cabeceras al peso : ${cabeceras}`);
  console.log(`  renglones al peso : ${renglones}`);
  console.log(`  estados corregidos: ${estados}`);
  console.log(`  fuera (≥ $1, a mano): ${fuera}`);
  console.log(`  intactas por DIAN : ${conDian}`);
  if (muestra.length) console.log('Muestra:\n' + muestra.join('\n'));
  await prisma.$disconnect();
})();
