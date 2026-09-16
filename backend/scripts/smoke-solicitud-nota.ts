/**
 * Smoke de las solicitudes de nota crédito/débito (pestaña Cobranza) contra la API VIVA.
 *
 * Pide la nota la cajera de prueba y se la asigna al superusuario de prueba, al que
 * se le PRESTA `billing.notes.emit` mientras dura el smoke: así no le suena la
 * campanita a nadie de verdad. Comprueba el aviso al asignado, los candados, que el
 * aviso se retira al cerrar y que a quien la pidió le llega la respuesta.
 *
 * No emite ninguna nota. Al terminar borra lo que creó y retira el permiso, pase lo
 * que pase.
 *
 * Correr:  npx ts-node scripts/smoke-solicitud-nota.ts
 */
import { PrismaClient } from '@prisma/client';
import { APP_PERMISSIONS } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();
const API = process.env.SMOKE_API ?? 'http://127.0.0.1:3061/api';
const CAJA = { email: 'prueba.caja@vestel.com.co', password: 'Prueba2026*' };
const EMISOR = { email: 'prueba.superusuario@vestel.com.co', password: 'Prueba2026*' };
const NO_EMISOR = 'prueba.contabilidad@vestel.com.co';

let fallos = 0;
function comprobar(que: string, ok: boolean, detalle = '') {
  if (!ok) fallos++;
  console.log(`  ${ok ? '✓' : '✗'} ${que}${detalle ? ` — ${detalle}` : ''}`);
}

async function entrar(cuenta: { email: string; password: string }) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuenta),
  });
  if (!res.ok) throw new Error(`login de ${cuenta.email} falló (${res.status})`);
  return (await res.json()).token as string;
}

