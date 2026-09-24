import 'reflect-metadata';
import { SupportWriteService } from './support-write.service';

/**
 * Editar la caja NAP y el puerto de un equipo YA INSTALADO (2026-09-14), con la VLAN
 * leída de la OLT.
 *
 * Lo mismo que defiende `asignar-equipo-nap.spec.ts` para la entrega —que se guardan
 * los ids LEGACY (`nat` = idn de la caja, `puerto` = idp de la fila) y que el censo
 * de la caja cuadra—, más lo propio de editar: el puerto viejo se suelta, la VLAN la
 * pone la OLT y no quien edita, y una OLT caída no impide corregir la caja.
 */
describe('reubicar equipo: caja NAP, puerto y VLAN de la OLT', () => {
  const SUB = 'sub-1';
  const PUERTO = {
    id: 'p-8', port: 8, legacyId: 2393, napId: 'nap-1', subscriberId: null,
    nap: { legacyId: 241, name: 'VICT_02', vlanLegacy: 30 },
    subscriber: null,
  };
  const EQUIPO = { id: 'eq-1', subscriberId: SUB, mac: 'AA:BB', code: 1, port: 1500, nat: 99, vlan: 0 };

  const armar = (o: { equipo?: any; olt?: any; quedan?: number } = {}) => {
    const escrito: { equipment: any[]; port: any[]; portMany: any[]; serial: any[] } = { equipment: [], port: [], portMany: [], serial: [] };
    const tx: any = {
      equipment: {
        update: jest.fn(async (a: any) => { escrito.equipment.push(a); return {}; }),
        count: jest.fn().mockResolvedValue(o.quedan ?? 0),
      },
      port: {
        update: jest.fn(async (a: any) => { escrito.port.push(a); return {}; }),
        updateMany: jest.fn(async (a: any) => { escrito.portMany.push(a); return { count: 1 }; }),
      },
    };
    const prisma: any = {
      // `exigirSedeSuscriptor` deja pasar al usuario sin sede (superadmin de prueba).
      staff: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null) },
      subscriber: { findUnique: jest.fn().mockResolvedValue({ legacyId: 9001, branchId: null }) },
      equipment: {
        findUnique: jest.fn().mockResolvedValue(o.equipo === undefined ? EQUIPO : o.equipo),
        update: jest.fn(async (a: any) => { escrito.serial.push(a); return {}; }),
      },
      port: { findMany: jest.fn().mockResolvedValue([PUERTO]) },
      ticket: { findFirst: jest.fn().mockResolvedValue(null) },
      ticketThread: { create: jest.fn() },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const olt = o.olt === null ? undefined : (o.olt ?? { vlanDeAbonado: jest.fn().mockResolvedValue({ ok: true, vlan: 120, vlans: [120] }) });
    const svc = new SupportWriteService(
      prisma, null as any, null as any, null as any, null as any, null as any, null as any,
      undefined, undefined, undefined, undefined, olt,
    );
    return { svc, escrito, olt };
  };
  const user: any = { role: 'superadmin', name: 'Prueba' };

  it('mueve el equipo al puerto elegido con los ids legacy y la VLAN de la OLT', async () => {
    const { svc, escrito } = armar();
    const r = await svc.ubicarEquipo(SUB, 'eq-1', { napId: 'nap-1', portId: 'p-8' }, user);

    const data = escrito.equipment[0].data;
    expect(data.nat).toBe(241);
    expect(data.port).toBe(2393);
    expect(data.vlan).toBe(120); // la de la OLT, no la de la caja (30)
    expect(data.assignedRaw).toBe('9001');
    expect(escrito.port[0]).toMatchObject({ where: { id: 'p-8' }, data: { subscriberId: SUB, status: 'Ocupado' } });
    // El puerto donde estaba (idp 1500) se suelta.
    expect(escrito.portMany[0]).toMatchObject({ where: { legacyId: 1500, subscriberId: SUB }, data: { status: 'Disponible' } });
    expect(r).toMatchObject({ ok: true, napName: 'VICT_02', portNumber: 8, vlan: 120 });
  });

  it('no suelta el puerto viejo si otro equipo del cliente sigue colgado ahí', async () => {
    const { svc, escrito } = armar({ quedan: 1 });
    await svc.ubicarEquipo(SUB, 'eq-1', { napId: 'nap-1', portId: 'p-8' }, user);
    expect(escrito.portMany).toHaveLength(0);
  });

  it('con la OLT caída guarda la caja igual y deja la VLAN como estaba', async () => {
    const { svc, escrito } = armar({ olt: { vlanDeAbonado: jest.fn().mockRejectedValue(new Error('timeout')) } });
    const r = await svc.ubicarEquipo(SUB, 'eq-1', { napId: 'nap-1', portId: 'p-8' }, user);
    expect(escrito.equipment[0].data).toMatchObject({ nat: 241, port: 2393, vlan: 0 });
    expect(r.vlanOlt).toMatchObject({ ok: false, error: 'timeout' });
  });

  it('quitar la caja suelta nat, puerto y el censo', async () => {
    const { svc, escrito } = armar();
    await svc.ubicarEquipo(SUB, 'eq-1', { quitarCaja: true }, user);
    expect(escrito.equipment[0].data).toMatchObject({ nat: null, port: null });
    expect(escrito.port).toHaveLength(0);
    expect(escrito.portMany[0]).toMatchObject({ where: { legacyId: 1500 } });
  });

  it('sin caja ni quitar sólo refresca la VLAN y no toca el censo', async () => {
    const { svc, escrito } = armar();
    await svc.ubicarEquipo(SUB, 'eq-1', {}, user);
    const data = escrito.equipment[0].data;
    expect(data).not.toHaveProperty('nat');
    expect(data).not.toHaveProperty('port');
    expect(data.vlan).toBe(120);
    expect(escrito.port).toHaveLength(0);
    expect(escrito.portMany).toHaveLength(0);
  });

  it('un serial nuevo se guarda ANTES de leer la OLT, y la lectura salta la caché', async () => {
    const orden: string[] = [];
    const olt = { vlanDeAbonado: jest.fn(async (_id: string, refresh: boolean) => { orden.push(`olt:${refresh}`); return { ok: true, vlan: 310 }; }) };
    const { svc, escrito } = armar({ equipo: { ...EQUIPO, serial: 'solicitar' }, olt });
    const upd = (svc as any).prisma.equipment.update;
    upd.mockImplementation(async (a: any) => { orden.push('serial'); escrito.serial.push(a); return {}; });

    const r = await svc.ubicarEquipo(SUB, 'eq-1', { serial: ' ZTEGDE519CDF ' }, user);
    expect(escrito.serial[0].data.serial).toBe('ZTEGDE519CDF');
    expect(orden).toEqual(['serial', 'olt:true']);
    expect(r).toMatchObject({ serial: 'ZTEGDE519CDF', vlan: 310 });
  });

  it('el mismo serial no reescribe ni salta la caché', async () => {
    const olt = { vlanDeAbonado: jest.fn().mockResolvedValue({ ok: true, vlan: 120 }) };
    const { svc, escrito } = armar({ equipo: { ...EQUIPO, serial: 'ZTEGDE519CDF' }, olt });
    await svc.ubicarEquipo(SUB, 'eq-1', { serial: 'ZTEGDE519CDF' }, user);
    expect(escrito.serial).toHaveLength(0);
    expect(olt.vlanDeAbonado).toHaveBeenCalledWith(SUB, false);
  });

  it('rechaza un equipo que no es de este cliente', async () => {
    const { svc } = armar({ equipo: { ...EQUIPO, subscriberId: 'otro' } });
    await expect(svc.ubicarEquipo(SUB, 'eq-1', { portId: 'p-8' }, user)).rejects.toThrow('no está asignado a este cliente');
  });

  /**
   * El alcance del técnico de campo (2026-09-18): quien cuelga el equipo es quien
   * sabe en qué caja y en qué puerto quedó, y las instalaciones no siempre caen en
   * su sede. "Es mía" le gana a "es de mi sede", igual que en el detalle de la orden
   * y en la IP remota; al que NO tiene orden con ese cliente le sigue mandando la sede.
   */
  describe('alcance del técnico de campo', () => {
    /** Técnico de Yopal (sede 2) con un cliente de Monterrey (sede 5). */
    const tecnico: any = { id: 'u-tec', email: 'tec@vestel.com.co', name: 'Omar Téc', permissions: ['area.tecnicos'], sedes: [2] };
    const conOrden = (suya: boolean) => {
      const { svc, escrito } = armar();
      const prisma: any = (svc as any).prisma;
      prisma.staff.findFirst.mockResolvedValue({ id: 'staff-1', name: 'Omar Téc', username: 'OmarTec', legacyId: 68 });
      prisma.subscriber.findUnique.mockResolvedValue({ legacyId: 9001, branch: { legacyId: 5 } });
      // `esClienteDeSuOrden` pregunta por las órdenes del técnico (where.OR); la otra
      // llamada es la de la traza, que busca la orden ABIERTA del cliente.
      prisma.ticket.findFirst.mockImplementation(async (a: any) => (a?.where?.OR ? (suya ? { id: 't-1' } : null) : null));
      return { svc, escrito };
    };

    it('deja al técnico poner la caja y el puerto de un cliente de otra sede si la orden es suya', async () => {
      const { svc, escrito } = conOrden(true);
      const r = await svc.ubicarEquipo(SUB, 'eq-1', { napId: 'nap-1', portId: 'p-8' }, tecnico);
      expect(escrito.equipment[0].data).toMatchObject({ nat: 241, port: 2393 });
      expect(r).toMatchObject({ ok: true, napName: 'VICT_02', portNumber: 8 });
    });

    it('a un cliente de otra sede que no es de sus órdenes le sigue cerrando la sede', async () => {
      const { svc } = conOrden(false);
      await expect(svc.ubicarEquipo(SUB, 'eq-1', { napId: 'nap-1', portId: 'p-8' }, tecnico))
        .rejects.toThrow('No tienes acceso a los datos de esta sede.');
    });
  });
});
