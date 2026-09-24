import 'reflect-metadata';
import { SupportWriteService } from './support-write.service';
import { serviciosDeOrden } from './order-types';

/**
 * La cascada de cierre, servicio por servicio.
 *
 * El internet y la televisión viven en equipos distintos —el Mikrotik y el CPE/OLT—
 * y la cascada hablaba solo con el primero. Por eso cerrar una 'Reconexion
 * Television' dejaba al cliente sin señal (y de paso le devolvía el internet a quien
 * seguía debiendo), y cerrar un 'Corte Television' le cortaba el internet a alguien
 * que solo debía perder la TV.
 */
function armar(opts: { tvOk?: boolean; conTv?: boolean; detalle?: string } = {}) {
  const { tvOk = true, conTv = true } = opts;
  const subscriberUpdates: any[] = [];
  const serviciosMarcados: any[] = [];

  const historial: any[] = [];
  const facturaMarcada: any[] = [];

  const prisma: any = {
    subscriber: {
      update: jest.fn(async (a: any) => { subscriberUpdates.push(a.data); return {}; }),
      findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVO' }),
    },
    subscriberService: {
      count: jest.fn().mockResolvedValue(conTv ? 1 : 0),
      updateMany: jest.fn(async (a: any) => { serviciosMarcados.push({ ...a.data, _where: a.where }); return { count: 1 }; }),
    },
    subscriberStatusHistory: { create: jest.fn(async (a: any) => { historial.push(a.data); return {}; }) },
    subInvoice: {
      findFirst: jest.fn().mockResolvedValue(null),
      // La factura vigente del abonado, cortada: es lo que la ficha pinta en rojo y lo
      // que la reconexión tiene que levantar (`levantarCorteEnFactura`).
      findUnique: jest.fn().mockResolvedValue({ estadoCombo: 'CORTADO', estadoTv: 'CORTADO', ron: 'CORTADO' }),
      update: jest.fn(async (a: any) => { facturaMarcada.push(a.data); return {}; }),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'fac-1' }]),
    appSetting: { findUnique: jest.fn().mockResolvedValue(null) }, // sin auto-cobro
  };
  const mikrotik: any = {
    cut: jest.fn().mockResolvedValue({ ok: true }),
    reconnect: jest.fn().mockResolvedValue({ ok: true }),
  };
  const genieacs: any = {
    tvBatchBySubscribers: jest.fn(async (ids: string[], enable: boolean) => ({
      ok: tvOk,
      results: [{
        subscriberId: ids[0], via: tvOk ? 'TR069' : null, ok: tvOk,
        detail: opts.detalle ?? (tvOk ? `TV ${enable ? 'restaurada' : 'cortada'} por TR-069.` : 'Sin equipo identificado.'),
      }],
    })),
  };

  const srv = new SupportWriteService(
    prisma, mikrotik, {} as any, {} as any, {} as any, {} as any, {} as any, undefined, genieacs,
  );
  const cascada = (type: string) => (srv as any).applyCloseCascade({ subscriberId: 'sub-1', type, code: 504994 });
  return { cascada, prisma, mikrotik, genieacs, subscriberUpdates, serviciosMarcados, historial, facturaMarcada };
}

describe('qué servicio toca cada orden', () => {
  it('lee el servicio del nombre de la orden', () => {
    expect(serviciosDeOrden('Reconexion Television')).toEqual(['TV']);
    expect(serviciosDeOrden('Corte Television')).toEqual(['TV']);
    expect(serviciosDeOrden('Reconexion Internet2')).toEqual(['INTERNET']);
    expect(serviciosDeOrden('Reconexion Combo por dias')).toEqual(['INTERNET', 'TV']);
    // Genéricas: no dicen de qué hablan, se piden los dos y se filtra por lo contratado.
    expect(serviciosDeOrden('Instalacion')).toEqual(['INTERNET', 'TV']);
  });
});

