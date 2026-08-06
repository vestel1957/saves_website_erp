import { PeriodsService } from './periods.service';

/**
 * Lo que se prueba aquí es el ARRASTRE DE FIN DE MES, que es donde una equivocación no
 * se ve hasta el mes siguiente:
 *   - las cuentas de resultado se barren a cero contra Utilidad del ejercicio;
 *   - las de balance conservan su saldo y NO entran en el asiento de cierre;
 *   - la utilidad sale del neto y el asiento cuadra;
 *   - no se cierra un mes con el anterior abierto (su saldo de entrada aún se mueve);
 *   - reabrir borra el asiento de cierre y el arrastre, para poder rehacerlos.
 */

const JULIO = {
  id: 'p-julio', name: '2026-07', type: 'MONTH', status: 'OPEN',
  startDate: new Date('2026-07-01T00:00:00.000Z'),
  endDate: new Date('2026-07-31T23:59:59.999Z'),
};

const CUENTAS = [
  { id: 'caja', code: '110505', name: 'Caja general', type: 'ASSET' },
  { id: 'ingreso', code: '415560', name: 'Servicio de internet', type: 'INCOME' },
  { id: 'gasto', code: '519595', name: 'Otros gastos', type: 'EXPENSE' },
  { id: 'utilidad', code: '360505', name: 'Utilidad del ejercicio', type: 'EQUITY' },
];

/**
 * Prisma de mentira. `groupBy` responde distinto según se le pregunte por lo ANTERIOR
 * al periodo (saldo de entrada) o por lo de DENTRO, que es la distinción de la que sale
 * todo el cálculo.
 */
function armar(opciones: {
  anteriores?: { accountId: string; debit: number; credit: number }[];
  movimientos?: { accountId: string; debit: number; credit: number }[];
  periodo?: Partial<typeof JULIO>;
  anterior?: { id: string; name: string; status: string } | null;
  siguienteCerrado?: { name: string } | null;
} = {}) {
  const suma = (fs: { accountId: string; debit: number; credit: number }[]) =>
    fs.map((f) => ({ accountId: f.accountId, _sum: { debit: f.debit, credit: f.credit } }));

  const journalLine = {
    groupBy: jest.fn(({ where }: any) =>
      Promise.resolve(where.entry.date?.lt ? suma(opciones.anteriores ?? []) : suma(opciones.movimientos ?? [])),
    ),
  };
  const fiscalPeriod = {
    findUnique: jest.fn().mockResolvedValue({ ...JULIO, ...(opciones.periodo ?? {}) }),
    // Se usa para el mes anterior (al cerrar) y para el siguiente (al reabrir).
    findFirst: jest.fn(({ where }: any) =>
      Promise.resolve(where.status ? opciones.siguienteCerrado ?? null : opciones.anterior ?? null),
    ),
    update: jest.fn((args: any) => Promise.resolve({ ...JULIO, ...args.data })),
  };
  const journalEntry = { create: jest.fn().mockResolvedValue({ id: 'a-1', number: 77 }), deleteMany: jest.fn().mockResolvedValue({ count: 1 }), findUnique: jest.fn().mockResolvedValue(null) };
  // El número de asiento sale de una secuencia de Postgres (`nextTid`): dentro de la
  // transacción se le pide al mismo cliente, así que el `tx` de mentira la responde.
  const $queryRaw = jest.fn().mockResolvedValue([{ tid: 77n }]);
  const fiscalPeriodBalance = { deleteMany: jest.fn().mockResolvedValue({ count: 0 }), createMany: jest.fn().mockResolvedValue({ count: 0 }), findMany: jest.fn().mockResolvedValue([]) };
  const prisma = {
    journalLine,
    account: { findMany: jest.fn().mockResolvedValue(CUENTAS) },
    fiscalPeriod, journalEntry, fiscalPeriodBalance,
    $transaction: jest.fn((cb: any) => cb({ journalEntry, fiscalPeriodBalance, fiscalPeriod, $queryRaw })),
  };
  return { svc: new PeriodsService(prisma as never), prisma, journalEntry, fiscalPeriodBalance, fiscalPeriod };
}

