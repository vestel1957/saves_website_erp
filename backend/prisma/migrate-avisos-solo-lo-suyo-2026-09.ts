/**
 * Limpieza de la campanita: que cada quien vea SÓLO lo que le compete (2026-09-04).
 * Idempotente — se puede correr las veces que haga falta.
 *
 * Lo pidió el usuario así: "los técnicos están viendo de todo, debería ser sólo lo
 * que les compete a ellos… si es superusuario pues todas". El código nuevo ya lo
 * dirige bien de aquí en adelante (`alcanzanSede` en el aviso por cargo,
 * `NotificationsService.retirar` en el del técnico), pero lo que la gente TIENE HOY
 * en la campanita se creó con las reglas viejas y no se limpia solo.
 *
 * Tres barridas, en orden de cuánto ruido quitan:
 *
 * 1. **`soporte.orden_automatica`** — el aviso que se retiró el 2026-08-29 por
 *    romper la regla de oro (notificar sólo lo que alguien tiene que HACER): eran
 *    ~38 reconexiones por pago al día que nadie repartía. Ya no se crea, pero
 *    quedaron 1.975 sin leer en 15 campanitas.
 *
 * 2. **`soporte.orden_asignada` de órdenes que ya no son suyas** — la reasignación
 *    no retiraba el aviso del técnico anterior, así que Brayan seguía viendo cuatro
 *    órdenes que hacía días eran de Miguel Ángel. Se compara contra `Ticket.assigned`
 *    de AHORA: si el avisado ya no es el técnico de la orden, sobra.
 *
 * 3. **`soporte.orden_sin_asignar` de otra sede** — salía a las 24 personas con
 *    permiso de agenda, así que la cajera de Mocoa tenía 118 avisos de órdenes de
 *    Villavicencio que ella nunca iba a repartir. Se respeta la semántica de
 *    `sede-scope`: sin sedes marcadas = todas las sedes, y el superusuario nunca
 *    se toca.
 *
 * Correr:  npx ts-node --transpile-only prisma/migrate-avisos-solo-lo-suyo-2026-09.ts [--dry]
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const DRY = process.argv.includes('--dry');

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** Borra por id, o sólo cuenta si va en seco. */
async function borrar(ids: string[], que: string): Promise<number> {
  if (!ids.length) { console.log(`· ${que}: nada que quitar`); return 0; }
  if (DRY) { console.log(`· ${que}: ${ids.length} (SECO, no se borra)`); return ids.length; }
  const r = await prisma.notification.deleteMany({ where: { id: { in: ids } } });
  console.log(`· ${que}: ${r.count} quitados`);
  return r.count;
}

