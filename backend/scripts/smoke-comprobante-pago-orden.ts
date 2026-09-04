/**
 * El soporte del pago de una orden de compra se sube UNA vez (2026-09-02).
 *
 * Lo que se pedía: "cuando se suba el soporte del pago a la orden de compra que quede
 * cargado también en egresos, para no cargar eso dos veces". El comprobante no se
 * guarda como adjunto de la orden: vive en el EGRESO que crea el pago
 * (`Transaction.attach`), y la ficha de la orden lo lee de ahí. Aquí se comprueba ese
 * camino de punta a punta, con la API real:
 *
 *   pagar la orden → adjuntar al movimiento que devolvió → la ficha de la orden
 *   enseña el pago CON su comprobante → tesorería sirve el fichero.
 *
 * (2026-09-03) Se añadió el otro camino, el que usa la gente: subir el soporte por
 * ADJUNTOS de la orden. La pantalla pregunta de qué pago es y manda el fichero a los
 * dos endpoints, así que queda de adjunto de la orden Y de comprobante del egreso.
 *
 * Toca plata de verdad (crea un egreso de 100 COP sobre una orden del legacy), así que
 * limpia SIEMPRE al terminar: borra el movimiento, el fichero, el evento de la bitácora
 * y devuelve el `paidAmount` de la orden a como estaba. OJO: el writeback de caja corre
 * cada 5 minutos (:02/:07/…) y empuja los movimientos nuevos al legacy — esta prueba
 * tarda segundos, pero no se deja a medias.
 *
 * Uso: npx ts-node --transpile-only scripts/smoke-comprobante-pago-orden.ts
 */
import { PrismaClient } from '@prisma/client';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const API = process.env.API_URL ?? 'http://127.0.0.1:3061/api';
const EMAIL = process.env.QA_EMAIL ?? 'prueba.administracion@vestel.com.co';
const PASS = process.env.QA_PASS ?? 'Prueba2026*';
const MONTO = 100;

const prisma = new PrismaClient();
let ok = 0, fail = 0;
const assert = (cond: boolean, msg: string, extra = '') => {
  if (cond) { ok++; console.log(`  OK    ${msg}`); } else { fail++; console.log(`  FALLO ${msg} ${extra}`); }
};

async function login(): Promise<string> {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  const d: any = await r.json();
  if (!d.token) throw new Error(`Login falló: ${d.message ?? r.status}`);
  return d.token;
}

