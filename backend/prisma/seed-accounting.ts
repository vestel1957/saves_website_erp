/**
 * Semilla contable — Plan Único de Cuentas (PUC Colombia), versión operativa mínima.
 * Idempotente: se puede correr varias veces (upsert por código).
 *   npx ts-node prisma/seed-accounting.ts
 */
import { PrismaClient, AccountType, NormalSide } from '@prisma/client';

const prisma = new PrismaClient();

const naturalSide = (t: AccountType): NormalSide =>
  t === 'ASSET' || t === 'COST' || t === 'EXPENSE' ? 'DEBIT' : 'CREDIT';

type Row = { code: string; name: string; type: AccountType; parent?: string; postable?: boolean };

// Clase (1 díg) → Grupo (2) → Cuenta (4) → Subcuenta/auxiliar (6, imputable)
const PUC: Row[] = [
  // ---- 1 ACTIVO ----
  { code: '1', name: 'ACTIVO', type: 'ASSET' },
  { code: '11', name: 'Disponible', type: 'ASSET', parent: '1' },
  { code: '1105', name: 'Caja', type: 'ASSET', parent: '11' },
  { code: '110505', name: 'Caja general', type: 'ASSET', parent: '1105', postable: true },
  { code: '1110', name: 'Bancos', type: 'ASSET', parent: '11' },
  { code: '111005', name: 'Bancos nacionales', type: 'ASSET', parent: '1110', postable: true },
  { code: '13', name: 'Deudores', type: 'ASSET', parent: '1' },
  { code: '1305', name: 'Clientes', type: 'ASSET', parent: '13' },
  { code: '130505', name: 'Clientes nacionales', type: 'ASSET', parent: '1305', postable: true },
  { code: '14', name: 'Inventarios', type: 'ASSET', parent: '1' },
  { code: '1435', name: 'Mercancías no fabricadas por la empresa', type: 'ASSET', parent: '14' },
  { code: '143501', name: 'Inventario de mercancías', type: 'ASSET', parent: '1435', postable: true },

  // ---- 2 PASIVO ----
  { code: '2', name: 'PASIVO', type: 'LIABILITY' },
  { code: '22', name: 'Proveedores', type: 'LIABILITY', parent: '2' },
  { code: '2205', name: 'Proveedores nacionales', type: 'LIABILITY', parent: '22' },
  { code: '220505', name: 'Proveedores nacionales', type: 'LIABILITY', parent: '2205', postable: true },
  { code: '24', name: 'Impuestos, gravámenes y tasas', type: 'LIABILITY', parent: '2' },
  { code: '2408', name: 'Impuesto sobre las ventas por pagar', type: 'LIABILITY', parent: '24' },
  { code: '240805', name: 'IVA generado', type: 'LIABILITY', parent: '2408', postable: true },
  { code: '240820', name: 'IVA descontable', type: 'LIABILITY', parent: '2408', postable: true },

  // ---- 3 PATRIMONIO ----
  { code: '3', name: 'PATRIMONIO', type: 'EQUITY' },
  { code: '36', name: 'Resultados del ejercicio', type: 'EQUITY', parent: '3' },
  { code: '3605', name: 'Utilidad del ejercicio', type: 'EQUITY', parent: '36' },
  { code: '360505', name: 'Utilidad del ejercicio', type: 'EQUITY', parent: '3605', postable: true },
  { code: '37', name: 'Resultados de ejercicios anteriores', type: 'EQUITY', parent: '3' },
  { code: '3705', name: 'Utilidades acumuladas', type: 'EQUITY', parent: '37' },
  { code: '370505', name: 'Utilidades acumuladas', type: 'EQUITY', parent: '3705', postable: true },

  // ---- 4 INGRESOS ----
  { code: '4', name: 'INGRESOS', type: 'INCOME' },
  { code: '41', name: 'Operacionales', type: 'INCOME', parent: '4' },
  { code: '4155', name: 'Servicios', type: 'INCOME', parent: '41' },
  { code: '415560', name: 'Servicio de internet / telecomunicaciones', type: 'INCOME', parent: '4155', postable: true },

  // ---- 5 GASTOS ----
  { code: '5', name: 'GASTOS', type: 'EXPENSE' },
  { code: '51', name: 'Operacionales de administración', type: 'EXPENSE', parent: '5' },
  { code: '5195', name: 'Diversos', type: 'EXPENSE', parent: '51' },
  { code: '519595', name: 'Otros gastos diversos', type: 'EXPENSE', parent: '5195', postable: true },

  // ---- 6 COSTOS ----
  { code: '6', name: 'COSTOS DE VENTAS', type: 'COST' },
  { code: '61', name: 'Costo de ventas y de prestación de servicios', type: 'COST', parent: '6' },
  { code: '6135', name: 'Comercio al por mayor y al por menor', type: 'COST', parent: '61' },
  { code: '613560', name: 'Costo de servicios prestados', type: 'COST', parent: '6135', postable: true },
];

