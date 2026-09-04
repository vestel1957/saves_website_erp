/**
 * `aplicarNotaEnTx` escribe en la BD: aquí sólo interesa QUÉ nota se manda escribir.
 * Se apunta en `notas` y se vacía en cada prueba.
 */
const notas: { invoiceId: string; opts: { type: string; amount: number; description?: string } }[] = [];
jest.mock('./nota-en-tx', () => ({
  aplicarNotaEnTx: jest.fn(async (_tx: unknown, invoiceId: string, opts: never) => {
    notas.push({ invoiceId, opts });
  }),
}));

import {
  concederDescuentosAdelantados, mesSiguiente, MINIMO_ANTICIPO, NOTA_ADELANTO,
  propuestaAdelanto, repartirAnticipos,
} from './anticipos';

beforeEach(() => { notas.length = 0; });

const anticipo = (id: string, pendiente: number) => ({ id, pendiente });
const factura = (tid: number, saldo: number) => ({ id: `f${tid}`, tid, saldo });

describe('repartirAnticipos', () => {
  it('el caso de ventanilla: pagó dos meses y el segundo nace pagado', () => {
    // Agosto (45.000) se cobró en la cascada del recaudo; el excedente quedó como
    // anticipo y en septiembre nace la factura del mes por el mismo valor.
    const reparto = repartirAnticipos([anticipo('a1', 45000)], [factura(500123, 45000)]);
    expect(reparto).toEqual([{ advanceId: 'a1', invoiceId: 'f500123', tid: 500123, amount: 45000 }]);
  });

  it('reparte un anticipo grande entre varias facturas, de la más vieja a la más nueva', () => {
    const reparto = repartirAnticipos(
      [anticipo('a1', 100000)],
      [factura(1, 45000), factura(2, 45000), factura(3, 45000)],
    );
    expect(reparto.map((r) => [r.tid, r.amount])).toEqual([[1, 45000], [2, 45000], [3, 10000]]);
  });

  it('gasta primero el anticipo más antiguo', () => {
    const reparto = repartirAnticipos(
      [anticipo('viejo', 30000), anticipo('nuevo', 30000)],
      [factura(1, 45000)],
    );
    expect(reparto).toEqual([
      { advanceId: 'viejo', invoiceId: 'f1', tid: 1, amount: 30000 },
      { advanceId: 'nuevo', invoiceId: 'f1', tid: 1, amount: 15000 },
    ]);
  });

  it('no deja una factura pagada de más', () => {
    const reparto = repartirAnticipos([anticipo('a1', 200000)], [factura(1, 45000)]);
    expect(reparto).toHaveLength(1);
    expect(reparto[0].amount).toBe(45000);
  });

  it('no reparte calderilla por debajo del mínimo', () => {
    expect(repartirAnticipos([anticipo('a1', MINIMO_ANTICIPO - 1)], [factura(1, 45000)])).toEqual([]);
    // Y deja de repartir cuando lo que queda ya no llega al mínimo.
    const reparto = repartirAnticipos([anticipo('a1', 45020)], [factura(1, 45000), factura(2, 45000)]);
    expect(reparto).toHaveLength(1);
  });

  it('sin facturas pendientes no imputa nada (el saldo espera al mes siguiente)', () => {
    expect(repartirAnticipos([anticipo('a1', 45000)], [])).toEqual([]);
  });

  it('nunca imputa más de lo que hay a favor', () => {
    const reparto = repartirAnticipos(
      [anticipo('a1', 45000)],
      [factura(1, 20000), factura(2, 20000), factura(3, 20000)],
    );
    expect(reparto.reduce((s, r) => s + r.amount, 0)).toBe(45000);
  });
});

describe('mesSiguiente', () => {
  it('cuenta por AÑO/MES, no sumando 30 días', () => {
    // El 31 de enero + 1 mes con aritmética de fechas se va al 3 de marzo. Aquí no:
    // lo único que importa es qué MES se está adelantando.
    expect(mesSiguiente(new Date(Date.UTC(2026, 0, 31)), 1).toISOString().slice(0, 10)).toBe('2026-02-01');
    expect(mesSiguiente(new Date(Date.UTC(2026, 11, 1)), 1).toISOString().slice(0, 10)).toBe('2027-01-01');
    expect(mesSiguiente(new Date(Date.UTC(2026, 8, 1)), 2).toISOString().slice(0, 10)).toBe('2026-11-01');
  });
});

/**
 * Prisma de pega con lo justo: las cuatro consultas que hace el adelanto. Cada campo
 * es una lista y las escrituras se apuntan para poder afirmarlas.
 */
function txFalso(opts: {
  ultimaFactura?: { invoiceDate: Date; total: number } | null;
  servicios?: { price: number; qty: number; taxRate: number }[];
  pct?: string | null;
  anticipos?: Record<string, unknown>[];
  pendientes?: Record<string, unknown>[];
  notasPrevias?: { invoiceId: string }[];
}) {
  const updates: Record<string, unknown>[] = [];
  return {
    updates,
    tx: {
      subInvoice: {
        findFirst: async () => opts.ultimaFactura ?? null,
        findMany: async () => opts.pendientes ?? [],
      },
      subscriberService: { findMany: async () => opts.servicios ?? [] },
      appSetting: { findUnique: async () => (opts.pct == null ? null : { value: opts.pct }) },
      customerAdvance: {
        findMany: async () => opts.anticipos ?? [],
        update: async (a: Record<string, unknown>) => { updates.push(a); return a; },
      },
      subInvoiceItem: { findMany: async () => opts.notasPrevias ?? [] },
    } as never,
  };
}

