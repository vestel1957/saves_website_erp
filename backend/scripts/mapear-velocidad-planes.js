#!/usr/bin/env node
/**
 * Mapea cada plan de internet a su par de traffic-tables en una OLT
 * (`PlanOltProfile`), que es lo que el alta de ONU le mete al service-port.
 *
 * Con esto configurado, el técnico ya NO elige megas al autenticar desde la orden
 * de instalación: escoge cuál ONU es y el servidor aplica la velocidad del plan.
 * Un plan sin mapear bloquea el botón a propósito — es preferible a dar de alta
 * una ONU sin tope.
 *
 * SE CALIBRA SOLO. Lee las traffic-tables del equipo y elige el par para cada
 * velocidad del catálogo. No hay tabla escrita a mano: los índices cambian de un
 * equipo a otro (300 Megas es 70|73 en Yopal y 55|58 en Villanueva), así que
 * fijarlos en el código obligaba a recalibrar a mano cada OLT nueva.
 *
 * CONVENCIÓN — familia CIR = PIR (simétricas dedicadas): el abonado tiene
 * garantizada toda su velocidad, no una ráfaga sobre un CIR bajo. Se prefiere,
 * en este orden:
 *   1. par de dos tablas simétricas idénticas del valor buscado (lo que la
 *      planta ya usa para 300/600/900),
 *   2. una sola tabla simétrica, repetida en subida y bajada,
 *   3. par de dos tablas idénticas aunque no sean simétricas,
 *   4. la tabla más cercana, repetida.
 * Todo dentro de una ventana de -10% / +35% sobre las megas vendidas: así están
 * hechas las tablas de esta planta (300 Megas se sirve con una de 293 o 302, y
 * las velocidades bajas no tienen tabla exacta — 3 Megas va con la de 4).
 *
 *   node scripts/mapear-velocidad-planes.js YOPAL            # ensayo
 *   node scripts/mapear-velocidad-planes.js YOPAL --aplicar  # escribe
 *   node scripts/mapear-velocidad-planes.js --todas --aplicar
 *
 * No reescribe una fila que ya entrega la misma velocidad, aunque use otros
 * índices: si el par guardado da los mismos Mbps, se deja como está.
 */
const fs = require('fs');
const path = require('path');
for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
  const i = l.indexOf('=');
  if (i > 0 && !l.trim().startsWith('#')) process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}
require('reflect-metadata');
const { prismaService: prisma, oltService } = require('../dist/src/core/contenedor');

const MIN = 0.9;
const MAX = 1.35;

/**
 * Elige [inbound, outbound] para `megas` entre las traffic-tables del equipo.
 * Devuelve null si el equipo no tiene ninguna tabla que sirva.
 */
function elegirPar(megas, tablas) {
  const dentro = tablas.filter((t) => t.mbps >= megas * MIN && t.mbps <= megas * MAX);
  if (!dentro.length) return null;
  const cerca = (a, b) => Math.abs(a.mbps - megas) - Math.abs(b.mbps - megas);

  // Agrupa por (PIR, CIR): las tablas gemelas son las que forman par.
  const grupos = new Map();
  for (const t of dentro) {
    const k = `${t.mbps}|${t.cir}`;
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(t);
  }
  const gemelas = [...grupos.values()].filter((g) => g.length >= 2).sort((a, b) => cerca(a[0], b[0]));
  const simetrica = (t) => t.cir != null && t.mbps != null && Math.abs(t.cir - t.mbps) < 0.05;

  const parSimetrico = gemelas.find((g) => simetrica(g[0]));
  if (parSimetrico) return { par: [parSimetrico[0].id, parSimetrico[1].id], t: parSimetrico[0], via: 'par simétrico' };

  const solaSimetrica = dentro.filter(simetrica).sort(cerca)[0];
  if (solaSimetrica) return { par: [solaSimetrica.id, solaSimetrica.id], t: solaSimetrica, via: 'simétrica sola' };

  if (gemelas.length) return { par: [gemelas[0][0].id, gemelas[0][1].id], t: gemelas[0][0], via: 'par (CIR bajo)' };

  const sola = dentro.sort(cerca)[0];
  return { par: [sola.id, sola.id], t: sola, via: 'más cercana' };
}

