import 'reflect-metadata';
import { SupportWriteService } from './support-write.service';
import { CargoOrdenService } from '../billing/cargo-orden.service';
import { CARGO_AGREGAR_INTERNET, cargoDeTipoDeOrden } from '../billing/cargos-orden';
import { esAgregarInternet } from './order-types';

/**
 * AGREGAR INTERNET: al cliente que solo tenía televisión se le monta el internet, y
 * eso se le cobra UNA VEZ al abrir la orden (30.000, decisión del usuario del
 * 2026-09-01).
 *
 * Lo que se comprueba aquí es lo que se rompe por su lado: que el cobro salga en el
 * tipo de orden correcto y solo en ése, que quede anotado en la orden con qué
 * factura, que sea un pago único —una factura suelta de un renglón, no un renglón
 * en la mensualidad— y que un fallo de facturación no impida abrir el trabajo.
 */
function armar(opts: { cobro?: any } = {}) {
  const creados: any[] = [];
  const prisma = {
    subscriber: { findUnique: jest.fn().mockResolvedValue({ id: 'sub-1', nomenclature: {}, addressLine: null, neighborhood: '77' }) },
    ticket: { update: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (fn: any) =>
      fn({
        ticket: { create: jest.fn((args: any) => { creados.push(args.data); return Promise.resolve({ id: 't-1', code: 500123 }); }) },
        subscriber: { update: jest.fn().mockResolvedValue({}) },
        $queryRaw: jest.fn().mockResolvedValue([{ tid: 500123n }]),
      }),
    ),
  };
  const cargo = {
    cobrar: jest.fn().mockResolvedValue(
      opts.cobro ?? {
        cobrado: true, modo: 'on', precio: 30000, invoiceTid: 500999, concepto: 'Agregar Internet',
        mensaje: 'Factura #500999 por $30.000 (agregar internet).',
      },
    ),
  };
  const srv = new SupportWriteService(
    prisma as any, {} as any, {} as any, { notifyPost: jest.fn().mockResolvedValue(undefined) } as any,
    { emit: jest.fn() } as any, {} as any, {} as any, undefined, undefined, cargo as any,
  );
  return { srv, prisma, cargo, creados };
}

const USUARIO = { id: 'u-1', name: 'Cajera', email: 'caja@vestel.com.co', areas: ['caja'] } as any;

describe('qué tipos de orden se cobran', () => {
  it('agregar internet lleva cargo; agregar televisión todavía no', () => {
    expect(esAgregarInternet('AgregarInternet')).toBe(true);
    expect(esAgregarInternet(' agregarinternet ')).toBe(true);
    expect(cargoDeTipoDeOrden('AgregarInternet')).toMatchObject({ clave: 'agregar-internet', precioPorDefecto: 30_000 });
    expect(cargoDeTipoDeOrden('AgregarTelevision')).toBeNull();
  });

  it('el traslado sigue cobrando, y el de equipos dentro de la casa no', () => {
    expect(cargoDeTipoDeOrden('Traslado')).toMatchObject({ clave: 'traslado' });
    expect(cargoDeTipoDeOrden('Traslado interno De Equipos Red en cliente final')).toBeNull();
  });

  it('el resto de los trabajos no cobra nada al abrirse', () => {
    for (const t of ['Instalacion', 'Revision de Internet', 'Reconexion Internet', 'Punto nuevo', '', null]) {
      expect(cargoDeTipoDeOrden(t)).toBeNull();
    }
  });
});

describe('orden de agregar internet', () => {
  it('factura los 30.000 al abrirla y anota en la orden con qué factura', async () => {
    const { srv, cargo, prisma } = armar();

    const creada: any = await srv.createTicket(
      { subscriberId: 'sub-1', subject: 'servicio', type: 'AgregarInternet' } as any, USUARIO,
    );

    expect(cargo.cobrar).toHaveBeenCalledWith(
      expect.objectContaining({ clave: 'agregar-internet' }), 'sub-1',
      expect.objectContaining({ ctx: 'orden #500123' }),
    );
    // La columna genérica, y NADA de `moveInvoiceTid`: esto no es un traslado.
    expect(prisma.ticket.update).toHaveBeenCalledWith({
      where: { id: 't-1' },
      data: { chargeInvoiceTid: 500999, chargeConcept: 'Agregar Internet' },
    });
    // Y quien la abrió se entera de que hay algo que cobrar en ventanilla.
    expect(creada.cargo).toMatchObject({ concepto: 'Agregar Internet', precio: 30000, factura: 500999, cobrado: true });
    expect(creada.traslado).toBeUndefined();
  });

  it('si el cobro falla, la orden se abre igual y lo dice', async () => {
    const { srv, prisma } = armar({ cobro: { cobrado: false, modo: 'on', precio: 30000, mensaje: 'No se pudo facturar agregar internet: sin cuenta contable.' } });

    const creada: any = await srv.createTicket({ subscriberId: 'sub-1', type: 'AgregarInternet' } as any, USUARIO);

    expect(creada.code).toBe(500123);
    expect(creada.cargo).toMatchObject({ factura: null, cobrado: false });
    expect(prisma.ticket.update).not.toHaveBeenCalled();
  });

  it('agregar televisión abre la orden sin cobrar nada', async () => {
    const { srv, cargo } = armar();
    const creada: any = await srv.createTicket({ subscriberId: 'sub-1', type: 'AgregarTelevision' } as any, USUARIO);
    expect(cargo.cobrar).not.toHaveBeenCalled();
    expect(creada.cargo).toBeUndefined();
  });
});