describe('PeriodsService — arrastre de fin de mes', () => {
  it('barre las cuentas de resultado y deja intactas las de balance', async () => {
    const { svc } = armar({
      movimientos: [
        { accountId: 'caja', debit: 55000, credit: 1234 },
        { accountId: 'ingreso', debit: 0, credit: 5000 },
        { accountId: 'gasto', debit: 1234, credit: 0 },
      ],
    });

    const previa = await svc.preview('p-julio');
    const por = (id: string) => previa.filas.find((f) => f.accountId === id)!;

    // La de balance arrastra su saldo; las de resultado salen en cero.
    expect(por('caja').closing).toBe(53766);
    expect(por('ingreso').closing).toBe(0);
    expect(por('gasto').closing).toBe(0);
    // Y solo las de resultado entran en el asiento, por el lado contrario a su saldo.
    expect(previa.cierre.lineas).toEqual([
      { accountId: 'ingreso', code: '415560', name: 'Servicio de internet', debit: 5000, credit: 0 },
      { accountId: 'gasto', code: '519595', name: 'Otros gastos', debit: 0, credit: 1234 },
    ]);
    expect(previa.cierre.utilidad).toBe(3766);
  });

  it('arrastra el saldo con el que la cuenta ENTRÓ, no solo lo que se movió', async () => {
    const { svc } = armar({
      anteriores: [{ accountId: 'caja', debit: 10000, credit: 0 }],
      movimientos: [{ accountId: 'caja', debit: 0, credit: 4000 }],
    });

    const previa = await svc.preview('p-julio');
    const caja = previa.filas.find((f) => f.accountId === 'caja')!;
    expect(caja.opening).toBe(10000);
    expect(caja.closing).toBe(6000); // 10.000 que traía − 4.000 que salió
  });

  it('con pérdida, la contrapartida va al débito de Utilidad del ejercicio', async () => {
    const { svc, journalEntry } = armar({
      movimientos: [
        { accountId: 'ingreso', debit: 0, credit: 1000 },
        { accountId: 'gasto', debit: 2500, credit: 0 },
      ],
    });

    const r = await svc.close('p-julio', 'Contadora');

    expect(r.utilidad).toBe(-1500);
    const lineas = journalEntry.create.mock.calls[0][0].data.lines.create;
    const contrapartida = lineas.at(-1);
    expect(contrapartida.accountId).toBe('utilidad');
    expect(contrapartida.debit).toBe(1500);
    expect(contrapartida.credit).toBe(0);
    // El asiento cuadra: 1.000 + 1.500 al débito contra 2.500 al crédito.
    const suma = (k: 'debit' | 'credit') => lineas.reduce((s: number, l: any) => s + l[k], 0);
    expect(suma('debit')).toBe(suma('credit'));
  });

  it('un mes sin movimientos ni saldos no escribe asiento de cierre', async () => {
    const { svc, journalEntry } = armar({});

    const r = await svc.close('p-julio');

    expect(r.asientoCierre).toBeNull();
    expect(journalEntry.create).not.toHaveBeenCalled();
  });

  it('no cierra si el mes anterior sigue abierto', async () => {
    const { svc, journalEntry } = armar({
      anterior: { id: 'p-junio', name: '2026-06', status: 'OPEN' },
      movimientos: [{ accountId: 'ingreso', debit: 0, credit: 100 }],
    });

    await expect(svc.close('p-julio')).rejects.toThrow('Cierra primero 2026-06');
    expect(journalEntry.create).not.toHaveBeenCalled();
  });

  it('no reabre si el mes siguiente ya está cerrado', async () => {
    const { svc, journalEntry } = armar({
      periodo: { status: 'CLOSED' },
      siguienteCerrado: { name: '2026-08' },
    });

    await expect(svc.reopen('p-julio')).rejects.toThrow('Reabre primero 2026-08');
    expect(journalEntry.deleteMany).not.toHaveBeenCalled();
  });

  it('reabrir borra el asiento de cierre y el arrastre guardado', async () => {
    const { svc, journalEntry, fiscalPeriodBalance } = armar({ periodo: { status: 'CLOSED' } });

    await svc.reopen('p-julio');

    // Se borra en vez de reversar: el asiento se rehace solo al volver a cerrar, y el
    // índice único (sourceType, sourceId) no dejaría escribir el nuevo con el viejo ahí.
    expect(journalEntry.deleteMany).toHaveBeenCalledWith({ where: { sourceType: 'CLOSING', sourceId: 'p-julio' } });
    expect(fiscalPeriodBalance.deleteMany).toHaveBeenCalledWith({ where: { periodId: 'p-julio' } });
  });
});
