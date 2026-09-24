import { filtrarCortables, fraseProtegidos, motivoProteccion } from '../common/corte.policy';
import { GenieacsService } from './genieacs.service';
import { MikrotikService } from './mikrotik.service';

/**
 * NO SE CORTA A QUIEN TODAVÍA ESTÁ EN PLAZO.
 *
 * El 2026-09-09 el legacy cortó un lote de 17 clientes "por mora" y NUEVE de ellos
 * debían únicamente la factura del mes corriente, emitida el día 1 y con vencimiento
 * el 20. Uno había pagado agosto cuatro días antes. Hubo que reconectarlos a mano.
 *
 * La causa no es el dedo de quien apretó el botón sino el criterio: allá la lista de
 * corte se arma sólo con PLATA ("debe una mensualidad") y la fecha de vencimiento no
 * entra en la consulta, así que desde el día 1 el que está al día ya "debe un mes".
 * Aquí se tapa en los dos sitios y estos tests cuidan el que importa: el botón.
 */
const hoy = new Date(Date.UTC(2026, 8, 10)); // 2026-09-10
const vencida = new Date(Date.UTC(2026, 7, 20));
const porVencer = new Date(Date.UTC(2026, 8, 20));

describe('corte.policy · a quién deja cortar el lote', () => {
  const fila = (extra: Partial<Parameters<typeof motivoProteccion>[0]> = {}) => ({
    id: 'sub-1', status: 'ACTIVO', promiseExpiry: null, tieneVencida: true, ...extra,
  });

  it('protege al que no arrastra ninguna factura vencida (aunque deba el mes corriente)', () => {
    expect(motivoProteccion(fila({ tieneVencida: false }), hoy)).toBe('sin-vencer');
  });

  it('deja cortar al que ya se pasó de plazo', () => {
    expect(motivoProteccion(fila(), hoy)).toBeNull();
  });

  it('sigue protegiendo el compromiso de pago VIGENTE', () => {
    const f = fila({ status: 'COMPROMISO', promiseExpiry: new Date(Date.UTC(2026, 8, 30)) });
    expect(motivoProteccion(f, hoy)).toBe('compromiso');
  });

  it('el compromiso ya vencido se corta (paridad con `_compromiso_vencido` del legacy)', () => {
    const f = fila({ status: 'COMPROMISO', promiseExpiry: new Date(Date.UTC(2026, 8, 1)) });
    expect(motivoProteccion(f, hoy)).toBeNull();
  });

  it('el compromiso SIN fecha —los que bajaron así del legacy— se corta si debe algo vencido', () => {
    // Antes "sin fecha" era protegido a secas y NINGÚN compromiso se podía cortar
    // en lote, aunque el cliente llevara meses debiendo.
    expect(motivoProteccion(fila({ status: 'COMPROMISO' }), hoy)).toBeNull();
  });

  it('no corta por una factura PARTIAL vencida que en plata está saldada (CC 39949681, 2026-09-21)', async () => {
    const prisma: any = {
      subscriber: {
        findMany: jest.fn().mockResolvedValue([
          // Agosto: 74.100 pagados sobre 73.150 y el legacy la dejó en `partial`.
          { id: 'sobrepagada', status: 'ACTIVO', promiseExpiry: null, invoices: [{ total: 73150, paidAmount: 74100 }] },
          // Residuo de IVA: 200 pesos vencidos no son un corte.
          { id: 'residuo', status: 'ACTIVO', promiseExpiry: null, invoices: [{ total: 73150, paidAmount: 72950 }] },
          // El sobrepago de una factura no tapa la deuda de otra.
          { id: 'debe-otra', status: 'ACTIVO', promiseExpiry: null, invoices: [{ total: 73150, paidAmount: 74100 }, { total: 73150, paidAmount: 0 }] },
        ]),
      },
    };
    const r = await filtrarCortables(prisma, ['sobrepagada', 'residuo', 'debe-otra'], hoy);
    expect(r.ids).toEqual(['debe-otra']);
    expect(r.protegidos).toEqual({ sinVencer: 2, compromiso: 0 });
  });

  it('separa el lote y cuenta por qué quedó cada uno fuera', async () => {
    const prisma: any = {
      subscriber: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'al-dia', status: 'ACTIVO', promiseExpiry: null, invoices: [] },
          { id: 'moroso', status: 'ACTIVO', promiseExpiry: null, invoices: [{ total: 73150, paidAmount: 0 }] },
          { id: 'con-acuerdo', status: 'COMPROMISO', promiseExpiry: new Date(Date.UTC(2026, 8, 30)), invoices: [{ total: 73150, paidAmount: 0 }] },
        ]),
      },
    };
    const r = await filtrarCortables(prisma, ['al-dia', 'moroso', 'con-acuerdo'], hoy);

    expect(r.ids).toEqual(['moroso']);
    expect(r.protegidos).toEqual({ sinVencer: 1, compromiso: 1 });
    // Sólo se miran las facturas YA vencidas: el filtro va en la consulta.
    expect(prisma.subscriber.findMany.mock.calls[0][0].select.invoices.where.dueDate).toEqual({ lt: hoy });
    expect(fraseProtegidos(r.protegidos)).toMatch(/sin ninguna factura vencida/);
  });
});

