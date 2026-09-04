/**
 * El técnico devuelve el material que le sobró (2026-09-03). Contra la BD real.
 *
 * Prueba el flujo entero con los usuarios `prueba.*`:
 *   1. qué le ofrece la pantalla al técnico (sólo devolver, y sólo a su sede),
 *   2. que no pueda sacar de otra bodega ni mandar el material a donde quiera,
 *   3. que la devolución salga de su bodega y quede EN TRÁNSITO,
 *   4. que la firme la CAJERA de esa sede — y sólo ella —, acreditando el material.
 *
 * Escribe sobre la BD real y lo REVIERTE al final: el acta se borra y las
 * existencias vuelven a estar como estaban. No es limpieza de cortesía — un acta
 * de prueba en tránsito es material que alguien va a ir a buscar.
 *
 * WhatsApp y la firma van con dobles: aquí no sale ningún mensaje de verdad.
 *
 * Uso: npx ts-node --transpile-only scripts/smoke-devolucion-tecnico.ts
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { InventoryService } from '../src/inventory/inventory.service';
import { cajerasDeSede } from '../src/common/sede-scope';

const prisma = new PrismaClient();
let ok = 0, fail = 0;
const assert = (cond: boolean, msg: string, extra: unknown = '') => {
  if (cond) { ok++; console.log(`  OK    ${msg}`); }
  else { fail++; console.log(`  FALLO ${msg}`, extra); }
};

/** Qué pasó al llamar: el error si lo hubo, para poder afirmar sobre él. */
async function falla(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { return (e as Error).message; }
}

// Dobles: ni WhatsApp ni códigos de firma. `required: false` deja recibir sin
// código; el caso con código lo cubre `smoke-firma-otp` (mismo servicio).
const firma = {
  config: async () => ({ required: false }),
  telefono: async () => ({ phone: null }),
  pedir: async () => ({ ok: true }),
  firmar: async () => ({ ok: true }),
} as any;
const whatsapp = { sendDocument: async () => false } as any;
const avisos = { notify: async () => undefined } as any;

const inv = new InventoryService(prisma as any, firma, whatsapp, avisos);

/** La sesión de un usuario, como la arma `resolveUser()` (permisos de sus roles). */
async function sesion(email: string) {
  const u = await prisma.user.findFirst({
    where: { email },
    select: { id: true, name: true, email: true, sedesAccede: true, roles: { select: { role: { select: { permissions: { select: { permission: { select: { key: true } } } } } } } } },
  });
  if (!u) throw new Error(`no está el usuario de prueba ${email}`);
  const permissions = [...new Set(u.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.key)))];
  return { id: u.id, name: u.name, email: u.email, permissions, roles: [], sedes: u.sedesAccede } as any;
}

