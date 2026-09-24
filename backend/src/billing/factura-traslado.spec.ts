import 'reflect-metadata';
import { FacturasService } from './facturas.service';
import { OrdenAlPagarService } from './orden-al-pagar.service';
import { motivoPorClave, MOTIVOS_FACTURA } from './motivos-factura';

/**
 * LA FACTURA DE TRASLADO y la orden que nace de su pago (2026-09-08).
 *
 * El orden de las cosas es el que pidió el usuario: se factura el traslado —con la
 * dirección nueva metida en la misma factura—, el cliente paga en ventanilla y ahí sí
 * nace la orden de traslado. Lo que se comprueba aquí es cada eslabón de esa cadena,
 * porque cada uno se rompe por su lado:
 *
 *   · la factura queda con su MOTIVO escrito (antes solo decía «Fija», que es lo
 *     mismo que dicen la afiliación, la reconexión y la venta de un equipo);
 *   · la factura de traslado NO se emite sin dirección destino (una factura así no
 *     se puede convertir en visita: el día del pago ya no hay a quién preguntarle);
 *   · la ficha del cliente NO se mueve al facturar (si la factura se anula, el
 *     cliente se quedaría viviendo en una casa a la que no se mudó);
 *   · al pagarse nace la orden, y nace SIN volver a cobrar los 30.000.
 */

const USUARIO = { id: 'u-1', name: 'Cajera', email: 'caja@vestel.com.co', areas: ['caja'], sedes: [] } as any;

const DESTINO = {
  nomenclature: { nomenclatura: 'Carrera', numero1: '7', numero2: '11', numero3: '2' },
  neighborhood: '81',
};

const ITEM = { productName: 'Traslado', productId: 46, description: 'Traslado', qty: 1, price: 30000, taxRate: 0 };

function armarFacturas() {
  const facturas: any[] = [];
  const pendientes: any[] = [];
  const prisma = {
    subscriber: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'sub-1', branchId: 'b-1', eInvoice: false, status: 'ACTIVO',
        nomenclature: { nomenclatura: 'Calle', numero1: '10', numero2: '5', numero3: '20' },
        addressLine: null, neighborhood: '77',
      }),
    },
    appSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (fn: any) =>
      fn({
        subInvoice: {
          create: jest.fn((args: any) => { facturas.push(args.data); return Promise.resolve({ id: 'inv-1', tid: 500999 }); }),
        },
        pendingOrder: {
          create: jest.fn((args: any) => { pendientes.push(args.data); return Promise.resolve({ id: 'po-1' }); }),
        },
        customerAdvance: { findMany: jest.fn().mockResolvedValue([]) },
        $queryRaw: jest.fn().mockResolvedValue([{ tid: 500999n }]),
      }),
    ),
  };
  const posting = { postSalesInvoice: jest.fn().mockResolvedValue(undefined), centroDeAbonado: jest.fn().mockResolvedValue('cc-sede') };
  const srv = new FacturasService(prisma as any, posting as any, {} as any, {} as any);
  return { srv, prisma, facturas, pendientes };
}

