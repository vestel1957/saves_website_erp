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
  /**
   * Su última factura recurrente: la otra fuente de "¿tiene TV y la tiene cortada?"
   * (`serviceTv` la nombra, `estadoTv` con valor = caída). Es la que vale para los
   * 2.350 clientes que se quedaron sin filas de servicio en la migración.
   */
  invoices: (p.factura ? [p.factura] : []) as { serviceTv: string | null; estadoTv: string | null }[],
  _count: { oltOnus: p.onus ?? 0 },
});

function armar(
  sub: any | null,
  opts: {
    internetOk?: boolean; tvOk?: boolean; dryRun?: boolean;
    /** Lo que el router responde sobre el abonado (vacío = no contestó / dry-run). */
    live?: { inMorosos?: boolean; secretDisabled?: boolean };
    /** Órdenes del abonado, de la más nueva a la más vieja. */
    ordenes?: { type: string; subscriberId?: string }[];
  } = {},
) {
  const { internetOk = true, tvOk = true, dryRun = false } = opts;
  const escrituras = {
    estado: [] as any[],
    historial: [] as any[],
    servicios: [] as any[],
    facturas: [] as any[],
    avisos: [] as any[],
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
    // La factura vigente del abonado: sólo esa se levanta (las viejas marcadas
    // 'Cortado' son el rastro de cortes de otros años y no se reescriben).
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'inv-vigente' }]),
    // La factura es donde la ficha lee el corte por servicio (`estado_combo` /
    // `estado_tv` del legacy), así que la reconexión tiene que limpiarla.
    subInvoice: {
      updateMany: jest.fn((args: any) => { escrituras.facturas.push(args); return Promise.resolve({ count: 1 }); }),
    },
    // Rastro de cortes/reconexiones: la red de seguridad para los cortes del legacy,
    // que no tocan el estado del abonado.
    ticket: {
      findMany: jest.fn().mockResolvedValue(
        (opts.ordenes ?? []).map((o) => ({ subscriberId: o.subscriberId ?? sub?.id, type: o.type })),
      ),
    },
  };
  const mikrotik = {
    // Estado real leído del router (lo que de verdad decide si está cortado).
    liveStatus: jest.fn().mockResolvedValue({ ok: true, live: opts.live ?? {} }),
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
  // Abridor de órdenes: lo que no se pueda reconectar por red tiene que acabar en
  // una orden de servicio, no en un aviso que se pierde.
  let nOrden = 700_000;
  const ordenes = {
    abrirSiNoHay: jest.fn(async (input: any) => ({
      id: `t-${++nOrden}`, code: nOrden, type: input.type, nueva: true, estado: 'PENDIENTE',
    })),
    // Constancia de lo ya hecho: nace y se cierra en el mismo acto.
    registrarResuelta: jest.fn(async (input: any) => ({
      id: `t-${++nOrden}`, code: nOrden, type: input.type, nueva: true, estado: 'RESUELTO',
    })),
  };
  // Bus de eventos: por ahí sale el aviso que hace que el legacy se entere en el acto.
  const events = { emit: jest.fn((nombre: string, payload: any) => { escrituras.avisos.push({ nombre, payload }); }) };
  const srv = new ReconexionService(prisma as any, mikrotik as any, genieacs as any, ordenes as any, undefined, events as any);
  // El log de errores es intencional (queda para reintentar desde Red); en la
  // prueba solo estorba.
  jest.spyOn((srv as any).logger, 'error').mockImplementation(() => undefined);
  jest.spyOn((srv as any).logger, 'log').mockImplementation(() => undefined);
  jest.spyOn((srv as any).logger, 'warn').mockImplementation(() => undefined);
  return { srv, prisma, mikrotik, genieacs, ordenes, events, escrituras };
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

  it('devuelve la TV del cortado que no tiene filas de servicio: se la nombra su factura', async () => {
    // El caso del abonado 56720 (08-09-2026): combo internet+TV cortado desde junio.
    // `SubscriberService` está vacío para él —la migración solo pobló a los ACTIVO—
    // y la reconexión solo le devolvía el internet, sin ni intentar la televisión.
    const { srv, mikrotik, genieacs } = armar(
      abonado({ services: [], factura: { serviceTv: 'Television26', estadoTv: 'CORTADO' } }),
    );
    const r = await srv.porPago('sub-1');

    expect(mikrotik.reconnect).toHaveBeenCalled();
    expect(genieacs.tvBatchBySubscribers).toHaveBeenCalled();
    expect(r.servicios.map((s) => s.servicio).sort()).toEqual(['INTERNET', 'TV']);
  });

  it('y si el equipo no le devuelve esa TV, la deja en una orden de visita', async () => {
    const { srv, ordenes } = armar(
      abonado({ services: [], factura: { serviceTv: 'Television26', estadoTv: 'CORTADO' } }),
      { tvOk: false },
    );
    const r = await srv.porPago('sub-1');

    const tv = r.ordenes.find((o) => o.servicio === 'TV');
    expect(tv).toBeTruthy();
    expect(ordenes.abrirSiNoHay).toHaveBeenCalledWith(expect.objectContaining({ type: 'Reconexion Television' }));
  });

  it('no le inventa televisión al que su factura dice que no la tiene', async () => {
    const { srv, genieacs } = armar(
      abonado({ services: [], factura: { serviceTv: 'no', estadoTv: null } }),
    );
    const r = await srv.porPago('sub-1');
    expect(genieacs.tvBatchBySubscribers).not.toHaveBeenCalled();
    expect(r.servicios.map((s) => s.servicio)).toEqual(['INTERNET']);
  });

  it('no hace nada con el que ya estaba al día', async () => {
    const { srv, mikrotik, genieacs } = armar(abonado({ status: 'ACTIVO' }));
    const r = await srv.porPago('sub-1');
    expect(r.aplica).toBe(false);
    expect(r.ok).toBe(true);
    expect(mikrotik.reconnect).not.toHaveBeenCalled();
    expect(genieacs.tvBatchBySubscribers).not.toHaveBeenCalled();
  });

  it('con TV contratada pero sin equipo identificable no intenta nada por red: deja orden de servicio', async () => {
    const { srv, genieacs, ordenes } = armar(
      // Con su TV marcada como cortada: es la prueba de que hay algo que restablecer.
      abonado({ pppUsername: null, onus: 0, services: [{ id: 'sv-2', kind: 'TV', status: 'CORTADO' }] }),
    );
    const r = await srv.porPago('sub-1');
    expect(genieacs.tvBatchBySubscribers).not.toHaveBeenCalled();
    // Aplica: hay algo que hacer por este cliente, solo que no se hace por red.
    expect(r.aplica).toBe(true);
    expect(ordenes.abrirSiNoHay).toHaveBeenCalledWith(
      expect.objectContaining({ subscriberId: 'sub-1', type: 'Reconexion Television' }),
    );
    expect(r.ordenes.map((o) => o.servicio)).toEqual(['TV']);
    expect(r.mensaje).toContain('orden');
  });
});

