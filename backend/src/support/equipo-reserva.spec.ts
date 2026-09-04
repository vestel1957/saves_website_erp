import { EquipoReservaService, ESTADO_POR_REVISAR, ESTADO_RESERVADO, tipoConReserva } from './equipo-reserva.service';

/**
 * La reserva es una apuesta, no una verdad: el sistema elige una caja en el papel
 * antes de que el técnico elija una en el estante. Lo que estas pruebas defienden
 * es que la apuesta nunca se convierta en un dato falso — que se deshaga sola
 * cuando la OLT demuestra otra cosa, y que nunca se quite de la ficha un equipo
 * que no se puede señalar sin dudar.
 */
describe('EquipoReservaService', () => {
  const SUB = 'sub-1';
  const TICKET = { id: 't1', code: 500900, type: 'Instalacion', status: 'PENDIENTE', subscriberId: SUB,
    subscriber: { id: SUB, branch: { name: 'Yopal', legacyId: 2 } } };

  const armar = (o: {
    ticket?: any;
    yaReservado?: any;
    stock?: any[];
    updateCount?: number;
  }) => {
    const notas: string[] = [];
    const updates: any[] = [];
    const prisma: any = {
      ticket: { findUnique: jest.fn().mockResolvedValue(o.ticket === undefined ? TICKET : o.ticket) },
      equipment: {
        findFirst: jest.fn().mockResolvedValue(o.yaReservado ?? null),
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn(async (args: any) => { updates.push(args); return { count: o.updateCount ?? 1 }; }),
        update: jest.fn(async (args: any) => { updates.push(args); return {}; }),
      },
      subscriber: { findUnique: jest.fn().mockResolvedValue({ branch: { legacyId: 2 } }) },
      branch: { findUnique: jest.fn().mockResolvedValue({ name: 'Yopal' }) },
      equipmentWarehouse: { findMany: jest.fn().mockResolvedValue([{ id: 'w-yopal', name: 'Yopal', legacyId: 10 }]) },
      ticketThread: { create: jest.fn(async (args: any) => { notas.push(args.data.message); return {}; }) },
      $queryRaw: jest.fn().mockResolvedValue(o.stock ?? []),
    };
    return { svc: new EquipoReservaService(prisma), prisma, notas, updates };
  };

  describe('qué órdenes apartan equipo', () => {
    it('las cinco que pidió el usuario, con los nombres de la base', () => {
      for (const t of ['Instalacion', 'Cambio de equipo', 'Migracion', 'AgregarInternet', 'Traslado']) {
        expect(tipoConReserva(t)).toBe(true);
      }
    });
    it('las demás no', () => {
      for (const t of ['Subir megas', 'Corte Internet', 'Cambio de clave', 'Revision de Internet', '', null]) {
        expect(tipoConReserva(t)).toBe(false);
      }
    });
  });

  describe('reservarParaOrden', () => {
    it('aparta la unidad y la deja a nombre del cliente como Reservado, sin sacarla de su bodega', async () => {
      const { svc, updates, notas } = armar({ stock: [{ id: 'eq-1', code: 4041, serial: 'HWTC12345678', bodega: 'Yopal' }] });
      const r = await svc.reservarParaOrden('t1');
      expect(r.hecho).toBe(true);
      expect(r.equipo?.code).toBe(4041);
      const u = updates[0];
      expect(u.where).toMatchObject({ id: 'eq-1', subscriberId: null, reservedTicketId: null });
      expect(u.data).toMatchObject({ subscriberId: SUB, reservedTicketId: 't1', status: ESTADO_RESERVADO });
      expect(u.data.warehouseId).toBeUndefined(); // sigue en el estante
      expect(u.data.editedAt).toBeInstanceOf(Date); // que el sync no lo deshaga
      expect(notas[0]).toMatch(/Equipo 4041 reservado/);
    });

    it('es idempotente: si la orden ya tiene reserva, no aparta otra', async () => {
      const { svc, updates } = armar({ yaReservado: { code: 4041, serial: null, warehouse: { name: 'Yopal' } }, stock: [{ id: 'eq-2', code: 5000 }] });
      const r = await svc.reservarParaOrden('t1');
      expect(r.hecho).toBe(false);
      expect(r.equipo?.code).toBe(4041);
      expect(updates).toHaveLength(0);
    });

    it('sin unidades en la bodega no inventa nada: lo anota en la orden', async () => {
      const { svc, updates, notas } = armar({ stock: [] });
      const r = await svc.reservarParaOrden('t1');
      expect(r.hecho).toBe(false);
      expect(updates).toHaveLength(0);
      expect(notas[0]).toMatch(/no tiene unidades disponibles/);
    });

    it('una orden que no aparta equipo (Subir megas) no toca nada', async () => {
      const { svc, prisma } = armar({ ticket: { ...TICKET, type: 'Subir megas' } });
      const r = await svc.reservarParaOrden('t1');
      expect(r.hecho).toBe(false);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('la consulta de stock salta lo que ya está autenticado en una OLT y prefiere serial real', async () => {
      const { svc, prisma } = armar({ stock: [] });
      await svc.reservarParaOrden('t1');
      const sql = (prisma.$queryRaw.mock.calls[0][0] as string[]).join(' ');
      expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM "OltOnu"/);
      expect(sql).toMatch(/ORDER BY \(CASE WHEN/);
      expect(sql).toMatch(/"reservedTicketId" IS NULL/);
    });
  });

  describe('liberarPorCierre', () => {
    it('al anular, la reserva vuelve a la bodega como Disponible', async () => {
      const { svc, prisma, updates, notas } = armar({});
      prisma.equipment.findMany.mockResolvedValueOnce([{ id: 'eq-1', code: 4041, subscriberId: SUB }]);
      const n = await svc.liberarPorCierre('t1', 'ANULADA');
      expect(n).toBe(1);
      expect(updates[0].data).toMatchObject({ subscriberId: null, reservedTicketId: null, status: 'Disponible' });
      expect(notas[0]).toMatch(/se anuló/);
    });

    it('al cerrar sin haber autenticado también se suelta, y se dice cómo asignarlo si sí se instaló', async () => {
      const { svc, prisma, notas } = armar({});
      prisma.equipment.findMany.mockResolvedValueOnce([{ id: 'eq-1', code: 4041, subscriberId: SUB }]);
      await svc.liberarPorCierre('t1', 'RESUELTO');
      expect(notas[0]).toMatch(/cerró sin autenticar/);
      expect(notas[0]).toMatch(/asígnelo desde la orden/);
    });

    it('sin reserva no hace nada', async () => {
      const { svc, updates } = armar({});
      expect(await svc.liberarPorCierre('t1', 'RESUELTO')).toBe(0);
      expect(updates).toHaveLength(0);
    });
  });

  describe('conciliarTrasAutenticar', () => {
    const base = { ticketId: 't1', ticketCode: 500900, subscriberId: SUB, sn: '48575443A1B2C3D4' };

    it('el técnico instaló la reservada: solo se le quita la marca de reserva', async () => {
      const { svc, prisma, updates } = armar({});
      prisma.equipment.findMany.mockResolvedValueOnce([]); // no hay sobrantes
      const r = await svc.conciliarTrasAutenticar({ ...base, ticketType: 'Instalacion', instaladoId: 'eq-1' });
      expect(r).toEqual({ liberados: [], devuelto: null });
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ where: { id: 'eq-1' }, data: { reservedTicketId: null } });
    });

    it('el técnico se llevó OTRA caja: la reservada vuelve a la bodega', async () => {
      const { svc, prisma, updates, notas } = armar({});
      prisma.equipment.findMany.mockResolvedValueOnce([{ id: 'eq-res', code: 4041 }]);
      const r = await svc.conciliarTrasAutenticar({ ...base, ticketType: 'Instalacion', instaladoId: 'eq-otro' });
      expect(r.liberados).toEqual([4041]);
      expect(updates[0].data).toMatchObject({ subscriberId: null, reservedTicketId: null, status: 'Disponible' });
      expect(notas[0]).toMatch(/instaló otra ONU/);
    });

    it('cambio de equipo: la ONU vieja (única con serial de ONU) sale de la ficha como Por revisar', async () => {
      const { svc, prisma, updates, notas } = armar({});
      prisma.equipment.findMany
        .mockResolvedValueOnce([]) // sobrantes
        .mockResolvedValueOnce([   // otros equipos del cliente
          { id: 'eq-vieja', code: 3001, serial: 'ZTEGC9E3311B', warehouseLegacy: 0, warehouse: null },
          { id: 'eq-deco', code: 3002, serial: 'BA1305-1704003199', warehouseLegacy: 0, warehouse: null },
        ]);
      const r = await svc.conciliarTrasAutenticar({ ...base, ticketType: 'Cambio de equipo', instaladoId: 'eq-nueva' });
      expect(r.devuelto).toBe(3001);
      const dev = updates.find((u) => u.where?.id === 'eq-vieja');
      expect(dev.data).toMatchObject({ subscriberId: null, status: ESTADO_POR_REVISAR, warehouseId: 'w-yopal' });
      expect(dev.data.observation).toMatch(/reemplazada por S\/N 48575443A1B2C3D4/);
      expect(notas.some((n) => /ONU anterior 3001/.test(n))).toBe(true);
    });

    it('cambio de equipo con DOS ONUs anteriores: no adivina, lo anota', async () => {
      const { svc, prisma, updates, notas } = armar({});
      prisma.equipment.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { id: 'a', code: 1, serial: 'ZTEGC9E3311B', warehouseLegacy: 0, warehouse: null },
          { id: 'b', code: 2, serial: 'HWTC00112233', warehouseLegacy: 0, warehouse: null },
        ]);
      const r = await svc.conciliarTrasAutenticar({ ...base, ticketType: 'Cambio de equipo', instaladoId: 'eq-nueva' });
      expect(r.devuelto).toBeNull();
      expect(updates.filter((u) => u.where?.id === 'a' || u.where?.id === 'b')).toHaveLength(0);
      expect(notas[0]).toMatch(/2 ONUs anteriores/);
    });

    it('cambio de equipo donde el "otro" equipo es un decodificador: no se toca', async () => {
      const { svc, prisma, updates } = armar({});
      prisma.equipment.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'eq-deco', code: 3002, serial: 'BA1305-1704003199', warehouseLegacy: 0, warehouse: null }]);
      const r = await svc.conciliarTrasAutenticar({ ...base, ticketType: 'Cambio de equipo', instaladoId: 'eq-nueva' });
      expect(r.devuelto).toBeNull();
      expect(updates.filter((u) => u.where?.id === 'eq-deco')).toHaveLength(0);
    });

    it('en una instalación no se retira nada aunque el cliente tenga otra ONU', async () => {
      const { svc, prisma, updates } = armar({});
      prisma.equipment.findMany.mockResolvedValueOnce([]);
      await svc.conciliarTrasAutenticar({ ...base, ticketType: 'Instalacion', instaladoId: 'eq-nueva' });
      expect(prisma.equipment.findMany).toHaveBeenCalledTimes(1); // no llegó a mirar "otros"
      expect(updates.filter((u) => u.data?.status === ESTADO_POR_REVISAR)).toHaveLength(0);
    });
  });
});
