import { PostingService } from './posting.service';

/**
 * Lo que se prueba aquí es el CONTRATO de `safePost`, que es el que sostiene la
 * promesa "contabilizar nunca rompe el flujo de negocio, pero deja rastro":
 *   - si el asiento falla, el documento sigue adelante (devuelve null) y queda un
 *     pendiente con los argumentos para reintentar;
 *   - si el asiento sale, cualquier pendiente previo se marca resuelto;
 *   - si ni siquiera se puede registrar el pendiente, tampoco se rompe nada.
 */

const pendientes = () => ({
  upsert: jest.fn().mockResolvedValue({}),
  updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  findUnique: jest.fn(),
  findMany: jest.fn().mockResolvedValue([]),
});

const armar = (postImpl: () => Promise<unknown>, asientoOriginal: unknown = { id: 'asiento-original' }) => {
  const pendingPosting = pendientes();
  // El parámetro se declara aunque no se use: sin él, `mock.calls` queda tipado como
  // tupla vacía y no se puede inspeccionar el argumento del asiento.
  const journal = { post: jest.fn((_args: { date: Date }) => postImpl()) };
  const mappings = { resolveMany: jest.fn().mockResolvedValue({ SALES_AR: 'a', SALES_REVENUE: 'b', SALES_TAX: 'c' }) };
  const journalEntry = { findUnique: jest.fn().mockResolvedValue(asientoOriginal) };
  const prisma = { pendingPosting, journalEntry };
  const svc = new PostingService(journal as never, mappings as never, prisma as never);
  return { svc, journal, pendingPosting, journalEntry };
};

const factura = {
  sourceId: 'inv-1', date: new Date('2026-07-01'), number: 42, subtotal: 100, tax: 19,
};

describe('PostingService.safePost', () => {
  it('cuando el asiento falla: devuelve null y registra el pendiente', async () => {
    const { svc, pendingPosting } = armar(() => Promise.reject(new Error('falta el mapeo SALES_AR')));

    const res = await svc.postSalesInvoice(factura);

    expect(res).toBeNull(); // el documento NO se rompe
    expect(pendingPosting.upsert).toHaveBeenCalledTimes(1);
    const arg = pendingPosting.upsert.mock.calls[0][0];
    expect(arg.where.sourceType_sourceId).toEqual({ sourceType: 'SALES_INVOICE', sourceId: 'inv-1' });
    expect(arg.create.error).toContain('falta el mapeo');
    // El payload guardado permite reintentar sin volver a leer el documento.
    expect(arg.create.payload).toMatchObject({ sourceId: 'inv-1', subtotal: 100 });
    // Reintentar sobre un pendiente existente suma intentos y lo reabre.
    expect(arg.update.attempts).toEqual({ increment: 1 });
    expect(arg.update.resolvedAt).toBeNull();
  });

  it('cuando el asiento sale: marca resuelto cualquier pendiente previo', async () => {
    const { svc, pendingPosting } = armar(() => Promise.resolve({ id: 'asiento-1' }));

    const res = await svc.postSalesInvoice(factura);

    expect(res).toEqual({ id: 'asiento-1' });
    expect(pendingPosting.upsert).not.toHaveBeenCalled();
    expect(pendingPosting.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { sourceType: 'SALES_INVOICE', sourceId: 'inv-1', resolvedAt: null },
      }),
    );
  });

  it('si tampoco se puede registrar el pendiente, el documento sigue adelante', async () => {
    const { svc, pendingPosting } = armar(() => Promise.reject(new Error('boom')));
    pendingPosting.upsert.mockRejectedValue(new Error('la BD tampoco responde'));

    // Lo que no puede pasar es que esto lance: tumbaría la emisión de la factura.
    await expect(svc.postSalesInvoice(factura)).resolves.toBeNull();
  });

  it('un importe no positivo no genera asiento ni pendiente', async () => {
    const { svc, journal, pendingPosting } = armar(() => Promise.resolve({ id: 'x' }));

    const res = await svc.postCustomerPayment({ sourceId: 'r-1', date: new Date(), amount: 0 });

    expect(res).toBeNull();
    expect(journal.post).not.toHaveBeenCalled();
    expect(pendingPosting.upsert).not.toHaveBeenCalled();
  });
});