describe('el estado de la ficha no es prueba de que tenga servicio', () => {
  // El caso real del abonado 1338 (2026-08-25): el legacy lo cortó por mora, allá el
  // estado se quedó en "Activo", aquí también, y al pagar el sistema respondía "no
  // estaba cortado". 221 de los 1.420 abonados que los routers tienen en MOROSOS
  // figuran ACTIVO en la ficha.
  it('la ficha dice ACTIVO pero el router lo tiene en MOROSOS: lo reconecta igual', async () => {
    const { srv, mikrotik } = armar(
      abonado({ status: 'ACTIVO', services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }] }),
      { live: { inMorosos: true } },
    );
    const r = await srv.porPago('sub-1');

    expect(mikrotik.liveStatus).toHaveBeenCalledWith('sub-1');
    expect(mikrotik.reconnect).toHaveBeenCalledWith('sub-1', undefined);
    expect(r.aplica).toBe(true);
    expect(r.ok).toBe(true);
  });

  it('el secret deshabilitado también cuenta como cortado', async () => {
    const { srv, mikrotik } = armar(
      abonado({ status: 'ACTIVO', services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }] }),
      { live: { secretDisabled: true } },
    );
    await srv.porPago('sub-1');
    expect(mikrotik.reconnect).toHaveBeenCalled();
  });

  it('si el router contesta que está bien, no inventa una reconexión', async () => {
    const { srv, mikrotik } = armar(
      abonado({ status: 'ACTIVO', services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }] }),
      { live: { inMorosos: false, secretDisabled: false }, ordenes: [{ type: 'Corte Internet' }] },
    );
    const r = await srv.porPago('sub-1');
    expect(mikrotik.reconnect).not.toHaveBeenCalled();
    expect(r.aplica).toBe(false);
  });

  it('sin respuesta del router, una orden de corte sin reconexión posterior basta', async () => {
    const { srv, mikrotik } = armar(
      abonado({ status: 'ACTIVO', services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }] }),
      { live: {}, ordenes: [{ type: 'Corte Internet' }, { type: 'Reconexion Internet' }] },
    );
    await srv.porPago('sub-1');
    expect(mikrotik.reconnect).toHaveBeenCalled();
  });

  it('si ya hubo una reconexión después del corte, no vuelve a reconectar', async () => {
    const { srv, mikrotik } = armar(
      abonado({ status: 'ACTIVO', services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }] }),
      { live: {}, ordenes: [{ type: 'Reconexion Internet' }, { type: 'Corte Internet' }] },
    );
    const r = await srv.porPago('sub-1');
    expect(mikrotik.reconnect).not.toHaveBeenCalled();
    expect(r.aplica).toBe(false);
  });

  it('una SUSPENSIÓN no se levanta pagando (la pidió el cliente)', async () => {
    const { srv, mikrotik } = armar(
      abonado({ status: 'ACTIVO', services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }] }),
      { live: {}, ordenes: [{ type: 'Suspension Internet' }, { type: 'Corte Internet' }] },
    );
    const r = await srv.porPago('sub-1');
    expect(mikrotik.reconnect).not.toHaveBeenCalled();
    expect(r.aplica).toBe(false);
  });

  it('un "Corte Combo" deja pendientes las dos cosas', async () => {
    const { srv, mikrotik, genieacs } = armar(
      abonado({ status: 'ACTIVO' }),
      { live: {}, ordenes: [{ type: 'Corte Combo' }] },
    );
    await srv.porPago('sub-1');
    expect(mikrotik.reconnect).toHaveBeenCalled();
    expect(genieacs.tvBatchBySubscribers).toHaveBeenCalled();
  });

  it('en el cargue de pagos la señal de órdenes también cuenta (sin preguntar al router)', async () => {
    const { srv, mikrotik } = armar(
      abonado({ status: 'ACTIVO', services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }] }),
      { ordenes: [{ type: 'Corte Internet' }] },
    );
    const r = await srv.porPagoLote(['sub-1']);
    expect(mikrotik.liveStatus).not.toHaveBeenCalled();
    expect(mikrotik.reconnectBatch).toHaveBeenCalled();
    expect(r.total).toBe(1);
  });

  // El retiro deja exactamente el mismo rastro que un corte por mora —secret
  // deshabilitado y orden de corte sin reconexión—, así que las dos vías que no
  // miraban el estado le devolvían el servicio a quien ya se dio de baja. En la
  // ventana de 30 días del portal de pagos eran 3 abonados.
  it('al RETIRADO no lo revive el router aunque lo tenga cortado', async () => {
    const { srv, mikrotik } = armar(
      abonado({ status: 'RETIRADO', services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }] }),
      { live: { inMorosos: true } },
    );
    const r = await srv.porPago('sub-1');
    expect(r.aplica).toBe(false);
    expect(mikrotik.reconnect).not.toHaveBeenCalled();
  });

  it('al RETIRADO tampoco lo revive su orden de corte, ni en el lote', async () => {
    for (const status of ['RETIRADO', 'DEPURADO', 'POR_RETIRAR', 'INACTIVO', 'SUSPENDIDO']) {
      const { srv, mikrotik } = armar(
        abonado({ status, services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }] }),
        { ordenes: [{ type: 'Corte Internet' }] },
      );
      const r = await srv.porPagoLote(['sub-1']);
      expect(r.total).toBe(0);
      expect(mikrotik.reconnectBatch).not.toHaveBeenCalled();
    }
  });

  it('y no sale en la lista que el puente de pagos en línea enseña en seco', async () => {
    const { srv } = armar(
      abonado({ status: 'RETIRADO', services: [{ id: 'sv-1', kind: 'TV', status: 'CORTADO' }] }),
      { ordenes: [{ type: 'Corte Combo' }] },
    );
    const r = await srv.aQuienLeToca(['sub-1']);
    expect(r.todos).toEqual([]);
  });
});

