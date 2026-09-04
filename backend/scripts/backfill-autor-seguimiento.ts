/**
 * Rellena QUIÉN DOCUMENTÓ lo que ya está escrito en el hilo de las órdenes.
 *
 * Desde hoy cada renglón del seguimiento nace firmado (`authorName` / `authorId`,
 * ver `src/support/autor-orden.ts`). Lo escrito antes desde el ERP entró con
 * `employeeId: 0` —el hueco del legacy para "sin empleado"— y la ficha lo pinta
 * como "Sistema", aunque lo hubiera escrito el técnico que estaba en la casa.
 *
 * De dónde sale el autor: de la bitácora (`AuditLog`), que sí guardó quién llamó a
 * `POST /support/tickets/<id>/thread` y `.../attach` y a qué hora. Se casa cada
 * renglón con la petición de SU MISMA orden más cercana en el tiempo, dentro de una
 * ventana corta, y sólo cuando esa ventana señala a UNA sola persona: si dos
 * funcionarios documentaron la misma orden en el mismo minuto, el renglón se queda
 * sin autor. Aquí no se adivina — "Sistema" es feo, pero atribuirle a alguien una
 * documentación que no escribió es peor.
 *
 * Las notas que de verdad escribió el sistema (material consumido, cascada de
 * cierre, provisión de la ONU) no tienen petición que las respalde y se quedan como
 * están, que es lo correcto.
 *
 * Es idempotente: sólo escribe donde `authorName` está vacío.
 *
 *   npx ts-node scripts/backfill-autor-seguimiento.ts             → sólo enseña qué haría
 *   npx ts-node scripts/backfill-autor-seguimiento.ts --aplicar   → escribe
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APLICAR = process.argv.includes('--aplicar');

/** Cuánto puede separar al renglón guardado de la petición que lo guardó. */
const VENTANA_MS = 60_000;

async function main() {
  // Candidatos: lo que se escribió AQUÍ (sin `legacyId`), sin autor y sin eid.
  const hilos = await prisma.ticketThread.findMany({
    where: { legacyId: null, authorName: null, employeeId: 0 },
    select: { id: true, ticketCode: true, date: true, message: true },
    orderBy: { date: 'asc' },
  });
  if (!hilos.length) return console.log('No hay seguimientos sin autor.');

  // `TicketThread` cuelga del NÚMERO de orden y la bitácora del id de la fila: hace
  // falta el puente para saber qué petición tocó qué renglón.
  const codigos = [...new Set(hilos.map((h) => h.ticketCode))];
  const tickets = await prisma.ticket.findMany({ where: { code: { in: codigos } }, select: { id: true, code: true } });
  const codePorTicket = new Map(tickets.map((t) => [t.id, t.code]));

  const auditorias = await prisma.auditLog.findMany({
    where: { entity: 'support/tickets', userId: { not: null }, OR: [{ action: { endsWith: '/thread' } }, { action: { endsWith: '/attach' } }] },
    select: { action: true, userId: true, createdAt: true, user: { select: { name: true, email: true } } },
    orderBy: { createdAt: 'asc' },
  });

  // Bitácora agrupada por número de orden.
  const porCodigo = new Map<number, { userId: string; nombre: string; cuando: Date }[]>();
  for (const a of auditorias) {
    const ticketId = a.action.split('/').at(-2) ?? '';
    const code = codePorTicket.get(ticketId);
    if (code == null || !a.userId) continue;
    const nombre = a.user?.name?.trim() || a.user?.email?.trim();
    if (!nombre) continue;
    const lista = porCodigo.get(code) ?? [];
    lista.push({ userId: a.userId, nombre, cuando: a.createdAt });
    porCodigo.set(code, lista);
  }

  const cambios: { id: string; authorName: string; authorId: string }[] = [];
  let ambiguos = 0;
  let sinRastro = 0;
  for (const h of hilos) {
    const cerca = (porCodigo.get(h.ticketCode) ?? []).filter((a) => Math.abs(a.cuando.getTime() - h.date.getTime()) <= VENTANA_MS);
    if (!cerca.length) { sinRastro++; continue; }
    const personas = new Set(cerca.map((a) => a.userId));
    if (personas.size > 1) { ambiguos++; continue; }
    cambios.push({ id: h.id, authorName: cerca[0].nombre, authorId: cerca[0].userId });
  }

  console.log(`Seguimientos sin autor: ${hilos.length}`);
  console.log(`  · con autor recuperable: ${cambios.length}`);
  console.log(`  · sin petición que los respalde (notas del sistema): ${sinRastro}`);
  console.log(`  · con dos personas en la misma ventana (se dejan sin autor): ${ambiguos}`);
  for (const c of cambios.slice(0, 10)) console.log(`    ${c.id} → ${c.authorName}`);

  if (!APLICAR) return console.log('\nSeco. Vuelve a correrlo con --aplicar para escribir.');
  for (const c of cambios) {
    await prisma.ticketThread.update({ where: { id: c.id }, data: { authorName: c.authorName, authorId: c.authorId } });
  }
  console.log(`\nEscritos ${cambios.length} seguimientos.`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
