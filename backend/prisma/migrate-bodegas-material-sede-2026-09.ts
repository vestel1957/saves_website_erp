/**
 * Sede y bodega principal de las bodegas de MATERIAL (2026-09-03). Idempotente.
 *
 * Nace con la devolución de material del técnico: él devuelve lo que le sobra a la
 * bodega principal de SU sede, y quien la recibe y firma es la cajera de esa sede.
 * Para eso hacía falta un dato que no existía — `MaterialWarehouse` no tenía sede —,
 * el mismo que ya se le había puesto a las bodegas de equipos
 * (`migrate-bodegas-equipos-sede-2026-07.ts`, del que esto es hermano).
 *
 * Se deduce del NOMBRE, que es lo único que hay: "Almacén Yopal", "Paquetes
 * Villanueva", "Cabecera yopal"… Y se marca como PRINCIPAL la que se llama
 * exactamente "Almacén <sede>", que es la bodega de instalaciones de cada sede.
 *
 * Lo que NO mapea queda en NULL a propósito (Clientes, Servicios, Productos de
 * compra, Depurados, VESAGRO): son bodegas de tránsito, no de una sede. Se reporta
 * todo para que se vea qué quedó fuera; lo que haga falta corregir se hace desde
 * /inventario/bodegas, sin SQL.
 *
 * Correr:  npx ts-node prisma/migrate-bodegas-material-sede-2026-09.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Sin tildes, en minúsculas y con los espacios colapsados. */
const norm = (s: string | null | undefined) =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

async function main() {
  const branches = await prisma.branch.findMany({ select: { legacyId: true, name: true }, orderBy: { legacyId: 'asc' } });
  const bodegas = await prisma.materialWarehouse.findMany({
    select: { id: true, title: true, extra: true, technicianRef: true, branchLegacy: true, isMain: true, _count: { select: { materials: true } } },
    orderBy: { title: 'asc' },
  });

  let conSede = 0;
  const principales = new Map<number, string>();
  const sinSede: string[] = [];

  for (const b of bodegas) {
    const titulo = norm(b.title);
    // La sede se busca en el título y, si no, en la descripción ("Tecnico Yopal",
    // "Material Villavicencio"): media docena de almacenes sólo la dicen ahí.
    const sede = branches.find((br) => new RegExp(`\\b${norm(br.name)}\\b`).test(titulo))
      ?? branches.find((br) => new RegExp(`\\b${norm(br.name)}\\b`).test(norm(b.extra)));
    // Principal = "Almacén <sede>" exacto, y nunca el almacén personal de un técnico.
    const esPrincipal = Boolean(sede) && !b.technicianRef && titulo === `almacen ${norm(sede!.name)}`;

    if (!sede) { sinSede.push(`${b.title} (${b._count.materials} mat.)`); continue; }
    conSede++;
    if (esPrincipal) principales.set(sede.legacyId!, b.title);

    if (b.branchLegacy === sede.legacyId && b.isMain === esPrincipal) continue;
    await prisma.materialWarehouse.update({
      where: { id: b.id },
      data: { branchLegacy: sede.legacyId, isMain: esPrincipal },
    });
    console.log(`  · ${b.title.padEnd(34)} → ${sede.name}${esPrincipal ? '  ★ PRINCIPAL' : ''}`);
  }

  console.log(`\n  ${conSede} de ${bodegas.length} bodegas quedaron con sede.`);
  console.log('\n  Bodega principal por sede (a donde el técnico devuelve lo que le sobra):');
  for (const br of branches) {
    const p = principales.get(br.legacyId!);
    console.log(`    ${p ? '✓' : '✗'} ${br.name.padEnd(15)} ${p ?? '— sin bodega principal: sus técnicos no pueden devolver'}`);
  }
  if (sinSede.length) {
    console.log(`\n  ℹ ${sinSede.length} bodega(s) sin sede (de tránsito o de nombre no reconocible):`);
    for (const s of sinSede) console.log(`    · ${s}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
