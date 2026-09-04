/**
 * El TABLERO de la semana, contra la BD real (2026-08-26).
 *
 * Comprueba las cuatro promesas de la reescritura al modelo de netrix, que son
 * justamente las cuatro formas que tiene esta pantalla de mentir:
 *
 *  1. El TEXTO libre no recorta la rejilla —la atenúa la pantalla— pero SÍ recorta
 *     la cola. Si recortara la rejilla quedarían casillas vacías que no lo están, y
 *     una casilla vacía se lee como carga libre.
 *  2. Los filtros ESTRUCTURALES (clase, tipo, prioridad, estado) sí recortan la
 *     rejilla, y aun así la CARGA de cada casilla sigue siendo la real.
 *  3. `despues` cuenta lo que hay MÁS ALLÁ del tramo y su primera fecha cae fuera:
 *     una fila con quince visitas en septiembre no puede leerse como semana tranquila.
 *  4. `fuera` sólo trae órdenes ABIERTAS, CON técnico y con día fuera del tramo — es
 *     la respuesta a "¿y esta de quién es?" cuando la orden no está en la semana.
 *
 * Y una quinta que no es de la pantalla sino de la puerta: el alcance por SEDE. Un
 * usuario acotado no puede ver más técnicos que uno sin límite.
 *
 * NO ESCRIBE NADA: sólo lee. El que sí escribe (y revierte) es
 * `smoke-agenda-calendario.ts`.
 *
 * Uso: npx ts-node --transpile-only scripts/smoke-agenda-tablero.ts
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { BusDeEventos } from '../src/core/eventos';
import { RoutingService } from '../src/geo/routing.service';
import { AgendaService } from '../src/support/agenda.service';
import { hoyEnColombia } from '../src/common/fecha-colombia';

const prisma = new PrismaClient();
const bus = new BusDeEventos();
const agenda = new AgendaService(prisma as any, bus, new RoutingService());

let ok = 0, fail = 0;
const assert = (cond: boolean, msg: string, extra: unknown = '') => {
  if (cond) { ok++; console.log(`  OK    ${msg}`); }
  else { fail++; console.log(`  FALLO ${msg}`, extra); }
};
const sesion = (u: { id: string; name: string; email: string }, permisos: string[]) =>
  ({ ...u, permissions: permisos, roles: [] }) as any;
const masDias = (ymd: string, n: number) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
/** Cuántas tarjetas hay pintadas en la rejilla entera. */
const enRejilla = (s: any) =>
  s.columnas.reduce(
    (t: number, c: any) => t + s.dias.reduce((u: number, d: string) => u + (c.dias[d]?.ordenes.length ?? 0), 0),
    0,
  );

