import 'reflect-metadata';
import { SubscribersService } from './subscribers.service';

/**
 * Quitarle un servicio al abonado desde el formulario de planes (la opción "No" del
 * legacy: dejarlo sólo con internet).
 *
 * Lo que hay que probar no es el borrado —eso es una línea— sino las dos cosas que
 * antes no pasaban: que se puede quitar SIN cambiar ningún plan, y que el legacy se
 * entera. Allá el plan del abonado se lee de la última factura recurrente, así que
 * una TV quitada aquí y no apagada allá vuelve a facturarse el mes siguiente.
 */
function armar(opts: { servicios?: any[]; recurrente?: any } = {}) {
  const servicios = opts.servicios ?? [
    { id: 'srv-tv', subscriberId: 'sub-1', kind: 'TV', planName: 'Television26' },
    { id: 'srv-net', subscriberId: 'sub-1', kind: 'INTERNET', planName: '100Megas26F' },
  ];
  const borrados: string[] = [];
  const facturas: any[] = [];
  const prisma: any = {
    subscriber: { findUnique: jest.fn().mockResolvedValue({ id: 'sub-1' }), update: jest.fn().mockResolvedValue({}) },
    subscriberService: {
      findFirst: jest.fn(async (a: any) => servicios.find((s) => s.kind === a.where.kind) ?? null),
      delete: jest.fn(async (a: any) => { borrados.push(a.where.id); return {}; }),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
    },
    subInvoice: {
      findFirst: jest.fn().mockResolvedValue('recurrente' in opts ? opts.recurrente : { id: 'fac-9' }),
      update: jest.fn(async (a: any) => { facturas.push(a); return {}; }),
    },
    plan: {
      findMany: jest.fn(async (a: any) => (a.where.id.in as string[]).map((id) => ({ id, kind: 'INTERNET' }))),
      findUnique: jest.fn(async (a: any) => ({
        id: a.where.id, kind: 'INTERNET', name: '300 Megas', price: 90000, taxRate: 0, megas: 300,
        pppProfile: null, active: true,
      })),
    },
  };
  const srv = new SubscribersService(prisma, {} as any, {} as any, {} as any, { emit: jest.fn() } as any, {} as any);
  return { srv, prisma, borrados, facturas };
}

describe('quitar un servicio contratado', () => {
  it('se puede quitar la TV sin cambiar ningún plan', async () => {
    const { srv, borrados } = armar();
    const r = await srv.changePlans('sub-1', [], { name: 'Nayme' } as any, { remove: ['TV'] as any });

    expect(borrados).toEqual(['srv-tv']);
    expect(r.results).toHaveLength(0);
    expect(r.removed[0]).toMatchObject({ removed: true, kind: 'TV', planName: 'Television26' });
  });

  it('apaga la televisión en la factura que le dicta el plan al legacy', async () => {
    const { srv, facturas } = armar();
    await srv.changePlans('sub-1', [], { name: 'Nayme' } as any, { remove: ['TV'] as any });

    expect(facturas[0].where).toEqual({ id: 'fac-9' });
    expect(facturas[0].data).toMatchObject({ serviceTv: 'no', serviceAssignedBy: 'Nayme' });
    // Sin la marca, la ida del sync devuelve el valor viejo a los 15 minutos.
    expect(facturas[0].data.serviceAssignedAt).toBeInstanceOf(Date);
    expect(facturas[0].data.serviceCombo).toBeUndefined(); // su internet no se toca
  });

  it('quitar el internet apaga `combo`, que es la otra columna del legacy', async () => {
    const { srv, facturas } = armar();
    await srv.changePlans('sub-1', [], undefined, { remove: ['INTERNET'] as any });
    expect(facturas[0].data).toMatchObject({ serviceCombo: 'no' });
  });

  it('el cliente sin recurrente no rompe nada: el legacy no tiene de dónde leer el plan', async () => {
    const { srv, facturas, borrados } = armar({ recurrente: null });
    await srv.changePlans('sub-1', [], undefined, { remove: ['TV'] as any });
    expect(borrados).toEqual(['srv-tv']);
    expect(facturas).toHaveLength(0);
  });

  it('quitar un servicio DERIVADO (sin fila) igual lo apaga en la factura', async () => {
    // La mitad de los abonados no tiene `SubscriberService`: su plan sale derivado de
    // las facturas. Sin fila que borrar la operación se iba en blanco y el servicio
    // seguía vivo en la ficha y en la corrida del mes siguiente (abonado 56130).
    const { srv, facturas, borrados } = armar({ servicios: [] });
    const r = await srv.changePlans('sub-1', [], undefined, { remove: ['TV'] as any });
    expect(borrados).toEqual([]);
    expect(r.removed[0]).toMatchObject({ removed: false });
    expect(facturas[0].data).toMatchObject({ serviceTv: 'no' });
  });

  it('cambiar internet y quitar TV es un solo movimiento', async () => {
    const { srv, borrados, prisma } = armar();
    const r = await srv.changePlans('sub-1', ['plan-300'], undefined, { remove: ['TV'] as any });
    expect(borrados).toEqual(['srv-tv']);
    expect(r.results).toHaveLength(1);
    expect(prisma.subscriberService.update).toHaveBeenCalled();
  });

  it('sin planes ni servicios que quitar, no hay nada que hacer', async () => {
    const { srv } = armar();
    await expect(srv.changePlans('sub-1', [], undefined, {})).rejects.toThrow(/al menos un plan/i);
  });
});