describe('lo que no se pudo reconectar queda como orden de servicio', () => {
  it('la TV que el equipo no aceptó se convierte en una orden pendiente', async () => {
    const { srv, ordenes } = armar(
      abonado({ services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }, { id: 'sv-2', kind: 'TV', status: 'CORTADO' }] }),
      { tvOk: false },
    );
    const r = await srv.porPago('sub-1', undefined, 'recibo 302513');

    expect(r.ok).toBe(false); // el fallo se sigue diciendo tal cual
    expect(ordenes.abrirSiNoHay).toHaveBeenCalledTimes(1);
    expect(ordenes.abrirSiNoHay).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Reconexion Television', priority: 'Alta' }),
    );
    expect(r.ordenes).toHaveLength(1);
    expect(r.ordenes[0].servicio).toBe('TV');
    // El detalle del equipo viaja dentro de la orden: el técnico no adivina.
    expect(ordenes.abrirSiNoHay.mock.calls[0][0].section).toContain('El ACS no pudo aplicar el cambio.');
    expect(ordenes.abrirSiNoHay.mock.calls[0][0].section).toContain('recibo 302513');
  });

  it('el internet que el router no aceptó también deja su orden', async () => {
    const { srv, ordenes } = armar(abonado(), { internetOk: false });
    const r = await srv.porPago('sub-1');
    expect(ordenes.abrirSiNoHay).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Reconexion Internet' }),
    );
    expect(r.ordenes.map((o) => o.servicio)).toEqual(['INTERNET']);
  });

  it('al que solo le cortaron el internet NO se le abre una orden de TV aunque el equipo falle', async () => {
    // El abonado está CORTADO por mora y tiene TV contratada, pero su televisión
    // nunca se cortó (servicio ACTIVO y sin orden de corte de TV): que la OLT no
    // responda no es motivo para mandarle un técnico a mirar un televisor que anda.
    const { srv, ordenes } = armar(abonado(), { tvOk: false });
    const r = await srv.porPago('sub-1');

    expect(r.servicios.find((s) => s.servicio === 'TV')!.ok).toBe(false);
    expect(ordenes.abrirSiNoHay).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Reconexion Television' }),
    );
    expect(r.ordenes.some((o) => o.servicio === 'TV')).toBe(false);
  });

  it('un corte de TV de hace dos años ya no cuenta como prueba', async () => {
    // El caso del abonado 1338: "Corte Television" de 2024 y su reconexión ANULADA.
    // La señal solo mira los últimos 45 días, así que ese rastro ya no dispara nada.
    const { srv, ordenes, genieacs } = armar(
      abonado({ status: 'ACTIVO', services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }, { id: 'sv-2', kind: 'TV', status: 'ACTIVO' }] }),
      { live: { inMorosos: true }, tvOk: false, ordenes: [] },
    );
    const r = await srv.porPago('sub-1');

    expect(genieacs.tvBatchBySubscribers).not.toHaveBeenCalled();
    expect(ordenes.abrirSiNoHay).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Reconexion Television' }),
    );
    expect(r.servicios.map((s) => s.servicio)).toEqual(['INTERNET']);
  });

  it('en dry-run NO abre órdenes: no se tocó ningún equipo', async () => {
    const { srv, ordenes } = armar(abonado(), { internetOk: false, tvOk: false, dryRun: true });
    const r = await srv.porPago('sub-1');
    expect(ordenes.abrirSiNoHay).not.toHaveBeenCalled();
    expect(r.ordenes).toHaveLength(0);
  });

  it('sin abridor de órdenes se comporta como antes (avisa y ya)', async () => {
    const { srv } = armar(abonado(), { tvOk: false });
    // Se le quita el abridor para simular el montaje viejo.
    (srv as any).ordenes = undefined;
    const r = await srv.porPago('sub-1');
    expect(r.ok).toBe(false);
    expect(r.ordenes).toHaveLength(0);
  });
});

