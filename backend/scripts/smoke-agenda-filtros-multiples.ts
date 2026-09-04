/**
 * Los filtros de la agenda admiten VARIAS opciones a la vez (2026-09-02).
 *
 * Lo que se prueba no es que el desplegable deje marcar dos, sino las tres cosas
 * que se pueden romper al pasar de un valor a una lista:
 *
 *  1. **Un solo valor sigue dando lo mismo.** Los enlaces guardados y lo que
 *     recuerda la pantalla llevan un valor suelto: si el `OR` nuevo cambiara el
 *     resultado del caso de siempre, la avería se vería en toda la agenda y no en
 *     la novedad.
 *  2. **Marcar dos SUMA, no resta.** Dentro de un filtro las opciones son un `OR`
 *     ("reclamo o incidente"): el resultado tiene que ser exactamente la unión de
 *     las dos por separado, sin repetir ni perder ninguna. Un `AND` mal puesto daría
 *     cero órdenes —una orden no puede ser de dos tipos— y una agenda vacía se lee
 *     como día libre.
 *  3. **La sede sigue siendo una puerta.** La sede no es un filtro más: estrecha el
 *     ALCANCE. Colar una sede ajena ENTRE dos propias tiene que seguir siendo un
 *     403, o la coma se convierte en la rendija por la que se mira otra sede.
 *
 * NO ESCRIBE NADA: sólo lee.
 *
 * Uso: npx ts-node --transpile-only scripts/smoke-agenda-filtros-multiples.ts
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

/** Las órdenes de la bandeja, por id: es la lista que los filtros SÍ recortan. */
const colaDe = (t: any): Set<string> => new Set(t.sinAgendar.map((o: any) => o.id));
const igual = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
const union = (a: Set<string>, b: Set<string>) => new Set([...a, ...b]);

