#!/usr/bin/env node
/**
 * Rellena `Plan.megas` leyéndolo del NOMBRE del plan.
 *
 * El catálogo llegó del legacy con las megas solo en el texto ("300Megas26F"),
 * y `Plan.megas` en NULL para casi todo. Sin ese número la pantalla de
 * "Velocidad en OLT por plan" no sabe qué traffic-tables proponer, y el botón de
 * autenticar de la orden de instalación se bloquea.
 *
 * Usa el MISMO lector que la pantalla (`OltPlanProfileService.megasDeNombre`),
 * para que lo que se guarda sea exactamente lo que allí se venía mostrando.
 *
 *   node scripts/poblar-megas-planes.js            # solo enseña qué haría
 *   node scripts/poblar-megas-planes.js --aplicar  # escribe
 *
 * No pisa un valor ya puesto a mano: solo rellena los que están en NULL.
 */
const fs = require('fs');
const path = require('path');
for (const l of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
  const i = l.indexOf('=');
  if (i > 0 && !l.trim().startsWith('#')) process.env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, '');
}
require('reflect-metadata');
const { prismaService: prisma } = require('../dist/src/core/contenedor');
const { OltPlanProfileService } = require('../dist/src/network/olt-plan-profile.service');

async function main() {
  const aplicar = process.argv.includes('--aplicar');
  const planes = await prisma.plan.findMany({
    where: { kind: 'INTERNET' },
    include: { _count: { select: { services: true } } },
    orderBy: { name: 'asc' },
  });

  const aRellenar = [];
  const sinLectura = [];
  for (const p of planes) {
    if (p.megas != null) continue;
    const megas = OltPlanProfileService.megasDeNombre(p.name);
    if (megas == null) sinLectura.push(p);
    else aRellenar.push({ p, megas });
  }

  console.log(`Planes de internet: ${planes.length} · ya tenían megas: ${planes.filter((p) => p.megas != null).length}`);
  console.log(`Se pueden leer del nombre: ${aRellenar.length} · sin lectura posible: ${sinLectura.length}\n`);

  for (const { p, megas } of aRellenar.sort((a, b) => b.p._count.services - a.p._count.services)) {
    console.log(`${String(megas).padStart(5)} Mbps  ←  ${p.name.padEnd(30)} (${p._count.services} abonados)${p.active ? '' : ' [inactivo]'}`);
  }
  if (sinLectura.length) {
    console.log('\nSin megas en el nombre (hay que ponerlas a mano):');
    for (const p of sinLectura) console.log(`  · ${p.name} (${p._count.services} abonados)`);
  }

  if (!aplicar) {
    console.log('\n(ensayo — nada escrito; añada --aplicar)');
    return;
  }
  let n = 0;
  for (const { p, megas } of aRellenar) {
    await prisma.plan.update({ where: { id: p.id }, data: { megas } });
    n++;
  }
  console.log(`\n✓ ${n} planes actualizados.`);
}

main()
  .catch((e) => { console.error('FALLO', e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
