import { PaymentImportsService } from './payment-imports.service';

/**
 * La reconexión del cargue que un reinicio dejó sin correr (2026-09-22,
 * 22SEPTIEMBRE2026.xlsx): se recoge después y respeta el corte posterior al pago.
 */
describe('PaymentImportsService.reconectarPendientes', () => {
  const hace = (min: number) => new Date(Date.now() - min * 60_000);

  function armar(filas: any[], cortes: any[] = []) {
    const prisma: any = {
      paymentImportRow: {
        findMany: jest.fn().mockResolvedValue(filas),
        updateMany: jest.fn().mockResolvedValue({ count: filas.length }),
      },
      ticket: { findMany: jest.fn().mockResolvedValue(cortes) },
    };
    const reconexion: any = { porPagoLote: jest.fn().mockResolvedValue({ total: 1 }) };
    const svc = new PaymentImportsService(prisma, {} as any, reconexion);
    return { svc, prisma, reconexion };
  }

  it('sin filas marcadas no toca los equipos', async () => {
    const { svc, reconexion } = armar([]);
    const r = await svc.reconectarPendientes();
    expect(r.filas).toBe(0);
    expect(reconexion.porPagoLote).not.toHaveBeenCalled();
  });

  it('reconecta una vez por abonado y quita la marca a todas las filas', async () => {
    const { svc, prisma, reconexion } = armar([
      { id: 'r1', subscriberId: 'a', reconexionPendienteDesde: hace(10) },
      { id: 'r2', subscriberId: 'a', reconexionPendienteDesde: hace(10) },
      { id: 'r3', subscriberId: 'b', reconexionPendienteDesde: hace(10) },
    ]);
    await svc.reconectarPendientes();
    expect(reconexion.porPagoLote).toHaveBeenCalledWith(['a', 'b'], expect.anything());
    expect(prisma.paymentImportRow.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1', 'r2', 'r3'] } }, data: { reconexionPendienteDesde: null },
    });
  });

  it('no reconecta a quien cortaron un día POSTERIOR al pago, pero sí le quita la marca', async () => {
    const ayer = new Date(Date.now() - 36 * 3600_000);
    const { svc, prisma, reconexion } = armar(
      [{ id: 'r1', subscriberId: 'a', reconexionPendienteDesde: ayer }, { id: 'r2', subscriberId: 'b', reconexionPendienteDesde: ayer }],
      [{ subscriberId: 'a', created: new Date(`${new Date(Date.now() + 24 * 3600_000).toISOString().slice(0, 10)}T00:00:00Z`) }],
    );
    const r = await svc.reconectarPendientes();
    expect(r.anterioresAlCorte).toBe(1);
    expect(reconexion.porPagoLote).toHaveBeenCalledWith(['b'], expect.anything());
    expect(prisma.paymentImportRow.updateMany.mock.calls[0][0].where.id.in).toEqual(['r1', 'r2']);
  });

  it('pide sólo filas con la marca vieja (una tanda en curso no se pisa)', async () => {
    const { svc, prisma } = armar([]);
    await svc.reconectarPendientes({ margenMin: 5 });
    const where = prisma.paymentImportRow.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('Cargado');
    expect(where.reconexionPendienteDesde.lt.getTime()).toBeLessThanOrEqual(Date.now() - 5 * 60_000 + 50);
  });
});
