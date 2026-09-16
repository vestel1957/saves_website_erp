/**
 * /soporte en SOLO LECTURA: la puerta abierta, la mano quieta. Contra la API viva.
 *
 * Comprueba lo que se separó el 2026-09: ver las órdenes de los técnicos ya no
 * arrastra el poder de tocarlas (`support.write`).
 *
 *  0. el navegador le abre la pantalla: el gate por área del middleware de Next
 *     (`frontend/src/middleware.ts`) deja pasar /soporte;
 *  1. quien solo consulta ENTRA: lista, detalle, PDF y Excel responden 200;
 *  2. y no puede escribir: las 14 rutas de escritura le devuelven 403;
 *  3. quien trabaja las órdenes (técnicos y caja) conserva la escritura.
 *
 * No escribe nada: los intentos del punto 2 se cortan en el guard, antes del
 * handler. Uso:
 *   npx ts-node --transpile-only scripts/smoke-soporte-solo-lectura.ts [correo]
 */
import { PrismaClient } from '@prisma/client';
import { signToken } from '../src/auth/crypto.util';
import { APP_PERMISSIONS, screenKey } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();
const API = `http://127.0.0.1:${process.env.PORT ?? 3061}/api`;
const WEB = `http://127.0.0.1:${process.env.WEB_PORT ?? 3060}`;
const CORREO = process.argv[2] ?? 'redes@vestel.com.co';

let ok = 0, fail = 0;
const assert = (cond: boolean, msg: string, extra: unknown = '') => {
  if (cond) { ok++; console.log(`  OK    ${msg}`); }
  else { fail++; console.log(`  FALLO ${msg}`, extra); }
};

/** Permisos efectivos tal como los arma `AuthService.resolveUser` (rol ∪ ALLOW − DENY). */
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

async function main() {
  const user = await prisma.user.findFirst({
    where: { email: { equals: CORREO, mode: 'insensitive' } },
    select: { id: true, name: true, email: true },
  });
  if (!user) { console.log(`No existe usuario ${CORREO}`); process.exitCode = 1; return; }
  console.log(`\nSolo consulta: ${user.name} <${user.email}>\n`);

  const perms = await efectivos(user.id);
  assert(perms.has(screenKey('/soporte')), 'tiene la pantalla de órdenes (screen.soporte)');
  assert(!perms.has(screenKey('/soporte/agenda')), 'NO tiene el agendamiento (screen.soporte.agenda)');
  assert(!perms.has(APP_PERMISSIONS.SUPPORT_WRITE), 'NO tiene la escritura (support.write)');

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
    return res.status;
  };

  // 0. La puerta del navegador. Va ANTES que la API a propósito: el 403 de una
  // escritura no se llega a ver si el middleware devuelve al usuario a /clientes
  // antes de pintar la pantalla — que es exactamente lo que pasaba.
  const areas = [...perms].filter((p) => p.startsWith('area.')).map((p) => p.slice(5));
  const pantalla = async (ruta: string) => {
    const res = await fetch(`${WEB}${ruta}`, { headers: { cookie: `nexus_token=${token}` }, redirect: 'manual' });
    return { status: res.status, destino: res.headers.get('location') };
  };
  const soporteWeb = await pantalla('/soporte');
  assert(soporteWeb.status === 200, `el navegador abre /soporte (áreas: ${areas.join(', ') || 'ninguna'})`, soporteWeb);

  // 1. Lo que SÍ puede: mirar.
  const lista = await fetch(`${API}/support/tickets?pageSize=1`, { headers: { Authorization: `Bearer ${token}` } });
  assert(lista.status === 200, 'GET /support/tickets responde 200', lista.status);
  const primera = lista.status === 200 ? (await lista.json()).items?.[0] : null;
  const id: string | undefined = primera?.id;
  if (!id) { console.log('  (sin órdenes en la base: no se puede probar el detalle)'); }
  else {
    assert(await pedir('GET', `/support/tickets/${id}`) === 200, 'GET del detalle responde 200');
    assert(await pedir('GET', `/support/tickets/${id}/pdf`) === 200, 'GET del PDF de la orden responde 200');
    assert(await pedir('GET', '/support/stats') === 200, 'GET /support/stats responde 200');
  }

  // 2. Lo que NO: cualquier escritura sobre la orden. Se corta en el guard.
  const escrituras: [string, string, unknown?][] = [
    ['POST', '/support/tickets', { subject: 'reclamo', type: 'x' }],
    ['PATCH', `/support/tickets/${id ?? 'x'}`, { type: 'x' }],
    ['POST', `/support/tickets/${id ?? 'x'}/status`, { status: 'ANULADA' }],
    ['POST', `/support/tickets/${id ?? 'x'}/assign`, { assigned: 'x' }],
    ['POST', `/support/tickets/${id ?? 'x'}/priority`, { priority: 'Alta' }],
    ['POST', `/support/tickets/${id ?? 'x'}/thread`, { message: 'x' }],
    ['POST', `/support/tickets/${id ?? 'x'}/signature`, { name: 'x' }],
    ['POST', `/support/tickets/${id ?? 'x'}/materials`, { items: [] }],
    ['POST', `/support/tickets/${id ?? 'x'}/equipment`, { equipmentId: 'x' }],
    ['POST', `/support/tickets/${id ?? 'x'}/onu/autenticar`, {}],
    ['POST', `/support/tickets/${id ?? 'x'}/onu/velocidad`, {}],
    ['POST', '/support/mi-agenda/no-atendida', { ticketId: id ?? 'x' }],
    // Repartir el trabajo también es mover una orden: no es consulta.
    ['POST', '/support/agenda/mover', { ticketId: id ?? 'x' }],
    ['POST', '/support/agenda/mover-lote', { ids: [] }],
    ['POST', '/support/agenda/recorrido', { tecnico: 'x' }],
  ];
  for (const [metodo, ruta, body] of escrituras) {
    const status = await pedir(metodo, ruta, body);
    assert(status === 403, `${metodo} ${ruta.replace(id ?? 'x', ':id')} → 403`, status);
  }

  // 3. Y quien trabaja las órdenes sigue pudiendo.
  for (const key of ['area-tecnicos', 'area-caja', 'area-administracion']) {
    const rol = await prisma.role.findUnique({
      where: { key },
      select: { permissions: { select: { permission: { select: { key: true } } } } },
    });
    assert(
      !!rol?.permissions.some((rp) => rp.permission.key === APP_PERMISSIONS.SUPPORT_WRITE),
      `el rol ${key} conserva la escritura`,
    );
  }

  console.log(`\n${fail ? 'FALLOS' : 'TODO OK'}: ${ok} bien · ${fail} mal\n`);
  if (fail) process.exitCode = 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