async function main() {
  const hoy = hoyEnColombia().toISOString().slice(0, 10);
  const lunes = masDias(hoy, -((new Date(`${hoy}T00:00:00Z`).getUTCDay() + 6) % 7));
  const domingo = masDias(lunes, 6);
  console.log(`\nHoy en Colombia: ${hoy} · semana ${lunes} → ${domingo}\n`);

  const admin = await prisma.user.findFirst({
    where: { email: 'prueba.superusuario@vestel.com.co' },
    select: { id: true, name: true, email: true },
  });
  if (!admin) throw new Error('no está el usuario de prueba de superusuario');
  const yo = sesion(admin, ['system.admin']);

  const base = await agenda.semana(yo, lunes, 7);
  const enBase = enRejilla(base);
  console.log(`  ${enBase} visitas en la rejilla · ${base.sinAgendarTotal} sin repartir · ${base.columnas.length} técnicos`);

  // --- 1. El texto NO recorta la rejilla; sí la cola --------------------------
  console.log('\n1) El texto libre atenúa, no esconde');
  // Se busca por el cliente de una tarjeta que de verdad esté puesta en la rejilla:
  // un texto inventado no probaría nada (no coincidiría con ninguna).
  let muestra: any = null;
  for (const c of base.columnas) {
    for (const d of base.dias) {
      const o = (c.dias as any)[d]?.ordenes?.[0];
      if (o?.cliente && o.cliente.trim().length > 4) { muestra = o; break; }
    }
    if (muestra) break;
  }
  if (!muestra) {
    console.log('  (la semana está vacía: nada que buscar)');
  } else {
    const texto = muestra.cliente.trim().split(/\s+/)[0];
    const conTexto = await agenda.semana(yo, lunes, 7, { q: texto } as any);
    assert(conTexto.q === texto, 'devuelve el texto buscado para que la pantalla atenúe', conTexto.q);
    assert(enRejilla(conTexto) === enBase, 'la rejilla trae las MISMAS tarjetas con texto puesto', {
      con: enRejilla(conTexto), sin: enBase,
    });
    assert(
      conTexto.sinAgendar.length <= base.sinAgendar.length,
      'la cola sí se recorta con el texto',
      { con: conTexto.sinAgendar.length, sin: base.sinAgendar.length },
    );
    assert(conTexto.filtrando === true, 'y se reporta como "filtrando"');
    console.log(`  buscando «${texto}» · rejilla ${enRejilla(conTexto)} (igual) · cola ${conTexto.sinAgendar.length} de ${base.sinAgendar.length}`);
  }

  // --- 2. Los filtros estructurales SÍ recortan -------------------------------
  console.log('\n2) Los filtros estructurales recortan la rejilla');
  const tipoUsado = base.tipos[0]?.tipo;
  if (!tipoUsado) {
    console.log('  (no hay tipos: nada que filtrar)');
  } else {
    const conTipo = await agenda.semana(yo, lunes, 7, { tipo: tipoUsado } as any);
    const pintadas = enRejilla(conTipo);
    assert(pintadas <= enBase, `filtrar por «${tipoUsado}» no puede AÑADIR tarjetas`, { pintadas, enBase });
    let mal = 0;
    for (const c of conTipo.columnas) {
      for (const d of conTipo.dias) {
        for (const o of ((c.dias as any)[d]?.ordenes ?? [])) {
          if ((o.type || '').toLowerCase() !== tipoUsado.toLowerCase()) mal++;
        }
      }
    }
    assert(mal === 0, 'y todo lo que queda es de ese tipo', mal);
    // La carga es la del técnico, no la de lo que se está mirando: un contador que
    // baja al filtrar es justo el dato con el que se reparte mal la semana.
    let cargaMenor = 0;
    for (const c of conTipo.columnas) {
      const antes = base.columnas.find((x) => x.staffId === c.staffId);
      if (!antes) continue;
      for (const d of conTipo.dias) {
        if (((c.dias as any)[d]?.total ?? 0) !== ((antes.dias as any)[d]?.total ?? 0)) cargaMenor++;
      }
    }
    assert(cargaMenor === 0, 'la CARGA de cada casilla no cambia al filtrar', cargaMenor);
    console.log(`  «${tipoUsado}»: ${pintadas} de ${enBase} tarjetas a la vista, cargas intactas`);
  }

  // --- 3. Lo que cae DESPUÉS del domingo --------------------------------------
  console.log('\n3) "+N desde el …": lo de más allá del tramo');
  let filasConDespues = 0, primeraMal = 0, cuentaMal = 0;
  for (const c of base.columnas) {
    const dsp = (c as any).despues;
    assert(dsp != null, `la fila de ${c.nombre} trae 'despues'`);
    if (!dsp?.cuantas) continue;
    filasConDespues++;
    if (!dsp.primera || dsp.primera <= domingo) primeraMal++;
    const real = await prisma.ticket.count({
      where: {
        assignedStaffId: c.staffId,
        status: { in: ['PENDIENTE', 'REALIZANDO'] },
        scheduledFor: { gt: new Date(`${domingo}T00:00:00Z`) },
      },
    });
    if (real !== dsp.cuantas) cuentaMal++;
  }
  assert(primeraMal === 0, 'la primera fecha de "después" cae fuera de la semana', primeraMal);
  assert(cuentaMal === 0, 'y la cuenta cuadra con la base', cuentaMal);
  console.log(`  ${filasConDespues} de ${base.columnas.length} técnicos tienen trabajo más allá del domingo`);

  // --- 4. "¿Y esta de quién es?" ----------------------------------------------
  console.log('\n4) Las coincidencias que caen FUERA de la semana');
  assert(Array.isArray(base.fuera), "sin filtro, 'fuera' viene vacío", base.fuera.length);
  assert(base.fuera.length === 0, 'sin filtro no se busca nada fuera', base.fuera.length);
  // Una orden abierta, con técnico y agendada más allá del domingo: es el caso que
  // la rejilla no puede enseñar.
  let lejana = await prisma.ticket.findFirst({
    where: {
      assignedStaffId: { not: null },
      status: { in: ['PENDIENTE', 'REALIZANDO'] },
      scheduledFor: { gt: new Date(`${domingo}T00:00:00Z`) },
      code: { not: null },
    },
    select: { id: true, code: true, assigned: true, scheduledFor: true },
  });
  /*
   * Si la base no tiene ninguna, se FABRICA una: se agenda una orden de la cola para
   * dentro de tres semanas, se comprueban las dos cosas y se deja como estaba. Sin
   * esto, en una base tranquila los dos casos nuevos pasaban sin ejecutarse nunca —
   * que es el peor resultado posible de una prueba: verde y sin haber mirado.
   */
  let postiza: { id: string; antes: any } | null = null;
  if (!lejana?.code && base.sinAgendar.length && base.columnas.length) {
    const c: any = base.sinAgendar[0];
    const antes = await prisma.ticket.findUnique({
      where: { id: c.id },
      select: {
        code: true, scheduledFor: true, scheduledSeq: true, scheduledById: true, scheduledByName: true,
        scheduledAt: true, assignedStaffId: true, assigned: true, assignedAt: true, editedAt: true, editedBy: true,
      },
    });
    if (antes?.code) {
      const lejos = masDias(domingo, 21);
      console.log(`  (no había ninguna: se agenda #${antes.code} a ${base.columnas[0].nombre} el ${lejos} y se revierte)`);
      await agenda.mover(yo, { ticketId: c.id, staffId: base.columnas[0].staffId, fecha: lejos });
      postiza = { id: c.id, antes };
      lejana = await prisma.ticket.findUnique({
        where: { id: c.id },
        select: { id: true, code: true, assigned: true, scheduledFor: true },
      });
    }
  }

  if (!lejana?.code) {
    console.log('  (no hay ninguna orden abierta agendada más allá del domingo, ni cola para fabricarla)');
  } else {
    const buscada = await agenda.semana(yo, lunes, 7, { q: String(lejana.code) } as any);
    const salio = buscada.fuera.find((o: any) => o.id === lejana.id);
    assert(!!salio, `la orden #${lejana.code} sale en 'fuera'`, buscada.fuera.map((o: any) => o.code));
    if (salio) {
      assert(!!salio.tecnico, 'y dice de quién es', salio.tecnico);
      assert(
        String(salio.agendadaPara).slice(0, 10) > domingo,
        'y para qué día, que está fuera de la semana',
        salio.agendadaPara,
      );
      console.log(`  #${lejana.code} → ${salio.tecnico} · ${String(salio.agendadaPara).slice(0, 10)}`);
    }
    let dentro = 0;
    for (const o of buscada.fuera as any[]) {
      const d = String(o.agendadaPara).slice(0, 10);
      if (d >= lunes && d <= domingo) dentro++;
    }
    assert(dentro === 0, "nada de 'fuera' está en realidad dentro de la semana", dentro);
  }

  // Con la orden postiza puesta, la fila de su técnico TIENE que contarla.
  if (postiza) {
    const conPostiza = await agenda.semana(yo, lunes, 7);
    const fila: any = conPostiza.columnas.find((c) => c.staffId === base.columnas[0].staffId);
    assert((fila?.despues?.cuantas ?? 0) >= 1, 'la fila del técnico cuenta la de más allá del domingo', fila?.despues);
    assert(
      !!fila?.despues?.primera && fila.despues.primera > domingo,
      'con su primera fecha, fuera de la semana',
      fila?.despues,
    );
    // Y se deja como estaba: agendarle a un técnico una visita de verdad es trabajo
    // que alguien iría a hacer.
    await prisma.ticket.update({ where: { id: postiza.id }, data: { ...postiza.antes, code: undefined } });
    const vuelta = await prisma.ticket.findUnique({
      where: { id: postiza.id },
      select: { scheduledFor: true, assignedStaffId: true },
    });
    assert(
      vuelta?.scheduledFor?.getTime() === postiza.antes.scheduledFor?.getTime() &&
        vuelta?.assignedStaffId === postiza.antes.assignedStaffId,
      'la orden de prueba vuelve a quedar como estaba',
      vuelta,
    );
  }

  // --- 5. El alcance por sede -------------------------------------------------
  console.log('\n5) Sedes: el acotado no ve más técnicos que el que no lo está');
  const cajera = await prisma.user.findFirst({
    where: { sedesAccede: { isEmpty: false }, isActive: true },
    select: { id: true, name: true, email: true, sedesAccede: true },
  });
  if (!cajera) {
    console.log('  (no hay ningún usuario acotado a sedes)');
  } else {
    const suya = await agenda.semana(sesion(cajera, []), lunes, 7);
    assert(
      suya.columnas.length <= base.columnas.length,
      `${cajera.email} (sedes ${cajera.sedesAccede.join(',')}) no ve más técnicos que el superusuario`,
      { acotado: suya.columnas.length, sinLimite: base.columnas.length },
    );
    console.log(`  ${cajera.email}: ${suya.columnas.length} técnicos · superusuario: ${base.columnas.length}`);
  }

  console.log(`\n${ok} OK · ${fail} fallos\n`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
