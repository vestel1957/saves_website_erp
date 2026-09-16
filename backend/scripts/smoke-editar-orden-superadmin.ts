/**
 * Smoke de EDITAR UNA ORDEN DE COMPRA YA APROBADA (salida del superusuario).
 *
 *   npx ts-node --transpile-only scripts/smoke-editar-orden-superadmin.ts
 *
 * Editar una orden solo se podía estando PENDIENTE: una vez aprobada, un error de
 * dedo obligaba a cancelarla y crearla de nuevo. El superusuario ahora puede
 * corregirla en cualquier estado, y esto comprueba que al hacerlo NO se pierde lo
 * que sostiene la orden:
 *
 *   1. quien no es superusuario sigue rebotado en una orden aprobada,
 *   2. el superusuario sí edita, y el total se recalcula,
 *   3. las firmas de aprobación se CONSERVAN (una orden aprobada por nadie sería peor
 *      que el error que se venía a corregir),
 *   4. lo ya RECIBIDO sobrevive al reemplazo de ítems (el stock ya se sumó en `receive`),
 *   5. la bitácora deja escrito que se editó estando aprobada, con total antes→después,
 *   6. estando PENDIENTE nada cambia: las firmas a medias se siguen reiniciando.
 *
 * Corre contra la base de VERDAD y no deja rastro: la orden de prueba se crea dentro
 * de una transacción que al final se revienta a propósito.
 */
import 'reflect-metadata';
import { PrismaClient, Prisma } from '@prisma/client';
import { OrdersService } from '../src/orders/orders.service';
import { num } from '../src/common/money';

const prisma = new PrismaClient();

function prismaDePega(tx: Prisma.TransactionClient) {
  return new Proxy({} as any, {
    get(_t, k: string) {
      if (k === '$transaction') return (fn: any) => fn(tx);
      return (tx as any)[k];
    },
  });
}

const SUPER = { id: 'u-super', email: 'super@vestel', name: 'Superusuario', roles: [], permissions: ['system.admin'] } as any;
const ADMIN = { id: 'u-admin', email: 'admin@vestel', name: 'Administración', roles: [], permissions: ['area.administracion'] } as any;

const REVENTAR = new Error('__rollback__');
let fallos = 0;
const ok = (cond: boolean, msg: string) => { console.log(`${cond ? '✅' : '❌'} ${msg}`); if (!cond) fallos++; };

