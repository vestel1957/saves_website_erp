import 'reflect-metadata';
import { OnuAlDevolverService } from './onu-al-devolver.service';

/**
 * Devolver un equipo lo desautentica de la OLT (2026-09-15). Caso real: la ONU 311071
 * (XPON1D8D6564) se devolvió en el inventario y siguió dada de alta en MONTERREY
 * 0/1/11 a nombre del cliente anterior.
 */
describe('al devolver un equipo sale también de la OLT', () => {
  const MONTERREY = { id: 'olt-mty', name: 'MONTERREY' };
  const alta = { fsp: '0/1/11', frame: 0, slot: 1, port: 11, ont_id: 45, run_state: 'online', description: '2378BARBARA' };

  const armar = (o: { vinculadas?: any[]; estado?: any; remove?: any; branchId?: string | null } = {}) => {
    const prisma: any = {
      oltOnu: { findMany: jest.fn().mockResolvedValue(o.vinculadas ?? []), deleteMany: jest.fn() },
      subscriber: { findUnique: jest.fn().mockResolvedValue({ branchId: o.branchId === undefined ? 'br-mty' : o.branchId }) },
      olt: { findMany: jest.fn().mockResolvedValue([MONTERREY]) },
      subscriberNote: { create: jest.fn().mockResolvedValue({}) },
      ticketThread: { create: jest.fn().mockResolvedValue({}) },
    };
    const olt: any = {
      estadoPorSn: jest.fn().mockResolvedValue(o.estado === undefined ? { ok: true, estado: alta } : o.estado),
      remove: jest.fn().mockResolvedValue(o.remove ?? { ok: true, dryRun: false, message: 'ONU eliminada' }),
    };
    return { svc: new OnuAlDevolverService(prisma, olt), prisma, olt };
  };
  const base = { serial: 'XPON1D8D6564', code: 311071, subscriberId: 'barbara', motivo: 'Devolución: recogido' };

  it('la busca por su SN de 16 hex, la borra donde esté y limpia el inventario de la OLT', async () => {
    const { svc, prisma, olt } = armar();
    const r = await svc.desautenticar({ ...base, ticketCode: 506243 });
    expect(r).toEqual({ accion: 'BORRADA', olt: 'MONTERREY', fsp: '0/1/11 ONT 45', dryRun: false });
    expect(olt.estadoPorSn).toHaveBeenCalledWith('olt-mty', '58504F4E1D8D6564');
    expect(olt.remove).toHaveBeenCalledWith('olt-mty', { frame: 0, slot: 1, port: 11, ont_id: 45, sn: '58504F4E1D8D6564' }, undefined);
    expect(prisma.oltOnu.deleteMany).toHaveBeenCalledWith({ where: { sn: '58504F4E1D8D6564', oltId: 'olt-mty' } });
    expect(prisma.subscriberNote.create).toHaveBeenCalled();
    expect(prisma.ticketThread.create).toHaveBeenCalled();
  });

  it('si la OLT la vincula a OTRO cliente, no la toca y lo anota', async () => {
    const { svc, olt, prisma } = armar({
      vinculadas: [{ oltId: 'olt-mty', subscriberId: 'vecino', clientName: 'JUAN VECINO', olt: { name: 'MONTERREY' } }],
    });
    const r = await svc.desautenticar(base);
    expect(r).toMatchObject({ accion: 'DE_OTRO', de: 'JUAN VECINO' });
    expect(olt.remove).not.toHaveBeenCalled();
    expect(prisma.subscriberNote.create.mock.calls[0][0].data.body).toMatch(/NO se desautenticó/);
  });

  it('vinculada al MISMO cliente que la devuelve (la vieja de un cambio de equipo): sí la borra', async () => {
    const { svc, olt } = armar({
      vinculadas: [{ oltId: 'olt-mty', subscriberId: 'barbara', clientName: 'BARBARA', olt: { name: 'MONTERREY' } }],
    });
    expect((await svc.desautenticar(base)).accion).toBe('BORRADA');
    expect(olt.remove).toHaveBeenCalled();
  });

  it('un equipo sin serial de ONU (deco, router, "solicitar") no consulta la OLT', async () => {
    const { svc, olt } = armar();
    expect(await svc.desautenticar({ ...base, serial: 'solicitar' })).toEqual({ accion: 'SIN_SERIAL' });
    expect(olt.estadoPorSn).not.toHaveBeenCalled();
  });

  it('si no está dada de alta no borra nada', async () => {
    const { svc, olt } = armar({ estado: { ok: false, estado: null } });
    expect(await svc.desautenticar(base)).toEqual({ accion: 'NO_ESTABA' });
    expect(olt.remove).not.toHaveBeenCalled();
  });

  it('en modo simulación (OLT_LIVE apagado) no limpia el inventario y lo dice', async () => {
    const { svc, prisma } = armar({ remove: { ok: true, dryRun: true } });
    expect(await svc.desautenticar(base)).toMatchObject({ accion: 'BORRADA', dryRun: true });
    expect(prisma.oltOnu.deleteMany).not.toHaveBeenCalled();
    expect(prisma.subscriberNote.create.mock.calls[0][0].data.body).toMatch(/simulación/);
  });

  it('la OLT rechaza el borrado o revienta: nunca lanza, anota el fallo', async () => {
    const rechazo = armar({ remove: { ok: false, error: 'timeout' } });
    expect(await rechazo.svc.desautenticar(base)).toEqual({ accion: 'ERROR', error: 'timeout' });
    expect(rechazo.prisma.subscriberNote.create.mock.calls[0][0].data.body).toMatch(/no se pudo desautenticar/);

    const caida = armar();
    caida.olt.estadoPorSn.mockRejectedValue(new Error('socket hang up'));
    expect(await caida.svc.desautenticar(base)).toEqual({ accion: 'ERROR', error: 'socket hang up' });
  });
});
