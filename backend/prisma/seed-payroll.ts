/**
 * Payroll (Nómina) seed. Idempotent — safe to run multiple times.
 * Run with:  npx ts-node prisma/seed-payroll.ts
 *
 * Seeds payroll permissions/roles, a default chart of payroll concepts
 * (configurable — rules live in data, not code), a demo payroll-manager user,
 * and a demo contract for the SST demo employee.
 *
 */
import { PrismaClient } from '@prisma/client';
import { ALL_PAYROLL_PERMISSIONS } from '../src/auth/permissions.catalog';

const prisma = new PrismaClient();

/**
 * Catálogo base de conceptos. Las TASAS viven aquí (datos), no en el motor.
 * Para horas extras/recargos: PER_QUANTITY + base BASIC_SALARY → el motor calcula
 *   valor unitario = (salarioBase / horasMes) × rate(multiplicador).
 * Para % (salud/pensión): PERCENTAGE + base IBC → rate aplicado sobre el IBC.
 * Para fijos (auxilios/bonos/descuentos): FIXED → rate = monto, o monto de la novedad.
 */
const CONCEPTS: {
  code: string;
  name: string;
  type: 'EARNING' | 'DEDUCTION';
  salaryNature: 'SALARIAL' | 'NON_SALARIAL';
  category: string;
  calcMethod: 'FIXED' | 'PERCENTAGE' | 'PER_QUANTITY' | 'PROPORTIONAL';
  rate?: number;
  base?: 'NONE' | 'BASIC_SALARY' | 'DAILY_SALARY' | 'GROSS_SALARIAL' | 'IBC';
  autoApply?: boolean;
  cycleDays?: number;
  affectsHealth?: boolean;
  affectsPension?: boolean;
}[] = [
  { code: 'SALBASE', name: 'Salario Base', type: 'EARNING', salaryNature: 'SALARIAL', category: 'BASIC_SALARY', calcMethod: 'FIXED', base: 'NONE', affectsHealth: true, affectsPension: true },
  { code: 'HED', name: 'Hora Extra Diurna', type: 'EARNING', salaryNature: 'SALARIAL', category: 'OVERTIME', calcMethod: 'PER_QUANTITY', base: 'BASIC_SALARY', rate: 1.25, affectsHealth: true, affectsPension: true },
  { code: 'HEN', name: 'Hora Extra Nocturna', type: 'EARNING', salaryNature: 'SALARIAL', category: 'OVERTIME', calcMethod: 'PER_QUANTITY', base: 'BASIC_SALARY', rate: 1.75, affectsHealth: true, affectsPension: true },
  { code: 'RECN', name: 'Recargo Nocturno', type: 'EARNING', salaryNature: 'SALARIAL', category: 'OVERTIME', calcMethod: 'PER_QUANTITY', base: 'BASIC_SALARY', rate: 0.35, affectsHealth: true, affectsPension: true },
  { code: 'DOM', name: 'Recargo Dominical', type: 'EARNING', salaryNature: 'SALARIAL', category: 'OVERTIME', calcMethod: 'PER_QUANTITY', base: 'BASIC_SALARY', rate: 0.75, affectsHealth: true, affectsPension: true },
  { code: 'FEST', name: 'Recargo Festivo', type: 'EARNING', salaryNature: 'SALARIAL', category: 'OVERTIME', calcMethod: 'PER_QUANTITY', base: 'BASIC_SALARY', rate: 0.75, affectsHealth: true, affectsPension: true },
  { code: 'TSEDO125', name: 'Trabajo Suplementario E.D.O 125%', type: 'EARNING', salaryNature: 'SALARIAL', category: 'OVERTIME', calcMethod: 'PER_QUANTITY', base: 'BASIC_SALARY', rate: 1.25, affectsHealth: true, affectsPension: true },
  { code: 'COMPENSATORIO', name: 'Compensatorio', type: 'EARNING', salaryNature: 'SALARIAL', category: 'OTHER', calcMethod: 'PER_QUANTITY', base: 'DAILY_SALARY', rate: 1, affectsHealth: true, affectsPension: true },
  { code: 'COM', name: 'Comisión Comercial', type: 'EARNING', salaryNature: 'SALARIAL', category: 'COMMISSION', calcMethod: 'FIXED', base: 'NONE', affectsHealth: true, affectsPension: true },
  { code: 'BONOPROD', name: 'Bono Productividad', type: 'EARNING', salaryNature: 'NON_SALARIAL', category: 'BONUS', calcMethod: 'FIXED', base: 'NONE' },
  { code: 'AUXT', name: 'Auxilio Transporte', type: 'EARNING', salaryNature: 'NON_SALARIAL', category: 'ALLOWANCE', calcMethod: 'FIXED', base: 'NONE', rate: 200000 },
  { code: 'AUXCON', name: 'Auxilio Conectividad', type: 'EARNING', salaryNature: 'NON_SALARIAL', category: 'ALLOWANCE', calcMethod: 'FIXED', base: 'NONE' },
  { code: 'LIBRANZA', name: 'Descuento Libranza', type: 'DEDUCTION', salaryNature: 'NON_SALARIAL', category: 'OTHER', calcMethod: 'FIXED', base: 'NONE' },
  { code: 'SALUD', name: 'Aporte Salud (4%)', type: 'DEDUCTION', salaryNature: 'SALARIAL', category: 'HEALTH', calcMethod: 'PERCENTAGE', base: 'IBC', rate: 0.04 },
  { code: 'PENSION', name: 'Aporte Pensión (4%)', type: 'DEDUCTION', salaryNature: 'SALARIAL', category: 'PENSION', calcMethod: 'PERCENTAGE', base: 'IBC', rate: 0.04 },
  // --- primas convencionales ---
  // Prima de Habitación: fija mensual, salarial, automática para todos.
  { code: 'PRIHAB', name: 'Prima de Habitación', type: 'EARNING', salaryNature: 'SALARIAL', category: 'OTHER', calcMethod: 'FIXED', base: 'NONE', rate: 411085, autoApply: true, affectsHealth: true, affectsPension: true },
  // Prima Convencional: 24 días de salario por semestre, proporcional al tiempo laborado (pago may/nov).
  { code: 'PRICONV', name: 'Prima Convencional', type: 'EARNING', salaryNature: 'SALARIAL', category: 'BONUS', calcMethod: 'PROPORTIONAL', base: 'NONE', rate: 24, cycleDays: 180, affectsHealth: true, affectsPension: true },
  // Prima de Vacaciones: 30 días de salario por año, proporcional al tiempo laborado.
  { code: 'PRIVAC', name: 'Prima de Vacaciones', type: 'EARNING', salaryNature: 'SALARIAL', category: 'VACATION', calcMethod: 'PROPORTIONAL', base: 'NONE', rate: 30, cycleDays: 360, affectsHealth: true, affectsPension: true },
];

