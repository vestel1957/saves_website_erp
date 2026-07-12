import { PrismaClient, AccountType } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Clean slate so the seed is idempotent
  await prisma.$transaction([
    prisma.kpi.deleteMany(),
    prisma.revenueMonth.deleteMany(),
    prisma.deal.deleteMany(),
    prisma.activity.deleteMany(),
    prisma.leaderboardEntry.deleteMany(),
    prisma.region.deleteMany(),
  ]);

  // ---- KPIs ----------------------------------------------------------------
  await prisma.kpi.createMany({
    data: [
      // primary row
      { key: 'revenue-mtd', group: 'primary', label: 'Ingresos del mes', value: '$248,930', delta: '+12.4%', deltaLabel: 'vs mes anterior', trend: 'up', icon: 'trending-up', sortOrder: 1 },
      { key: 'sales-pipeline', group: 'primary', label: 'Pipeline de ventas', value: '$1.82M', delta: '+8.1%', deltaLabel: '84 negocios abiertos', trend: 'up', icon: 'target', sortOrder: 2 },
      { key: 'cash-flow', group: 'primary', label: 'Flujo de caja', value: '$612,400', delta: '+3.7%', deltaLabel: 'neto a 30 días', trend: 'up', icon: 'wallet', sortOrder: 3 },
      { key: 'inventory-health', group: 'primary', label: 'Salud de inventario', value: '94.2%', delta: '−1.2pt', deltaLabel: 'nivel de servicio', trend: 'down', icon: 'package-check', sortOrder: 4 },
      // secondary row
      { key: 'team-productivity', group: 'secondary', label: 'Productividad del equipo', value: '87 / 100', delta: '+5pt', deltaLabel: 'puntaje semanal', trend: 'up', icon: 'activity', sortOrder: 5 },
      { key: 'csat', group: 'secondary', label: 'CSAT', value: '4.78 / 5', delta: '+0.12', deltaLabel: '1.204 respuestas', trend: 'up', icon: 'smile', sortOrder: 6 },
      { key: 'open-tickets', group: 'secondary', label: 'Tickets abiertos', value: '32', delta: '−9', deltaLabel: 'desde el lunes', trend: 'up', icon: 'life-buoy', sortOrder: 7 },
      { key: 'ai-insights', group: 'secondary', label: 'Insights de IA', value: '14 nuevos', delta: '5 críticos', deltaLabel: 'esta semana', trend: 'ai', icon: 'sparkles', sortOrder: 8 },
    ],
  });

  // ---- Revenue (last 12 months) -------------------------------------------
  // Values scaled from the design's bar heights; revenue sums to ~$2.41M YTD.
  await prisma.revenueMonth.createMany({
    data: [
      { month: 'Jul', revenue: 152000, target: 127000, sortOrder: 1 },
      { month: 'Ago', revenue: 165000, target: 139000, sortOrder: 2 },
      { month: 'Sep', revenue: 161000, target: 146000, sortOrder: 3 },
      { month: 'Oct', revenue: 187000, target: 161000, sortOrder: 4 },
      { month: 'Nov', revenue: 177000, target: 165000, sortOrder: 5 },
      { month: 'Dic', revenue: 210000, target: 175000, sortOrder: 6 },
      { month: 'Ene', revenue: 188000, target: 181000, sortOrder: 7 },
      { month: 'Feb', revenue: 215000, target: 187000, sortOrder: 8 },
      { month: 'Mar', revenue: 238000, target: 200000, sortOrder: 9 },
      { month: 'Abr', revenue: 223000, target: 207000, sortOrder: 10 },
      { month: 'May', revenue: 254000, target: 215000, sortOrder: 11 },
      { month: 'Jun', revenue: 239000, target: 223000, isCurrent: true, sortOrder: 12 },
    ],
  });

  // ---- Top deals -----------------------------------------------------------
  await prisma.deal.createMany({
    data: [
      { company: 'Acme Corp', name: 'Renovación anual', initials: 'SR', avatarColor: '#7C3AED', probability: 92, amount: 248000, sortOrder: 1 },
      { company: 'Globex', name: 'Expansión de plataforma', initials: 'MA', avatarColor: '#06B6D4', probability: 78, amount: 184000, sortOrder: 2 },
      { company: 'Hooli', name: 'Mejora empresarial', initials: 'JD', avatarColor: '#F59E0B', probability: 64, amount: 142000, sortOrder: 3 },
      { company: 'Stark', name: 'Multi-región', initials: 'EL', avatarColor: '#10B981', probability: 55, amount: 98000, sortOrder: 4 },
      { company: 'Initech', name: 'Licencia nueva', initials: 'SR', avatarColor: '#7C3AED', probability: 42, amount: 74000, sortOrder: 5 },
    ],
  });

  // ---- Recent activity -----------------------------------------------------
  await prisma.activity.createMany({
    data: [
      { title: 'Pedido #ORD-2926 despachado', source: 'Auto', timeAgo: 'hace 2 min', icon: 'check', variant: 'success', sortOrder: 1 },
      { title: 'Nuevo prospecto · Westfield Group', source: 'Marco A.', timeAgo: 'hace 8 min', icon: 'user-plus', variant: 'brand', sortOrder: 2 },
      { title: 'Pago recibido · $42,800', source: 'Stripe', timeAgo: 'hace 14 min', icon: 'dollar-sign', variant: 'success', sortOrder: 3 },
      { title: 'IA detectó riesgo de fuga · Initech', source: 'IA', timeAgo: 'hace 26 min', icon: 'sparkles', variant: 'ai', sortOrder: 4 },
      { title: 'Comentario en OC-1024', source: 'Sara R.', timeAgo: 'hace 42 min', icon: 'message-square', variant: 'accent', sortOrder: 5 },
      { title: 'Prospecto perdido · TechVibe', source: 'Elena L.', timeAgo: 'hace 1 h', icon: 'x', variant: 'error', sortOrder: 6 },
    ],
  });

  // ---- Sales leaderboard ---------------------------------------------------
  await prisma.leaderboardEntry.createMany({
    data: [
      { rank: 1, name: 'Sara Reyes', role: 'Ejec. Sr.', initials: 'SR', avatarColor: '#7C3AED', deals: 24, quotaPct: 88, amount: 486000 },
      { rank: 2, name: 'Marco Aragón', role: 'Ejecutivo', initials: 'MA', avatarColor: '#06B6D4', deals: 18, quotaPct: 76, amount: 412000 },
      { rank: 3, name: 'Elena Lima', role: 'Ejecutivo', initials: 'EL', avatarColor: '#10B981', deals: 15, quotaPct: 62, amount: 342000 },
      { rank: 4, name: 'Javier Díaz', role: 'Ejec. Sr.', initials: 'JD', avatarColor: '#F59E0B', deals: 13, quotaPct: 54, amount: 298000 },
      { rank: 5, name: 'Nora Petrova', role: 'Prospección', initials: 'NP', avatarColor: '#EC4899', deals: 22, quotaPct: 48, amount: 224000 },
    ],
  });

  // ---- Revenue by region ---------------------------------------------------
  await prisma.region.createMany({
    data: [
      { name: 'Norteamérica', color: '#7C3AED', amount: 968000, pct: 39, sortOrder: 1 },
      { name: 'Europa', color: '#06B6D4', amount: 624000, pct: 25, sortOrder: 2 },
      { name: 'Latinoamérica', color: '#EC4899', amount: 520000, pct: 21, sortOrder: 3 },
      { name: 'Asia Pacífico', color: '#10B981', amount: 378000, pct: 15, sortOrder: 4 },
    ],
  });

  // ========================================================================
  //  ACCOUNTING SEED (idempotent via upsert — no destructive deletes)
  // ========================================================================
  const normalSideFor = (t: AccountType): 'DEBIT' | 'CREDIT' =>
    t === 'ASSET' || t === 'EXPENSE' || t === 'COST' ? 'DEBIT' : 'CREDIT';

  // Generic, country-agnostic chart of accounts (editable from the UI).
  const chart: {
    code: string;
    name: string;
    type: AccountType;
    parent?: string;
    postable?: boolean;
  }[] = [
    // 1 · ASSETS
    { code: '1', name: 'Activo', type: 'ASSET' },
    { code: '11', name: 'Activo corriente', type: 'ASSET', parent: '1' },
    { code: '1105', name: 'Caja', type: 'ASSET', parent: '11', postable: true },
    { code: '1110', name: 'Bancos', type: 'ASSET', parent: '11', postable: true },
    { code: '1305', name: 'Cuentas por cobrar clientes', type: 'ASSET', parent: '11', postable: true },
    { code: '1355', name: 'Impuesto descontable (compras)', type: 'ASSET', parent: '11', postable: true },
    { code: '14', name: 'Inventarios', type: 'ASSET', parent: '1' },
    { code: '1435', name: 'Inventario de mercancías', type: 'ASSET', parent: '14', postable: true },
    // 2 · LIABILITIES
    { code: '2', name: 'Pasivo', type: 'LIABILITY' },
    { code: '22', name: 'Proveedores', type: 'LIABILITY', parent: '2' },
    { code: '2205', name: 'Cuentas por pagar proveedores', type: 'LIABILITY', parent: '22', postable: true },
    { code: '24', name: 'Impuestos por pagar', type: 'LIABILITY', parent: '2' },
    { code: '2365', name: 'Retención en la fuente por pagar', type: 'LIABILITY', parent: '24', postable: true },
    { code: '2367', name: 'Impuesto a las ventas retenido (ReteIVA)', type: 'LIABILITY', parent: '24', postable: true },
    { code: '2368', name: 'Impuesto de industria y comercio retenido (ReteICA)', type: 'LIABILITY', parent: '24', postable: true },
    { code: '2408', name: 'Impuesto a las ventas por pagar', type: 'LIABILITY', parent: '24', postable: true },
    { code: '2370', name: 'Retenciones y aportes de nómina por pagar', type: 'LIABILITY', parent: '24', postable: true },
    { code: '25', name: 'Obligaciones laborales', type: 'LIABILITY', parent: '2' },
    { code: '2505', name: 'Salarios por pagar', type: 'LIABILITY', parent: '25', postable: true },
    // 3 · EQUITY
    { code: '3', name: 'Patrimonio', type: 'EQUITY' },
    { code: '36', name: 'Resultados del ejercicio', type: 'EQUITY', parent: '3' },
    { code: '3605', name: 'Resultado del ejercicio', type: 'EQUITY', parent: '36', postable: true },
    { code: '3705', name: 'Resultados acumulados', type: 'EQUITY', parent: '3', postable: true },
    // 4 · INCOME
    { code: '4', name: 'Ingresos', type: 'INCOME' },
    { code: '41', name: 'Ingresos operacionales', type: 'INCOME', parent: '4' },
    { code: '4135', name: 'Comercio al por mayor y menor', type: 'INCOME', parent: '41', postable: true },
    // 5 · EXPENSES
    { code: '5', name: 'Gastos', type: 'EXPENSE' },
    { code: '51', name: 'Gastos operacionales', type: 'EXPENSE', parent: '5' },
    { code: '5105', name: 'Gastos de personal (nómina)', type: 'EXPENSE', parent: '51', postable: true },
    { code: '5135', name: 'Servicios', type: 'EXPENSE', parent: '51', postable: true },
    { code: '5195', name: 'Gastos diversos', type: 'EXPENSE', parent: '51', postable: true },
    // 6 · COST OF SALES
    { code: '6', name: 'Costos', type: 'COST' },
    { code: '61', name: 'Costo de ventas', type: 'COST', parent: '6' },
    { code: '6135', name: 'Costo de mercancías vendidas', type: 'COST', parent: '61', postable: true },
  ];

  const codeToId = new Map<string, string>();
  for (const a of chart) {
    const level = a.code.length <= 1 ? 1 : a.code.length === 2 ? 2 : 3;
    const data = {
      name: a.name,
      type: a.type,
      normalSide: normalSideFor(a.type),
      parentId: a.parent ? codeToId.get(a.parent) ?? null : null,
      isPostable: a.postable ?? false,
      level,
    };
    const rec = await prisma.account.upsert({
      where: { code: a.code },
      update: data,
      create: { code: a.code, ...data },
    });
    codeToId.set(a.code, rec.id);
  }

  // Event → GL account mapping (configurable in DB, drives automatic posting)
  const mappings: [string, string, string][] = [
    ['SALES_AR', '1305', 'Cuenta por cobrar al facturar una venta'],
    ['SALES_REVENUE', '4135', 'Ingreso por ventas'],
    ['SALES_TAX', '2408', 'Impuesto sobre ventas por pagar'],
    ['PURCHASE_AP', '2205', 'Cuenta por pagar al registrar una compra'],
    ['PURCHASE_EXPENSE', '5135', 'Gasto por compras de servicios'],
    ['PURCHASE_INVENTORY', '1435', 'Inventario por compras de mercancía'],
    ['PURCHASE_TAX', '1355', 'Impuesto descontable en compras'],
    ['BANK_DEFAULT', '1110', 'Banco por defecto para cobros/pagos'],
    ['COGS', '6135', 'Costo de mercancía vendida'],
    ['INVENTORY', '1435', 'Inventario de mercancías'],
    ['INCOME_SUMMARY', '3605', 'Resultado del ejercicio (cierre)'],
    ['RETAINED_EARNINGS', '3705', 'Resultados acumulados (cierre anual)'],
    ['PAYROLL_EXPENSE', '5105', 'Gasto de nómina (devengado) al cerrar el periodo'],
    ['PAYROLL_WITHHOLDINGS', '2370', 'Deducciones de nómina por pagar (salud/pensión/retención)'],
    ['PAYROLL_PAYABLE', '2505', 'Neto de nómina por pagar a empleados'],
  ];
  for (const [key, code, description] of mappings) {
    const accountId = codeToId.get(code)!;
    await prisma.accountMapping.upsert({
      where: { key },
      update: { accountId, description },
      create: { key, accountId, description },
    });
  }

  // --- Fixed assets: PP&E accounts (incl. contra-asset) + categories ---
  // normalSide is explicit here because accumulated depreciation (1592) is a
  // CREDIT-natured asset, which the generic normalSideFor() can't infer.
  const ppeAccounts: {
    code: string;
    name: string;
    type: AccountType;
    side: 'DEBIT' | 'CREDIT';
    parent: string;
    postable?: boolean;
  }[] = [
    { code: '15', name: 'Propiedad, planta y equipo', type: 'ASSET', side: 'DEBIT', parent: '1' },
    { code: '1524', name: 'Equipo de oficina', type: 'ASSET', side: 'DEBIT', parent: '15', postable: true },
    { code: '1528', name: 'Equipo de cómputo y comunicación', type: 'ASSET', side: 'DEBIT', parent: '15', postable: true },
    { code: '1540', name: 'Flota y equipo de transporte', type: 'ASSET', side: 'DEBIT', parent: '15', postable: true },
    { code: '1592', name: 'Depreciación acumulada', type: 'ASSET', side: 'CREDIT', parent: '15', postable: true },
    { code: '51', name: 'Gastos operacionales', type: 'EXPENSE', side: 'DEBIT', parent: '5' },
    { code: '5160', name: 'Depreciaciones', type: 'EXPENSE', side: 'DEBIT', parent: '51', postable: true },
    { code: '42', name: 'Ingresos no operacionales', type: 'INCOME', side: 'CREDIT', parent: '4' },
    { code: '4248', name: 'Utilidad en venta de propiedad, planta y equipo', type: 'INCOME', side: 'CREDIT', parent: '42', postable: true },
    { code: '53', name: 'Gastos no operacionales', type: 'EXPENSE', side: 'DEBIT', parent: '5' },
    { code: '5310', name: 'Pérdida en venta y retiro de bienes', type: 'EXPENSE', side: 'DEBIT', parent: '53', postable: true },
  ];
  for (const a of ppeAccounts) {
    const level = a.code.length <= 1 ? 1 : a.code.length === 2 ? 2 : 3;
    const data = {
      name: a.name,
      type: a.type,
      normalSide: a.side,
      parentId: codeToId.get(a.parent) ?? null,
      isPostable: a.postable ?? false,
      level,
    };
    const rec = await prisma.account.upsert({
      where: { code: a.code },
      update: data,
      create: { code: a.code, ...data },
    });
    codeToId.set(a.code, rec.id);
  }

  for (const [key, code, description] of [
    ['ASSET_DISPOSAL_GAIN', '4248', 'Utilidad en venta de activos fijos'],
    ['ASSET_DISPOSAL_LOSS', '5310', 'Pérdida en baja/venta de activos fijos'],
  ] as [string, string, string][]) {
    const accountId = codeToId.get(code)!;
    await prisma.accountMapping.upsert({
      where: { key },
      update: { accountId, description },
      create: { key, accountId, description },
    });
  }

  // Asset categories — each carries its depreciation policy + GL accounts
  const categories: {
    code: string;
    name: string;
    usefulLifeMonths: number;
    asset: string;
  }[] = [
    { code: 'COMP', name: 'Equipo de cómputo y comunicación', usefulLifeMonths: 36, asset: '1528' },
    { code: 'MUEB', name: 'Muebles y equipo de oficina', usefulLifeMonths: 120, asset: '1524' },
    { code: 'VEHIC', name: 'Flota y equipo de transporte', usefulLifeMonths: 60, asset: '1540' },
  ];
  for (const c of categories) {
    const data = {
      name: c.name,
      method: 'STRAIGHT_LINE' as const,
      usefulLifeMonths: c.usefulLifeMonths,
      assetAccountId: codeToId.get(c.asset)!,
      depreciationExpenseAccountId: codeToId.get('5160')!,
      accumulatedDepreciationAccountId: codeToId.get('1592')!,
    };
    await prisma.fixedAssetCategory.upsert({
      where: { code: c.code },
      update: data,
      create: { code: c.code, ...data },
    });
  }

  // Configurable tax engine (country agnostic) — rates editable per tax code
  await prisma.taxCode.upsert({
    where: { code: 'IVA19' },
    update: { rate: '0.19', accountId: codeToId.get('2408')! },
    create: { code: 'IVA19', name: 'IVA 19% (ventas)', kind: 'SALES', rate: '0.19', accountId: codeToId.get('2408')! },
  });
  await prisma.taxCode.upsert({
    where: { code: 'IVA19P' },
    update: { rate: '0.19', accountId: codeToId.get('1355')! },
    create: { code: 'IVA19P', name: 'IVA 19% (compras)', kind: 'PURCHASE', rate: '0.19', accountId: codeToId.get('1355')! },
  });

  // Retenciones (Colombia) — empresa como agente retenedor. Tarifas editables
  // por código; la base define sobre qué se aplica (SUBTOTAL o el IVA).
  const withholdingCodes: {
    code: string;
    name: string;
    rate: string;
    base: 'SUBTOTAL' | 'TAX';
    account: string;
  }[] = [
    { code: 'RFTE_COMPRAS', name: 'ReteFuente compras 2.5%', rate: '0.025', base: 'SUBTOTAL', account: '2365' },
    { code: 'RFTE_SERVICIOS', name: 'ReteFuente servicios 4%', rate: '0.04', base: 'SUBTOTAL', account: '2365' },
    { code: 'RFTE_HONORARIOS', name: 'ReteFuente honorarios 11%', rate: '0.11', base: 'SUBTOTAL', account: '2365' },
    { code: 'RFTE_ARRENDAM', name: 'ReteFuente arrendamientos 3.5%', rate: '0.035', base: 'SUBTOTAL', account: '2365' },
    { code: 'RETEIVA15', name: 'ReteIVA 15%', rate: '0.15', base: 'TAX', account: '2367' },
    { code: 'RETEICA966', name: 'ReteICA 9.66 x mil', rate: '0.00966', base: 'SUBTOTAL', account: '2368' },
  ];
  for (const w of withholdingCodes) {
    const accountId = codeToId.get(w.account)!;
    await prisma.taxCode.upsert({
      where: { code: w.code },
      update: { name: w.name, rate: w.rate, base: w.base, accountId },
      create: { code: w.code, name: w.name, kind: 'WITHHOLDING', rate: w.rate, base: w.base, accountId },
    });
  }

  // Open fiscal period for the current month
  const now = new Date();
  const y = now.getFullYear();
  const mo = now.getMonth() + 1;
  await prisma.fiscalPeriod.upsert({
    where: { year_month: { year: y, month: mo } },
    update: {},
    create: {
      name: `${y}-${String(mo).padStart(2, '0')}`,
      type: 'MONTH',
      year: y,
      month: mo,
      startDate: new Date(Date.UTC(y, mo - 1, 1)),
      endDate: new Date(Date.UTC(y, mo, 0)),
      status: 'OPEN',
    },
  });

  // Journal numbering counter
  await prisma.sequence.upsert({
    where: { key: 'journal' },
    update: {},
    create: { key: 'journal', value: 0 },
  });

  // Demo master data so the auto-posting flow can be exercised immediately
  await prisma.party.upsert({
    where: { id: 'seed-customer' },
    update: {},
    create: { id: 'seed-customer', kind: 'CUSTOMER', name: 'Cliente Demo S.A.', taxId: '900123456', email: 'cliente@demo.com' },
  });
  await prisma.party.upsert({
    where: { id: 'seed-supplier' },
    update: {},
    create: { id: 'seed-supplier', kind: 'SUPPLIER', name: 'Proveedor Demo Ltda.', taxId: '800987654', email: 'proveedor@demo.com' },
  });
  await prisma.bankAccount.upsert({
    where: { id: 'seed-bank' },
    update: {},
    create: { id: 'seed-bank', name: 'Banco Principal', accountNumber: '0001-2345', glAccountId: codeToId.get('1110')!, currency: 'USD', balance: '0' },
  });

  console.log('✅ Seed completed (dashboard + accounting).');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