describe('lo que SÍ se reconectó también deja su orden, ya cerrada', () => {
  it('registra "Reconexion Internet" resuelta cuando el servicio vuelve', async () => {
    const { srv, ordenes } = armar(abonado({ services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }] }));
    const r = await srv.porPago('sub-1', { name: 'Mireya Aguilera' } as any, 'recibo 302570');

    expect(ordenes.registrarResuelta).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'Reconexion Internet', subject: 'servicio', autor: 'Mireya Aguilera' }),
    );
    expect(r.registros).toHaveLength(1);
    expect(r.registros[0]).toMatchObject({ servicio: 'INTERNET', estado: 'RESUELTO' });
    // La constancia no es trabajo pendiente: no se mezcla con las visitas.
    expect(r.ordenes).toHaveLength(0);
  });

  it('en dry-run no registra nada: no se tocó ningún equipo', async () => {
    const { srv, ordenes } = armar(abonado(), { dryRun: true });
    const r = await srv.porPago('sub-1');
    expect(ordenes.registrarResuelta).not.toHaveBeenCalled();
    expect(r.registros).toHaveLength(0);
  });

  it('lo que falla no se registra como hecho', async () => {
    const { srv, ordenes } = armar(abonado({ services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }] }), { internetOk: false });
    const r = await srv.porPago('sub-1');
    expect(ordenes.registrarResuelta).not.toHaveBeenCalled();
    expect(r.registros).toHaveLength(0);
    expect(r.ordenes).toHaveLength(1); // esa sí es una visita pendiente
  });

  it('en el cargue de pagos también queda constancia', async () => {
    const { srv, ordenes } = armar(abonado({ services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }] }));
    const r = await srv.porPagoLote(['sub-1']);
    expect(ordenes.registrarResuelta).toHaveBeenCalledWith(expect.objectContaining({ type: 'Reconexion Internet' }));
    expect(r.registros).toBe(1);
  });
});

