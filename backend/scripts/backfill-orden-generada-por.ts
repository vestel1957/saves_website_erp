/**
 * Rellena QUIÉN GENERÓ las órdenes que ya existían.
 *
 * Desde 2026-08-28 toda orden nace firmada (`createdByName` / `createdById` /
 * `createdBySource`, ver `src/support/autor-orden.ts`). Lo anterior —321.000
 * órdenes— sólo tiene `col`, la columna del legacy, que guarda el *username* de
 * quien la abrió allá ('SoniaCajera'). Este script la traduce a nombre de persona
 * cruzándola con `Staff.username`, que es el mismo censo que usa `nombre-tecnico.ts`
 * para el técnico asignado.
 *
 * Qué escribe, y sólo donde `createdBySource` está vacío (es idempotente y no repisa
 * lo que ya se selló al crear):
 *   · `createdByName`   nombre completo del funcionario, o el texto crudo si su ficha
 *                       ya no existe (hay usernames de gente que se fue: dejar la
 *                       orden sin autor sería peor que mostrar el texto).
 *   · `createdBySource` LEGACY si la orden vino del sistema viejo · SISTEMA si la
 *                       abrió un proceso automático ('Sistema') · CHATBOT si la abrió
 *                       el bot · USUARIO si nació aquí a nombre de una persona.
 *   · `createdById`     el id de su `User`, cuando la cuenta existe (cruce por correo
 *                       y por nombre, insensible a mayúsculas). Es lo que permite
 *                       enlazar a quien la generó; queda null si no hay cuenta.
 *
 * Las 135.153 órdenes que nacieron con `col` VACÍO se quedan sin autor a propósito:
 * ese dato no existe en ningún lado, y ponerles "Sistema" sería inventarlo.
 *
 *   npx ts-node scripts/backfill-orden-generada-por.ts             → sólo enseña qué haría
 *   npx ts-node scripts/backfill-orden-generada-por.ts --aplicar   → escribe
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APLICAR = process.argv.includes('--aplicar');
const LOTE = 5_000;

const llave = (s: string) => s.trim().toLowerCase();


async function main() {
  const staff = await prisma.staff.findMany({ select: { username: true, name: true } });
  const nombrePorClave = new Map<string, string>();
  // Los dos censos van SEPARADOS porque es lo que distingue dónde nació la orden:
  // el legacy escribe en `col` el *username* ('SoniaCajera') y nexus el nombre de
  // pantalla del funcionario ('Sonia Barreto'). Sin esa distinción, las órdenes
  // abiertas aquí y empujadas al legacy —que ya tienen `legacyId`— quedaban
  // rotuladas "sistema anterior" en la ficha, que es justo lo contrario.
  const porUsername = new Set<string>();
  const porNombre = new Set<string>();
  for (const s of staff) {
    const nombre = s.name?.trim();
    if (!nombre) continue;
    const u = llave(String(s.username ?? ''));
    if (u) { porUsername.add(u); if (!nombrePorClave.has(u)) nombrePorClave.set(u, nombre); }
    const n = llave(nombre);
    if (n) { porNombre.add(n); if (!nombrePorClave.has(n)) nombrePorClave.set(n, nombre); }
  }

  // La cuenta con login de quien la abrió. `User` y `Staff` no tienen FK entre sí
  // (se cruzan por correo, ver `permisos-empleado-ficha`), así que aquí se indexa el
  // usuario por su correo Y por su nombre: el `col` de las órdenes nacidas en nexus
  // guarda el nombre de pantalla, no el username del legacy.
  const users = await prisma.user.findMany({ select: { id: true, name: true, email: true } });
  const userPorClave = new Map<string, string>();
  for (const u of users) {
    for (const clave of [u.email, u.name]) {
      const k = llave(String(clave ?? ''));
      if (k && !userPorClave.has(k)) userPorClave.set(k, u.id);
    }
  }

  const where = { createdBySource: null, NOT: { col: null }, col: { not: '' } };
  const total = await prisma.ticket.count({ where });
  const sinAutor = await prisma.ticket.count({ where: { createdBySource: null, OR: [{ col: null }, { col: '' }] } });
  console.log(`Órdenes por firmar: ${total.toLocaleString('es-CO')}`);
  console.log(`Órdenes que nacieron sin autor (se quedan así): ${sinAutor.toLocaleString('es-CO')}`);
  if (!total) return;

  // Reparto por autor ANTES de escribir: así se ve si un username no está cruzando
  // con ninguna ficha —y se ve cuántas órdenes se quedarían con el texto crudo—.
  const porAutor = await prisma.ticket.groupBy({ by: ['col'], where, _count: { _all: true } });
  const resumen = porAutor
    .map((a) => {
      const col = (a.col ?? '').trim();
      const k = llave(col);
      const nombre = nombrePorClave.get(k) ?? col;
      // `origen` fijo cuando el propio texto lo dice; null = "no se sabe por el
      // texto" y entonces lo decide `legacyId` fila a fila, en el SQL.
      const origen: 'SISTEMA' | 'CHATBOT' | 'USUARIO' | 'LEGACY' | null =
        k === 'sistema' ? 'SISTEMA'
        : k.startsWith('bot ') ? 'CHATBOT'
        : porUsername.has(k) ? 'LEGACY'
        : porNombre.has(k) || userPorClave.has(k) ? 'USUARIO'
        : null;
      return { col, nombre, origen, cruza: nombrePorClave.has(k), ordenes: a._count._all };
    })
    .sort((x, y) => y.ordenes - x.ordenes);
  console.table(
    resumen.slice(0, 30).map((r) => ({
      'col': r.col,
      'Queda como': r.nombre,
      Origen: r.origen ?? 'según la orden',
      Ficha: r.cruza ? 'sí' : '— (sin ficha)',
      Órdenes: r.ordenes.toLocaleString('es-CO'),
    })),
  );
  const sinFicha = resumen.filter((r) => !r.cruza).reduce((s, r) => s + r.ordenes, 0);
  if (sinFicha) console.log(`${sinFicha.toLocaleString('es-CO')} órdenes quedan con el texto crudo (su ficha ya no existe).`);

  if (!APLICAR) {
    console.log('\nSimulación. Nada se escribió. Añade --aplicar para hacerlo de verdad.');
    return;
  }

  // Un UPDATE por autor (son ~120), en lotes por id: nada de 321.000 idas y vueltas
  // ni de una transacción que bloquee la tabla mientras el resto sigue trabajando.
  // El `createdBySource IS NULL` del WHERE es lo que lo hace idempotente: si se corta
  // a la mitad, volver a lanzarlo sigue por donde iba.
  let escritas = 0;
  for (const { col, nombre, origen } of resumen) {
    // El id de usuario sólo tiene sentido si la abrió una persona desde aquí: en las
    // del legacy `col` es un username de allá, y no toda ficha tiene cuenta.
    const userId = origen === 'USUARIO' ? (userPorClave.get(llave(col)) ?? null) : null;
    for (;;) {
      // Cuando el texto no dice de dónde salió (un username de alguien cuya ficha ya
      // no existe), lo decide `legacyId` fila a fila: la misma persona abrió órdenes
      // en los dos sistemas.
      const n = await prisma.$executeRaw`
        UPDATE "Ticket"
           SET "createdByName" = ${nombre},
               "createdById" = CASE WHEN "legacyId" IS NULL THEN ${userId} ELSE NULL END,
               "createdBySource" = COALESCE(
                 ${origen}::text,
                 CASE WHEN "legacyId" IS NOT NULL THEN 'LEGACY' ELSE 'USUARIO' END
               )
         WHERE id IN (
           SELECT id FROM "Ticket"
            WHERE col = ${col} AND "createdBySource" IS NULL
            LIMIT ${LOTE}
         )`;
      if (!n) break;
      escritas += n;
      if (escritas % 50_000 < LOTE) console.log(`  ${escritas.toLocaleString('es-CO')} / ${total.toLocaleString('es-CO')}…`);
    }
  }

  const porOrigen = await prisma.ticket.groupBy({ by: ['createdBySource'], _count: { _all: true } });
  console.log(`\nListo: ${escritas.toLocaleString('es-CO')} órdenes firmadas.`);
  console.table(porOrigen.map((o) => ({ Origen: o.createdBySource ?? '(sin autor)', Órdenes: o._count._all.toLocaleString('es-CO') })));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
