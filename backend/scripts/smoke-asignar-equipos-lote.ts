/**
 * Smoke de la asignación de VARIOS equipos en una orden (2026-08-26).
 *
 * Comprueba las tres cosas que el cambio promete: que entran varios de una, que
 * el cuerpo plano de un solo equipo sigue funcionando (lo usaban las pantallas
 * viejas), y que el lote es atómico —si un equipo choca, no queda el anterior
 * asignado a medias—.
 *
 * Trabaja sobre una orden y un cliente de pega que crea y borra él mismo.
 */
export {};

const API = process.env.API_URL ?? 'http://127.0.0.1:3061/api';

async function login(email: string, password: string): Promise<string> {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const d: any = await r.json();
  if (!d.token) throw new Error(`Login de ${email} falló: ${d.message ?? r.status}`);
  return d.token;
}

let fallos = 0;
const check = (ok: boolean, msg: string) => { console.log(`  ${ok ? '✓' : '✗'} ${msg}`); if (!ok) fallos++; };

(async () => {
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  const tok = await login(process.env.QA_ADMIN_EMAIL ?? 'admin@bhdc.dev', process.env.QA_ADMIN_PASS ?? 'admin123');

  const sub = await prisma.subscriber.findFirst({ where: { legacyId: { not: null } }, select: { id: true, macEquipo: true, fullName: true } });
  if (!sub) throw new Error('No hay abonados para la prueba');
  const otro = await prisma.subscriber.findFirst({ where: { id: { not: sub.id } }, select: { id: true } });
  if (!otro) throw new Error('Hace falta un segundo abonado');
  const macPrevia = sub.macEquipo;

  const maxCode = (await prisma.ticket.aggregate({ _max: { code: true } }))._max.code ?? 0;
  const t = await prisma.ticket.create({
    data: { code: maxCode + 1, subscriber: { connect: { id: sub.id } }, created: new Date(), subject: 'servicio', type: 'Prueba lote equipos', status: 'PENDIENTE' },
    select: { id: true, code: true },
  });

  // MACs de pega, marcadas para poder barrerlas si algo se cae a mitad.
  const M1 = 'DE:AD:BE:EF:00:01', M2 = 'DE:AD:BE:EF:00:02', M3 = 'DE:AD:BE:EF:00:03';
  const ajena = 'DE:AD:BE:EF:00:99';
  const post = (body: unknown) => fetch(`${API}/support/tickets/${t.id}/equipment`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
    body: JSON.stringify(body),
  });

  try {
    console.log(`\nOrden de prueba ${t.code} · cliente ${sub.fullName}\n`);

    // 1) Dos equipos de una.
    let r = await post({ items: [
      { mac: M1, installType: 'FTTH', port: 3, nat: 12, meters: 40 },
      { mac: M2, installType: 'Otro', serial: 'SN-PRUEBA-2' },
    ] });
    let d: any = await r.json();
    check(r.ok, `dos equipos en un envío → ${r.status}`);
    check(d?.total === 2, `la respuesta dice total=2 (dijo ${d?.total})`);
    const creados = await prisma.equipment.findMany({ where: { mac: { in: [M1, M2] } }, select: { mac: true, code: true, subscriberId: true, status: true, port: true, nat: true, installType: true, editedAt: true } });
    check(creados.length === 2, `quedaron 2 unidades en la base (${creados.length})`);
    check(new Set(creados.map((e) => e.code)).size === 2, 'cada unidad recibió su propio consecutivo');
    check(creados.every((e) => e.subscriberId === sub.id && e.status === 'Asignado'), 'ambas quedaron asignadas al cliente');
    check(creados.every((e) => e.editedAt != null), 'ambas llevan editedAt (el sync no las pisa)');
    const ftth = creados.find((e) => e.mac === M1);
    check(ftth?.port === 3 && ftth?.nat === 12, 'los datos de FTTH se guardaron en la que tocaba');
    const tras = await prisma.subscriber.findUnique({ where: { id: sub.id }, select: { macEquipo: true } });
    check(tras?.macEquipo === M1, `la MAC principal del cliente es la primera del lote (${tras?.macEquipo})`);

    // 2) El cuerpo plano de siempre.
    r = await post({ mac: M3, installType: 'HFC' });
    d = await r.json();
    check(r.ok && d?.mac === M3, `un solo equipo en cuerpo plano → ${r.status}`);

    // 3) Atomicidad: la segunda MAC es de otro cliente, así que no debe entrar ninguna.
    await prisma.equipment.create({ data: { code: (await prisma.equipment.aggregate({ _max: { code: true } }))._max.code! + 1, mac: ajena, subscriberId: otro.id, status: 'Asignado', warehouseLegacy: 0, supplierLegacy: 0 } });
    const antes = await prisma.equipment.count();
    r = await post({ items: [{ mac: 'DE:AD:BE:EF:00:04', installType: 'Otro' }, { mac: ajena, installType: 'Otro' }] });
    d = await r.json();
    check(r.status === 400, `lote con una MAC de otro cliente → ${r.status} (esperado 400)`);
    check(String(d?.message ?? '').includes(ajena), `el error nombra la MAC culpable: ${d?.message}`);
    check(await prisma.equipment.count() === antes, 'no se creó la primera del lote (transacción revertida)');

    // 4) MAC repetida dentro del mismo envío.
    r = await post({ items: [{ mac: M1, installType: 'Otro' }, { mac: M1, installType: 'Otro' }] });
    d = await r.json();
    check(r.status === 400 && String(d?.message ?? '').includes('repetida'), `MAC repetida en la lista → ${r.status}: ${d?.message}`);
  } finally {
    // Limpieza: todo lo de pega fuera, y el cliente como estaba.
    await prisma.equipment.deleteMany({ where: { mac: { startsWith: 'DE:AD:BE:EF:' } } });
    await prisma.ticketThread.deleteMany({ where: { ticketCode: t.code } });
    await prisma.ticket.delete({ where: { id: t.id } }).catch(() => undefined);
    await prisma.subscriber.update({ where: { id: sub.id }, data: { macEquipo: macPrevia } }).catch(() => undefined);
    await prisma.$disconnect();
  }

  console.log(fallos ? `\n✗ ${fallos} comprobaciones fallaron\n` : '\n✓ todo en orden\n');
  process.exit(fallos ? 1 : 0);
})();
