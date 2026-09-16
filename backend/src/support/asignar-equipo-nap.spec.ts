import 'reflect-metadata';
import { SupportWriteService } from './support-write.service';

/**
 * La caja NAP y el puerto al entregar un equipo (2026-09-09).
 *
 * Lo que estas pruebas defienden es la traducción, que es donde está el peligro: el
 * legacy guarda en `equipos` DOS IDS —`nat` es el `idn` de la caja y `puerto` el
 * `idp` de la FILA del puerto, no su número— y la pantalla manda los ids de aquí.
 * Escribir ahí el número del puerto (el 1 al 16 rotulado en la caja) compila, se ve
 * bien y deja el dato mintiendo a los dos lados.
 *
 * Y la otra mitad: que la caja quede con el puerto marcado como ocupado. Un puerto
 * que sigue diciendo "libre" con un cliente colgado es lo que hace que se mande a
 * un técnico a conectar donde no cabe nadie.
 */
describe('asignar equipo con caja NAP y puerto', () => {
  const SUB = 'sub-1';
  const TICKET = { id: 't1', code: 500900, subscriberId: SUB };
  /** Puerto 8 de la caja "VICT_02": su fila es la 2393 y la caja la 241. */
  const PUERTO = {
    id: 'p-8', port: 8, legacyId: 2393, napId: 'nap-1', subscriberId: null,
    nap: { legacyId: 241, name: 'VICT_02', vlanLegacy: 30 },
    subscriber: null,
  };

  const armar = (o: { puertos?: any[]; equipo?: any; equiposEnPuerto?: number } = {}) => {
    const escrito: { equipment: any[]; port: any[]; portMany: any[] } = { equipment: [], port: [], portMany: [] };
    const notas: string[] = [];
    const tx: any = {
      equipment: {
        findUnique: jest.fn().mockResolvedValue(o.equipo ?? { id: 'eq-1', subscriberId: null, port: null, nat: null }),
        update: jest.fn(async (a: any) => { escrito.equipment.push(a); return { id: a.where.id }; }),
        create: jest.fn(async (a: any) => { escrito.equipment.push(a); return { id: 'eq-nuevo' }; }),
        count: jest.fn().mockResolvedValue(o.equiposEnPuerto ?? 0),
      },
      port: {
        update: jest.fn(async (a: any) => { escrito.port.push(a); return {}; }),
        updateMany: jest.fn(async (a: any) => { escrito.portMany.push(a); return { count: 1 }; }),
      },
    };
    const prisma: any = {
      ticket: {
        findUnique: jest.fn().mockResolvedValue(TICKET),
        findMany: jest.fn().mockResolvedValue([]),
      },
      subscriber: {
        findUnique: jest.fn().mockResolvedValue({ legacyId: 9001 }),
        update: jest.fn().mockResolvedValue({}),
      },
      port: { findMany: jest.fn().mockResolvedValue(o.puertos ?? [PUERTO]) },
      equipment: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        aggregate: jest.fn().mockResolvedValue({ _max: { code: 400000 } }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      ticketThread: { create: jest.fn(async (a: any) => { notas.push(a.data.message); return {}; }) },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const svc = new SupportWriteService(
      prisma, null as any, null as any, null as any, null as any, null as any, null as any,
    );
    return { svc, prisma, escrito, notas };
  };

  const entregar = (svc: SupportWriteService, item: Record<string, unknown>) =>
    svc.assignEquipment('t1', { items: [{ mac: 'AA:BB:CC:00:00:01', installType: 'FTTH', ...item }] } as any, {} as any);

  it('guarda los IDS del legacy: la caja en `nat` y la FILA del puerto en `puerto`', async () => {
    const { svc, escrito } = armar();
    await entregar(svc, { equipmentId: 'eq-1', napId: 'nap-1', portId: 'p-8' });

    const data = escrito.equipment[0].data;
    expect(data.nat).toBe(241);   // Nap.legacyId, no 'nap-1'
    expect(data.port).toBe(2393); // Port.legacyId (idp), NO el número 8
  });

  it('la VLAN sale de la caja cuando nadie la escribe, y la escrita manda', async () => {
    const a = armar();
    await entregar(a.svc, { equipmentId: 'eq-1', portId: 'p-8' });
    expect(a.escrito.equipment[0].data.vlan).toBe(30);

    const b = armar();
    await entregar(b.svc, { equipmentId: 'eq-1', portId: 'p-8', vlan: 44 });
    expect(b.escrito.equipment[0].data.vlan).toBe(44);
  });

  it('deja el puerto OCUPADO y a nombre del cliente (con su id del legacy)', async () => {
    const { svc, escrito } = armar();
    await entregar(svc, { equipmentId: 'eq-1', portId: 'p-8' });

    expect(escrito.port[0]).toMatchObject({
      where: { id: 'p-8' },
      data: { subscriberId: SUB, assignedLegacy: 9001, status: 'Ocupado' },
    });
  });

  it('mover el equipo de puerto suelta el anterior', async () => {
    const { svc, escrito } = armar({ equipo: { id: 'eq-1', subscriberId: SUB, port: 1712, nat: 199 } });
    await entregar(svc, { equipmentId: 'eq-1', portId: 'p-8' });

    expect(escrito.portMany[0]).toMatchObject({
      where: { legacyId: 1712, subscriberId: SUB },
      data: { subscriberId: null, assignedLegacy: 0, status: 'Disponible' },
    });
  });

  it('pero no lo suelta si otro aparato del cliente sigue colgado ahí', async () => {
    const { svc, escrito } = armar({
      equipo: { id: 'eq-1', subscriberId: SUB, port: 1712, nat: 199 },
      equiposEnPuerto: 1,
    });
    await entregar(svc, { equipmentId: 'eq-1', portId: 'p-8' });
    expect(escrito.portMany).toHaveLength(0);
  });

  it('un puerto ocupado por OTRO cliente no se puede pisar, y se dice de quién es', async () => {
    const { svc } = armar({
      puertos: [{ ...PUERTO, subscriberId: 'sub-2', subscriber: { fullName: 'Pedro Nel Ruiz', firstName: null, secondName: null, lastName1: null, lastName2: null, companyName: null } }],
    });
    await expect(entregar(svc, { equipmentId: 'eq-1', portId: 'p-8' }))
      .rejects.toThrow(/puerto 8 de la caja VICT_02 ya lo ocupa Pedro Nel Ruiz/i);
  });

  it('dos equipos en el mismo puerto se paran antes de escribir nada', async () => {
    const { svc, prisma } = armar();
    await expect(svc.assignEquipment('t1', {
      items: [
        { mac: 'AA:BB:CC:00:00:01', installType: 'FTTH', portId: 'p-8' },
        { mac: 'AA:BB:CC:00:00:02', installType: 'FTTH', portId: 'p-8' },
      ],
    } as any, {} as any)).rejects.toThrow(/mismo puerto/i);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('el puerto de una caja distinta a la elegida se rechaza', async () => {
    const { svc } = armar();
    await expect(entregar(svc, { equipmentId: 'eq-1', napId: 'otra-nap', portId: 'p-8' }))
      .rejects.toThrow(/no es de la caja NAP elegida/i);
  });

  it('sin caja elegida sigue valiendo el envío de siempre (números sueltos)', async () => {
    const { svc, escrito, prisma } = armar();
    await entregar(svc, { equipmentId: 'eq-1', port: 3, nat: 12 });
    expect(escrito.equipment[0].data).toMatchObject({ port: 3, nat: 12 });
    expect(prisma.port.findMany).not.toHaveBeenCalled();
    expect(escrito.port).toHaveLength(0);
  });

  it('la nota del hilo nombra la caja y el puerto, no los ids', async () => {
    const { svc, notas } = armar();
    await entregar(svc, { equipmentId: 'eq-1', portId: 'p-8' });
    expect(notas[0]).toContain('NAP VICT_02 pto 8');
    expect(notas[0]).not.toContain('2393');
  });
});
