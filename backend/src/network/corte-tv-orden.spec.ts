import { GenieacsService } from './genieacs.service';

/**
 * El corte de TV que se hace A MANO tiene que dejar rastro.
 *
 * El TR-069 no alcanza al parque —de los 676 abonados del corte masivo de agosto,
 * el equipo de 530 (78%) no era alcanzable— así que la televisión se termina
 * cortando a mano. Hasta el 09-09-2026 eso no dejaba NADA: el lote contestaba "16
 * sin equipo", el cliente se quedaba sin señal y en el sistema no había ni orden ni
 * estado. La ficha seguía diciendo "al aire" y, con ella, la reconexión al pagar:
 * nadie le devolvía la señal porque para el sistema nunca la había perdido.
 */
describe('GenieacsService · el corte de TV deja su orden, ya cerrada', () => {
  const server = { id: 's1', name: 'ACS', nbiUrl: 'http://acs', username: '', password: '' };

  const armar = (opciones: { live?: boolean; facturas?: any[] } = {}) => {
    const { live = true, facturas = [{ id: 'fac-1', subscriberId: 'sub-1', serviceTv: 'Television26' }] } = opciones;
    const prisma: any = {
      appSetting: { findUnique: jest.fn().mockResolvedValue({ value: String(live) }) },
      genieacsServer: { findFirst: jest.fn().mockResolvedValue(server) },
      genieacsActionLog: { create: jest.fn().mockResolvedValue({}) },
      subscriber: {
        findMany: jest.fn().mockResolvedValue([{ id: 'sub-1', abonado: 4321, fullName: 'Cliente', pppUsername: null }]),
      },
      oltOnu: { findMany: jest.fn().mockResolvedValue([]) },
      subscriberService: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      subInvoice: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $queryRaw: jest.fn().mockResolvedValue(facturas),
    };
    const ordenes: any = {
      registrarResuelta: jest.fn(async (i: any) => ({ id: 'ord-1', code: 500987, type: i.type, nueva: true, estado: 'RESUELTO' })),
    };
    const svc = new GenieacsService(prisma, {} as any, ordenes);
    (svc as any).devicesOf = async () => [];
    return { svc, prisma, ordenes };
  };

  it('el abonado sin equipo alcanzable igual queda con su orden de corte cerrada', async () => {
    const { svc, ordenes } = armar();
    const r: any = await svc.tvBatchBySubscribers(['sub-1'], false, { name: 'Nayme' } as any);

    // La respuesta sigue diciendo la verdad: no se aplicó por red.
    expect(r.sinEquipo).toBe(1);
    expect(r.ok).toBe(false);
    // Y aun así queda la constancia del trabajo.
    expect(ordenes.registrarResuelta).toHaveBeenCalledWith(
      expect.objectContaining({ subscriberId: 'sub-1', type: 'Corte Television', autor: 'Nayme' }),
    );
    expect(ordenes.registrarResuelta.mock.calls[0][0].section).toMatch(/manualmente/i);
  });

  it('el corte se anota en la factura vigente con la marca que lo salva de la ida', async () => {
    const { svc, prisma } = armar();
    await svc.tvBatchBySubscribers(['sub-1'], false, { name: 'Nayme' } as any);

    const [arg] = prisma.subInvoice.updateMany.mock.calls[0];
    expect(arg.where.id.in).toEqual(['fac-1']);
    expect(arg.data).toMatchObject({ estadoTv: 'CORTADO', serviceStatusBy: 'Nayme' });
    expect(arg.data.serviceStatusAt).toBeInstanceOf(Date);
    // Y la ficha del servicio, con sus puntos.
    expect(prisma.subscriberService.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'CORTADO' } }),
    );
  });

  it('no le inventa una TV cortada a quien no la tiene facturada', async () => {
    const { svc, prisma, ordenes } = armar({ facturas: [{ id: 'fac-1', subscriberId: 'sub-1', serviceTv: 'no' }] });
    await svc.tvBatchBySubscribers(['sub-1'], false);
    expect(prisma.subInvoice.updateMany).not.toHaveBeenCalled();
    // La orden sí se registra: lo que no se toca es la factura que no nombra televisión.
    expect(ordenes.registrarResuelta).toHaveBeenCalled();
  });

  it('en DRY-RUN no se da nada por cortado: no se pidió cortar de verdad', async () => {
    const { svc, prisma, ordenes } = armar({ live: false });
    (svc as any).devicesOf = async () => [{ id: 'cpe-1', pppUser: 'USUARIO-1' }];
    prisma.subscriber.findMany.mockResolvedValue([
      { id: 'sub-1', abonado: 4321, fullName: 'Cliente', pppUsername: 'usuario-1' },
    ]);

    const r: any = await svc.tvBatchBySubscribers(['sub-1'], false);
    expect(r.dryRun).toBe(true);
    expect(ordenes.registrarResuelta).not.toHaveBeenCalled();
    expect(prisma.subInvoice.updateMany).not.toHaveBeenCalled();
  });
});