async function main() {
  const proveedor = await prisma.supplier.findFirst({ select: { id: true, legacyId: true } });
  if (!proveedor) throw new Error('No hay proveedores en la base');

  await prisma.$transaction(async (tx) => {
    const fake = prismaDePega(tx);
    const orders = new OrdersService(fake, { avisarPorCargo: async () => {} } as any, {} as any);

    // Orden APROBADA con doble firma y con material ya recibido en una de las dos líneas.
    const orden = await tx.supplyOrder.create({
      data: {
        tid: 990001, supplierId: proveedor.id, supplierLegacy: proveedor.legacyId, orderDate: new Date(),
        subtotal: 200000, tax: 0, total: 200000, paidAmount: 0, status: 'aprobado', kind: 'compra', itemsCount: 2,
        createdById: ADMIN.id, createdByName: ADMIN.name,
        approvedById: 'u-gerente', approvedByName: 'Gerencia', approvedAt: new Date(),
        approved2ById: 'u-gerente2', approved2ByName: 'Gerencia 2', approved2At: new Date(),
        items: {
          create: [
            { product: 'Cable drop 100m', qty: 2, price: 50000, taxRate: 0, subtotal: 100000, taxTotal: 0, receivedQty: 2 },
            { product: 'Conectores', qty: 1, price: 100000, taxRate: 0, subtotal: 100000, taxTotal: 0, receivedQty: 0 },
          ],
        },
      },
      select: { id: true },
    });

    // 1) Sin superadmin, la orden aprobada sigue cerrada a la edición.
    let rebotado = false;
    await orders.update(orden.id, { notes: 'intento' }, ADMIN).catch((e) => { rebotado = /orden pendiente/i.test(e.message); });
    ok(rebotado, 'administración NO puede editar una orden aprobada');

    // 2-4) El superusuario sí: el precio del cable se corrige a 60.000.
    const r = await orders.update(orden.id, {
      notes: 'corrección de precio acordada con el proveedor',
      items: [
        { product: 'Cable drop 100m', qty: 2, price: 60000, taxRate: 0 },
        { product: 'Conectores', qty: 1, price: 100000, taxRate: 0 },
      ],
    } as any, SUPER);
    ok(r.total === 220000, `el total se recalcula: 200.000 → ${r.total}`);

    const despues = await tx.supplyOrder.findUnique({ where: { id: orden.id }, include: { items: true } });
    ok(despues!.status === 'aprobado', 'el estado no se mueve por editar');
    ok(despues!.approvedById === 'u-gerente' && despues!.approved2ById === 'u-gerente2', 'las firmas se conservan');
    const cable = despues!.items.find((i) => i.product === 'Cable drop 100m');
    const conect = despues!.items.find((i) => i.product === 'Conectores');
    ok(cable?.receivedQty === 2, `lo recibido sobrevive al reemplazo de ítems (${cable?.receivedQty}/2)`);
    ok(conect?.receivedQty === 0, 'lo no recibido sigue en cero');

    // 5) La bitácora lo cuenta.
    const ev = await tx.supplyOrderEvent.findFirst({ where: { orderId: orden.id, action: 'EDITAR' }, orderBy: { createdAt: 'desc' } });
    ok(/superusuario/i.test(ev?.detail ?? '') && /200000/.test(ev?.detail ?? '') && /220000/.test(ev?.detail ?? ''),
      `la bitácora deja el rastro: "${ev?.detail}"`);

    // 5b) El ESTADO a mano: exclusivo del superusuario y con su propia línea en la bitácora.
    let rechazaInvento = false;
    await orders.update(orden.id, { status: 'lo que sea' } as any, SUPER)
      .catch((e) => { rechazaInvento = /Estado no válido/i.test(e.message); });
    ok(rechazaInvento, 'un estado inventado se rechaza (lista cerrada)');

    await orders.update(orden.id, { status: 'recibido' } as any, SUPER);
    const conEstado = await tx.supplyOrder.findUnique({ where: { id: orden.id }, include: { items: true } });
    ok(conEstado!.status === 'recibido', 'el superusuario sí cambia el estado (aprobado → recibido)');
    ok(conEstado!.items.find((i) => i.product === 'Cable drop 100m')?.receivedQty === 2, 'cambiar el estado no toca los ítems');
    ok(num(conEstado!.total) === 220000, 'cambiar el estado no toca el dinero');
    const evE = await tx.supplyOrderEvent.findFirst({ where: { orderId: orden.id, action: 'ESTADO' }, orderBy: { createdAt: 'desc' } });
    ok(evE?.fromStatus === 'aprobado' && evE?.toStatus === 'recibido', `la bitácora guarda el salto: ${evE?.fromStatus} → ${evE?.toStatus}`);
    const editarSuelto = await tx.supplyOrderEvent.count({ where: { orderId: orden.id, action: 'EDITAR' } });
    ok(editarSuelto === 1, 'cambiar solo el estado no escribe un EDITAR vacío');

    // 6) Estando pendiente, el comportamiento de siempre: las firmas se reinician.
    await tx.supplyOrder.update({ where: { id: orden.id }, data: { status: 'pendiente' } });

    // Sobre una orden PENDIENTE administración sí edita… pero el estado sigue sin ser suyo.
    let rebotadoEstado = false;
    await orders.update(orden.id, { status: 'finalizado' } as any, ADMIN)
      .catch((e) => { rebotadoEstado = /superadministrador puede cambiar el estado/i.test(e.message); });
    ok(rebotadoEstado, 'administración edita la pendiente pero NO le cambia el estado');

    await orders.update(orden.id, { items: [{ product: 'Conectores', qty: 1, price: 100000, taxRate: 0 }] } as any, SUPER);
    const pend = await tx.supplyOrder.findUnique({ where: { id: orden.id } });
    ok(pend!.approvedById === null && pend!.approved2ById === null, 'en pendiente las firmas se siguen reiniciando');

    throw REVENTAR; // nada de esto queda en la base
  }, { timeout: 60000 }).catch((e) => { if (e !== REVENTAR) throw e; });

  console.log(fallos ? `\n${fallos} comprobación(es) fallida(s)` : '\nTodo en orden. La base quedó intacta.');
  process.exitCode = fallos ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