describe('el fallo no se traga', () => {
  it('si el router está caído lo dice y NO deja al cliente como activo', async () => {
    const { srv, escrituras } = armar(abonado({ services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }] }), { internetOk: false });
    const r = await srv.porPago('sub-1', undefined, 'recibo 7');

    expect(r.ok).toBe(false);
    // El mensaje dice qué quedó pendiente y en qué orden; lo que NO puede pasar es
    // que el cliente quede marcado como activo sin estarlo.
    expect(r.mensaje).toMatch(/pendiente de visita/);
    expect(r.ordenes).toHaveLength(1);
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

describe('el acuerdo de pago sobrevive a la reconexión', () => {
  // El arrastre del portal de pagos del 2026-08-28 dejó 39 COMPROMISO como ACTIVO: se
  // les devolvió el servicio y de paso se les borró el acuerdo de la ficha.
  it('al COMPROMISO le devuelve el servicio pero NO le cambia el estado', async () => {
    const { srv, prisma, mikrotik } = armar(abonado({ status: 'COMPROMISO' }));
    const r = await srv.porPago('sub-1');
    expect(mikrotik.reconnect).toHaveBeenCalled();
    expect(r.aplica).toBe(true);
    const estados = prisma.subscriber.update.mock.calls.map((c: any) => c[0]?.data?.status);
    expect(estados).not.toContain('ACTIVO');
    expect(prisma.subscriberStatusHistory.create).not.toHaveBeenCalled();
  });

  it('tampoco en el lote', async () => {
    const { srv, prisma } = armar(abonado({ status: 'COMPROMISO' }));
    await srv.porPagoLote(['sub-1']);
    const estados = prisma.subscriber.update.mock.calls.map((c: any) => c[0]?.data?.status);
    expect(estados).not.toContain('ACTIVO');
  });

  it('al CORTADO sí lo deja ACTIVO (no se cambió eso)', async () => {
    const { srv, prisma } = armar(abonado({ status: 'CORTADO' }));
    await srv.porPago('sub-1');
    const estados = prisma.subscriber.update.mock.calls.map((c: any) => c[0]?.data?.status);
    expect(estados).toContain('ACTIVO');
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

describe('si el router ya lo tenía al aire, no es una reconexión', () => {
  const alAire = (m: any) =>
    m.reconnect.mockResolvedValue({ ok: true, dryRun: false, action: 'RECONNECT', subscriberId: 'sub-1', steps: [], message: 'ok', wasCut: false });

  it('el COMPROMISO que paga sin estar cortado no deja orden ni cobro', async () => {
    // Caso real 12-09-2026: abonados 349, 2543 y 54205 (COMPROMISO) pagaron y quedó
    // una "Reconexion Internet" sin que el router los tuviera en MOROSOS.
    const { srv, mikrotik, ordenes, escrituras } = armar(
      abonado({ status: 'COMPROMISO', services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }] }),
    );
    alAire(mikrotik);
    const r = await srv.porPago('sub-1');
    expect(r.aplica).toBe(false);
    expect(r.registros).toHaveLength(0);
    expect(ordenes.registrarResuelta).not.toHaveBeenCalled();
    expect(ordenes.abrirSiNoHay).not.toHaveBeenCalled();
    expect(escrituras.historial).toHaveLength(0);
  });

  it('pero si lo sacó de MOROSOS sí deja su orden', async () => {
    const { srv, mikrotik, ordenes } = armar(
      abonado({ services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }] }),
    );
    mikrotik.reconnect.mockResolvedValue({ ok: true, dryRun: false, action: 'RECONNECT', subscriberId: 'sub-1', steps: [], message: 'ok', wasCut: true });
    const r = await srv.porPago('sub-1');
    expect(r.aplica).toBe(true);
    expect(ordenes.registrarResuelta).toHaveBeenCalledTimes(1);
  });

  it('en lote tampoco registra al que ya estaba al aire', async () => {
    const { srv, mikrotik, ordenes } = armar(
      abonado({ services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }] }),
    );
    mikrotik.reconnectBatch.mockResolvedValue({
      total: 1, ok: 1, results: [{ ok: true, dryRun: false, subscriberId: 'sub-1', steps: [], message: '', wasCut: false }],
    });
    const r = await srv.porPagoLote(['sub-1']);
    expect(r).toMatchObject({ internet: 0, registros: 0 });
    expect(ordenes.registrarResuelta).not.toHaveBeenCalled();
  });
});

