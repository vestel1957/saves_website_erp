import { ReportsService, SIN_ASIGNAR } from './reports.service';
import { CostCentersService } from './cost-centers.service';

/**
 * Estado de resultados por sede (docs/centros-de-costo/PLAN.md, fase 5):
 *   - la suma de las columnas es el estado de resultados total (el invariante);
 *   - lo que no tiene centro sale en «Sin asignar», nunca repartido;
 *   - un centro hijo suma en su sede; un centro suelto con movimiento tiene su columna;
 *   - las sedes y el general salen aunque estén en cero, y los asientos de cierre no cuentan;
 *   - `incomeStatement` filtrado por centro da lo mismo que su columna.
 * Y la edición del centro: enlazar / desenlazar sede sin pisar a otro centro.
 */

const CUENTAS = [
  { id: 'caja', code: '110505', name: 'Caja general', type: 'ASSET' },
  { id: 'ingreso', code: '415560', name: 'Servicio de internet', type: 'INCOME' },
  { id: 'costo', code: '613595', name: 'Costo del servicio', type: 'COST' },
  { id: 'gasto', code: '519595', name: 'Otros gastos', type: 'EXPENSE' },
];

const CENTROS = [
  { id: 'raiz', code: 'VESTEL', name: 'Vestel', kind: 'OTRO', isActive: true, parentId: null, branch: null },
  { id: 'admin', code: 'CC-ADMIN', name: 'Administración general', kind: 'GENERAL', isActive: true, parentId: 'raiz', branch: null },
  { id: 'villa', code: 'CC-VILLANUEVA', name: 'Villanueva', kind: 'SEDE', isActive: true, parentId: 'raiz', branch: { legacyId: 3, name: 'Villanueva' } },
  { id: 'yopal', code: 'CC-YOPAL', name: 'Yopal', kind: 'SEDE', isActive: true, parentId: 'raiz', branch: { legacyId: 2, name: 'Yopal' } },
  { id: 'mocoa', code: 'CC-MOCOA', name: 'Mocoa', kind: 'SEDE', isActive: false, parentId: 'raiz', branch: { legacyId: 5, name: 'Mocoa' } },
  { id: 'yopal-tec', code: 'CC-YOPAL-TEC', name: 'Técnicos Yopal', kind: 'OTRO', isActive: true, parentId: 'yopal', branch: null },
  { id: 'proyecto', code: 'PRY-1', name: 'Proyecto fibra', kind: 'OTRO', isActive: true, parentId: 'raiz', branch: null },
  { id: 'vacio', code: 'OTRO-VACIO', name: 'Sin uso', kind: 'OTRO', isActive: true, parentId: null, branch: null },
];

type Linea = { accountId: string; costCenterId: string | null; debit: number; credit: number; cierre?: boolean };

const LINEAS: Linea[] = [
  // Yopal: factura de 100 (ingreso) y su cobro (caja, que no es de resultado).
  { accountId: 'ingreso', costCenterId: 'yopal', debit: 0, credit: 100 },
  { accountId: 'caja', costCenterId: 'yopal', debit: 100, credit: 0 },
  // Técnicos de Yopal: un gasto que debe sumar en Yopal.
  { accountId: 'gasto', costCenterId: 'yopal-tec', debit: 30, credit: 0 },
  // Villanueva: ingreso con una nota crédito y un costo.
  { accountId: 'ingreso', costCenterId: 'villa', debit: 0, credit: 250.5 },
  { accountId: 'ingreso', costCenterId: 'villa', debit: 50.25, credit: 0 },
  { accountId: 'costo', costCenterId: 'villa', debit: 80, credit: 0 },
  // Administración general: gasto compartido.
  { accountId: 'gasto', costCenterId: 'admin', debit: 70, credit: 0 },
  // Un centro suelto con movimiento.
  { accountId: 'gasto', costCenterId: 'proyecto', debit: 12.34, credit: 0 },
  // Sin centro.
  { accountId: 'ingreso', costCenterId: null, debit: 0, credit: 40 },
  // Asiento de cierre: no cuenta en un P&G.
  { accountId: 'ingreso', costCenterId: 'yopal', debit: 100, credit: 0, cierre: true },
];

function agrupar(lineas: Linea[], por: string[]) {
  const grupos = new Map<string, { accountId: string; costCenterId?: string | null; _sum: { debit: number; credit: number } }>();
  for (const l of lineas) {
    const clave = por.map((k) => String((l as never)[k])).join('|');
    const g = grupos.get(clave) ?? {
      accountId: l.accountId,
      ...(por.includes('costCenterId') ? { costCenterId: l.costCenterId } : {}),
      _sum: { debit: 0, credit: 0 },
    };
    g._sum.debit += l.debit;
    g._sum.credit += l.credit;
    grupos.set(clave, g);
  }
  return [...grupos.values()];
}

