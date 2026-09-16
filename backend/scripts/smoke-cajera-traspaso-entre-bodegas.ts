/**
 * La cajera traspasa ENTRE BODEGAS, pero sólo dentro de su sede (2026-09-11).
 * Contra la API viva.
 *
 *  0. el navegador le abre /inventario/traspasos/nuevo;
 *  1. el contexto le da el modo "entre bodegas": destinos = bodegas generales de su
 *     sede, orígenes = esas + almacenes de los técnicos de su sede;
 *  2. mover a otra bodega de su sede, con material NO consumible, pasa la
 *     autorización (se corta después, por stock insuficiente, y la transacción se
 *     deshace: no escribe nada);
 *  3. y no puede: meter material a una bodega de otra sede, sacarlo de una bodega
 *     de otra sede, ni entregarle a un técnico algo que no sea consumible.
 *
 * Uso:
 *   npx ts-node --transpile-only scripts/smoke-cajera-traspaso-entre-bodegas.ts [correo]
 */
import { PrismaClient } from '@prisma/client';
import { signToken } from '../src/auth/crypto.util';
import { APP_PERMISSIONS } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();
const API = `http://127.0.0.1:${process.env.PORT ?? 3061}/api`;
const WEB = `http://127.0.0.1:${process.env.WEB_PORT ?? 3060}`;
const CORREO = process.argv[2] ?? 'prueba.caja@vestel.com.co';
/** Más de lo que cualquier bodega tiene: la petición pasa el permiso y cae en el stock. */
const CANTIDAD_IMPOSIBLE = 10_000_000;

let ok = 0, fail = 0;
const assert = (cond: boolean, msg: string, extra: unknown = '') => {
  if (cond) { ok++; console.log(`  OK    ${msg}`); }
  else { fail++; console.log(`  FALLO ${msg}`, extra); }
};

async function efectivos(userId: string): Promise<Set<string>> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      roles: { select: { role: { select: { permissions: { select: { permission: { select: { key: true } } } } } } } },
      permissionOverrides: { select: { effect: true, permission: { select: { key: true } } } },
    },
  });
  const set = new Set<string>();
  for (const r of u?.roles ?? []) for (const rp of r.role.permissions) set.add(rp.permission.key);
  for (const o of u?.permissionOverrides ?? []) {
    if (o.effect === 'DENY') set.delete(o.permission.key); else set.add(o.permission.key);
  }
  return set;
}

type Bodega = { id: string; title: string; isTechnician: boolean; branchLegacy: number | null };

async function main() {
  const user = await prisma.user.findFirst({
    where: { email: { equals: CORREO, mode: 'insensitive' } },
    select: { id: true, name: true, email: true },
  });
  if (!user) { console.log(`No existe usuario ${CORREO}`); process.exitCode = 1; return; }
  console.log(`\nCajera: ${user.name} <${user.email}>\n`);

  const perms = await efectivos(user.id);
  const token = signToken(user, {
    areas: [...perms].filter((p) => p.startsWith('area.')).map((p) => p.slice(5)),
    sa: perms.has(APP_PERMISSIONS.SYSTEM_ADMIN),
  });
  const pedir = async (metodo: string, ruta: string, body?: unknown) => {
    const res = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  // 0. La pantalla.
  const web = await fetch(`${WEB}/inventario/traspasos/nuevo`, { headers: { cookie: `nexus_token=${token}` }, redirect: 'manual' });
  assert(web.status === 200, 'el navegador abre /inventario/traspasos/nuevo', web.status);

  // 1. El contexto.
  const { status, body: ctx } = await pedir('GET', '/inventory/transfer/context');
  assert(status === 200, 'GET /inventory/transfer/context responde', status);
  assert(ctx.restricted === true, 'sigue siendo un contexto restringido');
  assert(ctx.canWarehouseMode === true, 'tiene el modo "entre bodegas"');
  const sedes: number[] = ctx.mySedes;
  const destinos: Bodega[] = ctx.warehouseTargets;
  const origenes: Bodega[] = ctx.warehouseOrigins;
  console.log(`        sedes ${sedes.join(',')} · ${destinos.length} destinos · ${origenes.length} orígenes`);
  assert(destinos.length > 0 && destinos.every((w) => !w.isTechnician && w.branchLegacy != null && sedes.includes(w.branchLegacy)),
    'los destinos son sólo bodegas generales de su sede', destinos.map((w) => w.title));
  assert(origenes.filter((w) => !w.isTechnician).every((w) => w.branchLegacy != null && sedes.includes(w.branchLegacy)),
    'las bodegas generales de origen son sólo de su sede');

  const ajena = (ctx.warehouses as Bodega[]).find((w) => !w.isTechnician && w.branchLegacy != null && !sedes.includes(w.branchLegacy));
  const [origen, destino] = destinos;
  if (!origen || !destino || !ajena) { console.log('Faltan bodegas para seguir'); process.exitCode = 1; return; }

  // Un material NO consumible de la bodega origen.
  const consumibles = new Set<string>(ctx.consumableCategoryIds);
  const noConsumible = await prisma.material.findFirst({
    where: { warehouseId: origen.id, qty: { gt: 0 }, OR: [{ categoryId: null }, { categoryId: { notIn: [...consumibles] } }] },
    select: { id: true, name: true },
  });
  const deAjena = await prisma.material.findFirst({ where: { warehouseId: ajena.id, qty: { gt: 0 } }, select: { id: true } });
  if (!noConsumible || !deAjena) { console.log('Faltan materiales para seguir'); process.exitCode = 1; return; }
  const traspaso = (from: string, to: string, materialId: string) =>
    pedir('POST', '/inventory/transfer', { fromWarehouseId: from, toWarehouseId: to, items: [{ materialId, qty: CANTIDAD_IMPOSIBLE }] });

  // 2. Dentro de su sede, cualquier material: pasa el permiso y cae en el stock.
  const dentro = await traspaso(origen.id, destino.id, noConsumible.id);
  assert(dentro.status === 400 && /Stock insuficiente/.test(dentro.body?.message ?? ''),
    `${origen.title} → ${destino.title} con "${noConsumible.name}" pasa el permiso`, dentro);

  // 3. Lo que no.
  const aOtraSede = await traspaso(origen.id, ajena.id, noConsumible.id);
  assert(aOtraSede.status === 403, `→ ${ajena.title} (otra sede) da 403`, aOtraSede);
  const deOtraSede = await traspaso(ajena.id, destino.id, deAjena.id);
  assert(deOtraSede.status === 403, `${ajena.title} (otra sede) → ${destino.title} da 403`, deOtraSede);
  const tecnico = ctx.technicians.find((t: { retired: boolean }) => !t.retired);
  if (tecnico) {
    const aTecnico = await traspaso(origen.id, tecnico.warehouseId, noConsumible.id);
    assert(aTecnico.status === 403 && /no es consumible/.test(aTecnico.body?.message ?? ''),
      `a un técnico (${tecnico.name}) sigue siendo sólo consumible`, aTecnico);
  }

  const actas = await prisma.materialActa.count({ where: { createdByName: user.name, date: { gte: new Date(Date.now() - 5 * 60_000) } } });
  assert(actas === 0, 'no quedó ningún acta creada por la prueba', actas);

  console.log(`\n${ok} OK · ${fail} fallos\n`);
  if (fail) process.exitCode = 1;
}

main().finally(() => prisma.$disconnect());