describe('la cajera no se queda esperando a la OLT', () => {
  it('si los equipos se demoran responde "en curso" y sigue trabajando por detrás', async () => {
    jest.useFakeTimers();
    try {
      const { srv, mikrotik } = armar(abonado());
      mikrotik.reconnect.mockReturnValue(new Promise(() => undefined)); // nunca contesta
      const promesa = srv.porPago('sub-1');
      // `advanceTimersByTimeAsync` (no la versión síncrona) porque antes de llegar al
      // reloj hay varios `await`: leer el abonado, preguntarle al router y mirar sus
      // órdenes. Con la síncrona el temporizador se disparaba antes de que el trabajo
      // hubiera arrancado siquiera.
      await jest.advanceTimersByTimeAsync(20_000);
      const r = await promesa;

      expect(r.enCurso).toBe(true);
      expect(r.ok).toBe(true);
      expect(r.mensaje).toMatch(/en curso/);
    } finally {
      jest.useRealTimers();
    }
  });
});

/**
 * El corte que ve el cliente en pantalla no está en `Subscriber.status`: está en la
 * FACTURA (`estadoCombo` / `estadoTv`, las columnas `estado_combo` / `estado_tv` del
 * legacy). Reconectar sin limpiarlas dejaba al abonado navegando y cortado en la ficha.
 */
