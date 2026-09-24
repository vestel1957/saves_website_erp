import { GenieacsService } from './genieacs.service';

/**
 * TV "sólo en el sistema" (`network.tvSoloSistema`, encendido desde 2026-09-22).
 *
 * El 21-sep el ACS estaba caído y un lote de 563 cortes de TV no tocó un solo
 * equipo: el corte lo hizo el operador a mano. Mientras el TR-069 esté en pausa el
 * lote no sale a la red —ni ACS ni OLT—, marca la ficha y deja la orden cerrada.
 */
describe('GenieacsService · TV sólo en el sistema', () => {
  const armar = (soloSistema = true) => {
    const prisma: any = {
      appSetting: {
        findUnique: jest.fn(async ({ where }: any) =>
          where?.key === 'network.tvSoloSistema' ? { value: String(soloSistema) } : { value: 'true' }),
      },
      subscriber: {
        findMany: jest.fn(async ({ where }: any) =>
          // La consulta de EOC trae `installTech`: ese cliente es EOC.
          where?.installTech === 'EOC'
            ? [{ id: 'sub-eoc', abonado: 2, fullName: 'Eoc' }]
            : [
                { id: 'sub-1', abonado: 1, fullName: 'Uno', pppUsername: 'U1' },
                { id: 'sub-eoc', abonado: 2, fullName: 'Eoc', pppUsername: null },
              ].filter((s) => where.id.in.includes(s.id))),
      },
      oltOnu: { findMany: jest.fn().mockResolvedValue([]) },
      subscriberService: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      subInvoice: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const olt: any = { setCatv: jest.fn() };
    const ordenes: any = {
      registrarResuelta: jest.fn(async (i: any) => ({ id: 'o', code: 1, type: i.type, nueva: true, estado: 'RESUELTO' })),
      abrirSiNoHay: jest.fn(async (i: any) => ({ id: 'o', code: 2, type: i.type, nueva: true, estado: 'PENDIENTE' })),
    };
    const svc = new GenieacsService(prisma, olt, ordenes);
    const devicesOf = jest.fn(async () => []);
    (svc as any).devicesOf = devicesOf;
    return { svc, prisma, olt, ordenes, devicesOf };
  };

  it('el corte marca la ficha y deja la orden PENDIENTE sin tocar el ACS ni la OLT — EOC incluidos', async () => {
    const { svc, prisma, olt, ordenes, devicesOf } = armar();
    const r: any = await svc.tvBatchBySubscribers(['sub-1', 'sub-eoc'], false, { name: 'Op' } as any);

    expect(devicesOf).not.toHaveBeenCalled();
    expect(olt.setCatv).not.toHaveBeenCalled();
    expect(r.soloSistema).toBe(true);
    expect(r.marcados).toBe(2);
    expect(r.eoc).toEqual([]);
    expect(prisma.subscriberService.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ subscriberId: { in: ['sub-1', 'sub-eoc'] } }), data: { status: 'CORTADO' } }),
    );
    // A mano: la orden queda pendiente y la cierra quien corta en sitio (2026-09-23).
    expect(ordenes.abrirSiNoHay).toHaveBeenCalledTimes(2);
    expect(ordenes.registrarResuelta).not.toHaveBeenCalled();
  });

  it('el alta automática (pago) NO se da por hecha: queda para un técnico', async () => {
    const { svc, prisma } = armar();
    const r: any = await svc.tvBatchBySubscribers(['sub-1'], true);
    expect(r.marcados).toBe(0);
    expect(r.results[0]).toMatchObject({ ok: false, via: null });
    expect(prisma.subscriberService.updateMany).not.toHaveBeenCalled();
  });

  it('el alta desde la pantalla masiva sí marca la TV activa', async () => {
    const { svc, prisma } = armar();
    const r: any = await svc.tvBatchBySubscribers(['sub-1'], true, undefined, { marcarSinRed: true });
    expect(r.marcados).toBe(1);
    expect(prisma.subscriberService.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'ACTIVO' } }));
  });

  it('apagado, el lote vuelve a buscar el equipo por red', async () => {
    const { svc, devicesOf } = armar(false);
    (svc as any).resolveServer = async () => ({ id: 's' });
    const r: any = await svc.tvBatchBySubscribers(['sub-1'], true);
    expect(devicesOf).toHaveBeenCalled();
    expect(r.soloSistema).toBe(false);
  });
});