function prismaDeMentira(lineas: Linea[] = LINEAS) {
  return {
    journalLine: {
      groupBy: jest.fn(async (args: { by: string[]; where: Record<string, any> }) => {
        const w = args.where;
        let ls = lineas;
        if (w.entry?.type?.not === 'CLOSING') ls = ls.filter((l) => !l.cierre);
        if ('costCenterId' in w) ls = ls.filter((l) => l.costCenterId === w.costCenterId);
        if (w.account?.type?.in) {
          const tipos: string[] = w.account.type.in;
          ls = ls.filter((l) => tipos.includes(CUENTAS.find((c) => c.id === l.accountId)!.type));
        }
        return agrupar(ls, args.by);
      }),
    },
    account: {
      findMany: jest.fn(async (args?: { where?: { type?: { in: string[] } } }) =>
        CUENTAS.filter((c) => !args?.where?.type?.in || args.where.type.in.includes(c.type))),
    },
    costCenter: { findMany: jest.fn(async () => CENTROS) },
  };
}

describe('ReportsService.incomeStatementByCenter', () => {
  it('las columnas suman el estado de resultados total y el cuadre lo confirma', async () => {
    const rs = new ReportsService(prismaDeMentira() as never);
    const r = await rs.incomeStatementByCenter({ from: '2026-09-01', to: '2026-09-30' });
    const total = await rs.incomeStatement({ from: '2026-09-01', to: '2026-09-30' });

    expect(r.cuadre.ok).toBe(true);
    expect(r.totals).toEqual(total.totals);
    expect(r.totals).toEqual({
      totalIncome: 340.25, totalCosts: 80, grossProfit: 260.25, totalExpenses: 112.34, netIncome: 147.91,
    });
    const suma = r.columns.reduce((t, c) => t + r.totalsByColumn[c.key].netIncome, 0);
    expect(Math.round(suma * 100) / 100).toBe(total.totals.netIncome);
  });

  it('columnas: sedes por gid (también en cero o inactivas), general, sueltos con movimiento y «Sin asignar» al final', async () => {
    const rs = new ReportsService(prismaDeMentira() as never);
    const r = await rs.incomeStatementByCenter();
    expect(r.columns.map((c) => c.code || c.key)).toEqual([
      'CC-YOPAL', 'CC-VILLANUEVA', 'CC-MOCOA', 'CC-ADMIN', 'PRY-1', SIN_ASIGNAR,
    ]);
    // El hijo de Yopal no tiene columna propia, y un OTRO sin movimiento tampoco.
    expect(r.columns.find((c) => c.code === 'CC-YOPAL-TEC')).toBeUndefined();
    expect(r.columns.find((c) => c.code === 'OTRO-VACIO')).toBeUndefined();
    expect(r.totalsByColumn['mocoa'].netIncome).toBe(0);
  });

  it('cada centro en su columna; el hijo suma en su sede y lo que no tiene centro, en «Sin asignar»', async () => {
    const rs = new ReportsService(prismaDeMentira() as never);
    const r = await rs.incomeStatementByCenter();
    expect(r.totalsByColumn['yopal']).toMatchObject({ totalIncome: 100, totalExpenses: 30, netIncome: 70 });
    expect(r.totalsByColumn['villa']).toMatchObject({ totalIncome: 200.25, totalCosts: 80, grossProfit: 120.25, netIncome: 120.25 });
    expect(r.totalsByColumn['admin']).toMatchObject({ totalExpenses: 70, netIncome: -70 });
    expect(r.totalsByColumn['proyecto']).toMatchObject({ totalExpenses: 12.34 });
    expect(r.totalsByColumn[SIN_ASIGNAR]).toMatchObject({ totalIncome: 40, netIncome: 40 });

    // Filas: sólo cuentas de resultado, cada una con su reparto y su total.
    expect(r.income).toEqual([
      { accountId: 'ingreso', code: '415560', name: 'Servicio de internet', amounts: { yopal: 100, villa: 200.25, [SIN_ASIGNAR]: 40 }, total: 340.25 },
    ]);
    expect(r.expenses[0].amounts).toEqual({ yopal: 30, admin: 70, proyecto: 12.34 });
    expect([...r.income, ...r.costs, ...r.expenses].some((f) => f.code === '110505')).toBe(false);
  });

  it('incomeStatement filtrado por un centro o por «Sin asignar» (null)', async () => {
    const rs = new ReportsService(prismaDeMentira() as never);
    expect((await rs.incomeStatement(undefined, { costCenterId: 'villa' })).totals.netIncome).toBe(120.25);
    expect((await rs.incomeStatement(undefined, { costCenterId: null })).totals.netIncome).toBe(40);
    // Sin filtro, todo (menos el cierre).
    expect((await rs.incomeStatement()).totals.netIncome).toBe(147.91);
  });

  it('sin movimientos: todo en cero y cuadra', async () => {
    const rs = new ReportsService(prismaDeMentira([]) as never);
    const r = await rs.incomeStatementByCenter({ from: '2030-01-01', to: '2030-01-31' });
    expect(r.cuadre.ok).toBe(true);
    expect(r.totals.netIncome).toBe(0);
    expect(r.income).toEqual([]);
    expect(r.columns.at(-1)?.key).toBe(SIN_ASIGNAR);
  });
});

