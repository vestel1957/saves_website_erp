/**
 * Smoke del material EN LA ORDEN, por HTTP y como el técnico de campo: ver sus
 * bodegas → recorrer la suya → registrar consumo → comprobar que el stock baja.
 *
 * Nace del fallo del 10/9: el modal salía vacío porque
 * `GET support/materials/warehouses` no existía —el handler estaba escrito, pero
 * sin entrada en el contrato no hay ruta— y el buscador devolvía el array viejo
 * porque el router tiraba `page`. Los candados de `rutas-vivas.spec.ts` impiden
 * que la ruta desaparezca; esto comprueba lo que un test no puede: que el
 * recorrido entero funciona contra la base y la sesión de verdad.
 *
 * Se comprueba además la acotación ([[material-tecnico-su-bodega]]): el técnico
 * ve UNA bodega —la suya— y no puede descontar de la de un compañero ni mandando
 * el `materialId` a mano.
 *
 * ESCRIBE Y DESHACE: crea una orden de prueba, consume 1 unidad y lo devuelve
 * todo (stock, línea y orden) al terminar, incluso si algo falla.
 *
 *   npx ts-node --transpile-only scripts/smoke-material-orden.ts
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';

const API = process.env.API_URL ?? 'http://127.0.0.1:3061/api';
const EMAIL = process.env.QA_TECNICO_EMAIL ?? 'prueba.tecnicos@vestel.com.co';
const PASS = process.env.QA_TECNICO_PASS ?? 'Prueba2026*';

/** Nº de orden de la franja de prueba: nunca se cruza con los consecutivos reales. */
const CODIGO_PRUEBA = 999_000_001;

const prisma = new PrismaClient();
let fallos = 0;
const comprobar = (ok: boolean, texto: string) => {
  console.log(`${ok ? '  ok  ' : 'FALLO '} ${texto}`);
  if (!ok) fallos++;
};

async function login(email: string, password: string): Promise<string> {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const d: any = await r.json();
  if (!d.token) throw new Error(`Login de ${email} falló: ${d.message ?? r.status}`);
  return d.token;
}

