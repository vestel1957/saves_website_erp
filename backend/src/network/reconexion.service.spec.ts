import { ReconexionService } from './reconexion.service';

/**
 * Reconexión automática al pagar.
 *
 * Lo que se prueba aquí es la DECISIÓN —a quién le corresponde qué— y que un
 * fallo de los equipos no se trague ni deje la base de datos mintiendo. Los
 * equipos en sí (RouterOS, ACS, OLT) van dobles: lo que interesa es a quién se
 * le manda la orden y qué se escribe después.
 */

type Servicio = { id: string; kind: string; status: string };

/** Un abonado de mentira con lo que mira el servicio. */
const abonado = (p: Partial<any> = {}) => ({
  id: p.id ?? 'sub-1',
  abonado: p.abonado ?? 1234,
  status: 'status' in p ? p.status : 'CORTADO',
  pppUsername: 'pppUsername' in p ? p.pppUsername : 'VESTEL1234',
  services: (p.services ?? [
    { id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' },
    { id: 'sv-2', kind: 'TV', status: 'ACTIVO' },
  ]) as Servicio[],
  _count: { oltOnus: p.onus ?? 0 },
});

function armar(sub: any | null, opts: { internetOk?: boolean; tvOk?: boolean; dryRun?: boolean } = {}) {
  const { internetOk = true, tvOk = true, dryRun = false } = opts;
  const escrituras = {
    estado: [] as any[],
    historial: [] as any[],
    servicios: [] as any[],
  };
  const prisma = {
    subscriber: {
      findUnique: jest.fn().mockResolvedValue(sub),
      findMany: jest.fn().mockResolvedValue(sub ? [sub] : []),
      update: jest.fn((args: any) => { escrituras.estado.push(args.data); return Promise.resolve({}); }),
    },
    subscriberStatusHistory: {
      create: jest.fn((args: any) => { escrituras.historial.push(args.data); return Promise.resolve({}); }),
    },
    subscriberService: {
      updateMany: jest.fn((args: any) => { escrituras.servicios.push(args); return Promise.resolve({ count: 1 }); }),
    },
  };
  const mikrotik = {
    reconnect: jest.fn().mockResolvedValue({
      ok: internetOk, dryRun, action: 'RECONNECT', subscriberId: sub?.id,
      steps: [], message: internetOk ? 'Reconexión aplicada.' : 'Fallo la reconexión: router caído',
      error: internetOk ? undefined : 'router caído',
    }),
    reconnectBatch: jest.fn().mockResolvedValue({
      total: 1, ok: internetOk ? 1 : 0,
      results: [{ ok: internetOk, dryRun, subscriberId: sub?.id, steps: [], message: '' }],
    }),
  };
  const genieacs = {
    tvBatchBySubscribers: jest.fn().mockResolvedValue({
      ok: tvOk, dryRun, total: 1, done: tvOk ? 1 : 0, failed: tvOk ? 0 : 1, sinEquipo: 0,
      results: [{
        subscriberId: sub?.id, via: 'TR069', ok: tvOk, dryRun,
        detail: tvOk ? 'TV restaurada por TR-069.' : 'El ACS no pudo aplicar el cambio.',
      }],
    }),
  };
  const srv = new ReconexionService(prisma as any, mikrotik as any, genieacs as any);
  // El log de errores es intencional (queda para reintentar desde Red); en la
  // prueba solo estorba.
  jest.spyOn((srv as any).logger, 'error').mockImplementation(() => undefined);
  jest.spyOn((srv as any).logger, 'log').mockImplementation(() => undefined);
  jest.spyOn((srv as any).logger, 'warn').mockImplementation(() => undefined);
  return { srv, prisma, mikrotik, genieacs, escrituras };
}

describe('a quién le corresponde reconectar', () => {
  it('al cortado con internet y TV le devuelve las dos cosas', async () => {
    const { srv, mikrotik, genieacs } = armar(abonado());
    const r = await srv.porPago('sub-1');

    expect(r.aplica).toBe(true);
    expect(r.ok).toBe(true);
    expect(mikrotik.reconnect).toHaveBeenCalledWith('sub-1', undefined);
    expect(genieacs.tvBatchBySubscribers).toHaveBeenCalledWith(['sub-1'], true, undefined);
    expect(r.servicios.map((s) => s.servicio).sort()).toEqual(['INTERNET', 'TV']);
  });

  it('reconecta también al que está en CARTERA: es el mismo corte dos meses después', async () => {
    const { srv, mikrotik } = armar(abonado({ status: 'CARTERA' }));
    const r = await srv.porPago('sub-1');
    expect(r.aplica).toBe(true);
    expect(mikrotik.reconnect).toHaveBeenCalled();
  });

  it('NO levanta una suspensión pedida por el cliente ni revive a un retirado', async () => {
    for (const status of ['SUSPENDIDO', 'RETIRADO', 'DEPURADO', 'INACTIVO']) {
      const { srv, mikrotik, genieacs } = armar(abonado({ status }));
      const r = await srv.porPago('sub-1');
      expect(r.aplica).toBe(false);
      expect(mikrotik.reconnect).not.toHaveBeenCalled();
      expect(genieacs.tvBatchBySubscribers).not.toHaveBeenCalled();
    }
  });

  it('al que solo tiene TV (sin PPPoE) no le inventa una reconexión de internet', async () => {
    const { srv, mikrotik, genieacs } = armar(
      abonado({ pppUsername: null, onus: 1, services: [{ id: 'sv-2', kind: 'TV', status: 'ACTIVO' }] }),
    );
    const r = await srv.porPago('sub-1');
    expect(mikrotik.reconnect).not.toHaveBeenCalled();
    expect(genieacs.tvBatchBySubscribers).toHaveBeenCalled();
    expect(r.servicios.map((s) => s.servicio)).toEqual(['TV']);
  });

  it('al que solo tiene internet no le manda una orden de TV', async () => {
    const { srv, genieacs } = armar(abonado({ services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }] }));
    const r = await srv.porPago('sub-1');
    expect(genieacs.tvBatchBySubscribers).not.toHaveBeenCalled();
    expect(r.servicios.map((s) => s.servicio)).toEqual(['INTERNET']);
  });

  it('devuelve la TV al cliente ACTIVO que solo tenía la TV cortada', async () => {
    // El corte de TV no cambia el estado del abonado: la marca vive en el servicio.
    const { srv, mikrotik, genieacs } = armar(
      abonado({ status: 'ACTIVO', services: [{ id: 'sv-2', kind: 'TV', status: 'CORTADO' }] }),
    );
    const r = await srv.porPago('sub-1');
    expect(r.aplica).toBe(true);
    expect(mikrotik.reconnect).not.toHaveBeenCalled();
    expect(genieacs.tvBatchBySubscribers).toHaveBeenCalled();
  });

  it('no hace nada con el que ya estaba al día', async () => {
    const { srv, mikrotik, genieacs } = armar(abonado({ status: 'ACTIVO' }));
    const r = await srv.porPago('sub-1');
    expect(r.aplica).toBe(false);
    expect(r.ok).toBe(true);
    expect(mikrotik.reconnect).not.toHaveBeenCalled();
    expect(genieacs.tvBatchBySubscribers).not.toHaveBeenCalled();
  });

  it('con TV contratada pero sin equipo identificable no intenta nada por TV', async () => {
    const { srv, genieacs } = armar(
      abonado({ pppUsername: null, onus: 0, services: [{ id: 'sv-2', kind: 'TV', status: 'ACTIVO' }] }),
    );
    const r = await srv.porPago('sub-1');
    expect(genieacs.tvBatchBySubscribers).not.toHaveBeenCalled();
    expect(r.aplica).toBe(false);
  });
});

