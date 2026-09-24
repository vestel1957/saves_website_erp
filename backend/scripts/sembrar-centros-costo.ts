/**
 * Siembra los centros de costo de gestión: la raíz VESTEL, uno por sede (CC-<SEDE>, enlazado
 * desde Branch.costCenterId) y CC-ADMIN «Administración general» para los gastos compartidos.
 * Ver docs/centros-de-costo/PLAN.md.
 *
 * Idempotente: reutiliza por `code`. Lo que ya existe no se renombra ni se reactiva (puede
 * haberse editado a mano); sólo se completa lo que falte (padre, tipo, enlace con la sede).
 * Si una sede ya apunta a OTRO centro, se respeta y se avisa.
 *
 * Uso: npx ts-node --transpile-only scripts/sembrar-centros-costo.ts [--dry]
 */
import { CostCenterKind, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dry = process.argv.includes('--dry');

/** 'Villavicencio' → 'CC-VILLAVICENCIO'; sin tildes ni espacios. */
export const codigoDeSede = (nombre: string) =>
  'CC-' +
  nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

type Resultado = 'creado' | 'completado' | 'sin cambios';

async function asegurar(
  code: string,
  name: string,
  kind: CostCenterKind,
  parentId: string | null,
): Promise<{ id: string; resultado: Resultado }> {
  const hay = await prisma.costCenter.findUnique({ where: { code } });
  if (!hay) {
    if (dry) return { id: `(nuevo ${code})`, resultado: 'creado' };
    const c = await prisma.costCenter.create({ data: { code, name, kind, parentId } });
    return { id: c.id, resultado: 'creado' };
  }
  const data: { kind?: CostCenterKind; parentId?: string } = {};
  // Estos códigos son del sembrado y su tipo es fijo.
  if (hay.kind !== kind) data.kind = kind;
  if (parentId && !hay.parentId && hay.id !== parentId) data.parentId = parentId;
  if (!Object.keys(data).length) return { id: hay.id, resultado: 'sin cambios' };
  if (!dry) await prisma.costCenter.update({ where: { id: hay.id }, data });
  return { id: hay.id, resultado: 'completado' };
}

async function main() {
  console.log(dry ? '== DRY: no se escribe nada ==' : '== Sembrando centros de costo ==');

  const raiz = await asegurar('VESTEL', 'Vestel', CostCenterKind.OTRO, null);
  console.log(`  VESTEL           ${raiz.resultado}`);

  const admin = await asegurar('CC-ADMIN', 'Administración general', CostCenterKind.GENERAL, raiz.id);
  console.log(`  CC-ADMIN         ${admin.resultado}`);

  const sedes = await prisma.branch.findMany({ orderBy: { legacyId: 'asc' } });
  for (const b of sedes) {
    const code = codigoDeSede(b.name);
    const cc = await asegurar(code, b.name, CostCenterKind.SEDE, raiz.id);
    let enlace: string;
    if (b.costCenterId === cc.id) enlace = 'ya enlazada';
    else if (b.costCenterId) enlace = `AVISO: la sede ya apunta a otro centro (${b.costCenterId}); se respeta`;
    else {
      // El centro no puede estar enlazado a otra sede (unique): pasaría si dos sedes dieran el mismo código.
      const otra = dry ? null : await prisma.branch.findFirst({ where: { costCenterId: cc.id } });
      if (otra) enlace = `AVISO: ${code} ya es de la sede ${otra.name}; no se enlaza`;
      else {
        if (!dry) await prisma.branch.update({ where: { id: b.id }, data: { costCenterId: cc.id } });
        enlace = 'enlazada';
      }
    }
    console.log(`  ${code.padEnd(17)}${cc.resultado.padEnd(12)} sede ${b.legacyId} ${b.name}: ${enlace}`);
  }

  if (!dry) {
    const total = await prisma.costCenter.count();
    const enlazadas = await prisma.branch.count({ where: { costCenterId: { not: null } } });
    console.log(`\nCentros de costo: ${total} · sedes enlazadas: ${enlazadas}/${sedes.length}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