async function pedir(token: string, metodo: string, ruta: string, cuerpo?: unknown) {
  const res = await fetch(`${API}${ruta}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await res.text();
  let json: any = null;
  try { json = JSON.parse(texto); } catch { /* sin cuerpo */ }
  return { status: res.status, json };
}

async function main() {
  const perm = await prisma.permission.findUnique({ where: { key: APP_PERMISSIONS.BILLING_NOTES_EMIT } });
  if (!perm) throw new Error('No existe el permiso billing.notes.emit');
  const [caja, emisor, noEmisor] = await Promise.all(
    [CAJA.email, EMISOR.email, NO_EMISOR].map((email) => prisma.user.findFirst({ where: { email }, select: { id: true, name: true } })),
  );
  if (!caja || !emisor || !noEmisor) throw new Error('Faltan cuentas de prueba (prisma/seed-usuarios-prueba.ts)');
  const sub = await prisma.subscriber.findFirst({ where: { fullName: { not: null } }, select: { id: true, abonado: true } });
  if (!sub) throw new Error('No hay clientes');

  const yaTenia = await prisma.userPermission.findUnique({ where: { userId_permissionId: { userId: emisor.id, permissionId: perm.id } } });
  if (yaTenia) throw new Error(`${emisor.name} ya tiene el permiso; el smoke necesita prestarlo y devolverlo.`);

  const creadas: string[] = [];
  await prisma.userPermission.create({ data: { userId: emisor.id, permissionId: perm.id, effect: 'ALLOW' } });
  try {
    const [tCaja, tEmisor] = [await entrar(CAJA), await entrar(EMISOR)];

    console.log('Asignables');
    const asig = await pedir(tCaja, 'GET', '/collections/note-requests/assignees');
    comprobar('la cajera ve la lista', asig.status === 200, `${asig.status}`);
    const nombres = (asig.json ?? []).map((e: { name: string }) => e.name);
    comprobar('incluye al emisor prestado', (asig.json ?? []).some((e: { id: string }) => e.id === emisor.id));
    comprobar('no incluye a quien no emite', !(asig.json ?? []).some((e: { id: string }) => e.id === noEmisor.id));
    console.log(`    hoy: ${nombres.join(' · ')}`);

    console.log('Pedir');
    const mala = await pedir(tCaja, 'POST', '/collections/note-requests', {
      subscriberId: sub.id, type: 'CREDITO', reason: 'smoke solicitud de nota', assignedToId: noEmisor.id,
    });
    comprobar('asignar a quien no emite → 400', mala.status === 400, `${mala.status}`);
    if (mala.json?.id) creadas.push(mala.json.id);

    const buena = await pedir(tCaja, 'POST', '/collections/note-requests', {
      subscriberId: sub.id, type: 'CREDITO', amount: 12345, reason: 'smoke solicitud de nota', assignedToId: emisor.id,
    });
    comprobar('la cajera la pide', buena.status < 300 && !!buena.json?.id, `${buena.status}`);
    const id = buena.json?.id as string;
    if (!id) throw new Error('sin solicitud no hay más que probar');
    creadas.push(id);

    const aviso = await prisma.notification.findFirst({ where: { userId: emisor.id, groupKey: `solicitud-nota:${id}` } });
    comprobar('al asignado le llega el aviso', !!aviso && aviso.kind === 'facturacion.solicitud_nota', aviso?.title ?? 'sin aviso');
    comprobar('el aviso lleva a la pestaña Cobranza', aviso?.link === `/clientes/${sub.id}?tab=cobranza`, aviso?.link ?? '');

    const lista = await pedir(tCaja, 'GET', `/collections/subscriber/${sub.id}/note-requests`);
    const fila = (lista.json?.items ?? []).find((s: { id: string }) => s.id === id);
    comprobar('sale en la ficha, pendiente y con monto', fila?.status === 'PENDIENTE' && fila?.amount === 12345);

    console.log('Cerrar');
    const ajena = await pedir(tCaja, 'PATCH', `/collections/note-requests/${id}`, { status: 'RECHAZADA', response: 'no me toca' });
    comprobar('la cajera no la cierra → 403', ajena.status === 403, `${ajena.status}`);
    const muda = await pedir(tEmisor, 'PATCH', `/collections/note-requests/${id}`, { status: 'RECHAZADA' });
    comprobar('rechazar sin motivo → 400', muda.status === 400, `${muda.status}`);
    const cerrada = await pedir(tEmisor, 'PATCH', `/collections/note-requests/${id}`, { status: 'RECHAZADA', response: 'smoke: no procede' });
    comprobar('el asignado la rechaza', cerrada.status < 300 && cerrada.json?.status === 'RECHAZADA', `${cerrada.status}`);

    const sigue = await prisma.notification.count({ where: { userId: emisor.id, groupKey: `solicitud-nota:${id}` } });
    comprobar('el aviso sale de su campanita', sigue === 0, `${sigue}`);
    const respuesta = await prisma.notification.findFirst({ where: { userId: caja.id, groupKey: `solicitud-nota-cerrada:${id}` } });
    comprobar('a quien la pidió le llega la respuesta', !!respuesta, respuesta?.title ?? 'sin aviso');

    const otraVez = await pedir(tEmisor, 'PATCH', `/collections/note-requests/${id}`, { status: 'APLICADA' });
    comprobar('cerrarla dos veces → 400', otraVez.status === 400, `${otraVez.status}`);
  } finally {
    if (creadas.length) {
      await prisma.notification.deleteMany({
        where: { groupKey: { in: creadas.flatMap((c) => [`solicitud-nota:${c}`, `solicitud-nota-cerrada:${c}`]) } },
      });
      await prisma.noteRequest.deleteMany({ where: { id: { in: creadas } } });
    }
    await prisma.userPermission.deleteMany({ where: { userId: emisor.id, permissionId: perm.id } });
    await prisma.$disconnect();
  }
  console.log(fallos ? `\n${fallos} fallo(s)` : '\nTodo en orden');
  process.exit(fallos ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
