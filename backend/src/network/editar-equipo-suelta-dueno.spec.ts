import 'reflect-metadata';
import { NetworkWriteService } from './network-write.service';

/**
 * Editar el estado de un equipo desde el inventario (2026-09-15): poner "Disponible"
 * dejaba el dueño puesto, y el equipo no se podía entregar a nadie más ("la MAC ya
 * está asignada a otro cliente"). Ahora se suelta como en una devolución.
 */
describe('editar equipo: el estado suelta al cliente', () => {
  const armar = (eq: any, restantes: any[] = []) => {
    const tx: any = {
      equipment: { update: jest.fn() },
      port: { updateMany: jest.fn() },
      subscriber: { update: jest.fn() },
      subscriberNote: { create: jest.fn() },
    };
    const prisma: any = {
      equipment: { findUnique: jest.fn().mockResolvedValue(eq), findMany: jest.fn().mockResolvedValue(restantes), update: jest.fn() },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const svc = new NetworkWriteService(prisma, null as any, null as any, null as any);
    return { svc, prisma, tx };
  };
  const user: any = { id: 'u1', email: 'admin@x', name: 'Admin', permissions: [], areas: ['administracion'] };
  const base = { id: 'e1', code: 311071, mac: '50:5B:1D:8D:65:66', status: 'Asignado', subscriberId: 'barbara', port: 10178, reservedTicketId: null };

  it('a Disponible: quita dueño, libera el puerto y la MAC del cliente', async () => {
    const { svc, prisma, tx } = armar({ ...base });
    const r = await svc.updateEquipment('e1', { status: 'Disponible' } as any, user);
    expect(r).toMatchObject({ soltado: true, cambios: 1 });
    expect(prisma.equipment.update).not.toHaveBeenCalled();
    expect(tx.equipment.update.mock.calls[0][0].data).toMatchObject({ status: 'Disponible', subscriber: { disconnect: true }, assignedRaw: null, port: null, nat: null });
    expect(tx.port.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { subscriberId: 'barbara', legacyId: 10178 } }));
    expect(tx.subscriber.update).toHaveBeenCalledWith({ where: { id: 'barbara' }, data: { macEquipo: 'sin asignar' } });
    expect(tx.subscriberNote.create).toHaveBeenCalled();
  });

  it('si otro equipo del cliente cuelga del mismo puerto, el puerto no se libera y su MAC pasa a la del otro', async () => {
    const { svc, tx } = armar({ ...base }, [{ mac: 'AA:BB', port: 10178 }]);
    await svc.updateEquipment('e1', { status: 'Malo' } as any, user);
    expect(tx.port.updateMany).not.toHaveBeenCalled();
    expect(tx.subscriber.update).toHaveBeenCalledWith({ where: { id: 'barbara' }, data: { macEquipo: 'AA:BB' } });
  });

  it('sin dueño, o cambiando solo la observación, no toca ningún cliente', async () => {
    const libre = armar({ ...base, subscriberId: null, status: 'Bueno' });
    expect(await libre.svc.updateEquipment('e1', { status: 'Disponible' } as any, user)).not.toHaveProperty('soltado');
    expect(libre.prisma.$transaction).not.toHaveBeenCalled();

    const nota = armar({ ...base });
    await nota.svc.updateEquipment('e1', { observation: 'caja golpeada' } as any, user);
    expect(nota.prisma.$transaction).not.toHaveBeenCalled();
    expect(nota.prisma.equipment.update).toHaveBeenCalled();
  });
});