(async () => {
  const tok = await login(EMAIL, PASS);
  const auth = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };

  const staff = await prisma.staff.findFirst({
    where: { OR: [{ email: EMAIL }, { username: 'prueba.tecnico' }] },
    select: { id: true, name: true, username: true },
  });
  if (!staff) throw new Error(`Sin ficha de empleado para ${EMAIL}: corre prisma/seed-tecnico-prueba.ts`);

  // 1. Las bodegas: al técnico le sale UNA, la suya, y el modal entra solo.
  const rBodegas = await fetch(`${API}/support/materials/warehouses`, { headers: auth });
  comprobar(rBodegas.ok, `GET /support/materials/warehouses -> ${rBodegas.status}`);
  const bodegas: any[] = await rBodegas.json();
  comprobar(bodegas.length === 1, `ve ${bodegas.length} bodega(s) (esperado 1: la suya)`);
  const suya = bodegas[0];
  comprobar(Boolean(suya?.mine && suya?.personal), `"${suya?.title}" viene marcada como suya`);

  // 2. Su material, paginado: es lo que llena el selector del modal.
  const rBusca = await fetch(`${API}/support/materials/search?page=1&pageSize=25`, { headers: auth });
  const pagina: any = await rBusca.json();
  comprobar(Array.isArray(pagina.rows), 'el buscador responde la PÁGINA {rows,total,…}, no el array viejo');
  comprobar(pagina.rows.length > 0, `${pagina.total} referencia(s) en su bodega`);
  comprobar(pagina.rows.every((m: any) => m.warehouseId === suya.id), 'todo lo que ve es de su bodega');

  // 3. Ni pidiendo otra bodega por id se le enseña el almacén del compañero.
  const ajena = await prisma.materialWarehouse.findFirst({
    where: { id: { not: suya.id }, materials: { some: { qty: { gt: 0 } } } },
    select: { id: true, title: true },
  });
  if (ajena) {
    // Pedir otra bodega por id no es un error: el filtro simplemente NO manda —
    // se le sigue respondiendo su estante, nunca el del compañero.
    const rAjena = await fetch(`${API}/support/materials/search?page=1&warehouseId=${ajena.id}`, { headers: auth });
    const otra: any = await rAjena.json();
    comprobar(
      (otra.rows ?? []).every((m: any) => m.warehouseId === suya.id),
      `pedir la bodega "${ajena.title}" no le enseña nada de ella`,
    );
  }

  const mat = pagina.rows.find((m: any) => m.qty >= 1);
  if (!mat) throw new Error('Su bodega no tiene stock con el que probar');

  // Orden de prueba a su nombre: el técnico no puede abrir órdenes por API (es
  // así a propósito), así que se siembra aquí y se borra al final.
  const orden = await prisma.ticket.create({
    data: {
      subject: 'PRUEBA · smoke material', type: 'Instalacion', created: new Date(),
      // El consumo deja nota en el hilo de la orden, y el hilo va por NÚMERO de
      // orden: sin `code` la nota no tendría dónde colgarse. Uno de la franja de
      // prueba, lejos de los consecutivos de verdad.
      code: CODIGO_PRUEBA,
      assignedStaffId: staff.id, assigned: staff.username ?? staff.name, status: 'REALIZANDO',
    },
    select: { id: true },
  });

  try {
    // 4. Registrar el consumo descuenta stock y deja la línea en la orden.
    const antes = mat.qty;
    const rAlta = await fetch(`${API}/support/tickets/${orden.id}/materials`, {
      method: 'POST', headers: auth, body: JSON.stringify({ items: [{ materialId: mat.id, qty: 1 }] }),
    });
    comprobar(rAlta.ok, `POST /support/tickets/:id/materials -> ${rAlta.status}`);
    const tras = await prisma.material.findUnique({ where: { id: mat.id }, select: { qty: true, editedAt: true } });
    comprobar(tras!.qty === antes - 1, `stock de "${mat.name}": ${antes} -> ${tras!.qty} (esperado ${antes - 1})`);
    comprobar(tras!.editedAt != null, 'queda blindado con editedAt (el sync no lo revierte)');
    const linea = await prisma.ticketMaterial.findFirst({ where: { ticketId: orden.id }, select: { id: true, warehouseName: true } });
    comprobar(Boolean(linea), 'la línea queda registrada en la orden, con su bodega');

    // 5. La puerta de verdad: un material de otra bodega se rechaza aunque el id
    //    venga a mano, y no toca ningún stock.
    if (ajena) {
      const suyoNo = await prisma.material.findFirst({ where: { warehouseId: ajena.id, qty: { gt: 0 } }, select: { id: true, qty: true } });
      if (suyoNo) {
        const rNo = await fetch(`${API}/support/tickets/${orden.id}/materials`, {
          method: 'POST', headers: auth, body: JSON.stringify({ items: [{ materialId: suyoNo.id, qty: 1 }] }),
        });
        const intacto = await prisma.material.findUnique({ where: { id: suyoNo.id }, select: { qty: true } });
        comprobar(rNo.status === 403, `material de otra bodega -> ${rNo.status} (esperado 403)`);
        comprobar(intacto!.qty === suyoNo.qty, 'el rechazo no tocó el stock del compañero');
      }
    }

    // 6. Pedir más de lo que hay se rechaza sin descontar nada.
    const rTope = await fetch(`${API}/support/tickets/${orden.id}/materials`, {
      method: 'POST', headers: auth, body: JSON.stringify({ items: [{ materialId: mat.id, qty: antes + 1000 }] }),
    });
    comprobar(rTope.status === 400, `pedir más de lo que hay -> ${rTope.status} (esperado 400)`);

    // Deshacer: devolver la unidad y quitar la línea.
    await prisma.ticketMaterial.deleteMany({ where: { ticketId: orden.id } });
    await prisma.material.update({ where: { id: mat.id }, data: { qty: antes } });
    const final = await prisma.material.findUnique({ where: { id: mat.id }, select: { qty: true } });
    comprobar(final!.qty === antes, `stock devuelto: ${final!.qty}`);
  } finally {
    await prisma.ticketThread.deleteMany({ where: { ticketCode: CODIGO_PRUEBA } });
    await prisma.ticketMaterial.deleteMany({ where: { ticketId: orden.id } });
    await prisma.ticket.delete({ where: { id: orden.id } });
  }

  // 7. A quien no es técnico de campo no se le acota: sigue viendo todos los estantes.
  const admin = await login(process.env.QA_ADMIN_EMAIL ?? 'prueba.administracion@vestel.com.co', process.env.QA_ADMIN_PASS ?? 'Prueba2026*');
  const rTodas = await fetch(`${API}/support/materials/warehouses`, { headers: { Authorization: `Bearer ${admin}` } });
  const todas: any[] = await rTodas.json();
  comprobar(todas.length > 1, `administración sigue viendo ${todas.length} bodegas`);

  await prisma.$disconnect();
  console.log(fallos ? `\n${fallos} comprobación(es) FALLARON` : '\nTodo OK');
  process.exit(fallos ? 1 : 0);
})();
