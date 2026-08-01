/**
 * Verifica que TODO el catálogo de datos funcione contra la base real.
 *
 * Por qué existe: el catálogo son fragmentos de SQL escritos a mano (`s."planName"`,
 * `o.paid`…) y TypeScript no puede comprobar que esas columnas existan. Al montarlo,
 * cuatro entradas estaban mal —`Subscriber.barrio` y `Subscriber.planName` no existen,
 * `SupplyOrder.paid` se llama `paidAmount`, y el stock traía valores centinela de
 * 2.147.483.647 que hacían que "el material más valioso" diera cuatrillones— y cada
 * una solo se descubría cuando alguien preguntaba justo eso.
 *
 * Esto las ejercita todas de una: cada filtro, cada agrupación y cada cifra de cada
 * entidad. Es de solo lectura y no gasta LLM.
 *
 *   node scripts/verify-data-catalog.js
 */
process.env.WA_AGENT_ENABLED = 'false';

const { NestFactory } = require('@nestjs/core');
const { AppModule } = require('../dist/src/app.module');
const { DataQueryService } = require('../dist/src/search/data-query.service');
const { CATALOGO } = require('../dist/src/search/data-catalog');

const SUPER = ['system.admin'];
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m✗ ${m}\x1b[0m`); process.exitCode = 1; };

/** Un valor de prueba plausible según el tipo del filtro. */
const muestra = (f) => {
  if (f.valores?.length) return f.valores[0];
  switch (f.tipo) {
    case 'fecha': return { desde: '2026-01-01', hasta: '2026-12-31' };
    case 'numero': return 1;
    case 'bool': return false;
    default: return 'a';
  }
};

(async () => {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const q = app.get(DataQueryService);
  let probadas = 0;

  for (const [clave, e] of Object.entries(CATALOGO)) {
    console.log(`\n\x1b[1m${clave}\x1b[0m — ${e.etiqueta}`);

    // 1. La entidad responde con la consulta más simple.
    const base = await q.consultar({ entidad: clave }, SUPER);
    probadas++;
    base.ok ? ok(`consulta base · ${JSON.stringify(base.filas?.[0] ?? {})}`) : bad(`consulta base: ${base.error}`);

    // 2. Cada filtro, de a uno.
    for (const [nombre, f] of Object.entries(e.filtros)) {
      const r = await q.consultar({ entidad: clave, filtros: { [nombre]: muestra(f) } }, SUPER);
      probadas++;
      r.ok ? ok(`filtro ${nombre}`) : bad(`filtro ${nombre}: ${r.error}`);
    }

    // 3. Cada agrupación, con cada cifra a la vez (así se prueban todas las métricas
    //    y de paso que se puedan combinar).
    const metricas = Object.keys(e.metricas);
    for (const g of Object.keys(e.grupos)) {
      const r = await q.consultar({ entidad: clave, agrupar: [g], metricas, limite: 3 }, SUPER);
      probadas++;
      r.ok
        ? ok(`agrupar por ${g} · ${r.filas?.length ?? 0} fila(s) · ${JSON.stringify(r.filas?.[0] ?? {})}`)
        : bad(`agrupar por ${g}: ${r.error}`);
    }
  }

  console.log(`\n${probadas} consulta(s) ejercitada(s).`);
  await app.close();
  process.exit(process.exitCode ?? 0);
})().catch((e) => { console.error(e); process.exit(1); });