describe('cascada de cierre por servicio', () => {
  it('cerrar una reconexión de TV enciende la TV y NO toca el router', async () => {
    const { cascada, mikrotik, genieacs, serviciosMarcados } = armar();
    const c = await cascada('Reconexion Television');

    expect(genieacs.tvBatchBySubscribers).toHaveBeenCalledWith(['sub-1'], true, undefined, { desdeOrden: true });
    expect(mikrotik.reconnect).not.toHaveBeenCalled();
    expect(c.tv).toMatchObject({ ok: true, via: 'TR069' });
    expect(serviciosMarcados.map((x: any) => x.status)).toEqual(['ACTIVO']);
  });

  it('una orden de TV no cambia el estado del abonado', async () => {
    const { cascada, subscriberUpdates } = armar();
    const c = await cascada('Suspension Television');
    expect(c.statusSet).toBeUndefined();
    expect(subscriberUpdates).toEqual([]);
  });

  it('cerrar un corte de TV apaga la TV, no el internet', async () => {
    const { cascada, mikrotik, serviciosMarcados } = armar();
    const c = await cascada('Corte Television');
    expect(mikrotik.cut).not.toHaveBeenCalled();
    expect(c.tv.ok).toBe(true);
    expect(serviciosMarcados.map((x: any) => x.status)).toEqual(['CORTADO']);
  });

  it('si el equipo no pudo, lo dice en la cara de quien cierra', async () => {
    const { cascada } = armar({ tvOk: false });
    const c = await cascada('Reconexion Television');
    expect(c.tv.ok).toBe(false);
    expect(c.mensaje).toContain('⚠');
    expect(c.mensaje).toContain('Sin equipo identificado');
  });

  it('aun fallando el equipo, la ficha queda al día: la cerró una persona', async () => {
    const { cascada, serviciosMarcados } = armar({ tvOk: false });
    await cascada('Reconexion Television');
    expect(serviciosMarcados.map((x: any) => x.status)).toEqual(['ACTIVO']);
  });

  it('cerrar la reconexión de internet TAMBIÉN borra el corte de la línea de servicio', async () => {
    // El chip rojo de la ficha no lo pinta el estado del abonado: manda el corte de
    // `SubscriberService`, que el lote de corte escribe y nadie borraba. Abonado 17842,
    // 10-09-2026: reconectado en el router, factura limpia y ficha en rojo.
    const { cascada, prisma } = armar();
    await cascada('Reconexion Internet');
    expect(prisma.subscriberService.updateMany).toHaveBeenCalledWith({
      where: { subscriberId: 'sub-1', kind: 'INTERNET', status: 'CORTADO' },
      data: { status: 'ACTIVO' },
    });
  });

  it('sólo levanta lo CORTADO: una suspensión no la deshace una reconexión', async () => {
    const { cascada, prisma } = armar();
    await cascada('Reconexion Internet');
    const llamada = prisma.subscriberService.updateMany.mock.calls.at(-1)[0];
    expect(llamada.where.status).toBe('CORTADO');
  });

  it('una reconexión de sólo TV no toca la línea del internet', async () => {
    const { cascada, prisma } = armar();
    await cascada('Reconexion Television');
    const kinds = prisma.subscriberService.updateMany.mock.calls.map((c: any[]) => c[0].where.kind);
    expect(kinds).not.toContainEqual('INTERNET');
  });

  it('la reconexión de internet sigue yendo al router y activando al cliente', async () => {
    const { cascada, mikrotik, genieacs } = armar();
    const c = await cascada('Reconexion Internet');
    expect(mikrotik.reconnect).toHaveBeenCalledWith('sub-1', undefined);
    expect(genieacs.tvBatchBySubscribers).not.toHaveBeenCalled();
    expect(c.statusSet).toBe('ACTIVO');
  });

  it('el combo devuelve las dos cosas', async () => {
    const { cascada, mikrotik, genieacs } = armar();
    const c = await cascada('Reconexion Combo');
    expect(mikrotik.reconnect).toHaveBeenCalled();
    expect(genieacs.tvBatchBySubscribers).toHaveBeenCalledWith(['sub-1'], true, undefined, { desdeOrden: true });
    expect(c.statusSet).toBe('ACTIVO');
  });

  it('una instalación no le enciende la TV a quien no la tiene contratada', async () => {
    const { cascada, genieacs, mikrotik } = armar({ conTv: false });
    await cascada('Instalacion');
    expect(mikrotik.reconnect).toHaveBeenCalled();
    expect(genieacs.tvBatchBySubscribers).not.toHaveBeenCalled();
  });

  /**
   * El retiro que no dejaba rastro. La cascada ponía RETIRADO en la ficha y nada más:
   * sin fila de historial no viajaba al legacy (`pushEstados`/`pushBajas`), y el estado
   * lo manda el legacy en la ida, así que quince minutos después el cliente retirado
   * volvía a estar ACTIVO (orden #504994, 31-08-2026).
   */
  it('un retiro deja constancia: estado anterior, historial y la baja en la factura', async () => {
    const { cascada, subscriberUpdates, historial, facturaMarcada } = armar();
    const c = await cascada('Retiro voluntario');

    expect(c.statusSet).toBe('RETIRADO');
    expect(subscriberUpdates).toContainEqual(expect.objectContaining({ status: 'RETIRADO', previousStatus: 'ACTIVO' }));
    expect(historial).toHaveLength(1);
    expect(historial[0]).toMatchObject({ status: 'RETIRADO', originTicketId: 504994 });
    expect(facturaMarcada[0]).toMatchObject({ ron: 'RETIRADO', estadoTv: 'SUSPENDIDO', estadoCombo: 'SUSPENDIDO' });
  });

  /**
   * El agujero por el que se coló la orden #502150 (31-08-2026): la suspensión SÓLO de
   * televisión no le cambia el estado al abonado —y hace bien—, así que no deja fila de
   * historial y `pushBajas`, que busca por ahí a quién empujar, no la veía. Nadie se lo
   * contaba al legacy y la ida devolvía el "al aire" quince minutos después. La marca
   * `serviceStatusAt` es lo que la hace sobrevivir: sin ella esta prueba pasa igual y en
   * la calle el cliente sigue con la TV activa en pantalla.
   */
  it('una suspensión de sólo TV baja el servicio en la factura y deja la marca que la salva', async () => {
    const { cascada, subscriberUpdates, historial, facturaMarcada } = armar();
    const c = await cascada('Suspension Television');

    expect(c.statusSet).toBeUndefined();            // el abonado NO queda suspendido
    expect(subscriberUpdates).toHaveLength(0);
    expect(historial).toHaveLength(0);
    expect(facturaMarcada[0]).toMatchObject({ estadoTv: 'SUSPENDIDO' });
    expect(facturaMarcada[0].estadoCombo).toBeUndefined(); // su internet no se toca
    expect(facturaMarcada[0].ron).toBeUndefined();         // el `ron` es del abonado
    expect(facturaMarcada[0].serviceStatusAt).toBeInstanceOf(Date);
  });

  /**
   * La suspensión del COMBO sí es del abonado entero: pierde el internet y la
   * televisión, así que la ficha tiene que decir SUSPENDIDO. No es cosmético —el
   * estado es lo que mira el corte masivo, la cartera y el paz y salvo—, y es
   * además lo que `pushBajas` busca para contárselo al legacy antes de que la ida
   * lo devuelva a Cortado quince minutos después (orden #505112, 01-09-2026).
   */
  it('una suspensión de combo deja al abonado SUSPENDIDO', async () => {
    const { cascada, prisma, mikrotik, subscriberUpdates, historial, facturaMarcada } = armar();
    prisma.subscriber.findUnique.mockResolvedValue({ status: 'CORTADO' }); // venía cortado por mora
    const c = await cascada('Suspension Combo');

    expect(c.statusSet).toBe('SUSPENDIDO');
    expect(mikrotik.cut).toHaveBeenCalled();            // y se le baja el internet
    expect(c.tv.ok).toBe(true);                          // y la televisión
    expect(subscriberUpdates).toContainEqual(
      expect.objectContaining({ status: 'SUSPENDIDO', previousStatus: 'CORTADO' }),
    );
    expect(historial[0]).toMatchObject({ status: 'SUSPENDIDO', originTicketId: 504994 });
    expect(facturaMarcada[0]).toMatchObject({ ron: 'SUSPENDIDO', estadoTv: 'SUSPENDIDO', estadoCombo: 'SUSPENDIDO' });
  });

  /**
   * El espejo que faltaba. El cierre sabía ESCRIBIR el corte en la factura
   * (`marcarBajaEnFactura`) pero no borrarlo, y la ficha lee de ahí qué servicio está
   * caído: se cerraba la 'Reconexion Internet', el router devolvía al abonado a ACTIVOS
   * y su ficha seguía pintando el internet en rojo (orden #505799, 09-09-2026).
   */
  it('cerrar una reconexión de internet levanta el corte de la factura', async () => {
    const { cascada, facturaMarcada } = armar();
    const c = await cascada('Reconexion Internet');

    expect(c.facturaReconexion).toMatchObject({ ok: true });
    expect(facturaMarcada[0]).toMatchObject({ estadoCombo: null });
    expect(facturaMarcada[0].estadoTv).toBeUndefined();  // no se le regala la televisión
    expect(facturaMarcada[0].ron).toBeUndefined();       // le queda la TV cortada: el eje no sube
    // Sin la marca, la ida del sync devuelve el 'Cortado' del legacy a los 15 minutos.
    expect(facturaMarcada[0].serviceStatusAt).toBeInstanceOf(Date);
  });

  it('el combo levanta los dos servicios y sube el `ron` de la factura', async () => {
    const { cascada, facturaMarcada } = armar();
    await cascada('Reconexion Combo');
    expect(facturaMarcada[0]).toMatchObject({ estadoCombo: null, estadoTv: null, ron: 'ACTIVO' });
  });

  /**
   * Una SUSPENSIÓN no la deshace una reconexión: la pidió el cliente y se levanta por
   * su propio trámite. Sólo se borra lo que dice 'Cortado'.
   */
  it('una reconexión no levanta un servicio SUSPENDIDO', async () => {
    const { cascada, prisma, facturaMarcada } = armar();
    prisma.subInvoice.findUnique.mockResolvedValue({ estadoCombo: 'SUSPENDIDO', estadoTv: null, ron: 'SUSPENDIDO' });
    const c = await cascada('Reconexion Internet');
    expect(c.facturaReconexion).toMatchObject({ sinCambio: true });
    expect(facturaMarcada).toHaveLength(0);
  });

  /**
   * Y la reconexión deja CONSTANCIA, que es de donde el writeback saca a quién empujar
   * al legacy (`pushEstados`/`pushReconexiones`). Hasta el 09-09-2026 el estado lo movía
   * en silencio `MikrotikService.markStatus`, sin fila de historial: la reconexión no
   * llegaba allá y la ida devolvía el 'Cortado' quince minutos después.
   */
  it('una reconexión de internet deja fila de historial', async () => {
    const { cascada, prisma, historial } = armar();
    prisma.subscriber.findUnique.mockResolvedValue({ status: 'CORTADO' }); // venía cortado por mora
    await cascada('Reconexion Internet');
    expect(historial[0]).toMatchObject({ status: 'ACTIVO', originTicketId: 504994 });
    expect(historial[0].note).toContain('Reconexión');
  });

  /** El ACUERDO DE PAGO se respeta: vuelve el servicio, no se borra el compromiso. */
  it('reconectar a un COMPROMISO no lo pone ACTIVO', async () => {
    const { cascada, prisma, historial, subscriberUpdates } = armar();
    prisma.subscriber.findUnique.mockResolvedValue({ status: 'COMPROMISO' });
    await cascada('Reconexion Internet');
    expect(historial).toHaveLength(0);
    expect(subscriberUpdates).toHaveLength(0);
  });

  it('cerrar un corte de TV lo deja CORTADO en la factura (no suspendido)', async () => {
    const { cascada, facturaMarcada } = armar();
    await cascada('Corte Television');
    expect(facturaMarcada[0]).toMatchObject({ estadoTv: 'CORTADO' });
    expect(facturaMarcada[0].estadoCombo).toBeUndefined();
    expect(facturaMarcada[0].serviceStatusAt).toBeInstanceOf(Date);
  });

  it('cerrar dos veces el mismo retiro no duplica el historial', async () => {
    const { cascada, prisma, historial } = armar();
    prisma.subscriber.findUnique.mockResolvedValue({ status: 'RETIRADO' }); // ya estaba retirado
    await cascada('Retiro voluntario');
    expect(historial).toHaveLength(0);
  });

  it('sin módulo de equipos no se inventa que la TV volvió', async () => {
    const prisma: any = {
      subscriber: { update: jest.fn(), findUnique: jest.fn().mockResolvedValue({ status: 'CORTADO' }) },
      subscriberService: { count: jest.fn().mockResolvedValue(1), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      subInvoice: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
      subscriberStatusHistory: { create: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
      appSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const srv = new SupportWriteService(prisma, { reconnect: jest.fn() } as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const c = await (srv as any).applyCloseCascade({ subscriberId: 'sub-1', type: 'Reconexion Television' });
    expect(c.tv.ok).toBe(false);
    expect(c.mensaje).toContain('⚠');
  });
});
