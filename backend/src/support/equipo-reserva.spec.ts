import { EquipoReservaService, ESTADO_POR_REVISAR, ESTADO_RESERVADO, equiposDeOrdenes, tipoConReserva } from './equipo-reserva.service';

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
    subscriber: { id: SUB, legacyId: 9001, branch: { name: 'Yopal', legacyId: 2 } } };

  const armar = (o: {
    ticket?: any;
    yaReservado?: any;
    stock?: any[];
    /** Lo que el cliente YA tiene a su nombre (`equipoDelCliente`). */
    suyos?: any[];
    updateCount?: number;
  }) => {
    const notas: string[] = [];
    const updates: any[] = [];
    const prisma: any = {
      ticket: { findUnique: jest.fn().mockResolvedValue(o.ticket === undefined ? TICKET : o.ticket) },
      equipment: {
        findFirst: jest.fn().mockResolvedValue(o.yaReservado ?? null),
        findMany: jest.fn().mockResolvedValue(o.suyos ?? []),
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
    it('NINGÚN traslado aparta: el cliente se lleva su ONU y se le vuelve a autenticar', () => {
      expect(tipoConReserva('Traslado')).toBe(false);
      expect(tipoConReserva('Traslado interno De Equipos Red en cliente final')).toBe(false);
    });

    it('las que sí estrenan aparato, con los nombres de la base', () => {
      for (const t of ['Instalacion', 'Cambio de equipo', 'Migracion', 'AgregarInternet']) {
        expect(tipoConReserva(t)).toBe(true);
      }
    });
    it('la REINSTALACIÓN no aparta: el equipo ya está en casa del cliente', () => {
      // Calza con 'instalac' y entraba de rebote hasta el 2026-09-08.
      for (const t of ['Reinstalación', 'Reinstalacion', 'REINSTALACIÓN']) {
        expect([t, tipoConReserva(t)]).toEqual([t, false]);
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
      // El MISMO dueño en la casilla que entiende el legacy. Sin esto el writeback
      // empujaba `asignado = 0` y la ida deshacía la reserva en la pasada siguiente.
      expect(u.data.assignedRaw).toBe('9001');
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

    /**
     * 2026-09-04: apartarle una caja a quien ya tiene la suya era mandar al técnico
     * con la equivocada (la autenticación monta la del cliente) y restar del stock
     * una unidad que nadie iba a instalar.
     */
    it('si el cliente ya tiene su ONU no aparta ninguna: es esa la que se instala', async () => {
      const { svc, updates } = armar({
        suyos: [{ id: 'eq-suyo', code: 311772, serial: 'ZTEGDE519CBA', status: 'Asignado', reservedTicketId: null, warehouse: { name: 'Villanueva' } }],
        stock: [{ id: 'eq-nueva', code: 311781, serial: 'ZTEGDE519CD0', bodega: 'Villanueva' }],
      });
      const r = await svc.reservarParaOrden('t1');
      expect(r.hecho).toBe(false);
      expect(r.equipo?.code).toBe(311772);
      expect(updates).toHaveLength(0); // el stock no se toca
    });

    it('en un CAMBIO DE EQUIPO sí aparta una nueva aunque el cliente tenga la vieja', async () => {
      const { svc, updates } = armar({
        ticket: { ...TICKET, type: 'Cambio de equipo' },
        suyos: [{ id: 'eq-vieja', code: 100, serial: 'ZTEGDE519CBA', status: 'Asignado', reservedTicketId: null, warehouse: null }],
        stock: [{ id: 'eq-nueva', code: 5000, serial: 'HWTC1234ABCD', bodega: 'Yopal' }],
      });
      const r = await svc.reservarParaOrden('t1');
      expect(r.hecho).toBe(true);
      expect(r.equipo?.code).toBe(5000);
      expect(updates[0].where.id).toBe('eq-nueva');
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

  /**
   * La cajera entrega la caja en la ventanilla: lo que la orden tenía apartado deja
   * de tener sentido y vuelve al estante. Sin esto el cliente quedaba con dos
   * unidades a su nombre y el aviso nombraba la que no era.
   */
  describe('liberarSobrantesDeCliente', () => {
    const conOrdenes = (ordenes: any[], sobrantes: any[]) => {
      const notas: string[] = [];
      const updates: any[] = [];
      const prisma: any = {
        ticket: { findMany: jest.fn().mockResolvedValue(ordenes) },
        equipment: {
          findMany: jest.fn().mockResolvedValue(sobrantes),
          updateMany: jest.fn(async (args: any) => { updates.push(args); return { count: sobrantes.length }; }),
        },
        ticketThread: { create: jest.fn(async (args: any) => { notas.push(args.data.message); return {}; }) },
      };
      return { svc: new EquipoReservaService(prisma), prisma, notas, updates };
    };

    it('la apartada que no se entregó vuelve a la bodega como Disponible, y se anota', async () => {
      const { svc, prisma, updates, notas } = conOrdenes(
        [{ id: 't1', code: 500900 }],
        [{ id: 'eq-r', code: 311781, reservedTicketId: 't1' }],
      );
      const codigos = await svc.liberarSobrantesDeCliente(SUB, ['eq-entregado']);
      expect(codigos).toEqual([311781]);
      expect(prisma.equipment.findMany.mock.calls[0][0].where.id).toEqual({ notIn: ['eq-entregado'] });
      expect(updates[0].data).toMatchObject({ subscriberId: null, assignedRaw: null, reservedTicketId: null, status: 'Disponible' });
      expect(notas[0]).toMatch(/311781.*vuelve a la bodega/);
    });

    it('lo que se acaba de entregar NO se suelta', async () => {
      const { svc, updates } = conOrdenes([{ id: 't1', code: 500900 }], []);
      expect(await svc.liberarSobrantesDeCliente(SUB, ['eq-entregado'])).toEqual([]);
      expect(updates).toHaveLength(0);
    });

    it('sin órdenes abiertas no toca nada', async () => {
      const { svc, prisma } = conOrdenes([], [{ id: 'x', code: 1 }]);
      expect(await svc.liberarSobrantesDeCliente(SUB, [])).toEqual([]);
      expect(prisma.equipment.findMany).not.toHaveBeenCalled();
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

  /**
   * El aviso que ven la cajera (ficha del abonado) y quien reparte el día
   * (agendamiento). Lo que se defiende aquí es que no mienta en los dos sentidos:
   * ni anuncie equipo en una visita que no lo lleva, ni se calle el caso que obliga
   * a hacer algo — la orden que pide equipo y no tiene ninguno apartado.
   */
  describe('equiposDeOrdenes (el aviso "hay que llevar equipo")', () => {
    // `equiposDeOrdenes` completa el cliente de las órdenes que no lo traen (la
    // campanita del técnico llega con un ticketId pelado): sin este mock la
    // consulta de relleno rompe antes de llegar a lo que se está probando.
    const prismaCon = (filas: any[]) => ({
      equipment: { findMany: jest.fn().mockResolvedValue(filas) },
      ticket: { findMany: jest.fn().mockResolvedValue([]) },
    }) as any;

    it('solo entran las órdenes que piden equipo: una revisión no lleva nada', async () => {
      const prisma = prismaCon([]);
      const m = await equiposDeOrdenes(prisma, [
        { id: 't1', type: 'Instalacion', status: 'PENDIENTE' },
        { id: 't2', type: 'Revision de Internet', status: 'PENDIENTE' },
      ]);
      expect([...m.keys()]).toEqual(['t1']);
    });

    it('la orden abierta con reserva anuncia SU unidad, con serial y bodega', async () => {
      const prisma = prismaCon([
        { id: 'eq-1', code: 4711, serial: 'HWTC1234ABCD', reservedTicketId: 't1', warehouse: { name: 'Yopal' } },
      ]);
      const m = await equiposDeOrdenes(prisma, [{ id: 't1', type: 'Cambio de equipo', status: 'REALIZANDO' }]);
      // `origen: 'reserva'` = la unidad se apartó para ESTA orden (frente a 'asignado',
      // la que el abonado ya tiene a su nombre): es lo que cambia el texto del aviso.
      expect(m.get('t1')!.equipo).toEqual({ id: 'eq-1', code: 4711, serial: 'HWTC1234ABCD', bodega: 'Yopal', origen: 'reserva' });
    });

    it('la que pide equipo y no tiene ninguno apartado entra igual, con equipo en null', async () => {
      const m = await equiposDeOrdenes(prismaCon([]), [{ id: 't1', type: 'Instalacion', status: 'PENDIENTE' }]);
      expect(m.has('t1')).toBe(true);
      expect(m.get('t1')!.equipo).toBeNull();
    });

    it('una orden CERRADA no avisa: su reserva ya volvió a la bodega', async () => {
      const prisma = prismaCon([]);
      const m = await equiposDeOrdenes(prisma, [{ id: 't1', type: 'Instalacion', status: 'RESUELTO' }]);
      expect(m.size).toBe(0);
      expect(prisma.equipment.findMany).not.toHaveBeenCalled();
    });

    it('sin ninguna orden que pida equipo no se va a la base', async () => {
      const prisma = prismaCon([]);
      await equiposDeOrdenes(prisma, [{ id: 't1', type: 'Corte Internet', status: 'PENDIENTE' }]);
      expect(prisma.equipment.findMany).not.toHaveBeenCalled();
    });

    /**
     * EL CASO QUE LO ORIGINÓ (2026-09-04, cliente LEONORY AGUILAR): la orden tenía
     * apartada la 311781 y el cliente ya tenía la 311772 a su nombre. El aviso
     * mandaba a entregar una caja que no es la suya, y la autenticación —que
     * siempre prefiere "el equipo del abonado"— iba a montar la otra.
     */
    it('si el cliente YA tiene equipo suyo, ese manda sobre el que la orden apartó', async () => {
      const prisma = {
        equipment: {
          findMany: jest.fn()
            .mockResolvedValueOnce([{ id: 'eq-r', code: 311781, serial: 'ZTEGDE519CD0', reservedTicketId: 't1', warehouse: { name: 'Villanueva' } }])
            .mockResolvedValueOnce([{ id: 'eq-s', code: 311772, serial: 'ZTEGDE519CBA', status: 'Asignado', subscriberId: 'sub-9', reservedTicketId: null, warehouse: { name: 'Villanueva' } }]),
        },
        ticket: { findMany: jest.fn().mockResolvedValue([]) },
      } as any;
      const m = await equiposDeOrdenes(prisma, [{ id: 't1', type: 'Instalacion', status: 'PENDIENTE', subscriberId: 'sub-9' }]);
      expect(m.get('t1')!.equipo).toMatchObject({ code: 311772, origen: 'asignado' });
    });

    it('en un CAMBIO DE EQUIPO manda la reservada: la del cliente es justo la que se retira', async () => {
      const prisma = {
        equipment: { findMany: jest.fn().mockResolvedValue([{ id: 'eq-r', code: 5000, serial: 'HWTC1234ABCD', reservedTicketId: 't1', warehouse: { name: 'Yopal' } }]) },
        ticket: { findMany: jest.fn().mockResolvedValue([]) },
      } as any;
      const m = await equiposDeOrdenes(prisma, [{ id: 't1', type: 'Cambio de equipo', status: 'PENDIENTE', subscriberId: 'sub-9' }]);
      expect(m.get('t1')!.equipo).toMatchObject({ code: 5000, origen: 'reserva' });
      // Ni siquiera se pregunta por lo que el cliente tiene: una sola consulta.
      expect(prisma.equipment.findMany).toHaveBeenCalledTimes(1);
    });

    it('la reserva de la propia orden se anuncia como reserva aunque ya sea del cliente', async () => {
      const prisma = {
        equipment: {
          findMany: jest.fn()
            .mockResolvedValueOnce([{ id: 'eq-r', code: 4711, serial: 'HWTC1234ABCD', reservedTicketId: 't1', warehouse: { name: 'Yopal' } }])
            .mockResolvedValueOnce([{ id: 'eq-r', code: 4711, serial: 'HWTC1234ABCD', status: 'Reservado', subscriberId: 'sub-9', reservedTicketId: 't1', warehouse: { name: 'Yopal' } }]),
        },
        ticket: { findMany: jest.fn().mockResolvedValue([]) },
      } as any;
      const m = await equiposDeOrdenes(prisma, [{ id: 't1', type: 'Instalacion', status: 'PENDIENTE', subscriberId: 'sub-9' }]);
      expect(m.get('t1')!.equipo).toMatchObject({ code: 4711, origen: 'reserva' });
    });

    it('el cliente pregunta una sola vez para todo el lote y solo si no vino con las órdenes', async () => {
      const prisma = {
        equipment: { findMany: jest.fn().mockResolvedValue([]) },
        ticket: { findMany: jest.fn().mockResolvedValue([{ id: 't2', subscriberId: 'sub-2' }]) },
      } as any;
      await equiposDeOrdenes(prisma, [
        { id: 't1', type: 'Instalacion', status: 'PENDIENTE', subscriberId: 'sub-1' },
        { id: 't2', type: 'Migracion', status: 'PENDIENTE' },
      ]);
      expect(prisma.ticket.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.ticket.findMany.mock.calls[0][0].where.id.in).toEqual(['t2']);
    });

    it('con dos unidades apartadas a la misma orden manda siempre la misma', async () => {
      const prisma = prismaCon([
        { id: 'eq-1', code: 100, serial: null, reservedTicketId: 't1', warehouse: null },
        { id: 'eq-2', code: 200, serial: null, reservedTicketId: 't1', warehouse: null },
      ]);
      const m = await equiposDeOrdenes(prisma, [{ id: 't1', type: 'Migracion', status: 'PENDIENTE' }]);
      expect(m.get('t1')!.equipo!.code).toBe(100);
      expect(prisma.equipment.findMany.mock.calls[0][0].orderBy).toEqual({ code: 'asc' });
    });
  });
});