/**
 * Ajuste por edición de factura: lo que importa es que el asiento CUADRE cuando el
 * valor sube y cuando baja, y que no se cuelgue de una factura que nunca se
 * contabilizó aquí (las traídas del legacy).
 */
describe('PostingService.postSalesInvoiceAdjustment', () => {
  const edicion = { sourceId: 'inv-1', date: new Date('2026-08-01'), number: 42, edit: 1 };

  it('sube el valor: cartera al debe, ingreso e IVA al haber', async () => {
    const { svc, journal } = armar(() => Promise.resolve({ id: 'ajuste-1' }));

    await svc.postSalesInvoiceAdjustment({ ...edicion, deltaSubtotal: 100, deltaTax: 19 });

    const { lines, sourceType, sourceId } = journal.post.mock.calls[0][0] as never as
      { lines: { accountId: string; debit: number; credit: number }[]; sourceType: string; sourceId: string };
    expect(sourceType).toBe('SALES_INVOICE_ADJ');
    expect(sourceId).toBe('inv-1#1'); // por edición: la segunda no choca con la primera
    expect(lines.find((l) => l.accountId === 'a')).toMatchObject({ debit: 119, credit: 0 });
    expect(lines.find((l) => l.accountId === 'b')).toMatchObject({ debit: 0, credit: 100 });
    expect(lines.find((l) => l.accountId === 'c')).toMatchObject({ debit: 0, credit: 19 });
  });

  it('baja el valor: el asiento se da vuelta y sigue cuadrando', async () => {
    const { svc, journal } = armar(() => Promise.resolve({ id: 'ajuste-2' }));

    await svc.postSalesInvoiceAdjustment({ ...edicion, edit: 2, deltaSubtotal: -50, deltaTax: -9.5 });

    const { lines } = journal.post.mock.calls[0][0] as never as { lines: { debit: number; credit: number }[] };
    const debe = lines.reduce((s, l) => s + l.debit, 0);
    const haber = lines.reduce((s, l) => s + l.credit, 0);
    expect(debe).toBeCloseTo(haber);
    expect(debe).toBeCloseTo(59.5);
  });

  it('si la factura nunca se contabilizó aquí (viene del legacy), no se ajusta nada', async () => {
    const { svc, journal } = armar(() => Promise.resolve({ id: 'x' }), null);

    const res = await svc.postSalesInvoiceAdjustment({ ...edicion, deltaSubtotal: 100, deltaTax: 19 });

    expect(res).toBeNull();
    expect(journal.post).not.toHaveBeenCalled();
  });

  it('sin diferencia de valor no hay asiento', async () => {
    const { svc, journal } = armar(() => Promise.resolve({ id: 'x' }));

    const res = await svc.postSalesInvoiceAdjustment({ ...edicion, deltaSubtotal: 0, deltaTax: 0 });

    expect(res).toBeNull();
    expect(journal.post).not.toHaveBeenCalled();
  });
});

describe('PostingService.retryPending', () => {
  it('revive la fecha (que vuelve de JSON como texto) y reintenta', async () => {
    const { svc, journal, pendingPosting } = armar(() => Promise.resolve({ id: 'asiento-2' }));
    pendingPosting.findUnique.mockResolvedValue({
      id: 'p-1', sourceType: 'SALES_INVOICE',
      payload: { sourceId: 'inv-1', date: '2026-07-01T00:00:00.000Z', number: 42, subtotal: 100, tax: 19 },
    });

    const res = await svc.retryPending('p-1');

    expect(res).toEqual({ id: 'p-1', ok: true });
    expect(journal.post).toHaveBeenCalledTimes(1);
    expect(journal.post.mock.calls[0][0].date).toBeInstanceOf(Date);
  });

  it('un sourceType desconocido se reporta, no revienta', async () => {
    const { svc, pendingPosting } = armar(() => Promise.resolve({}));
    pendingPosting.findUnique.mockResolvedValue({ id: 'p-2', sourceType: 'ALGO_RARO', payload: {} });

    await expect(svc.retryPending('p-2')).resolves.toEqual({
      id: 'p-2', ok: false, error: 'No sé reintentar un ALGO_RARO',
    });
  });
});

