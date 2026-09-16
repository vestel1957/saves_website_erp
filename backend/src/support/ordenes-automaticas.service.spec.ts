import { OrdenesAutomaticasService } from './ordenes-automaticas.service';

/**
 * Las órdenes que abre el sistema.
 *
 * Lo que importa aquí es que exista trabajo cuando algo falla y que NO se duplique:
 * un cliente en cartera puede abonar tres veces en una semana, y tres órdenes de
 * "Reconexion Television" para el mismo trabajo ensucian la agenda del técnico y el
 * tablero de rendimiento.
 */
function armar(abierta: any = null) {
  const creados: any[] = [];
  const prisma = {
    ticket: { findFirst: jest.fn().mockResolvedValue(abierta) },
    $transaction: jest.fn(async (fn: any) =>
      fn({
        ticket: { create: jest.fn((args: any) => { creados.push(args.data); return Promise.resolve({ id: 't-1', code: 500123, type: args.data.type }); }) },
        // `nextTid` avanza el contador propio de nexus (nextval de la secuencia).
        $queryRaw: jest.fn().mockResolvedValue([{ tid: 500123n }]),
      }),
    ),
  };
  const porCargo = { notifyPost: jest.fn().mockResolvedValue(undefined) };
  const srv = new OrdenesAutomaticasService(prisma as any, porCargo as any);
  jest.spyOn((srv as any).logger, 'log').mockImplementation(() => undefined);
  jest.spyOn((srv as any).logger, 'error').mockImplementation(() => undefined);
  return { srv, prisma, porCargo, creados };
}

describe('órdenes que abre el sistema', () => {
  it('abre la orden PENDIENTE y NO le suena a nadie', async () => {
    const { srv, porCargo, creados } = armar();
    const o = await srv.abrirSiNoHay({
      subscriberId: 'sub-1', type: 'Reconexion Television', problem: 'El cliente pagó y no volvió la TV.',
    });

    expect(o).toMatchObject({ nueva: true, type: 'Reconexion Television' });
    expect(creados[0]).toMatchObject({ status: 'PENDIENTE', subject: 'servicio', subscriberId: 'sub-1', code: 500123 });
    // El aviso se retiró el 2026-08-29 (decisión del usuario): una orden automática
    // —38 al día, casi todas reconexiones por pago— no es trabajo que nadie tenga
    // que ir a hacer en ese momento, y avisarla una a una llenaba 31 campanitas con
    // 4.688 avisos en cuatro días. Se reparten desde la bandeja de "sin agendar", y
    // al técnico se le avisa cuando la orden pasa a ser SUYA (`AvisoTecnicoService`).
    expect(porCargo.notifyPost).not.toHaveBeenCalled();
  });

  it('si ya hay una orden abierta igual, la reusa en vez de duplicar el trabajo', async () => {
    const { srv, prisma, porCargo } = armar({ id: 't-9', code: 499000, type: 'Reconexion Television' });
    const o = await srv.abrirSiNoHay({ subscriberId: 'sub-1', type: 'Reconexion Television' });

    expect(o).toEqual({ id: 't-9', code: 499000, type: 'Reconexion Television', nueva: false, estado: 'PENDIENTE' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(porCargo.notifyPost).not.toHaveBeenCalled();
  });

  it('la constancia nace ya RESUELTA y no le avisa a nadie (no hay trabajo que repartir)', async () => {
    const { srv, porCargo, creados } = armar();
    const o = await srv.registrarResuelta({
      subscriberId: 'sub-1', type: 'Reconexion Internet', problem: 'Volvió el internet.',
    });

    expect(o).toMatchObject({ nueva: true, estado: 'RESUELTO' });
    expect(creados[0]).toMatchObject({ status: 'RESUELTO', type: 'Reconexion Internet' });
    expect(creados[0].resolvedAt).toBeInstanceOf(Date);
    expect(porCargo.notifyPost).not.toHaveBeenCalled();
  });

  it('si ya había una orden abierta de lo mismo, la CIERRA en vez de crear otra', async () => {
    const { srv, prisma, creados } = armar({ id: 't-9', code: 499000, type: 'Reconexion Internet' });
    (prisma as any).ticket.update = jest.fn().mockResolvedValue({});

    const o = await srv.registrarResuelta({ subscriberId: 'sub-1', type: 'Reconexion Internet' });

    expect(o).toMatchObject({ id: 't-9', nueva: false, estado: 'RESUELTO' });
    expect((prisma as any).ticket.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 't-9' }, data: expect.objectContaining({ status: 'RESUELTO' }) }),
    );
    expect(creados).toHaveLength(0); // no se duplicó
  });

  it('no tumba a quien la llama si la escritura falla', async () => {
    const { srv, prisma } = armar();
    prisma.$transaction.mockRejectedValueOnce(new Error('base caída'));
    await expect(srv.abrirSiNoHay({ subscriberId: 'sub-1', type: 'Reconexion Internet' })).resolves.toBeNull();
  });
});
