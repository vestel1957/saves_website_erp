/**
 * SST seed. Idempotent — safe to run multiple times.
 * Run with:  npx ts-node prisma/seed-sst.ts
 *
 * Seeds SST permissions and a small demo dataset (employee, risk matrix, EPP
 * product, inspection template). Ya NO siembra roles ni usuario de demostración:
 * ver la nota más abajo.
 */
import { PrismaClient } from '@prisma/client';
import { ALL_SST_PERMISSIONS } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

async function main() {
  // ---- SST permissions ---------------------------------------------------
  for (const p of ALL_SST_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { label: p.label },
      create: { key: p.key, label: p.label },
    });
  }
  // dashboard.view is referenced by SST roles; ensure it exists.
  await prisma.permission.upsert({
    where: { key: 'dashboard.view' },
    update: {},
    create: { key: 'dashboard.view', label: 'Ver panel ejecutivo' },
  });
  console.log(`✓ ${ALL_SST_PERMISSIONS.length} permisos SST`);

  // Los roles SST (y su usuario de demostración) se retiraron el 2026-07-29:
  // el módulo nunca se construyó y sus tres roles llevaban meses en el selector
  // sin que nadie los pudiera usar. Los permisos siguen sembrándose porque las
  // tablas SST sí existen en el esquema; cuando haya pantallas, los roles se
  // diseñan contra ellas.

  // ---- demo employee -----------------------------------------------------
  const employee = await prisma.employee.upsert({
    where: { docNumber: '1000000001' },
    update: {},
    create: {
      docType: 'CC',
      docNumber: '1000000001',
      firstName: 'Carlos',
      lastName: 'Operario',
      position: 'Operario de planta',
      area: 'Producción',
      status: 'ACTIVE',
    },
  });

  // ---- demo risk matrix + entry -----------------------------------------
  const existingMatrix = await prisma.sstRiskMatrix.findFirst({ where: { name: 'Matriz general' } });
  const matrix =
    existingMatrix ??
    (await prisma.sstRiskMatrix.create({ data: { name: 'Matriz general', area: 'Planta' } }));
  const hasEntry = await prisma.sstRiskEntry.findFirst({ where: { matrixId: matrix.id } });
  if (!hasEntry) {
    await prisma.sstRiskEntry.create({
      data: {
        matrixId: matrix.id,
        area: 'Producción',
        position: 'Operario de planta',
        activity: 'Operación de maquinaria',
        riskType: 'MECANICO',
        hazard: 'Atrapamiento por partes móviles',
        probability: 3,
        impact: 4,
        riskLevel: 'ALTO',
        existingControls: 'Guardas de seguridad',
        preventiveMeasures: 'Capacitación + EPP + bloqueo y etiquetado',
      },
    });
  }

  // ---- demo EPP product (reuses inventory Product) -----------------------
  const und = await prisma.unitOfMeasure.upsert({
    where: { code: 'UND' },
    update: {},
    create: { code: 'UND', name: 'Unidad' },
  });
  await prisma.product.upsert({
    where: { sku: 'EPP-CASCO-001' },
    update: {},
    create: { sku: 'EPP-CASCO-001', name: 'Casco de seguridad', type: 'CONSUMABLE', uomId: und.id },
  });

  // ---- demo inspection template -----------------------------------------
  const tplExists = await prisma.sstInspectionTemplate.findFirst({ where: { name: 'Inspección de vehículo' } });
  if (!tplExists) {
    await prisma.sstInspectionTemplate.create({
      data: {
        name: 'Inspección de vehículo',
        type: 'VEHICLE',
        description: 'Checklist preoperacional de vehículo',
        items: [
          { question: 'Niveles de aceite y refrigerante', category: 'Mecánico' },
          { question: 'Estado de llantas', category: 'Mecánico' },
          { question: 'Luces y direccionales', category: 'Eléctrico' },
          { question: 'Cinturones de seguridad', category: 'Seguridad' },
          { question: 'Extintor vigente', category: 'Emergencia' },
          { question: 'Botiquín completo', category: 'Emergencia' },
        ],
      },
    });
  }

  console.log(`✓ datos demo SST (empleado ${employee.docNumber}, matriz, EPP, plantilla)`);
  console.log('\n✅ Seed SST completado.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