describe('propuestaAdelanto', () => {
  it('cobra el mes siguiente rebajado con el % del ajuste', async () => {
    const { tx } = txFalso({
      ultimaFactura: { invoiceDate: new Date(Date.UTC(2026, 8, 1)), total: 0 },
      servicios: [{ price: 100000, qty: 1, taxRate: 0 }],
      pct: '5',
    });
    const p = await propuestaAdelanto(tx, 's1', 1);
    expect(p).toMatchObject({ pct: 5, bruto: 100000, descuento: 5000, neto: 95000 });
    // El mes que se adelanta se cuenta desde la ÚLTIMA FACTURA, no desde hoy.
    expect(p!.meses[0].label).toBe('octubre');
  });

  it('sin ajuste usa el 5% por defecto, y con 0 no rebaja nada', async () => {
    const base = {
      ultimaFactura: { invoiceDate: new Date(Date.UTC(2026, 8, 1)), total: 0 },
      servicios: [{ price: 50000, qty: 1, taxRate: 19 }],
    };
    expect((await propuestaAdelanto(txFalso({ ...base }).tx, 's1'))!.descuento).toBe(2975);
    expect((await propuestaAdelanto(txFalso({ ...base, pct: '0' }).tx, 's1'))!.descuento).toBe(0);
  });

  it('sin servicios activos cae al total de la última factura (respaldo del legacy)', async () => {
    const { tx } = txFalso({
      ultimaFactura: { invoiceDate: new Date(Date.UTC(2026, 8, 1)), total: 47000 },
      servicios: [], pct: '5',
    });
    expect((await propuestaAdelanto(tx, 's1'))).toMatchObject({ bruto: 47000, neto: 44650 });
  });

  it('sin ninguna factura de referencia no propone nada', async () => {
    expect(await propuestaAdelanto(txFalso({ ultimaFactura: null }).tx, 's1')).toBeNull();
  });
});

describe('concederDescuentosAdelantados', () => {
  const anticipoConDescuento = {
    id: 'a1', date: new Date(Date.UTC(2026, 8, 2)),
    discountPct: 5, discountAmount: 5000, discountApplied: 0, months: 1,
  };
  const facturaDe = (tid: number, mes: number, total = 100000, paid = 0) => ({
    id: `f${tid}`, tid, invoiceDate: new Date(Date.UTC(2026, mes, 1)), total, paid,
    paidAmount: paid,
  });

  it('rebaja la factura del mes adelantado cuando por fin nace', async () => {
    const { tx, updates } = txFalso({
      anticipos: [anticipoConDescuento],
      pendientes: [facturaDe(500900, 9)], // octubre
    });
    const r = await concederDescuentosAdelantados(tx, 's1');
    expect(r).toMatchObject({ total: 5000 });
    expect(r.facturas).toEqual([{ tid: 500900, monto: 5000 }]);
    expect(notas).toHaveLength(1);
    expect(notas[0].opts.type).toBe('CREDITO');
    expect(notas[0].opts.description).toContain(NOTA_ADELANTO);
    expect(updates[0].data).toEqual({ discountApplied: 5000 });
  });

  it('NO rebaja la mora: sólo meses posteriores al recaudo', async () => {
    const { tx } = txFalso({
      anticipos: [anticipoConDescuento],
      // Julio y septiembre: una vencida y la del propio mes en que se pagó.
      pendientes: [facturaDe(500800, 6), facturaDe(500850, 8)],
    });
    expect(await concederDescuentosAdelantados(tx, 's1')).toMatchObject({ total: 0 });
    expect(notas).toHaveLength(0);
  });

  it('no la rebaja dos veces: la nota que ya está en la factura es la huella', async () => {
    const { tx } = txFalso({
      anticipos: [anticipoConDescuento],
      pendientes: [facturaDe(500900, 9, 100000, 50000)],
      notasPrevias: [{ invoiceId: 'f500900' }],
    });
    expect(await concederDescuentosAdelantados(tx, 's1')).toMatchObject({ total: 0 });
  });

  it('nunca rebaja más de lo que la factura debe', async () => {
    const { tx } = txFalso({
      anticipos: [anticipoConDescuento],
      pendientes: [facturaDe(500900, 9, 100000, 98000)], // sólo quedan 2.000
    });
    expect(await concederDescuentosAdelantados(tx, 's1')).toMatchObject({ total: 2000 });
  });

  it('un anticipo sin descuento prometido no toca nada', async () => {
    const { tx } = txFalso({ anticipos: [], pendientes: [facturaDe(500900, 9)] });
    expect(await concederDescuentosAdelantados(tx, 's1')).toMatchObject({ total: 0, facturas: [] });
  });
});
