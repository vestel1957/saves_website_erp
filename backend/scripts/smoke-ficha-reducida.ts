/**
 * La FICHA REDUCIDA del técnico de paso, contra la BD real y SIN ESCRIBIR NADA.
 *
 * Comprueba lo que se pidió el 2026-09-12 —«todos los clientes tengan la opción de
 * tomar foto a la vivienda»— y, sobre todo, que abrirla no destapó nada más:
 *
 *  1. Al cliente que NO es de sus órdenes el técnico ya no choca con un 403: recibe
 *     la ficha reducida (`limitado: true`).
 *  2. Esa ficha NO lleva teléfono, correo, documento, deuda, facturas, equipos, red,
 *     historial ni notas. Lo que se cerró el 2026-09-10 sigue cerrado.
 *  3. Al cliente de SU orden le sigue saliendo la ficha completa.
 *  4. A quien no es técnico de campo (administración, caja…) no le cambia nada.
 *
 * Sólo lee: ni sube fotos ni toca adjuntos.
 *
 * Uso: npx tsx scripts/smoke-ficha-reducida.ts
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { SubscribersService } from '../src/subscribers/subscribers.service';

const prisma = new PrismaClient();
const subs = new SubscribersService(prisma as any, {} as any, {} as any, {} as any);

let ok = 0, fail = 0;
const assert = (cond: boolean, msg: string, extra: unknown = '') => {
  if (cond) { ok++; console.log(`  OK    ${msg}`); }
  else { fail++; console.log(`  FALLO ${msg}`, extra); }
};

/** Los campos que la ficha reducida NO puede traer, por más que se refactorice. */
const PROHIBIDOS = [
  'phone1', 'phone2', 'email', 'docNumber', 'docType', 'receivable', 'invoices',
  'equipment', 'network', 'statusHistory', 'notes', 'services', 'status',
];

async function main() {
  // Un técnico de campo REAL, con su ficha de empleado y órdenes a su nombre: la
  // regla se casa por correo/nombre, así que inventarse un usuario no probaría nada.
  const staff = await prisma.staff.findFirst({
    where: { banned: false, tickets: { some: { subscriberId: { not: null } } } },
    select: { id: true, name: true, email: true },
  });
  if (!staff) { console.log('No hay técnico con órdenes: nada que probar.'); return; }

  const cuenta = await prisma.user.findFirst({
    where: { isActive: true, OR: [{ email: { equals: staff.email ?? '—', mode: 'insensitive' } }, { name: { equals: staff.name, mode: 'insensitive' } }] },
    select: { id: true, name: true, email: true },
  });
  if (!cuenta) { console.log(`El empleado ${staff.name} no tiene cuenta: nada que probar.`); return; }

  const tecnico = { ...cuenta, permissions: ['area.tecnicos'], roles: [] } as any;
  const jefe = { ...cuenta, id: `${cuenta.id}-jefe`, permissions: ['area.administracion'], roles: [] } as any;
  console.log(`\nTécnico de prueba: ${staff.name} <${staff.email ?? 'sin correo'}>\n`);

  // ── 1. Un cliente SUYO y uno que no lo es ──────────────────────────────────
  const suyo = await prisma.ticket.findFirst({
    where: { assignedStaffId: staff.id, subscriberId: { not: null } },
    select: { subscriberId: true },
  });
  // El ajeno se busca DENTRO de sus sedes: el alcance por sede sigue mandando por
  // encima de todo esto, y elegir un abonado de otra sede haría fallar la prueba por
  // el motivo correcto (403 de sede) sin llegar a mirar lo que se quiere mirar.
  const sedes = (await prisma.user.findUnique({ where: { id: cuenta.id }, select: { sedesAccede: true } }))?.sedesAccede ?? [];
  const ajeno = await prisma.subscriber.findFirst({
    where: {
      tickets: { none: { assignedStaffId: staff.id } },
      ...(sedes.length ? { branch: { legacyId: { in: sedes } } } : {}),
    },
    select: { id: true, abonado: true },
  });
  if (!suyo?.subscriberId || !ajeno) { console.log('Faltan clientes para comparar.'); return; }

  assert(await subs.fichaLimitada(tecnico, ajeno.id), 'el cliente ajeno le sale REDUCIDO (antes: 403)');
  assert(!(await subs.fichaLimitada(tecnico, suyo.subscriberId)), 'el cliente de su orden le sale COMPLETO');
  assert(!(await subs.fichaLimitada(jefe, ajeno.id)), 'a administración no se le acota nada');

  // ── 2. Lo que la ficha reducida enseña, y lo que NO ────────────────────────
  const reducida: Record<string, unknown> = await subs.fichaReducida(ajeno.id, tecnico);
  console.log(`\n  Abonado ${reducida.abonado} · ${reducida.name} · ${reducida.address ?? 'sin dirección'}\n`);
  assert(reducida.limitado === true, 'viene marcada como limitada (la pantalla se pinta reducida)');
  assert(Boolean(reducida.name), 'trae el nombre: hay que saber de quién es la casa');
  assert('address' in reducida, 'trae la dirección: es lo que dice si es la casa correcta');
  const destapados = PROHIBIDOS.filter((k) => k in reducida);
  assert(destapados.length === 0, 'no destapa nada de lo que se cerró el 2026-09-10', destapados);

  console.log(`\n${fail === 0 ? 'TODO BIEN' : 'HAY FALLOS'} — ${ok} ok, ${fail} fallos\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().finally(() => prisma.$disconnect());
