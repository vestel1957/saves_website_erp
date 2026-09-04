/**
 * Rellena QUIÉN CREÓ las tareas que ya estaban en la tabla.
 *
 * Desde hoy toda tarea nace firmada (`createdByName` / `createdById` /
 * `createdBySource`, ver `src/support/autor-orden.ts`). Lo que ya existe viene del
 * legacy (`todolist`) y sólo trae `eid`: se traduce contra el censo de empleados
 * (`Staff.legacyId`) y se marca como LEGACY, que es de donde salió.
 *
 * Las que tienen `eid = 0` se quedan sin autor a propósito: ese dato no existe, y
 * ponerles "Sistema" sería inventarse que las abrió un proceso automático. Las que
 * apuntan a una cuenta que el legacy ya borró (16 eids, 2.148 tareas) sí se marcan
 * LEGACY sin nombre: de dónde salieron se sabe, quién las escribió ya no.
 *
 * Es idempotente: sólo escribe donde `createdBySource` está vacío.
 *
 *   npx ts-node scripts/backfill-tarea-creada-por.ts             → sólo enseña qué haría
 *   npx ts-node scripts/backfill-tarea-creada-por.ts --aplicar   → escribe
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APLICAR = process.argv.includes('--aplicar');

async function main() {
  const tareas = await prisma.todoTask.findMany({
    where: { createdBySource: null },
    select: { id: true, employeeId: true },
  });
  if (!tareas.length) {
    console.log('No hay tareas sin autor: nada que hacer.');
    return;
  }

  const eids = [...new Set(tareas.map((t) => t.employeeId).filter((n) => n > 0))];
  const staff = await prisma.staff.findMany({
    where: { legacyId: { in: eids } },
    select: { legacyId: true, name: true },
  });
  const nombre = new Map(staff.map((s) => [s.legacyId!, s.name]));

  let conAutor = 0;
  let sinFicha = 0;
  let sinEid = 0;
  const porNombre = new Map<string, string[]>();
  /** Su `eid` ya no existe en el legacy: se sabe de dónde salieron, no quién las hizo. */
  const huerfanas: string[] = [];

  for (const t of tareas) {
    if (!t.employeeId) { sinEid++; continue; }
    const n = nombre.get(t.employeeId);
    if (!n) { sinFicha++; huerfanas.push(t.id); continue; }
    conAutor++;
    const lista = porNombre.get(n) ?? [];
    lista.push(t.id);
    porNombre.set(n, lista);
  }

  console.log(`Tareas sin autor: ${tareas.length}`);
  console.log(`  · con empleado reconocido: ${conAutor} (${porNombre.size} personas)`);
  console.log(`  · con eid que ya no existe en el legacy (LEGACY sin nombre): ${sinFicha}`);
  console.log(`  · sin eid (ese dato no existe): ${sinEid}`);

  if (!APLICAR) {
    console.log('\nEnsayo. Vuelve a lanzarlo con --aplicar para escribir.');
    return;
  }

  for (const [n, ids] of porNombre) {
    // En bloques: son decenas de miles de filas y un IN gigante no cabe.
    for (let i = 0; i < ids.length; i += 1000) {
      await prisma.todoTask.updateMany({
        where: { id: { in: ids.slice(i, i + 1000) } },
        data: { createdByName: n, createdBySource: 'LEGACY' },
      });
    }
  }
  for (let i = 0; i < huerfanas.length; i += 1000) {
    await prisma.todoTask.updateMany({
      where: { id: { in: huerfanas.slice(i, i + 1000) } },
      data: { createdBySource: 'LEGACY' },
    });
  }
  console.log(`\nFirmadas ${conAutor} tareas como LEGACY con nombre y ${huerfanas.length} sin él.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
