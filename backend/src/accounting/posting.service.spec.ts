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

const armar = (postImpl: () => Promise<unknown>) => {
  const pendingPosting = pendientes();
  // El parámetro se declara aunque no se use: sin él, `mock.calls` queda tipado como
  // tupla vacía y no se puede inspeccionar el argumento del asiento.
  const journal = { post: jest.fn((_args: { date: Date }) => postImpl()) };
  const mappings = { resolveMany: jest.fn().mockResolvedValue({ SALES_AR: 'a', SALES_REVENUE: 'b' }) };
  const prisma = { pendingPosting };
  const svc = new PostingService(journal as never, mappings as never, prisma as never);
  return { svc, journal, pendingPosting };
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