const MAPPINGS: { key: string; code: string; description: string }[] = [
  { key: 'SALES_AR', code: '130505', description: 'Cuentas por cobrar clientes' },
  { key: 'SALES_REVENUE', code: '415560', description: 'Ingreso por servicios' },
  { key: 'SALES_TAX', code: '240805', description: 'IVA generado en ventas' },
  { key: 'PURCHASE_AP', code: '220505', description: 'Cuentas por pagar proveedores' },
  { key: 'PURCHASE_EXPENSE', code: '519595', description: 'Gasto/compra por defecto' },
  { key: 'PURCHASE_TAX', code: '240820', description: 'IVA descontable en compras' },
  { key: 'BANK_DEFAULT', code: '111005', description: 'Banco por defecto' },
  { key: 'CASH_DEFAULT', code: '110505', description: 'Caja por defecto' },
  { key: 'COGS', code: '613560', description: 'Costo de ventas' },
  { key: 'INVENTORY', code: '143501', description: 'Inventario de mercancías' },
  { key: 'RETAINED_EARNINGS', code: '370505', description: 'Utilidades acumuladas' },
  { key: 'INCOME_SUMMARY', code: '360505', description: 'Utilidad del ejercicio' },
];

async function main() {
  console.log('Sembrando PUC…');
  const idByCode = new Map<string, string>();
  // insertar en orden (padres primero, ya vienen ordenados por longitud de código)
  for (const row of PUC) {
    const level = row.code.length <= 1 ? 1 : row.code.length <= 2 ? 2 : row.code.length <= 4 ? 3 : 4;
    const parentId = row.parent ? idByCode.get(row.parent) ?? null : null;
    const acc = await prisma.account.upsert({
      where: { code: row.code },
      update: { name: row.name, type: row.type, parentId, level, isPostable: !!row.postable },
      create: {
        code: row.code, name: row.name, type: row.type, normalSide: naturalSide(row.type),
        parentId, level, isPostable: !!row.postable, currency: 'COP',
      },
    });
    idByCode.set(row.code, acc.id);
  }
  console.log(`  ${PUC.length} cuentas`);

  console.log('Sembrando mapeos de cuentas…');
  for (const m of MAPPINGS) {
    const accountId = idByCode.get(m.code);
    if (!accountId) { console.warn(`  ! cuenta ${m.code} no encontrada para ${m.key}`); continue; }
    await prisma.accountMapping.upsert({
      where: { key: m.key },
      update: { accountId, description: m.description },
      create: { key: m.key, accountId, description: m.description },
    });
  }
  console.log(`  ${MAPPINGS.length} mapeos`);

  // Periodo fiscal del mes actual (abierto)
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  await prisma.fiscalPeriod.upsert({
    where: { year_month: { year, month } },
    update: {},
    create: {
      name: `${year}-${String(month).padStart(2, '0')}`, type: 'MONTH', year, month,
      startDate: start, endDate: end, status: 'OPEN',
    },
  });
  console.log(`Periodo ${year}-${String(month).padStart(2, '0')} listo (abierto)`);
  console.log('✔ Semilla contable completada.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
