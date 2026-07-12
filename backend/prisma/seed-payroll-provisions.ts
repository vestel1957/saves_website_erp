/**
 * Seed enfocado: cuentas y mapeos para la CARGA PATRONAL de nómina (provisiones
 * de prestaciones + aportes patronales). Idempotente (upsert por code / key);
 * no toca ninguna otra cuenta ni dato. Re-ejecutable sin riesgo.
 *
 *   ts-node prisma/seed-payroll-provisions.ts   (o npm run prisma:seed:payroll-provisions)
 */
import { PrismaClient, AccountType } from '@prisma/client';

const prisma = new PrismaClient();

type Side = 'DEBIT' | 'CREDIT';
interface Acc { code: string; name: string; type: AccountType; side: Side; parent: string; postable?: boolean }

// Gastos de personal (5105) → subcuentas de provisión/aporte (gasto, naturaleza débito).
// Pasivos: prestaciones bajo 25 (obligaciones laborales), aportes bajo 24.
const ACCOUNTS: Acc[] = [
  // Grupos padre (ya existen en el seed base; upsert por si acaso).
  { code: '24', name: 'Impuestos, gravámenes y aportes por pagar', type: 'LIABILITY', side: 'CREDIT', parent: '2' },
  { code: '25', name: 'Obligaciones laborales', type: 'LIABILITY', side: 'CREDIT', parent: '2' },
  { code: '5105', name: 'Gastos de personal (nómina)', type: 'EXPENSE', side: 'DEBIT', parent: '51', postable: true },

  // Cuentas BASE de nómina (lado empleado) — aseguradas por si el seed contable
  // completo no se aplicó en este entorno (sin ellas no se postea ni el devengado).
  { code: '2370', name: 'Retenciones y aportes de nómina por pagar', type: 'LIABILITY', side: 'CREDIT', parent: '24', postable: true },
  { code: '2505', name: 'Salarios por pagar', type: 'LIABILITY', side: 'CREDIT', parent: '25', postable: true },

  // --- Gastos (débito) ---
  { code: '510530', name: 'Cesantías', type: 'EXPENSE', side: 'DEBIT', parent: '5105', postable: true },
  { code: '510533', name: 'Intereses sobre cesantías', type: 'EXPENSE', side: 'DEBIT', parent: '5105', postable: true },
  { code: '510536', name: 'Prima de servicios', type: 'EXPENSE', side: 'DEBIT', parent: '5105', postable: true },
  { code: '510539', name: 'Vacaciones', type: 'EXPENSE', side: 'DEBIT', parent: '5105', postable: true },
  { code: '510568', name: 'Aportes ARL', type: 'EXPENSE', side: 'DEBIT', parent: '5105', postable: true },
  { code: '510569', name: 'Aportes salud (EPS) patronal', type: 'EXPENSE', side: 'DEBIT', parent: '5105', postable: true },
  { code: '510570', name: 'Aportes pensión patronal', type: 'EXPENSE', side: 'DEBIT', parent: '5105', postable: true },
  { code: '510572', name: 'Aportes caja de compensación', type: 'EXPENSE', side: 'DEBIT', parent: '5105', postable: true },
  { code: '510575', name: 'Aportes ICBF', type: 'EXPENSE', side: 'DEBIT', parent: '5105', postable: true },
  { code: '510578', name: 'Aportes SENA', type: 'EXPENSE', side: 'DEBIT', parent: '5105', postable: true },

  // --- Pasivos (crédito) — prestaciones (25) ---
  { code: '2510', name: 'Cesantías por pagar', type: 'LIABILITY', side: 'CREDIT', parent: '25', postable: true },
  { code: '2515', name: 'Intereses sobre cesantías por pagar', type: 'LIABILITY', side: 'CREDIT', parent: '25', postable: true },
  { code: '2520', name: 'Prima de servicios por pagar', type: 'LIABILITY', side: 'CREDIT', parent: '25', postable: true },
  { code: '2525', name: 'Vacaciones por pagar', type: 'LIABILITY', side: 'CREDIT', parent: '25', postable: true },

  // --- Pasivos (crédito) — aportes (24) ---
  { code: '2375', name: 'Aportes salud (EPS) por pagar', type: 'LIABILITY', side: 'CREDIT', parent: '24', postable: true },
  { code: '2376', name: 'Aportes pensión por pagar', type: 'LIABILITY', side: 'CREDIT', parent: '24', postable: true },
  { code: '2377', name: 'Aportes ARL por pagar', type: 'LIABILITY', side: 'CREDIT', parent: '24', postable: true },
  { code: '2378', name: 'Aportes parafiscales (SENA/ICBF/Caja) por pagar', type: 'LIABILITY', side: 'CREDIT', parent: '24', postable: true },
];