async function mapearOlt(olt, aplicar) {
  const r = await oltService.trafficTables(olt.id, true);
  if (!r.ok) { console.log(`✗ ${olt.name}: no se pudieron leer las traffic-tables — ${r.error}`); return; }
  const tablas = r.tables
    .filter((t) => t.mbps != null)
    .map((t) => ({ id: Number(t.id), mbps: t.mbps, cir: t.cirMbps }));
  const porIndice = new Map(tablas.map((t) => [t.id, t]));

  const planes = await prisma.plan.findMany({
    where: { kind: 'INTERNET', megas: { not: null } },
    include: { _count: { select: { services: true } }, oltProfiles: { where: { oltId: olt.id } } },
  });

  const eleccion = new Map(); // megas → resultado de elegirPar
  for (const p of planes) if (!eleccion.has(p.megas)) eleccion.set(p.megas, elegirPar(p.megas, tablas));

  const acciones = [];
  const sinTabla = [];
  let igual = 0;
  for (const p of planes) {
    const e = eleccion.get(p.megas);
    if (!e) { sinTabla.push(p); continue; }
    const actual = p.oltProfiles[0] ?? null;
    // No se toca una fila que YA sirve. El criterio es la velocidad que entrega,
    // no los índices: dos tablas distintas pueden dar lo mismo, y varias caen
    // dentro de la ventana aceptable. Reescribir por reescribir movería la
    // velocidad de miles de abonados para ganar décimas.
    const mbpsActual = actual ? [actual.trafficIn, actual.trafficOut].map((i) => porIndice.get(i)?.mbps ?? null) : null;
    const sirve = mbpsActual && mbpsActual.every((m) => m != null && m >= p.megas * MIN && m <= p.megas * MAX);
    if (sirve) { igual++; continue; }
    acciones.push({ p, e, actual });
  }

  console.log(`\n=== ${olt.name} · ${tablas.length} traffic-tables leídas ===`);
  console.log(`planes con megas: ${planes.length} · ya correctos: ${igual} · a escribir: ${acciones.length} · sin tabla en el equipo: ${sinTabla.length}`);
  const porMegas = new Map();
  for (const a of acciones) porMegas.set(a.p.megas, a);
  for (const [megas, a] of [...porMegas].sort((x, y) => y[0] - x[0])) {
    const n = acciones.filter((x) => x.p.megas === megas).reduce((s, x) => s + x.p._count.services, 0);
    console.log(`  ${String(megas).padStart(4)}M → ${a.e.par[0]}|${a.e.par[1]} = ${a.e.t.mbps}/${a.e.t.cir} Mbps · ${a.e.via} · ${n} abonados`);
  }
  for (const p of sinTabla) console.log(`  ✗ ${p.name} (${p.megas}M): el equipo no tiene ninguna tabla que sirva`);

  if (!aplicar) return;
  for (const a of acciones) {
    await prisma.planOltProfile.upsert({
      where: { planId_oltId: { planId: a.p.id, oltId: olt.id } },
      create: { planId: a.p.id, oltId: olt.id, trafficIn: a.e.par[0], trafficOut: a.e.par[1] },
      update: { trafficIn: a.e.par[0], trafficOut: a.e.par[1] },
    });
  }
  console.log(`  ✓ ${acciones.length} planes escritos en ${olt.name}.`);
}

async function main() {
  const args = process.argv.slice(2);
  const aplicar = args.includes('--aplicar');
  const todas = args.includes('--todas');
  const nombre = args.find((a) => !a.startsWith('--'));
  if (!todas && !nombre) {
    console.error('Uso: node scripts/mapear-velocidad-planes.js <OLT> [--aplicar]  |  --todas [--aplicar]');
    process.exit(1);
  }
  const olts = todas
    ? await prisma.olt.findMany({ orderBy: { name: 'asc' } })
    : await prisma.olt.findMany({ where: { name: nombre } });
  if (!olts.length) { console.error(`No existe la OLT "${nombre}".`); process.exit(1); }
  for (const olt of olts) await mapearOlt(olt, aplicar);
  if (!aplicar) console.log('\n(ensayo — nada escrito; añada --aplicar)');
}

main().catch((e) => { console.error('FALLO', e.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