describe('el fallo no se traga', () => {
  it('si el router está caído lo dice y NO deja al cliente como activo', async () => {
    const { srv, escrituras } = armar(abonado({ services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }] }), { internetOk: false });
    const r = await srv.porPago('sub-1', undefined, 'recibo 7');

    expect(r.ok).toBe(false);
    expect(r.mensaje).toMatch(/PAGÓ pero puede seguir cortado/);
    expect(escrituras.estado).toHaveLength(0);
    expect(escrituras.historial).toHaveLength(0);
  });

  it('si falla solo la TV, el internet ya reconectado se conserva y el resultado avisa', async () => {
    const { srv, escrituras } = armar(abonado(), { tvOk: false });
    const r = await srv.porPago('sub-1');

    expect(r.ok).toBe(false);
    expect(r.servicios.find((s) => s.servicio === 'INTERNET')!.ok).toBe(true);
    expect(r.servicios.find((s) => s.servicio === 'TV')!.ok).toBe(false);
    // El internet sí se aplicó: el abonado queda activo aunque la TV haya fallado.
    expect(escrituras.estado).toHaveLength(1);
  });

  it('un cliente que no existe no rompe el recaudo', async () => {
    const { srv } = armar(null);
    await expect(srv.porPago('fantasma')).resolves.toMatchObject({ aplica: false, ok: true });
  });

  it('si el equipo revienta con excepción, responde sin lanzar', async () => {
    const { srv, mikrotik } = armar(abonado({ services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }] }));
    mikrotik.reconnect.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await srv.porPago('sub-1');
    expect(r.ok).toBe(false);
    expect(r.servicios[0].detalle).toBe('ECONNREFUSED');
  });
});

