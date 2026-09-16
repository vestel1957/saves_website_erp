import { MikrotikService } from './mikrotik.service';
import { ESTADO_SERVICIO_EVENT } from '../subscribers/subscribers.events';

/**
 * La vuelta del corte en lote: reconectar tiene que BORRAR el corte de donde se
 * escribió, no sólo sacar la IP de MOROSOS.
 *
 * `cutBatch` anota el corte de internet en dos sitios —`SubInvoice.estadoCombo` de la
 * factura vigente y la línea `SubscriberService` del internet— y hasta el 10-09-2026 la
 * reconexión en lote no borraba ninguno: el abonado navegaba, su estado quedaba en
 * ACTIVO y su ficha seguía pintando "internet cortado", porque ese chip no lo pinta el
 * estado del abonado (ver `SubscribersService.conEstadoDeServicio`, que le da prioridad
 * absoluta al corte de la línea de servicio).
 */
describe('MikrotikService · la reconexión en lote limpia la ficha', () => {
  const armar = (facturas: any[] = [{ id: 'fac-1', subscriberId: 'sub-1', estadoTv: null }]) => {
    const prisma: any = {
      subInvoice: { updateMany: jest.fn().mockResolvedValue({ count: facturas.length }) },
      subscriberService: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $queryRaw: jest.fn().mockResolvedValue(facturas),
    };
    const events: any = { emit: jest.fn() };
    const svc = new MikrotikService(prisma, {} as any, {} as any, undefined, events);
    const levantar = (results: any[], user?: any) => (svc as any).levantarCorteDeInternet(results, user);
    return { levantar, prisma, events };
  };
  const ok = [{ ok: true, dryRun: false, subscriberId: 'sub-1' }];

  it('borra el corte de la factura vigente y deja la marca que lo salva de la ida', async () => {
    const { levantar, prisma } = armar();
    await levantar(ok, { name: 'Paula Andrea Unas' });

    const [arg] = prisma.subInvoice.updateMany.mock.calls[0];
    expect(arg.where).toMatchObject({ estadoCombo: 'CORTADO' });
    expect(arg.where.id.in).toEqual(['fac-1']);
    expect(arg.data).toMatchObject({ estadoCombo: null, serviceStatusBy: 'Paula Andrea Unas' });
    expect(arg.data.serviceStatusAt).toBeInstanceOf(Date);
  });

  it('borra el corte de la línea de servicio, que es la que pinta el chip rojo', async () => {
    const { levantar, prisma } = armar();
    await levantar(ok);
    expect(prisma.subscriberService.updateMany).toHaveBeenCalledWith({
      where: { subscriberId: { in: ['sub-1'] }, kind: 'INTERNET', status: 'CORTADO' },
      data: { status: 'ACTIVO' },
    });
  });

  it('el `ron` de la factura sólo sube si no le queda la TV cortada', async () => {
    const { levantar, prisma } = armar([{ id: 'fac-1', subscriberId: 'sub-1', estadoTv: 'CORTADO' }]);
    await levantar(ok);
    // Una sola escritura: la del `estadoCombo`. El eje no se toca.
    expect(prisma.subInvoice.updateMany).toHaveBeenCalledTimes(1);
  });

  it('se lo cuenta al legacy en el acto, que si no la ida devuelve el Cortado', async () => {
    const { levantar, events } = armar();
    await levantar(ok);
    expect(events.emit).toHaveBeenCalledWith(
      ESTADO_SERVICIO_EVENT,
      expect.objectContaining({ servicio: 'INTERNET', estado: 'ACTIVO' }),
    );
  });

  it('en dry-run no se toca nada: no se reconectó a nadie', async () => {
    const { levantar, prisma, events } = armar();
    await levantar([{ ok: true, dryRun: true, subscriberId: 'sub-1' }]);
    expect(prisma.subInvoice.updateMany).not.toHaveBeenCalled();
    expect(prisma.subscriberService.updateMany).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('al que el router no aceptó no se le limpia la ficha', async () => {
    const { levantar, prisma } = armar();
    await levantar([{ ok: false, dryRun: false, subscriberId: 'sub-1', error: 'no conectó' }]);
    expect(prisma.subInvoice.updateMany).not.toHaveBeenCalled();
  });

  it('un fallo de base de datos no revienta la reconexión, que ya está hecha', async () => {
    const { levantar, prisma } = armar();
    prisma.$queryRaw.mockRejectedValue(new Error('se cayó la consulta'));
    await expect(levantar(ok)).resolves.toBe(0);
  });
});
