/**
 * SST seed. Idempotent — safe to run multiple times.
 * Run with:  npx ts-node prisma/seed-sst.ts
 *
 * Seeds SST permissions/roles (self-contained), an SST demo user, and a small
 * demo dataset (employee, risk matrix, EPP product, inspection template).
 *
 * Default SST login →  sst@bhdc.dev  /  sst123
 */
import { PrismaClient } from '@prisma/client';
import { ALL_SST_PERMISSIONS, SST_ROLES } from '../src/auth/permissions.catalog';
import { hashPassword } from '../src/auth/crypto.util';

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

  // ---- SST roles + role-permissions --------------------------------------
  for (const r of SST_ROLES) {
    const role = await prisma.role.upsert({
      where: { key: r.key },
      update: { name: r.name, description: r.description },
      create: { key: r.key, name: r.name, description: r.description },
    });
    const perms = await prisma.permission.findMany({ where: { key: { in: r.permissions } } });
    for (const perm of perms) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
        update: {},
        create: { roleId: role.id, permissionId: perm.id },
      });
    }
  }
  console.log(`✓ ${SST_ROLES.length} roles SST`);

  // ---- SST demo user -----------------------------------------------------
  const adminRole = await prisma.role.findUnique({ where: { key: 'sst-admin' } });
  const user = await prisma.user.upsert({
    where: { email: 'sst@bhdc.dev' },
    update: { name: 'Sofía SST', passwordHash: hashPassword('sst123'), isActive: true },
    create: { email: 'sst@bhdc.dev', name: 'Sofía SST', passwordHash: hashPassword('sst123') },
  });
  if (adminRole) {
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: adminRole.id } },
      update: {},
      create: { userId: user.id, roleId: adminRole.id },
    });
  }
  console.log('✓ usuario sst@bhdc.dev / sst123  (sst-admin)');

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