/**
 * El cobro en sí. Lo que importa de esta factura es la FORMA: un pago único, en
 * factura aparte, del día y vencida el día —como las 3.875 del traslado en el
 * legacy—, y no un renglón añadido a la mensualidad.
 */
function armarCobro(material: any = null, ajuste: string | null = null) {
  const facturas: any[] = [];
  const prisma = {
    appSetting: { findUnique: jest.fn().mockResolvedValue(ajuste ? { value: ajuste } : null) },
    material: { findFirst: jest.fn().mockResolvedValue(material) },
    subscriber: { findUnique: jest.fn().mockResolvedValue({ id: 'sub-1', status: 'ACTIVO', eInvoice: false }) },
    $transaction: jest.fn(async (fn: any) =>
      fn({
        $queryRaw: jest.fn().mockResolvedValue([{ tid: 500999n }]),
        subInvoice: { create: jest.fn((args: any) => { facturas.push(args.data); return Promise.resolve({ id: 'inv-1', tid: 500999 }); }) },
      }),
    ),
  };
  const posting = { postSalesInvoice: jest.fn().mockResolvedValue({}) };
  return { srv: new CargoOrdenService(prisma as any, posting as any), prisma, posting, facturas };
}

describe('la factura del cargo', () => {
  it('sin producto en el catálogo cobra los 30.000 de respaldo, en una factura de un renglón', async () => {
    const { srv, facturas, posting } = armarCobro();

    const r = await srv.cobrar(CARGO_AGREGAR_INTERNET, 'sub-1', { ctx: 'orden #500123' });

    expect(r).toMatchObject({ cobrado: true, precio: 30_000, invoiceTid: 500999 });
    const f = facturas[0];
    expect(f).toMatchObject({ kind: 'FIJA', status: 'DUE', subtotal: 30_000, tax: 0, total: 30_000, itemsCount: 1 });
    // Vence el mismo día que se emite: es un cobro de ventanilla, no una mensualidad.
    expect(f.dueDate).toEqual(f.invoiceDate);
    expect(f.items.create).toHaveLength(1);
    expect(f.items.create[0]).toMatchObject({ productName: 'Agregar Internet', qty: 1, price: 30_000 });
    expect(f.notes).toContain('orden #500123');
    expect(posting.postSalesInvoice).toHaveBeenCalled();
  });

  it('si el catálogo tiene el producto, manda el catálogo (precio e IVA)', async () => {
    const { srv, facturas } = armarCobro({ name: 'Agregar Internet', price: 45_000, taxRate: 19 });

    const r = await srv.cobrar(CARGO_AGREGAR_INTERNET, 'sub-1');

    expect(r).toMatchObject({ cobrado: true, precio: 45_000, concepto: 'Agregar Internet' });
    expect(facturas[0]).toMatchObject({ subtotal: 45_000, tax: 8_550, total: 53_550 });
  });

  it('apagado no cobra, y en modo informe calcula sin tocar plata', async () => {
    const apagado = armarCobro(null, 'off');
    expect(await apagado.srv.cobrar(CARGO_AGREGAR_INTERNET, 'sub-1')).toMatchObject({ cobrado: false, modo: 'off' });
    expect(apagado.facturas).toHaveLength(0);

    const informe = armarCobro(null, 'informe');
    expect(await informe.srv.cobrar(CARGO_AGREGAR_INTERNET, 'sub-1')).toMatchObject({ cobrado: false, modo: 'informe', precio: 30_000 });
    expect(informe.facturas).toHaveLength(0);
  });

  it('nunca lanza: si la facturación se cae, lo dice y la orden puede seguir', async () => {
    const { srv } = armarCobro();
    (srv as any).prisma.subscriber.findUnique = jest.fn().mockResolvedValue(null);

    const r = await srv.cobrar(CARGO_AGREGAR_INTERNET, 'sub-1');

    expect(r.cobrado).toBe(false);
    expect(r.mensaje).toMatch(/no se pudo facturar/i);
  });
});