describe('factura con motivo', () => {
  it('el catálogo de motivos dice cuál abre orden y cuál pide dirección', () => {
    expect(motivoPorClave('traslado')).toMatchObject({ abreOrden: 'Traslado', pideDestino: true, kind: 'FIJA' });
    expect(motivoPorClave('mensualidad')).toMatchObject({ kind: 'RECURRENTE' });
    expect(motivoPorClave('mensualidad')?.abreOrden).toBeUndefined();
    expect(motivoPorClave('  TRASLADO ')).toMatchObject({ clave: 'traslado' });
    expect(motivoPorClave('inventado')).toBeNull();
    // Agregar internet recorre el mismo camino desde el 2026-09-09, y por la misma
    // razón: la cajera cobra en ventanilla y antes tenía que abrir la orden para
    // poder cobrar — lo que dejaba dos facturas de 30.000 del mismo trabajo.
    expect(motivoPorClave('agregar-internet')).toMatchObject({
      abreOrden: 'AgregarInternet', kind: 'FIJA',
    });
    expect(motivoPorClave('agregar-internet')?.pideDestino).toBeUndefined();
    // Los que abren trabajo, uno por uno: si mañana se le pone `abreOrden` a otro,
    // que sea a conciencia (necesita una fila de `PendingOrder` que alguien cierre).
    expect(MOTIVOS_FACTURA.filter((m) => m.abreOrden).map((m) => m.clave))
      .toEqual(['traslado', 'agregar-internet']);
  });

  it('guarda el motivo y no deja nada programado en un cargo cualquiera', async () => {
    const { srv, facturas, pendientes } = armarFacturas();
    const r: any = await srv.createInvoice(
      { subscriberId: 'sub-1', purpose: 'venta', items: [{ description: 'Repetidor', qty: 1, price: 50000 }] } as any,
      USUARIO,
    );
    expect(facturas[0].purpose).toBe('venta');
    expect(pendientes).toHaveLength(0);
    expect(r.ordenAlPagar).toBeNull();
  });

  it('rechaza un motivo que no está en el catálogo', async () => {
    const { srv } = armarFacturas();
    await expect(srv.createInvoice(
      { subscriberId: 'sub-1', purpose: 'traslad0', items: [ITEM] } as any, USUARIO,
    )).rejects.toThrow(/desconocido/i);
  });

  it('la factura de traslado lleva la dirección nueva y deja la orden programada', async () => {
    const { srv, facturas, pendientes } = armarFacturas();
    const r: any = await srv.createInvoice(
      { subscriberId: 'sub-1', purpose: 'traslado', moveTo: DESTINO, items: [ITEM], notes: 'Paga el viernes' } as any,
      USUARIO,
    );

    // La factura dice por qué existe y a dónde se muda el cliente (la observación es
    // lo único que viaja al sistema viejo, que no tiene columna para el destino).
    expect(facturas[0].purpose).toBe('traslado');
    expect(facturas[0].notes).toContain('Carrera 7 # 11 - 2');
    expect(facturas[0].notes).toContain('Paga el viernes');

    // El trabajo queda PROGRAMADO, con el destino y el resumen de dónde a dónde.
    expect(pendientes[0]).toMatchObject({
      invoiceId: 'inv-1', motivo: 'traslado', type: 'Traslado',
      resumen: 'De Calle 10 # 5 - 20 a Carrera 7 # 11 - 2',
    });
    expect(pendientes[0].payload).toMatchObject({ nomenclature: { nomenclatura: 'Carrera', numero1: '7' }, neighborhood: '81' });
    expect(r.ordenAlPagar).toMatchObject({ tipo: 'Traslado', traslado: { hasta: 'Carrera 7 # 11 - 2' } });
  });

  it('no factura un traslado sin dirección', async () => {
    const { srv } = armarFacturas();
    await expect(srv.createInvoice(
      { subscriberId: 'sub-1', purpose: 'traslado', items: [ITEM] } as any, USUARIO,
    )).rejects.toThrow(/dirección nueva/i);
  });

  it('factura el traslado a la MISMA dirección (el segundo piso de la misma casa)', async () => {
    // 2026-09-08, pedido del usuario: repetir la dirección dejó de ser un error. La
    // factura sale igual y el trabajo queda programado como cualquier otro traslado.
    const { srv, pendientes } = armarFacturas();
    await srv.createInvoice(
      {
        subscriberId: 'sub-1', purpose: 'traslado', items: [ITEM],
        moveTo: { nomenclature: { nomenclatura: 'Calle', numero1: '10', numero2: '5', numero3: '20' } },
      } as any,
      USUARIO,
    );
    expect(pendientes[0]).toMatchObject({ motivo: 'traslado', type: 'Traslado' });
    expect(pendientes[0].context).toContain('dentro del mismo inmueble');
  });
});