async function main() {
  // ---- permissions -------------------------------------------------------
  for (const p of ALL_PAYROLL_PERMISSIONS) {
    await prisma.permission.upsert({
      where: { key: p.key },
      update: { label: p.label },
      create: { key: p.key, label: p.label },
    });
  }
  for (const [key, label] of [['dashboard.view', 'Ver panel ejecutivo'], ['hr.employees.read', 'Ver empleados (RRHH)']] as const) {
    await prisma.permission.upsert({ where: { key }, update: {}, create: { key, label } });
  }
  console.log(`✓ ${ALL_PAYROLL_PERMISSIONS.length} permisos de nómina`);

  // Los roles de nómina se retiraron el 2026-07-29: el módulo no tiene
  // pantallas y sus dos roles llevaban meses en el selector sin poder usarse.
  // Los permisos se siguen sembrando (el super-admin los necesita abajo);
  // cuando existan las pantallas, los roles se diseñan contra ellas.

  // ---- mantener al super-admin con acceso total --------------------------
  const superAdmin = await prisma.role.findUnique({ where: { key: 'super-admin' } });
  if (superAdmin) {
    const payrollPerms = await prisma.permission.findMany({
      where: { key: { in: ALL_PAYROLL_PERMISSIONS.map((p) => p.key) } },
    });
    for (const perm of payrollPerms) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: superAdmin.id, permissionId: perm.id } },
        update: {},
        create: { roleId: superAdmin.id, permissionId: perm.id },
      });
    }
    console.log('✓ super-admin actualizado con permisos de nómina');
  }

  // ---- conceptos por defecto --------------------------------------------
  for (const c of CONCEPTS) {
    await prisma.payrollConcept.upsert({
      where: { code: c.code },
      update: {
        name: c.name,
        type: c.type as any,
        salaryNature: c.salaryNature as any,
        category: c.category as any,
        calcMethod: c.calcMethod as any,
        base: (c.base ?? 'NONE') as any,
        rate: c.rate ?? null,
        autoApply: c.autoApply ?? false,
        cycleDays: c.cycleDays ?? null,
        affectsHealth: c.affectsHealth ?? false,
        affectsPension: c.affectsPension ?? false,
      },
      create: {
        code: c.code,
        name: c.name,
        type: c.type as any,
        salaryNature: c.salaryNature as any,
        category: c.category as any,
        calcMethod: c.calcMethod as any,
        base: (c.base ?? 'NONE') as any,
        rate: c.rate ?? null,
        autoApply: c.autoApply ?? false,
        cycleDays: c.cycleDays ?? null,
        affectsHealth: c.affectsHealth ?? false,
        affectsPension: c.affectsPension ?? false,
      },
    });
  }
  console.log(`✓ ${CONCEPTS.length} conceptos de nómina`);

  // ---- demo contract for the SST demo employee --------------------------
  const employee = await prisma.employee.findUnique({ where: { docNumber: '1000000001' } });
  if (employee) {
    const existing = await prisma.payrollContract.findFirst({ where: { employeeId: employee.id, active: true } });
    if (!existing) {
      await prisma.payrollContract.create({
        data: {
          employeeId: employee.id,
          contractType: 'INDEFINITE',
          baseSalary: 2000000,
          monthlyHours: 240,
          transportAllowance: true,
          startDate: new Date('2025-01-01'),
        },
      });
      console.log(`✓ contrato demo para ${employee.firstName} ${employee.lastName}`);
    }
  } else {
    console.log('• (sin empleado demo 1000000001 — corre seed-sst primero para datos de prueba)');
  }

  console.log('\n✅ Seed de nómina completado.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