describe('el corte se levanta también en la factura', () => {
  it('al reconectar el internet limpia estadoCombo, no estadoTv', async () => {
    const { srv, escrituras } = armar(abonado({ services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }] }));
    await srv.porPago('sub-1');

    const limpieza = escrituras.facturas.find((f) => 'estadoCombo' in (f.data ?? {}));
    expect(limpieza).toBeTruthy();
    expect(limpieza.data.estadoCombo).toBeNull();
    expect(limpieza.data).not.toHaveProperty('estadoTv');
    // Sólo la factura vigente, la que devolvió la consulta: las viejas no se tocan.
    expect(limpieza.where.id).toEqual({ in: ['inv-vigente'] });
  });

  it('al reconectar la TV limpia estadoTv, no estadoCombo', async () => {
    const { srv, escrituras } = armar(abonado({
      services: [{ id: 'sv-2', kind: 'TV', status: 'CORTADO' }], pppUsername: null, onus: 1,
    }));
    await srv.porPago('sub-1');

    const limpieza = escrituras.facturas.find((f) => 'estadoTv' in (f.data ?? {}));
    expect(limpieza).toBeTruthy();
    expect(limpieza.data.estadoTv).toBeNull();
    expect(limpieza.data).not.toHaveProperty('estadoCombo');
  });

  it('en dry-run NO toca la factura: no se tocó ningún equipo', async () => {
    const { srv, escrituras } = armar(abonado(), { dryRun: true });
    await srv.porPago('sub-1');
    expect(escrituras.facturas).toHaveLength(0);
  });

  it('si el equipo falla no limpia nada: el cliente sigue cortado de verdad', async () => {
    const { srv, escrituras } = armar(abonado({ services: [{ id: 'sv-1', kind: 'INTERNET', status: 'ACTIVO' }] }), { internetOk: false });
    await srv.porPago('sub-1');
    expect(escrituras.facturas).toHaveLength(0);
  });
});

/**
 * El aviso al legacy no es cosmético: su ida devuelve `usu_estado` cada 15 minutos y
 * borra la reconexión hecha aquí si no llega antes (35 de las 37 primeras acabaron así).
 */
describe('aviso para que el legacy se entere en el acto', () => {
  it('avisa cuando el servicio volvió de verdad', async () => {
    const { srv, escrituras } = armar(abonado());
    await srv.porPago('sub-1');

    const avisos = escrituras.avisos.filter((a) => a.nombre === 'network.reconexion.aplicada');
    expect(avisos.length).toBeGreaterThan(0);
    expect(avisos.flatMap((a) => a.payload.subscriberIds)).toContain('sub-1');
  });

  it('no avisa en dry-run ni cuando el equipo falla', async () => {
    for (const opts of [{ dryRun: true }, { internetOk: false, tvOk: false }]) {
      const { srv, escrituras } = armar(abonado(), opts);
      await srv.porPago('sub-1');
      expect(escrituras.avisos.filter((a) => a.nombre === 'network.reconexion.aplicada')).toHaveLength(0);
    }
  });
});
