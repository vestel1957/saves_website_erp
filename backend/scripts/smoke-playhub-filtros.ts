/**
 * Smoke de los FILTROS del reporte de PlayHub.
 *
 *   npm run smoke:playhub-filtros
 *
 * Corre contra la base de VERDAD y sólo LEE: el reporte es una consulta.
 *
 * Lo que se está cuidando es que los números signifiquen lo que dicen. Los filtros
 * viejos (los "pills") mezclaban unidades —cuentas, apps y suscripciones por
 * producto— sobre una tabla que lista CUENTAS, así que el número del botón no
 * coincidía con las filas que salían. Ahora:
 *
 *   1. el estado reparte el total sin solaparse: Cumplen + Por limpiar + Solo
 *      cuenta = Todas;
 *   2. cada cuenta cae en UNA opción de plan, así que las opciones de plan suman
 *      el total;
 *   3. los filtros se combinan (300 Megas Y Premium plus), cosa que antes era
 *      imposible: los pills eran excluyentes;
 *   4. los conteos de cada filtro se calculan dejando fuera ese mismo filtro, que
 *      es lo que permite seguir viendo las otras opciones después de marcar una;
 *   5. la pregunta del día —"los clientes de 300 Megas que tengan PlayHub"— da
 *      exactamente eso: todos con ese plan, todos con apps, ninguno por limpiar.
 */
import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { ExtrasService } from '../src/extras/extras.service';
import type { PrismaService } from '../src/prisma/prisma.service';

const prisma = new PrismaClient();
const extras = new ExtrasService(prisma as unknown as PrismaService);