async function main() {
  const hoy = hoyEnColombia().toISOString().slice(0, 10);
  console.log(`\nHoy en Colombia: ${hoy}\n`);

  const admin = await prisma.user.findFirst({
    where: { email: 'prueba.superusuario@vestel.com.co' },
    select: { id: true, name: true, email: true },
  });
  if (!admin) throw new Error('no está el usuario de prueba de superusuario');
  const yo = sesion(admin, ['system.admin']);

  const base = await agenda.tablero(yo, hoy);
  console.log(`  ${base.sinAgendar.length} en la cola · ${base.columnas.length} técnicos · ${base.sedes.length} sedes`);

  // --- 1. Dos tipos = la unión de los dos por separado ------------------------
  console.log('\n1) Marcar dos tipos SUMA');
  const [t1, t2] = base.tipos.slice(0, 2).map((t: any) => t.tipo);
  if (!t2) {
    console.log('  (hay menos de dos tipos en la cola: nada que sumar)');
  } else {
    const [uno, otro, ambos] = await Promise.all([
      agenda.tablero(yo, hoy, { tipo: t1 }),
      agenda.tablero(yo, hoy, { tipo: t2 }),
      agenda.tablero(yo, hoy, { tipo: `${t1},${t2}` }),
    ]);
    assert(igual(colaDe(ambos), union(colaDe(uno), colaDe(otro))),
      `«${t1}» + «${t2}» da exactamente la unión de los dos`,
      { ambos: colaDe(ambos).size, uno: colaDe(uno).size, otro: colaDe(otro).size });
    assert(colaDe(ambos).size >= colaDe(uno).size,
      'y nunca menos que marcar uno solo', { ambos: colaDe(ambos).size, uno: colaDe(uno).size });
    const ajenas = ambos.sinAgendar.filter((o: any) => ![t1, t2].some((t) => t.toLowerCase() === (o.type ?? '').toLowerCase()));
    assert(ajenas.length === 0, 'y no se cuela nada de otro tipo', ajenas.slice(0, 3).map((o: any) => o.type));
    console.log(`  «${t1}» ${colaDe(uno).size} + «${t2}» ${colaDe(otro).size} → ${colaDe(ambos).size}`);
  }

  // --- 2. Un solo valor se comporta igual que siempre -------------------------
  console.log('\n2) Un valor suelto (el enlace guardado) no cambia');
  const soloClase = await agenda.tablero(yo, hoy, { clase: 'servicio' });
  const claseConComaSobrante = await agenda.tablero(yo, hoy, { clase: 'servicio,' });
  assert(igual(colaDe(soloClase), colaDe(claseConComaSobrante)),
    'una coma de más no cambia el resultado',
    { limpio: colaDe(soloClase).size, sucio: colaDe(claseConComaSobrante).size });
  const deOtraClase = soloClase.sinAgendar.filter((o: any) => (o.subject ?? '').toLowerCase() !== 'servicio');
  assert(deOtraClase.length === 0, 'y «servicio» sigue trayendo sólo servicios', deOtraClase.slice(0, 3).map((o: any) => o.subject));

  // --- 3. Estado: "cerradas" son DOS estados y conviven con los otros ---------
  console.log('\n3) Estado: "cerradas" se aplana a RESUELTO + ANULADA');
  const [pend, cerr, mezcla] = await Promise.all([
    agenda.tablero(yo, hoy, { estado: 'PENDIENTE' }),
    agenda.tablero(yo, hoy, { estado: 'cerradas' }),
    agenda.tablero(yo, hoy, { estado: 'PENDIENTE,cerradas' }),
  ]);
  assert(igual(colaDe(mezcla), union(colaDe(pend), colaDe(cerr))),
    'pendientes + cerradas = la unión de las dos',
    { mezcla: colaDe(mezcla).size, pend: colaDe(pend).size, cerr: colaDe(cerr).size });
  const noEsperado = mezcla.sinAgendar.filter((o: any) => !['PENDIENTE', 'RESUELTO', 'ANULADA'].includes(o.status));
  assert(noEsperado.length === 0, 'y no aparece ningún REALIZANDO', noEsperado.slice(0, 3).map((o: any) => o.status));
  // Un valor que no se reconoce se IGNORA, como antes: no vale devolver cero.
  const conBasura = await agenda.tablero(yo, hoy, { estado: 'INVENTADO' });
  assert(igual(colaDe(conBasura), colaDe(base)), 'un estado inventado se ignora, no vacía la cola',
    { conBasura: colaDe(conBasura).size, base: colaDe(base).size });

  // --- 4. La sede: dos sedes son las dos, y una ajena sigue siendo un 403 -----
  console.log('\n4) Sede: suma alcance, pero no abre puertas');
  if (base.sedes.length < 2) {
    console.log('  (menos de dos sedes: nada que comparar)');
  } else {
    const [a, b] = base.sedes.slice(0, 2);
    const [enA, enB, enAmbas] = await Promise.all([
      agenda.tablero(yo, hoy, { sede: a.id }),
      agenda.tablero(yo, hoy, { sede: b.id }),
      agenda.tablero(yo, hoy, { sede: `${a.id},${b.id}` }),
    ]);
    assert(igual(colaDe(enAmbas), union(colaDe(enA), colaDe(enB))),
      `${a.nombre} + ${b.nombre} = la cola de las dos`,
      { ambas: colaDe(enAmbas).size, a: colaDe(enA).size, b: colaDe(enB).size });
    assert(colaDe(enAmbas).size <= colaDe(base).size,
      'y nunca más que sin elegir sede', { ambas: colaDe(enAmbas).size, base: colaDe(base).size });
    assert(enAmbas.sede === `${a.id},${b.id}`, 'la respuesta devuelve las dos elegidas', enAmbas.sede);

    // La puerta: una sede que no existe, colada entre dos buenas.
    let cerro = false;
    try { await agenda.tablero(yo, hoy, { sede: `${a.id},no-existe,${b.id}` }); }
    catch (e: any) { cerro = /acceso a esa sede/i.test(String(e?.message ?? e)); }
    assert(cerro, 'una sede ajena entre dos propias sigue siendo un 403');
  }

  console.log(`\n${fail === 0 ? '✅' : '❌'} ${ok} bien · ${fail} mal\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
