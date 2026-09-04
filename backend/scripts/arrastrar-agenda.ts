/**
 * Pasa al día de HOY lo que quedó sin resolver en días anteriores — a mano.
 *
 * Es la misma operación que hace sola la tarea `agenda-arrastre` cada madrugada
 * (00:05, ver `src/core/tareas.ts`); esto sirve para dos cosas: VER qué se movería
 * antes de que corra, y para el día en que haya que arrastrar fuera de hora —la API
 * estuvo caída de madrugada, se repobló la agenda a mano—.
 *
 *   npx ts-node --transpile-only scripts/arrastrar-agenda.ts            # sólo informe
 *   npx ts-node --transpile-only scripts/arrastrar-agenda.ts --aplicar  # mueve de verdad
 *
 * Sin `--aplicar` no escribe NADA: enseña la lista y se va.
 */

import { PrismaService } from '../src/prisma/prisma.service';
import { arrastrarAlDiaDeHoy, whereArrastrables } from '../src/support/agenda-arrastre';
import { hoyEnColombia } from '../src/common/fecha-colombia';

const APLICAR = process.argv.includes('--aplicar');
const ymd = (d: Date | null | undefined) => d?.toISOString().slice(0, 10) ?? '—';

async function main() {
  const prisma = new PrismaService();
  const hoy = hoyEnColombia();

  const filas = await prisma.ticket.findMany({
    where: whereArrastrables(hoy),
    select: {
      id: true, code: true, status: true, assigned: true,
      scheduledFor: true, carriedFrom: true, scheduledSeq: true,
    },
    orderBy: [{ scheduledFor: 'asc' }, { scheduledSeq: 'asc' }],
  });

  console.log(`Hoy en Colombia: ${ymd(hoy)}`);
  console.log(`Sin resolver de días anteriores: ${filas.length}\n`);
  for (const f of filas) {
    const desde = ymd(f.carriedFrom ?? f.scheduledFor);
    const rodando = f.carriedFrom ? ' (ya venía arrastrada)' : '';
    console.log(
      `  orden ${String(f.code ?? '—').padStart(7)} · ${f.status.padEnd(10)} · del ${desde}${rodando} · ${f.assigned ?? 'sin técnico'}`,
    );
  }

  if (!filas.length) {
    console.log('\nNada que arrastrar: la agenda de ayer quedó cerrada.');
  } else if (!APLICAR) {
    console.log('\nInforme solamente. Para moverlas de verdad: --aplicar');
  } else {
    const r = await arrastrarAlDiaDeHoy(prisma, hoy);
    console.log(
      `\nMovidas ${r.movidas} visitas a ${ymd(hoy)} en ${r.tecnicos} jornada(s)` +
        `${r.masVieja ? `; la más vieja venía del ${r.masVieja}` : ''}.`,
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