let fallos = 0;
function check(ok: boolean, texto: string) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${texto}`);
  if (!ok) fallos++;
}

/** Sin usuario = sin recorte por sede: el smoke mira el reporte entero. */
const pedir = (p: Parameters<ExtrasService['playhub']>[1] = {}) =>
  extras.playhub(undefined, { pageSize: 100, ...p });

async function main() {
  const base = await pedir();
  const e = base.facetas.estado;
  console.log(`\nReporte: ${base.cuentas} cuentas · ${base.apps} apps en uso (mínimo ${base.minMegas} Megas)`);
  console.log(`Estado: cumplen ${e.cumple} · por limpiar ${e.limpiar} · solo cuenta ${e.solo}`);
  console.log(`Planes: ${base.facetas.megas.map((o) => `${o.label}=${o.count}`).join(' · ')}`);
  console.log(`Niveles: ${base.facetas.nivel.map((o) => `${o.label}=${o.count}`).join(' · ')}`);

  console.log('\n1) El estado reparte el total sin solaparse');
  check(e.cumple + e.limpiar + e.solo === e.todas, `${e.cumple} + ${e.limpiar} + ${e.solo} = ${e.todas}`);
  check(e.todas === base.cuentas, 'sin filtros, "Todas" es el total de cuentas');
  check(base.total === base.cuentas, 'sin filtros no se recorta nada');

  console.log('\n2) Cada cuenta cae en un solo plan');
  const sumaPlanes = base.facetas.megas.reduce((n, o) => n + o.count, 0);
  check(sumaPlanes === base.cuentas, `las opciones de plan suman ${sumaPlanes} = ${base.cuentas} cuentas`);
  check(
    base.facetas.megas.every((o, i, xs) => i === 0 || Number(xs[i - 1].value) > Number(o.value)),
    'los planes van de mayor a menor',
  );
  check(
    base.facetas.megas.filter((o) => o.bajo).every((o) => Number(o.value) < base.minMegas),
    'sólo se marcan como bajos los que no llegan al mínimo',
  );

  console.log('\n3) Los estados significan lo que dicen');
  const limpiar = await pedir({ estado: 'limpiar' });
  check(limpiar.total === e.limpiar, `"Por limpiar" devuelve ${limpiar.total} filas, las mismas del contador`);
  check(
    limpiar.items.every((r) => r.total > 0 && !r.elegible),
    'todas tienen apps y ninguna cumple el mínimo (o no es de un cliente)',
  );
  const solo = await pedir({ estado: 'solo' });
  check(solo.items.every((r) => r.total === 0), '"Solo cuenta" son las que no tienen ninguna app');

  console.log('\n4) La pregunta del día: los de 300 Megas que tengan PlayHub');
  const hay300 = base.facetas.megas.some((o) => o.value === '300');
  const con300 = await pedir({ megas: ['300'], estado: 'cumple' });
  if (!hay300) {
    console.log('  · no hay cuentas de 300 Megas en la base; se salta');
  } else {
    check(con300.total > 0, `${con300.total} cuentas`);
    check(con300.items.every((r) => r.megas === 300), 'todas son de 300 Megas');
    check(con300.items.every((r) => r.total > 0), 'todas tienen apps contratadas');
    // Las 300 Megas están escritas de varias formas ("300 Megas F-26", "300 Megas
    // ST", "300Megas26F"…): el filtro va por Megas justamente por eso.
    const formas = [...new Set(con300.items.map((r) => r.planInternet))];
    check(formas.length >= 1, `agrupa ${formas.length} forma(s) de escribir el mismo plan: ${formas.slice(0, 4).join(' / ')}`);
  }

  console.log('\n5) Los filtros se combinan y los conteos se cruzan');
  const nivelTop = base.facetas.nivel.find((o) => o.count > 0);
  if (nivelTop && hay300) {
    const combinado = await pedir({ megas: ['300'], nivel: [nivelTop.value] });
    const soloNivel = await pedir({ nivel: [nivelTop.value] });
    check(combinado.total <= soloNivel.total, `300 Megas Y ${nivelTop.label}: ${combinado.total} ⊆ ${soloNivel.total}`);
    check(
      combinado.items.every((r) => r.megas === 300 && r.niveles.includes(nivelTop.value)),
      'cada fila cumple las dos condiciones a la vez',
    );
    // El conteo de una faceta NO se mira a sí mismo: con 300 marcado, las demás
    // opciones de plan siguen enseñando cuántas cuentas tendrían.
    const conPlanMarcado = await pedir({ megas: ['300'] });
    const otras = conPlanMarcado.facetas.megas.filter((o) => o.value !== '300' && o.count > 0);
    check(otras.length > 0, `con 300 marcado, las otras ${otras.length} opciones de plan siguen contando`);
    check(
      conPlanMarcado.facetas.megas.find((o) => o.value === '300')!.count === conPlanMarcado.total,
      'y la marcada coincide con lo que devuelve la tabla',
    );
    // El de al lado sí se recorta: los niveles se cuentan ya con el plan puesto.
    const nivelConPlan = conPlanMarcado.facetas.nivel.reduce((n, o) => Math.max(n, o.count), 0);
    check(nivelConPlan <= conPlanMarcado.total, 'los niveles se cuentan sobre las cuentas del plan elegido');
  } else {
    console.log('  · no hay datos suficientes para cruzar plan y nivel; se salta');
  }

  console.log('\n6) Ordenar por plan ordena por Megas, no por el texto');
  const porPlan = await pedir({ sortBy: 'plan', sortDir: 'desc' });
  const megasOrden = porPlan.items.map((r) => r.megas);
  check(
    megasOrden.every((m, i) => i === 0 || megasOrden[i - 1] >= m),
    `de mayor a menor: ${megasOrden.slice(0, 8).join(', ')}…`,
  );

  console.log('\n7) La búsqueda sigue mandando sobre todo lo demás');
  const conBusqueda = await pedir({ search: 'zzzzz-no-existe' });
  check(conBusqueda.cuentas === 0 && conBusqueda.total === 0, 'una búsqueda sin resultados deja el reporte en cero');

  console.log(fallos ? `\n${fallos} comprobación(es) fallaron\n` : '\nTodo bien\n');
  process.exit(fallos ? 1 : 0);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => void prisma.$disconnect());