const MAPPINGS: [string, string, string][] = [
  // Base (lado empleado) — aseguradas para que la nómina postee siempre.
  ['PAYROLL_EXPENSE', '5105', 'Gasto de nómina (devengado) al cerrar el periodo'],
  ['PAYROLL_WITHHOLDINGS', '2370', 'Deducciones de nómina por pagar (salud/pensión/retención)'],
  ['PAYROLL_PAYABLE', '2505', 'Neto de nómina por pagar a empleados'],
  // Carga patronal (lado empleador).
  ['PAYROLL_SEVERANCE_EXPENSE', '510530', 'Gasto provisión cesantías'],
  ['PAYROLL_SEVERANCE_INTEREST_EXPENSE', '510533', 'Gasto intereses sobre cesantías'],
  ['PAYROLL_SERVICE_BONUS_EXPENSE', '510536', 'Gasto provisión prima de servicios'],
  ['PAYROLL_VACATION_EXPENSE', '510539', 'Gasto provisión vacaciones'],
  ['PAYROLL_ARL_EXPENSE', '510568', 'Gasto aporte ARL'],
  ['PAYROLL_HEALTH_EXPENSE', '510569', 'Gasto aporte salud patronal'],
  ['PAYROLL_PENSION_EXPENSE', '510570', 'Gasto aporte pensión patronal'],
  ['PAYROLL_CCF_EXPENSE', '510572', 'Gasto aporte caja de compensación'],
  ['PAYROLL_ICBF_EXPENSE', '510575', 'Gasto aporte ICBF'],
  ['PAYROLL_SENA_EXPENSE', '510578', 'Gasto aporte SENA'],
  ['PAYROLL_SEVERANCE_PAYABLE', '2510', 'Cesantías por pagar'],
  ['PAYROLL_SEVERANCE_INTEREST_PAYABLE', '2515', 'Intereses sobre cesantías por pagar'],
  ['PAYROLL_SERVICE_BONUS_PAYABLE', '2520', 'Prima de servicios por pagar'],
  ['PAYROLL_VACATION_PAYABLE', '2525', 'Vacaciones por pagar'],
  ['PAYROLL_HEALTH_PAYABLE', '2375', 'Aportes salud por pagar'],
  ['PAYROLL_PENSION_PAYABLE', '2376', 'Aportes pensión por pagar'],
  ['PAYROLL_ARL_PAYABLE', '2377', 'Aportes ARL por pagar'],
  ['PAYROLL_PARAFISCAL_PAYABLE', '2378', 'Aportes parafiscales por pagar'],
];

async function main() {
  const codeToId = new Map<string, string>();
  for (const a of ACCOUNTS) {
    const level = a.code.length <= 1 ? 1 : a.code.length === 2 ? 2 : 3;
    const data = {
      name: a.name,
      type: a.type,
      normalSide: a.side,
      parentId: (await prisma.account.findUnique({ where: { code: a.parent } }))?.id ?? null,
      isPostable: a.postable ?? false,
      level,
    };
    const rec = await prisma.account.upsert({ where: { code: a.code }, update: data, create: { code: a.code, ...data } });
    codeToId.set(a.code, rec.id);
  }
  for (const [key, code, description] of MAPPINGS) {
    const accountId = codeToId.get(code) ?? (await prisma.account.findUnique({ where: { code } }))!.id;
    await prisma.accountMapping.upsert({ where: { key }, update: { accountId, description }, create: { key, accountId, description } });
  }
  console.log(`✅ Carga patronal: ${ACCOUNTS.length} cuentas y ${MAPPINGS.length} mapeos asegurados.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