async function main() {
  const tecnico = await sesion('prueba.tecnicos@vestel.com.co');
  const cajera = await sesion('prueba.caja@vestel.com.co');
  const contable = await sesion('prueba.contabilidad@vestel.com.co');

  // --- 1. Lo que la pantalla le ofrece al técnico ----------------------------
  console.log('\n1) El contexto del traspaso para un técnico de campo');
  const ctx: any = await inv.transferContext(tecnico);
  assert(ctx.canReturnMode === true, 'puede devolver');
  assert(ctx.canWarehouseMode === false, 'NO tiene el modo "entre bodegas"');
  assert(ctx.canTechnicianMode === false, 'NO le puede entregar material a otro técnico');
  assert(ctx.technicians.length === 0, 'no se le lista ningún técnico', ctx.technicians.length);
  assert(ctx.originWarehouses.length === 1, 'un solo origen: su bodega', ctx.originWarehouses.map((w: any) => w.title));
  assert(!ctx.returnBlocked, 'nada le impide devolver', ctx.returnBlocked);
  const destino = ctx.returnTargets?.[0];
  console.log(`     ${ctx.returnFrom?.title}  →  ${destino?.title} (${destino?.branchName})`);
  assert(!!destino?.branchLegacy, 'el destino es la bodega principal de su sede', destino);
  assert(Array.isArray(destino?.receivers), 'se sabe qué cajeras la firmarían', destino?.receivers);

  // --- 2. Las dos puertas: de dónde sale y a dónde va ------------------------
  console.log('\n2) No puede sacar de otra bodega ni mandarlo a otra parte');
  const ajena = await prisma.materialWarehouse.findFirst({
    where: { technicianRef: { not: null }, id: { not: ctx.returnFrom.id }, materials: { some: { qty: { gt: 0 } } } },
    select: { id: true, title: true, materials: { where: { qty: { gt: 0 } }, take: 1, select: { id: true } } },
  });
  if (!ajena) console.log('     (no hay otro almacén de técnico con material: se omite)');
  else {
    const m1 = await falla(() => inv.transfer({ fromWarehouseId: ajena.id, toWarehouseId: destino.id, items: [{ materialId: ajena.materials[0].id, qty: 1 }] } as any, tecnico));
    assert(!!m1 && /tu propia bodega/i.test(m1), 'sacar de la bodega de otro técnico → 403', m1);
  }
  const material = await prisma.material.findFirst({ where: { warehouseId: ctx.returnFrom.id, qty: { gt: 1 } }, select: { id: true, name: true, qty: true } });
  if (!material) throw new Error('la bodega del técnico de prueba no tiene material con existencias');
  const otraBodega = await prisma.materialWarehouse.findFirst({ where: { isMain: false, technicianRef: null, id: { not: destino.id } }, select: { id: true, title: true } });
  const m2 = await falla(() => inv.transfer({ fromWarehouseId: ctx.returnFrom.id, toWarehouseId: otraBodega!.id, items: [{ materialId: material.id, qty: 1 }] } as any, tecnico));
  assert(!!m2 && /bodega principal de tu sede/i.test(m2), `mandarlo a "${otraBodega!.title}" → 403`, m2);

  // --- 3. La devolución sale de su bodega y queda en tránsito ----------------
  console.log('\n3) Devuelve 2 unidades de ' + material.name);
  const antesDestino = await prisma.material.findFirst({ where: { warehouseId: destino.id, name: material.name }, select: { id: true, qty: true } });
  const r: any = await inv.transfer(
    { fromWarehouseId: ctx.returnFrom.id, toWarehouseId: destino.id, observations: 'SMOKE devolución (se borra al terminar)', items: [{ materialId: material.id, qty: 2 }] } as any,
    tecnico,
  );
  const acta = await prisma.materialActa.findUnique({ where: { id: r.actaId } });
  assert(acta?.status === 'En tránsito', 'el acta queda EN TRÁNSITO', acta?.status);
  assert(acta?.assignedToId === null, 'sin persona designada: la firma la cajera de turno');
  assert(acta?.assignedBranchLegacy === destino.branchLegacy, 'el acta apunta a la sede que la firma', acta?.assignedBranchLegacy);
  const origenDespues = await prisma.material.findUnique({ where: { id: material.id }, select: { qty: true } });
  assert(origenDespues?.qty === material.qty - 2, 'el material sale de su bodega', `${material.qty} → ${origenDespues?.qty}`);
  assert(!(await prisma.material.findFirst({ where: { warehouseId: destino.id, name: material.name, qty: { gt: antesDestino?.qty ?? 0 } } })), 'y NO se acredita en destino hasta que lo reciban');

  // --- 4. La firma es de la cajera de esa sede -------------------------------
  console.log('\n4) Quién puede firmar el recibido');
  const cajeras = await cajerasDeSede(prisma as any, destino.branchLegacy);
  console.log(`     cajeras de ${destino.branchName}: ${cajeras.map((c) => c.name).join(', ') || '(ninguna)'}`);
  assert(cajeras.some((c) => c.id === cajera.id), 'la cajera de prueba está entre ellas');
  const m3 = await falla(() => inv.receiveActa(r.actaId, tecnico));
  assert(!!m3 && /cajera/i.test(m3), 'el propio técnico NO puede firmar su devolución', m3);
  const m4 = await falla(() => inv.receiveActa(r.actaId, contable));
  assert(!!m4 && /cajera/i.test(m4), 'contabilidad tampoco', m4);
  const detalle: any = await inv.actaDetail(r.actaId, cajera);
  assert(detalle.isReceiver === true, 'a la cajera la pantalla le ofrece firmar');
  assert((await inv.actaDetail(r.actaId, tecnico)).isReceiver === false, 'al técnico no');

  const recibida: any = await inv.receiveActa(r.actaId, cajera);
  assert(recibida.status === 'Recibida', 'la cajera la firma y queda RECIBIDA', recibida.status);
  const destinoDespues = await prisma.material.findFirst({ where: { warehouseId: destino.id, name: material.name }, select: { id: true, qty: true } });
  assert(destinoDespues?.qty === (antesDestino?.qty ?? 0) + 2, 'el material se acredita en la bodega de la sede', `${antesDestino?.qty ?? 0} → ${destinoDespues?.qty}`);

  // --- Deshacer ---------------------------------------------------------------
  console.log('\n5) Revertir lo que escribió la prueba');
  await prisma.materialActa.delete({ where: { id: r.actaId } }); // los ítems van en cascada
  await prisma.material.update({ where: { id: material.id }, data: { qty: material.qty } });
  if (antesDestino) await prisma.material.update({ where: { id: antesDestino.id }, data: { qty: antesDestino.qty } });
  else if (destinoDespues) await prisma.material.delete({ where: { id: destinoDespues.id } });
  const limpio = await prisma.materialActa.count({ where: { id: r.actaId } });
  assert(limpio === 0 && (await prisma.material.findUnique({ where: { id: material.id } }))!.qty === material.qty, 'todo vuelve a estar como estaba');

  // --- 6. Y la entrega de siempre sigue funcionando -------------------------
  // El camino de la cajera comparte con la devolución el envío del acta y la puerta
  // de la firma, que se reescribieron: si algo se rompió, se rompió aquí.
  console.log('\n6) La entrega de la cajera al técnico sigue igual');
  const ctxCaja: any = await inv.transferContext(cajera);
  assert(ctxCaja.canTechnicianMode === true && ctxCaja.canReturnMode === false, 'la cajera entrega, no devuelve');
  const suTecnico = ctxCaja.technicians.find((t: any) => t.warehouseId === ctx.returnFrom.id);
  assert(!!suTecnico, 've al técnico de prueba (es de su sede)');
  const consumible = await prisma.material.findFirst({
    where: { warehouseId: destino.id, qty: { gt: 1 }, categoryId: { in: ctxCaja.consumableCategoryIds } },
    select: { id: true, name: true, qty: true },
  });
  if (!consumible) console.log('     (la bodega de la sede no tiene consumible con existencias: se omite)');
  else {
    const antes = await prisma.material.findFirst({ where: { warehouseId: ctx.returnFrom.id, name: consumible.name }, select: { id: true, qty: true } });
    const e: any = await inv.transfer(
      { fromWarehouseId: destino.id, toWarehouseId: ctx.returnFrom.id, observations: 'SMOKE entrega (se borra al terminar)', items: [{ materialId: consumible.id, qty: 1 }] } as any,
      cajera,
    );
    const actaE = await prisma.materialActa.findUnique({ where: { id: e.actaId } });
    assert(actaE?.assignedToId === tecnico.id, 'el acta queda designada al técnico, no a una sede', actaE?.assignedToName);
    assert(actaE?.assignedBranchLegacy === null, 'y sin sede firmante');
    const m5 = await falla(() => inv.receiveActa(e.actaId, contable));
    assert(!!m5 && /designada/i.test(m5), 'nadie más la firma', m5);
    const rec: any = await inv.receiveActa(e.actaId, tecnico);
    assert(rec.status === 'Recibida', 'el técnico la recibe');
    const suyo = await prisma.material.findFirst({ where: { warehouseId: ctx.returnFrom.id, name: consumible.name }, select: { id: true, qty: true } });
    assert(suyo?.qty === (antes?.qty ?? 0) + 1, 'y el material le queda acreditado', `${antes?.qty ?? 0} → ${suyo?.qty}`);

    await prisma.materialActa.delete({ where: { id: e.actaId } });
    await prisma.material.update({ where: { id: consumible.id }, data: { qty: consumible.qty } });
    if (antes) await prisma.material.update({ where: { id: antes.id }, data: { qty: antes.qty } });
    else if (suyo) await prisma.material.delete({ where: { id: suyo.id } });
    console.log('     revertido');
  }

  console.log(`\n  ${ok} OK · ${fail} FALLO(S)\n`);
  if (fail) process.exitCode = 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