async function main() {
  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };

  // Una orden DEL LEGACY con saldo: esas no pasan por el flujo de aprobación.
  const candidatas = await prisma.supplyOrder.findMany({
    where: { legacyId: { not: null }, status: { notIn: ['cancelado', 'anulado', 'finalizado'] } },
    orderBy: { orderDate: 'desc' }, take: 200,
    select: { id: true, tid: true, total: true, paidAmount: true },
  });
  const orden = candidatas.find((o) => Number(o.total) - Number(o.paidAmount) >= MONTO);
  if (!orden) throw new Error('No hay ninguna orden del legacy con saldo con la que probar');
  const saldo = Number(orden.total) - Number(orden.paidAmount);
  console.log(`Orden ${orden.tid} · saldo ${saldo}`);

  let txId: string | null = null;
  let fileId: string | null = null;
  let primerAttach: string | null = null;
  try {
    const pago = await fetch(`${API}/orders/${orden.id}/pay`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: MONTO, method: 'Cash', note: 'PRUEBA smoke comprobante (se borra)' }),
    });
    const d: any = await pago.json();
    assert(pago.ok && !!d.transactionId, 'el pago crea el egreso y devuelve su id', JSON.stringify(d));
    txId = d.transactionId;
    if (!txId) return;

    // El fichero se sube UNA vez, contra el movimiento: es lo que hace la pantalla.
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
    const fd = new FormData();
    fd.append('file', new Blob([pdf], { type: 'application/pdf' }), 'soporte-prueba.pdf');
    const sub = await fetch(`${API}/treasury/transactions/${txId}/attach`, { method: 'POST', headers: auth, body: fd });
    assert(sub.ok, 'el comprobante se adjunta al egreso', String(sub.status));
    // Reemplazar el comprobante NO borra el binario anterior: se anota para limpiarlo.
    primerAttach = (await prisma.transaction.findUnique({ where: { id: txId }, select: { attach: true } }))?.attach ?? null;

    // La ficha de la orden lo enseña sin que nadie lo haya subido dos veces.
    const ficha: any = await (await fetch(`${API}/orders/${orden.id}`, { headers: auth })).json();
    const fila = (ficha.payments ?? []).find((p: any) => p.id === txId);
    assert(!!fila, 'el pago sale en la ficha de la orden');
    assert(fila?.attachName === 'soporte-prueba.pdf', 'con el nombre del comprobante', JSON.stringify(fila));

    // Y se puede abrir desde ahí (es el endpoint que llama la celda de comprobante).
    const bajada = await fetch(`${API}/treasury/transactions/${txId}/attachment`, { headers: auth });
    const bytes = Buffer.from(await bajada.arrayBuffer());
    assert(bajada.ok && bytes.subarray(0, 4).toString() === '%PDF', 'el comprobante se descarga y es el PDF',
      `${bajada.status} ${bajada.headers.get('content-type')}`);

    // El egreso está en el libro de caja, que es lo que se quería evitar duplicar.
    const enCaja: any = await (await fetch(`${API}/treasury/transactions?type=EXPENSE&search=PRUEBA%20smoke&all=1`, { headers: auth })).json();
    const enLista = (enCaja.items ?? []).find((t: any) => t.id === txId);
    assert(!!enLista?.attach, 'el mismo comprobante se ve en el movimiento de tesorería', JSON.stringify(enLista ?? enCaja).slice(0, 200));

    // ---- El mismo soporte, subido por ADJUNTOS de la orden (2026-09-03) ----
    // Es donde de verdad lo suelta la gente: el botón grande de "Subir archivo". La
    // pantalla pregunta de qué pago es y manda el fichero a los DOS endpoints; esto
    // comprueba que después está en los dos sitios sin haberlo cargado dos veces.
    const fdOrden = new FormData();
    fdOrden.append('file', new Blob([pdf], { type: 'application/pdf' }), 'soporte-adjunto.pdf');
    const adj = await fetch(`${API}/orders/${orden.id}/files`, { method: 'POST', headers: auth, body: fdOrden });
    const dAdj: any = await adj.json().catch(() => null);
    assert(adj.ok && !!dAdj?.id, 'el archivo se sube como adjunto de la orden', String(adj.status));
    fileId = dAdj?.id ?? null;

    const fdTx = new FormData();
    fdTx.append('file', new Blob([pdf], { type: 'application/pdf' }), 'soporte-adjunto.pdf');
    const sub2 = await fetch(`${API}/treasury/transactions/${txId}/attach`, { method: 'POST', headers: auth, body: fdTx });
    assert(sub2.ok, 'y el mismo archivo queda de comprobante del egreso', String(sub2.status));

    const ficha2: any = await (await fetch(`${API}/orders/${orden.id}`, { headers: auth })).json();
    assert((ficha2.files ?? []).some((f: any) => f.id === fileId), 'sigue estando en los adjuntos de la orden');
    const fila2 = (ficha2.payments ?? []).find((p: any) => p.id === txId);
    assert(fila2?.attachName === 'soporte-adjunto.pdf', 'y el pago enseña ese comprobante', JSON.stringify(fila2));

    const enCaja2: any = await (await fetch(`${API}/treasury/transactions?type=EXPENSE&search=PRUEBA%20smoke&all=1`, { headers: auth })).json();
    assert(
      (enCaja2.items ?? []).find((t: any) => t.id === txId)?.attachName === 'soporte-adjunto.pdf',
      'y tesorería lo ve en el egreso (que era lo que había que subir dos veces)',
    );
  } finally {
    // El adjunto de la orden: metadata + binario en uploads/orders/<id>/.
    if (fileId) {
      const f = await prisma.supplyOrderFile.findUnique({ where: { id: fileId }, select: { storedName: true } });
      if (f) {
        const ruta = join(process.cwd(), 'uploads', 'orders', orden.id, f.storedName);
        if (existsSync(ruta)) unlinkSync(ruta);
        await prisma.supplyOrderFile.delete({ where: { id: fileId } });
      }
    }
    await prisma.supplyOrderEvent.deleteMany({ where: { orderId: orden.id, action: 'ADJUNTO', detail: { contains: 'soporte-adjunto.pdf' } } });
    for (const archivo of [primerAttach]) {
      if (!archivo) continue;
      const ruta = join(process.cwd(), 'uploads', 'treasury', archivo);
      if (existsSync(ruta)) unlinkSync(ruta);
    }
    if (txId) {
      const t = await prisma.transaction.findUnique({ where: { id: txId }, select: { attach: true } });
      if (t?.attach) {
        const ruta = join(process.cwd(), 'uploads', 'treasury', t.attach);
        if (existsSync(ruta)) unlinkSync(ruta);
      }
      await prisma.transaction.delete({ where: { id: txId } });
    }
    await prisma.supplyOrderEvent.deleteMany({ where: { orderId: orden.id, action: 'PAGAR', detail: { contains: 'PRUEBA smoke comprobante' } } });
    await prisma.supplyOrder.update({ where: { id: orden.id }, data: { paidAmount: orden.paidAmount } });
    console.log('  ·     limpieza hecha (movimiento, fichero, bitácora y saldo de la orden)');
  }

  console.log(`\n${fail === 0 ? 'TODO OK' : 'HAY FALLOS'} — ${ok} ok, ${fail} fallos`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