describe('el lote sólo corta el servicio que el cliente tiene (2026-09-23)', () => {
  const debe = [{ total: 73150, paidAmount: 0 }];
  const armar = (lineas: Record<string, string[]>) => ({
    subscriber: {
      findMany: jest.fn().mockResolvedValue(
        Object.keys(lineas).map((id) => ({ id, status: 'ACTIVO', promiseExpiry: null, invoices: debe })),
      ),
    },
    // Las líneas de sus mensualidades: de ahí sale qué tiene cada uno.
    $queryRaw: jest.fn().mockResolvedValue(
      Object.entries(lineas).flatMap(([subscriberId, ns]) => ns.map((nombre) => ({ subscriberId, nombre }))),
    ),
    subscriberService: { findMany: jest.fn().mockResolvedValue([]) },
  });

  it('el corte de TV deja fuera a quien sólo paga internet', async () => {
    const prisma: any = armar({ combo: ['100 Megas F-26', 'Television26'], soloNet: ['100 Megas FS-26'], soloTv: ['SoloTelevision22'] });
    const r = await filtrarCortables(prisma, ['combo', 'soloNet', 'soloTv'], hoy, 'TV');

    expect(r.ids).toEqual(['combo', 'soloTv']);
    expect(r.protegidos.sinServicio).toBe(1);
    expect(fraseProtegidos(r.protegidos)).toMatch(/1 que no tienen ese servicio/);
  });

  it('el corte de internet deja fuera a quien sólo paga TV', async () => {
    const prisma: any = armar({ combo: ['5MegasV', 'Television24'], soloTv: ['SoloTelevision', 'Punto Adicional'] });
    const r = await filtrarCortables(prisma, ['combo', 'soloTv'], hoy, 'INTERNET');

    expect(r.ids).toEqual(['combo']);
    expect(r.protegidos.sinServicio).toBe(1);
  });

  it('sin datos de lo que tiene, lo deja pasar (como antes)', async () => {
    const prisma: any = armar({ nuevo: [] });
    const r = await filtrarCortables(prisma, ['nuevo'], hoy, 'TV');

    expect(r.ids).toEqual(['nuevo']);
  });
});