/**
 * Centro de costo (docs/centros-de-costo, fase 3): viaja a TODAS las líneas del asiento
 * y nunca puede impedir que se contabilice.
 */
describe('PostingService · centro de costo', () => {
  const lineas = (journal: { post: jest.Mock }, llamada = 0) =>
    (journal.post.mock.calls[llamada][0] as { lines: { costCenterId?: string | null }[] }).lines;

  it('recaudo, ingreso y egreso de tesorería llevan el centro en todas sus líneas', async () => {
    const { svc, journal } = armar(() => Promise.resolve({ id: 'asiento' }));
    const base = { date: new Date('2026-09-24'), amount: 50_000, costCenterId: 'cc-yopal' };
    await svc.postCustomerPayment({ ...base, sourceId: 'rec-1' });
    await svc.postTreasuryIncome({ ...base, sourceId: 'tx-1' });
    await svc.postTreasuryExpense({ ...base, sourceId: 'tx-2' });
    for (const i of [0, 1, 2]) {
      expect(lineas(journal, i)).toHaveLength(2);
      expect(lineas(journal, i).every((l) => l.costCenterId === 'cc-yopal')).toBe(true);
    }
  });

  it('sin centro, las líneas quedan en null («Sin asignar»)', async () => {
    const { svc, journal } = armar(() => Promise.resolve({ id: 'asiento' }));
    await svc.postTreasuryExpense({ sourceId: 'tx-3', date: new Date('2026-09-24'), amount: 10 });
    expect(lineas(journal).every((l) => l.costCenterId === null)).toBe(true);
  });

  it('si la base rechaza el centro (FK), se contabiliza igual sin centro y sin pendiente', async () => {
    let intento = 0;
    const { svc, journal, pendingPosting } = armar(() =>
      ++intento === 1 ? Promise.reject(Object.assign(new Error('FK'), { code: 'P2003' })) : Promise.resolve({ id: 'asiento' }),
    );
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await svc.postSalesInvoice({ ...factura, costCenterId: 'cc-borrado' });
    expect(res).toEqual({ id: 'asiento' });
    expect(journal.post).toHaveBeenCalledTimes(2);
    expect(lineas(journal, 1).every((l) => l.costCenterId === null)).toBe(true);
    expect(pendingPosting.upsert).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('un P2003 sin centro de por medio sigue siendo un pendiente, no se reintenta', async () => {
    const { svc, journal, pendingPosting } = armar(() =>
      Promise.reject(Object.assign(new Error('FK'), { code: 'P2003' })),
    );
    expect(await svc.postSalesInvoice(factura)).toBeNull();
    expect(journal.post).toHaveBeenCalledTimes(1);
    expect(pendingPosting.upsert).toHaveBeenCalledTimes(1);
  });

  it('centroDeTesoreria: manda el elegido a mano, sin consultar nada', async () => {
    const { svc } = armar(() => Promise.resolve(null));
    expect(await svc.centroDeTesoreria(11, 'cc-elegido')).toBe('cc-elegido');
  });

  it('los resolutores no lanzan: si la base falla, null y aviso', async () => {
    const roto = jest.fn().mockRejectedValue(new Error('base caída'));
    const prisma = {
      subscriber: { findUnique: roto }, cashAccount: { findUnique: roto },
      branch: { findMany: roto }, costCenter: { findMany: roto },
    };
    const svc = new PostingService({} as never, {} as never, prisma as never);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await svc.centroDeAbonado('sub-1')).toBeNull();
    expect(await svc.centroDeTesoreria(11)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
