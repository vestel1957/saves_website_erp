import 'reflect-metadata';
import { SupportWriteService } from './support-write.service';
import { esTraslado } from './order-types';

/**
 * La orden de TRASLADO: el cliente se muda.
 *
 * Tres cosas tienen que pasar al abrirla y las tres se comprueban aquí, porque
 * cada una se rompe por su lado: que la orden lleve a dónde va (antes no lo
 * llevaba y el técnico salía a preguntar por teléfono), que la ficha del cliente
 * quede con la dirección nueva y marcada como tocada aquí —sin `editedAt` el sync
 * de ida devuelve la dirección vieja a los 15 minutos— y que se le facture el
 * traslado.
 */
function armar(opts: { cobro?: any } = {}) {
  const creados: any[] = [];
  const fichas: any[] = [];
  const sub = {
    id: 'sub-1',
    nomenclature: { nomenclatura: 'Calle', numero1: '10', numero2: '5', numero3: '20' },
    addressLine: null,
    neighborhood: '77',
  };
  const prisma = {
    subscriber: { findUnique: jest.fn().mockResolvedValue(sub) },
    ticket: { update: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (fn: any) =>
      fn({
        ticket: { create: jest.fn((args: any) => { creados.push(args.data); return Promise.resolve({ id: 't-1', code: 500123 }); }) },
        subscriber: { update: jest.fn((args: any) => { fichas.push(args.data); return Promise.resolve({}); }) },
        $queryRaw: jest.fn().mockResolvedValue([{ tid: 500123n }]),
      }),
    ),
  };
  const porCargo = { notifyPost: jest.fn().mockResolvedValue(undefined) };
  const eventos = { emit: jest.fn() };
  const cargo = {
    cobrar: jest.fn().mockResolvedValue(
      opts.cobro ?? {
        cobrado: true, modo: 'on', precio: 30000, invoiceTid: 500999, concepto: 'Traslado',
        mensaje: 'Factura #500999 por $30.000 (traslado).',
      },
    ),
  };
  const srv = new SupportWriteService(
    prisma as any, {} as any, {} as any, porCargo as any, eventos as any, {} as any, {} as any,
    undefined, undefined, cargo as any,
  );
  return { srv, prisma, cargo, creados, fichas };
}

const USUARIO = { id: 'u-1', name: 'Cajera', email: 'caja@vestel.com.co', areas: ['caja'] } as any;

const DESTINO = {
  nomenclature: { nomenclatura: 'Carrera', numero1: '7', numero2: '11', numero3: '2' },
  neighborhood: '81',
};