describe('el lote de corte de internet no toca el router de quien está en plazo', () => {
  const armar = (invoices: any[]) => {
    const prisma: any = {
      subscriber: { findMany: jest.fn().mockResolvedValue([{ id: 'sub-1', status: 'ACTIVO', promiseExpiry: null, invoices }]) },
    };
    const svc = new MikrotikService(prisma, {} as any, {} as any, {} as any);
    (svc as any).batchByRouter = jest.fn().mockResolvedValue({ ok: true, results: [] });
    (svc as any).registrarCorteDeInternet = jest.fn().mockResolvedValue([]);
    (svc as any).conNombre = async (x: any[]) => x;
    return { svc, prisma };
  };

  it('con la factura del mes sin vencer: no se corta a nadie y se dice por qué', async () => {
    const { svc } = armar([]);
    await expect(svc.cutBatch(['sub-1'])).rejects.toThrow(/sin ninguna factura vencida/i);
    expect((svc as any).batchByRouter).not.toHaveBeenCalled();
  });

  it('con una factura vencida: el lote sigue su curso', async () => {
    const { svc } = armar([{ total: 73150, paidAmount: 0 }]);
    const r: any = await svc.cutBatch(['sub-1']);
    expect((svc as any).batchByRouter).toHaveBeenCalledWith(['sub-1'], 'CUT', undefined);
    expect(r.protegidos).toEqual({ sinVencer: 0, compromiso: 0, sinServicio: 0 });
  });
});

describe('el lote de corte de TV usa el mismo candado (y sólo al cortar)', () => {
  const armar = (invoices: any[]) => {
    const prisma: any = {
      appSetting: {
        // La TV "sólo en el sistema" se apaga aquí: estas pruebas van por la red.
        findUnique: jest.fn(async ({ where }: any) =>
          where?.key === 'network.tvSoloSistema' ? { value: 'false' } : { value: 'false' }),
      },
      genieacsServer: { findFirst: jest.fn().mockResolvedValue({ id: 's1', name: 'ACS', nbiUrl: 'http://acs', username: '', password: '' }) },
      genieacsActionLog: { create: jest.fn().mockResolvedValue({}) },
      subscriber: {
        findMany: jest.fn().mockImplementation((args: any) =>
          // El candado pregunta por el acuerdo de pago; el lote, por el equipo.
          args?.select?.promiseExpiry
            ? Promise.resolve([{ id: 'sub-1', status: 'ACTIVO', promiseExpiry: null, invoices }])
            // No es EOC: el lote no lo saca antes del candado.
            : args?.where?.installTech === 'EOC'
              ? Promise.resolve([])
              : Promise.resolve([{ id: 'sub-1', abonado: 4321, fullName: 'Cliente', pppUsername: null }]),
        ),
      },
      oltOnu: { findMany: jest.fn().mockResolvedValue([]) },
      subscriberService: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      subInvoice: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const ordenes: any = {
      registrarResuelta: jest.fn().mockResolvedValue({ id: 'o1', code: 1, nueva: true }),
      abrirSiNoHay: jest.fn().mockResolvedValue({ id: 'o1', code: 1, nueva: true }),
    };
    const svc = new GenieacsService(prisma, {} as any, ordenes);
    (svc as any).devicesOf = async () => [];
    return { svc, ordenes };
  };

  it('sin factura vencida no se le corta la TV ni se le abre orden', async () => {
    const { svc, ordenes } = armar([]);
    await expect(svc.tvBatchBySubscribers(['sub-1'], false, undefined, { candadoDeuda: true }))
      .rejects.toThrow(/sin ninguna factura vencida/i);
    expect(ordenes.registrarResuelta).not.toHaveBeenCalled();
    expect(ordenes.abrirSiNoHay).not.toHaveBeenCalled();
  });

  it('devolver la TV nunca pasa por el candado', async () => {
    const { svc } = armar([]);
    const r: any = await svc.tvBatchBySubscribers(['sub-1'], true, undefined, { candadoDeuda: true });
    expect(r.total).toBe(1);
  });

  it('cerrar una orden de corte ya abierta tampoco: ahí manda la persona', async () => {
    // `aplicarTv` (support-write) llama SIN opts: es trabajo mandado, no un barrido.
    const { svc } = armar([]);
    const r: any = await svc.tvBatchBySubscribers(['sub-1'], false);
    expect(r.total).toBe(1);
  });
});