describe('CostCentersService.update', () => {
  function armar(centro: { id: string; kind: string; branch: { id: string; legacyId: number } | null }, sede?: unknown) {
    const tx = {
      branch: { update: jest.fn(async () => ({})) },
      costCenter: { update: jest.fn(async (a: { data: unknown }) => ({ id: centro.id, ...(a.data as object) })) },
    };
    const prisma = {
      costCenter: { findUnique: jest.fn(async () => centro) },
      branch: { findUnique: jest.fn(async () => sede ?? null) },
      $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    return { svc: new CostCentersService(prisma as never), prisma, tx };
  }

  it('cambia el nombre (recortado) y el estado sin tocar la sede', async () => {
    const { svc, tx } = armar({ id: 'yopal', kind: 'SEDE', branch: { id: 'b2', legacyId: 2 } });
    await svc.update('yopal', { name: '  Yopal centro ', isActive: false });
    expect(tx.costCenter.update).toHaveBeenCalledWith(expect.objectContaining({ data: { name: 'Yopal centro', isActive: false } }));
    expect(tx.branch.update).not.toHaveBeenCalled();
  });

  it('rechaza un nombre vacío', async () => {
    const { svc } = armar({ id: 'yopal', kind: 'SEDE', branch: null });
    await expect(svc.update('yopal', { name: '  ' })).rejects.toThrow('vacío');
  });

  it('enlaza una sede libre, desenlaza la anterior y marca el centro como de sede', async () => {
    const { svc, tx } = armar(
      { id: 'pry', kind: 'OTRO', branch: { id: 'b6', legacyId: 6 } },
      { id: 'b5', name: 'Mocoa', costCenter: null },
    );
    await svc.update('pry', { branchLegacyId: 5 });
    expect(tx.branch.update).toHaveBeenNthCalledWith(1, { where: { id: 'b6' }, data: { costCenterId: null } });
    expect(tx.branch.update).toHaveBeenNthCalledWith(2, { where: { id: 'b5' }, data: { costCenterId: 'pry' } });
    expect(tx.costCenter.update).toHaveBeenCalledWith(expect.objectContaining({ data: { kind: 'SEDE' } }));
  });

  it('no roba una sede enlazada con otro centro', async () => {
    const { svc, tx } = armar(
      { id: 'pry', kind: 'OTRO', branch: null },
      { id: 'b2', name: 'Yopal', costCenter: { id: 'yopal', code: 'CC-YOPAL' } },
    );
    await expect(svc.update('pry', { branchLegacyId: 2 })).rejects.toThrow('CC-YOPAL');
    expect(tx.branch.update).not.toHaveBeenCalled();
  });

  it('«Administración general» no se enlaza con una sede', async () => {
    const { svc } = armar({ id: 'admin', kind: 'GENERAL', branch: null }, { id: 'b2', name: 'Yopal', costCenter: null });
    await expect(svc.update('admin', { branchLegacyId: 2 })).rejects.toThrow('Administración general');
  });

  it('desenlazar (null) suelta la sede y el centro pasa a «otro»', async () => {
    const { svc, tx } = armar({ id: 'yopal', kind: 'SEDE', branch: { id: 'b2', legacyId: 2 } });
    await svc.update('yopal', { branchLegacyId: null });
    expect(tx.branch.update).toHaveBeenCalledWith({ where: { id: 'b2' }, data: { costCenterId: null } });
    expect(tx.costCenter.update).toHaveBeenCalledWith(expect.objectContaining({ data: { kind: 'OTRO' } }));
  });

  it('volver a mandar la misma sede no hace nada con las sedes', async () => {
    const { svc, prisma, tx } = armar({ id: 'yopal', kind: 'SEDE', branch: { id: 'b2', legacyId: 2 } });
    await svc.update('yopal', { branchLegacyId: 2 });
    expect(prisma.branch.findUnique).not.toHaveBeenCalled();
    expect(tx.branch.update).not.toHaveBeenCalled();
  });

  it('404 si el centro no existe', async () => {
    const { svc, prisma } = armar({ id: 'x', kind: 'OTRO', branch: null });
    prisma.costCenter.findUnique.mockResolvedValueOnce(null as never);
    await expect(svc.update('x', { name: 'a' })).rejects.toThrow('no encontrado');
  });
});