describe('orden de traslado', () => {
  it('solo el traslado de domicilio pide dirección, no el de equipos dentro de la casa', () => {
    expect(esTraslado('Traslado')).toBe(true);
    expect(esTraslado(' traslado ')).toBe(true);
    expect(esTraslado('Traslado interno De Equipos Red en cliente final')).toBe(false);
    expect(esTraslado('Instalacion')).toBe(false);
  });

  it('guarda a dónde va, mueve la ficha del cliente y cobra el traslado', async () => {
    const { srv, cargo, creados, fichas, prisma } = armar();

    const creada: any = await srv.createTicket(
      { subscriberId: 'sub-1', subject: 'servicio', type: 'Traslado', moveTo: DESTINO } as any,
      USUARIO,
    );

    // La orden porta el destino y el origen, ya armados y legibles.
    expect(creados[0]).toMatchObject({
      type: 'Traslado',
      moveToText: 'Carrera 7 # 11 - 2',
      moveFromText: 'Calle 10 # 5 - 20',
    });
    expect(creados[0].moveAppliedAt).toBeInstanceOf(Date);
    // Y la dirección viaja también en la observación: es lo que ve el legacy.
    expect(creados[0].section).toContain('Carrera 7 # 11 - 2');

    // La ficha queda con la dirección nueva Y marcada como tocada aquí.
    expect(fichas[0].nomenclature).toMatchObject({ nomenclatura: 'Carrera', numero1: '7' });
    expect(fichas[0].neighborhood).toBe('81');
    expect(fichas[0].editedAt).toBeInstanceOf(Date);

    // Y se factura el cargo, con el número de factura anotado en la orden. El
    // traslado escribe las DOS columnas: la genérica y la suya de siempre, que es
    // la que lee su tarjeta y la que ya tienen escrita las órdenes de agosto.
    expect(cargo.cobrar).toHaveBeenCalledWith(
      expect.objectContaining({ clave: 'traslado' }), 'sub-1', expect.objectContaining({ ctx: 'orden #500123' }),
    );
    expect(prisma.ticket.update).toHaveBeenCalledWith({
      where: { id: 't-1' },
      data: { chargeInvoiceTid: 500999, chargeConcept: 'Traslado', moveInvoiceTid: 500999 },
    });
    expect(creada.traslado).toMatchObject({ hasta: 'Carrera 7 # 11 - 2', factura: 500999, cobrado: true });
  });

  it('la misma casa PERO otro piso sí es un traslado', async () => {
    // El caso real (2026-09-08): el cliente se muda al piso 2 del mismo inmueble. El
    // piso va en las casillas del INTERIOR —que sí forman parte de la dirección—; en
    // Residencia o Referencia no contaría y la orden se quedaría sin poder abrir.
    const { srv, creados, fichas } = armar();
    await srv.createTicket(
      {
        subscriberId: 'sub-1', type: 'Traslado',
        moveTo: {
          nomenclature: {
            nomenclatura: 'Calle', numero1: '10', numero2: '5', numero3: '20',
            divicion: 'Piso', divnum1: '2',
          },
        },
      } as any,
      USUARIO,
    );
    expect(creados[0].moveToText).toBe('Calle 10 # 5 - 20 Piso 2');
    expect(creados[0].moveFromText).toBe('Calle 10 # 5 - 20');
    expect(fichas[0].nomenclature).toMatchObject({ divicion: 'Piso', divnum1: '2' });
  });

  it('no abre un traslado sin dirección destino', async () => {
    const { srv } = armar();
    await expect(srv.createTicket({ subscriberId: 'sub-1', type: 'Traslado' } as any, USUARIO))
      .rejects.toThrow(/dirección nueva/i);
    await expect(srv.createTicket(
      { subscriberId: 'sub-1', type: 'Traslado', moveTo: { nomenclature: { residencia: 'Casa' } } } as any, USUARIO,
    )).rejects.toThrow(/vacía/i);
  });

  it('a la MISMA dirección sí se abre: el traslado corto también es un traslado', async () => {
    // 2026-09-08, pedido del usuario: se rechazaba por parecer un error de dedo y
    // frenaba el caso más común de todos —el segundo piso de la misma casa, la pieza
    // del fondo—, que no siempre se puede escribir en las casillas del interior. Hay
    // visita y hay obra: la orden vale.
    const { srv, creados } = armar();
    const creada: any = await srv.createTicket(
      {
        subscriberId: 'sub-1', type: 'Traslado',
        moveTo: { nomenclature: { nomenclatura: 'Calle', numero1: '10', numero2: '5', numero3: '20' } },
      } as any,
      USUARIO,
    );
    expect(creados[0].moveToText).toBe('Calle 10 # 5 - 20');
    expect(creados[0].moveFromText).toBe('Calle 10 # 5 - 20');
    // La nota que lee el técnico no puede decir "de X a X".
    expect(creados[0].section).toContain('dentro del mismo inmueble');
    expect(creada.traslado).toMatchObject({ desde: 'Calle 10 # 5 - 20', hasta: 'Calle 10 # 5 - 20' });
  });

  it('si el cobro falla, la orden se abre igual y lo dice', async () => {
    const { srv, prisma } = armar({ cobro: { cobrado: false, modo: 'on', precio: 30000, mensaje: 'No se pudo facturar el traslado: sin cuenta contable.' } });

    const creada: any = await srv.createTicket(
      { subscriberId: 'sub-1', type: 'Traslado', moveTo: DESTINO } as any, USUARIO,
    );

    expect(creada.code).toBe(500123);
    expect(creada.traslado).toMatchObject({ factura: null, cobrado: false });
    expect(prisma.ticket.update).not.toHaveBeenCalled();
  });

  it('el traslado pedido por chat se abre sin destino y sin cobro', async () => {
    const { srv, cargo, creados, fichas } = armar();

    // Por WhatsApp la dirección la dicta el cliente en texto libre: va en la
    // observación, no en las casillas, y el cobro lo hace quien atienda la orden.
    const creada: any = await srv.createTicket(
      { subscriberId: 'sub-1', type: 'Traslado', section: 'Se muda a la Carrera 7 con 11' } as any,
      USUARIO,
      { destinoOpcional: true },
    );

    expect(creada.code).toBe(500123);
    expect(creada.traslado).toBeUndefined();
    expect(creados[0].moveToText).toBeUndefined();
    expect(fichas).toHaveLength(0);
    expect(cargo.cobrar).not.toHaveBeenCalled();
  });

  it('en cualquier otra orden el destino se ignora: nadie lo va a aplicar', async () => {
    const { srv, cargo, creados, fichas } = armar();

    await srv.createTicket(
      { subscriberId: 'sub-1', type: 'Revision de Internet', moveTo: DESTINO } as any, USUARIO,
    );

    expect(creados[0].moveToText).toBeUndefined();
    expect(fichas).toHaveLength(0);
    expect(cargo.cobrar).not.toHaveBeenCalled();
  });
});