async function main() {
  console.log(DRY ? '— SECO: sólo se cuenta —' : '— borrando de verdad —');

  // 1) El aviso retirado el 2026-08-29 --------------------------------------
  const automaticas = await prisma.notification.findMany({
    where: { kind: 'soporte.orden_automatica' }, select: { id: true },
  });
  const n1 = await borrar(automaticas.map((a) => a.id), 'órdenes automáticas (aviso retirado)');

  // 2) Órdenes que ya no son de quien recibió el aviso ------------------------
  const asignadas = await prisma.notification.findMany({
    where: { kind: 'soporte.orden_asignada' },
    select: { id: true, userId: true, groupKey: true },
  });
  const ticketIds = [...new Set(asignadas.map((a) => a.groupKey?.replace(/^ticket:/, '')).filter((x): x is string => !!x))];
  const tickets = await prisma.ticket.findMany({
    where: { id: { in: ticketIds } }, select: { id: true, assigned: true },
  });
  const tecnicoDe = new Map(tickets.map((t) => [t.id, norm(t.assigned)]));
  // El nombre con el que entra cada avisado, para casarlo con el texto de la orden.
  const usuarios = await prisma.user.findMany({
    where: { id: { in: [...new Set(asignadas.map((a) => a.userId))] } },
    select: { id: true, name: true, email: true },
  });
  const fichas = await prisma.staff.findMany({ select: { name: true, username: true, email: true } });
  const alias = new Map<string, Set<string>>();
  for (const u of usuarios) {
    const suyos = new Set<string>([norm(u.name)]);
    for (const f of fichas) {
      const casa = (f.email && norm(f.email) === norm(u.email)) || norm(f.name) === norm(u.name);
      if (!casa) continue;
      if (f.name) suyos.add(norm(f.name));
      if (f.username) suyos.add(norm(f.username));
    }
    alias.set(u.id, suyos);
  }
  const ajenas = asignadas.filter((a) => {
    const ticketId = a.groupKey?.replace(/^ticket:/, '') ?? '';
    const tec = tecnicoDe.get(ticketId);
    // La orden ya no existe (anulada, borrada): el aviso tampoco tiene a dónde ir.
    if (tec === undefined) return true;
    if (!tec) return true; // se quedó sin técnico
    return !(alias.get(a.userId)?.has(tec) ?? false);
  });
  const n2 = await borrar(ajenas.map((a) => a.id), 'órdenes que ya no son de quien las tiene en la campanita');

  // 3) Órdenes sin asignar de sedes que no le tocan ---------------------------
  const sinAsignar = await prisma.notification.findMany({
    where: { kind: 'soporte.orden_sin_asignar' },
    select: { id: true, userId: true, groupKey: true },
  });
  const idsOrden = [...new Set(sinAsignar.map((a) => a.groupKey?.replace(/^ticket:/, '')).filter((x): x is string => !!x))];
  const conSede = await prisma.ticket.findMany({
    where: { id: { in: idsOrden } },
    select: { id: true, subscriber: { select: { branch: { select: { legacyId: true } } } } },
  });
  const sedeDeOrden = new Map(conSede.map((t) => [t.id, t.subscriber?.branch?.legacyId ?? null]));
  const cuentas = await prisma.user.findMany({
    where: { id: { in: [...new Set(sinAsignar.map((a) => a.userId))] } },
    select: {
      id: true, sedesAccede: true, cajaLegacyId: true,
      roles: { select: { role: { select: { permissions: { select: { permission: { select: { key: true } } } } } } } },
    },
  });
  const cajas = await prisma.cashAccount.findMany({ select: { legacyId: true, branchLegacy: true } });
  const sedeDeCaja = new Map(cajas.map((c) => [c.legacyId, c.branchLegacy && c.branchLegacy > 0 ? c.branchLegacy : null]));
  /** null = sin límite (ve todas las sedes). Misma semántica que `sede-scope`. */
  const sedesDe = new Map<string, number[] | null>();
  for (const c of cuentas) {
    const permisos = c.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.key));
    if (permisos.includes('system.admin')) { sedesDe.set(c.id, null); continue; }
    const marcadas = (c.sedesAccede ?? []).filter((n) => Number.isFinite(n) && n > 0);
    if (marcadas.length) { sedesDe.set(c.id, [...new Set(marcadas)]); continue; }
    // El respaldo por caja asignada, sólo para la cajera pura (igual que allá).
    const mando = ['area.contabilidad', 'area.administracion', 'area.gerencia'].some((m) => permisos.includes(m));
    const cajeraPura = !mando && permisos.includes('area.caja');
    const sede = cajeraPura && c.cajaLegacyId != null ? sedeDeCaja.get(c.cajaLegacyId) ?? null : null;
    sedesDe.set(c.id, sede != null ? [sede] : null);
  }
  const deOtraSede = sinAsignar.filter((a) => {
    const sedes = sedesDe.get(a.userId);
    if (!sedes) return false; // sin límite: le toca todo
    const sede = sedeDeOrden.get(a.groupKey?.replace(/^ticket:/, '') ?? '');
    // Sin sede conocida no se le quita a nadie: quitar por no saber es peor que dejar.
    if (sede == null) return false;
    return !sedes.includes(sede);
  });
  const n3 = await borrar(deOtraSede.map((a) => a.id), 'órdenes sin asignar de otras sedes');

  const quedan = await prisma.notification.groupBy({
    by: ['kind'], _count: { _all: true }, where: { readAt: null },
  });
  console.log(`\nTotal quitados: ${n1 + n2 + n3}`);
  console.log('Sin leer que quedan por tipo:');
  for (const q of quedan.sort((a, b) => b._count._all - a._count._all)) {
    console.log(`  ${q.kind.padEnd(30)} ${q._count._all}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