describe('lo que queda escrito', () => {
  it('deja el abonado ACTIVO y REGISTRA el cambio de estado', async () => {
    const { srv, escrituras } = armar(abonado({ status: 'CARTERA' }));
    await srv.porPago('sub-1');

    expect(escrituras.estado[0]).toMatchObject({ status: 'ACTIVO', previousStatus: 'CARTERA' });
    expect(escrituras.historial[0]).toMatchObject({ status: 'ACTIVO', note: 'Reconexión automática por pago' });
  });

  it('en dry-run NO toca la base de datos: no se movió ningún equipo', async () => {
    const { srv, escrituras } = armar(abonado(), { dryRun: true });
    const r = await srv.porPago('sub-1');

    expect(r.dryRun).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.mensaje).toMatch(/simulada/);
    expect(escrituras.estado).toHaveLength(0);
    expect(escrituras.historial).toHaveLength(0);
    expect(escrituras.servicios).toHaveLength(0);
  });

  it('marca los servicios reconectados como ACTIVO', async () => {
    const { srv, escrituras } = armar(
      abonado({ services: [{ id: 'sv-2', kind: 'TV', status: 'CORTADO' }] }),
    );
    await srv.porPago('sub-1');
    expect(escrituras.servicios[0]).toMatchObject({
      where: { id: { in: ['sv-2'] } },
      data: { status: 'ACTIVO' },
    });
  });
});

describe('cargue de pagos (lote)', () => {
  it('agrupa: una sola pasada por router y una sola por el ACS', async () => {
    const { srv, mikrotik, genieacs } = armar(abonado());
    const r = await srv.porPagoLote(['sub-1', 'sub-1']); // el mismo cliente en dos filas

    expect(mikrotik.reconnectBatch).toHaveBeenCalledTimes(1);
    expect(genieacs.tvBatchBySubscribers).toHaveBeenCalledTimes(1);
    expect(r.total).toBe(1);
    expect(r).toMatchObject({ internet: 1, tv: 1, fallidos: 0 });
  });

  it('sin nadie a quién reconectar no toca los equipos', async () => {
    const { srv, mikrotik, genieacs } = armar(abonado({ status: 'ACTIVO' }));
    const r = await srv.porPagoLote(['sub-1']);
    expect(r).toMatchObject({ total: 0 });
    expect(mikrotik.reconnectBatch).not.toHaveBeenCalled();
    expect(genieacs.tvBatchBySubscribers).not.toHaveBeenCalled();
  });
});

describe('la cajera no se queda esperando a la OLT', () => {
  it('si los equipos se demoran responde "en curso" y sigue trabajando por detrás', async () => {
    jest.useFakeTimers();
    try {
      const { srv, mikrotik } = armar(abonado());
      mikrotik.reconnect.mockReturnValue(new Promise(() => undefined)); // nunca contesta
      const promesa = srv.porPago('sub-1');
      await Promise.resolve(); // deja arrancar el trabajo
      jest.advanceTimersByTime(20_000);
      const r = await promesa;

      expect(r.enCurso).toBe(true);
      expect(r.ok).toBe(true);
      expect(r.mensaje).toMatch(/en curso/);
    } finally {
      jest.useRealTimers();
    }
  });
});