/**
 * El mismo traslado, pero registrado DESPUÉS: la orden ya existe y no dice a dónde.
 *
 * Es el caso normal, no el raro: las 4.000 órdenes de traslado del legacy —y las
 * que se siguen abriendo allá— no tienen dónde guardar el destino, y las del
 * chatbot nacen sin él a propósito. Antes se quedaban así para siempre.
 */
function armarEdicion(orden: Partial<Record<string, any>> = {}, ficha: Partial<Record<string, any>> = {}) {
  const t = {
    id: 't-9', code: 504379, subject: 'servicio', type: 'Traslado', status: 'PENDIENTE',
    problem: null, section: null, created: new Date('2026-08-27T00:00:00Z'), graceDays: null,
    subscriberId: 'sub-1', moveToText: null, moveFromText: null, ...orden,
  };
  const sub = {
    id: 'sub-1',
    nomenclature: { nomenclatura: 'Calle', numero1: '10', numero2: '5', numero3: '20' },
    addressLine: null,
    neighborhood: '77',
    ...ficha,
  };
  const prisma = {
    ticket: { findUnique: jest.fn().mockResolvedValue(t), update: jest.fn().mockResolvedValue({}) },
    subscriber: { findUnique: jest.fn().mockResolvedValue(sub), update: jest.fn().mockResolvedValue({}) },
    ticketThread: { create: jest.fn().mockResolvedValue({}) },
  };
  const srv = new SupportWriteService(
    prisma as any, {} as any, {} as any, { notifyPost: jest.fn() } as any, { emit: jest.fn() } as any,
    {} as any, {} as any, undefined, undefined, { cobrar: jest.fn() } as any,
  );
  return { srv, prisma };
}

describe('registrar el destino de un traslado que ya existe', () => {
  it('guarda a dónde va, mueve la ficha y lo deja dicho en la observación', async () => {
    const { srv, prisma } = armarEdicion();

    const r: any = await srv.updateTicket('t-9', { moveTo: DESTINO } as any, USUARIO);

    const data = prisma.ticket.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ moveToText: 'Carrera 7 # 11 - 2', moveFromText: 'Calle 10 # 5 - 20' });
    expect(data.moveAppliedAt).toBeInstanceOf(Date);
    // La dirección viaja al legacy por la observación: allá no hay columna para ella.
    expect(data.section).toContain('Carrera 7 # 11 - 2');
    // Y la ficha del cliente queda mudada, marcada para que el sync no la revierta.
    const ficha = prisma.subscriber.update.mock.calls[0][0].data;
    expect(ficha.nomenclature).toMatchObject({ nomenclatura: 'Carrera', numero1: '7' });
    expect(ficha.editedAt).toBeInstanceOf(Date);
    expect(r.cambios.join(' ')).toMatch(/destino del traslado/i);
  });

  it('si la ficha ya está en esa dirección, se anota en la orden y no se le toca nada', async () => {
    // Lo normal en una orden abierta en el legacy: allá ya le cambiaron la dirección
    // a la ficha a mano. Registrarla aquí no puede ser un error ni volver a moverla.
    const { srv, prisma } = armarEdicion({}, {
      nomenclature: { nomenclatura: 'Carrera', numero1: '7', numero2: '11', numero3: '2' },
    });

    await srv.updateTicket('t-9', { moveTo: DESTINO } as any, USUARIO);

    expect(prisma.ticket.update.mock.calls[0][0].data.moveToText).toBe('Carrera 7 # 11 - 2');
    expect(prisma.subscriber.update).not.toHaveBeenCalled();
  });

  it('el destino no viaja al legacy por sí solo, pero no impide corregir el resto', async () => {
    const { srv, prisma } = armarEdicion();
    await srv.updateTicket('t-9', { moveTo: DESTINO } as any, USUARIO);
    // `moveTo*` son columnas de este sistema: no sellan la orden como nuestra... pero
    // la nota de la observación sí, que es la que tiene que llegar allá.
    expect(prisma.ticket.update.mock.calls[0][0].data.editedAt).toBeInstanceOf(Date);
  });

  it('en cualquier otra orden el destino se ignora, igual que al abrirla', async () => {
    const { srv, prisma } = armarEdicion({ type: 'Revision de Internet' });

    const r: any = await srv.updateTicket('t-9', { moveTo: DESTINO } as any, USUARIO);

    expect(r.cambios).toHaveLength(0);
    expect(prisma.ticket.update).not.toHaveBeenCalled();
    expect(prisma.subscriber.update).not.toHaveBeenCalled();
  });

  it('una dirección vacía no borra la que la orden ya tenía', async () => {
    const { srv } = armarEdicion({ moveToText: 'Carrera 7 # 11 - 2' });
    await expect(srv.updateTicket('t-9', { moveTo: { nomenclature: { residencia: 'Casa' } } } as any, USUARIO))
      .rejects.toThrow(/vacía/i);
  });
});