function armarPago(opts: { creaOrden?: jest.Mock } = {}) {
  const pendiente = {
    id: 'po-1', subscriberId: 'sub-1', motivo: 'traslado', type: 'Traslado',
    payload: { nomenclature: { nomenclatura: 'Carrera', numero1: '7', numero2: '11', numero3: '2' }, neighborhood: '81' },
    resumen: 'De Calle 10 # 5 - 20 a Carrera 7 # 11 - 2',
    context: 'Traslado: de Calle 10 # 5 - 20 a Carrera 7 # 11 - 2.',
    createdAt: new Date(), invoice: { tid: 500999 },
  };
  const prisma = {
    pendingOrder: {
      findMany: jest.fn().mockResolvedValue([pendiente]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    subscriber: { findUnique: jest.fn().mockResolvedValue({ nomenclature: {}, addressLine: null }) },
    ticket: { update: jest.fn().mockResolvedValue({}) },
  };
  const createTicket = opts.creaOrden ?? jest.fn().mockResolvedValue({ id: 't-9', code: 500123 });
  const srv = new OrdenAlPagarService(prisma as any, { createTicket } as any);
  return { srv, prisma, createTicket };
}

describe('la orden que nace al pagar la factura', () => {
  it('abre la orden de traslado con su destino y SIN volver a cobrarla', async () => {
    const { srv, prisma, createTicket } = armarPago();
    const r = await srv.alPagar('sub-1');

    expect(r.creadas).toBe(1);
    const [dto, , opts] = createTicket.mock.calls[0];
    expect(dto).toMatchObject({ subscriberId: 'sub-1', subject: 'servicio', type: 'Traslado' });
    expect(dto.moveTo).toMatchObject({ nomenclature: { nomenclatura: 'Carrera' } });
    // La orden se ata a la factura YA pagada; el cargo automático de los 30.000 no
    // se dispara (sin esto el cliente pagaría el traslado dos veces).
    expect(opts).toMatchObject({ yaFacturada: { tid: 500999, concepto: 'Traslado' } });
    // Y la fila queda sellada contra la orden que abrió.
    expect(prisma.pendingOrder.update).toHaveBeenCalledWith({
      where: { id: 'po-1' }, data: { ticketId: 't-9', ticketCode: 500123 },
    });
  });

  it('el candado: si otro camino se llevó la fila, no abre una segunda orden', async () => {
    const { srv, prisma, createTicket } = armarPago();
    prisma.pendingOrder.updateMany.mockResolvedValue({ count: 0 });
    const r = await srv.alPagar('sub-1');
    expect(r.creadas).toBe(0);
    expect(createTicket).not.toHaveBeenCalled();
  });

  it('si falla, suelta el sello y guarda por qué para reintentarlo en el barrido', async () => {
    const creaOrden = jest.fn().mockRejectedValue(new Error('el Mikrotik no responde'));
    const { srv, prisma } = armarPago({ creaOrden });
    const r = await srv.barrer();
    expect(r.creadas).toBe(0);
    expect(prisma.pendingOrder.update).toHaveBeenCalledWith({
      where: { id: 'po-1' },
      data: { fulfilledAt: null, lastError: 'el Mikrotik no responde' },
    });
  });

  it('si alguien ya movió la ficha a esa dirección, la orden se abre igual', async () => {
    // Antes esto era un rechazo que había que atrapar y reintentar sin destino. Desde
    // 2026-09-08 `armarTraslado` acepta la dirección repetida, así que es un alta
    // normal: un solo intento, con su `moveTo`, y el parche a la ficha no cambia nada
    // porque ya está puesto.
    const { srv, createTicket } = armarPago();
    prisma_sub_ya_movida(srv);
    const r = await srv.alPagar('sub-1');

    expect(r.creadas).toBe(1);
    expect(createTicket).toHaveBeenCalledTimes(1);
    expect(createTicket.mock.calls[0][0].moveTo).toMatchObject({ nomenclature: { nomenclatura: 'Carrera' } });
  });
});

/** La ficha del cliente ya está en la dirección de destino. */
function prisma_sub_ya_movida(srv: any) {
  srv['prisma'].subscriber.findUnique.mockResolvedValue({
    nomenclature: { nomenclatura: 'Carrera', numero1: '7', numero2: '11', numero3: '2' },
    addressLine: null,
  });
}
