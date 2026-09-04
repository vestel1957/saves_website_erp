import { descuentosDePromocionPendientes } from './descuento-al-cobrar';

/**
 * A QUÉ factura alcanza el 5% de pronto pago cuando se concede solo en ventanilla.
 *
 * La promesa de la empresa (`chatbot/tramites.catalogo.ts` → `pronto_pago`) es "5% si
 * paga dentro de los primeros 5 días del mes, sólo el mes en curso, no facturas
 * atrasadas". El plazo lo pone la vigencia de la promoción; lo que se prueba aquí es la
 * otra mitad: que se rebaje LA MENSUALIDAD y nada más. Un cargo de traslado se emite
 * con fecha de hoy, así que cae dentro del mes en curso y —hasta el 2026-09-02— se
 * llevaba el descuento: los 30.000 se cobraban a 28.500.
 */
const HOY = new Date(Date.UTC(2026, 8, 3)); // 3 de septiembre de 2026

const PROMO = {
  id: 'promo-1', name: '5% Pronto pago', active: true,
  discountFormat: '%', percentage: 5, flatAmount: 0,
  invoiceScope: 'MENSUALIDAD_DEL_MES',
  allSubscribers: false, subscriberStatuses: ['ACTIVO'], neighborhoodRefs: [],
  subscribers: [], plans: [], branches: [],
  startDate: new Date(Date.UTC(2026, 8, 1)), endDate: new Date(Date.UTC(2026, 8, 5)),
};

/** La campaña opuesta: rebaja lo que el cliente DEBE, atrasado incluido. */
const PROMO_CARTERA = {
  ...PROMO,
  id: 'promo-cartera', name: 'cartera 50%', percentage: 50,
  invoiceScope: 'MENSUALIDADES_PENDIENTES', subscriberStatuses: ['CARTERA'],
  startDate: new Date(Date.UTC(2026, 8, 1)), endDate: new Date(Date.UTC(2026, 8, 30)),
};

function prismaFake(promos: any[] = [PROMO], status = 'ACTIVO') {
  return {
    promotion: { findMany: jest.fn().mockResolvedValue(promos) },
    subscriber: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'sub-1', status, branchId: 1, neighborhood: '77',
        services: [{ planId: 'plan-1' }],
      }),
    },
    promotionApplication: { findMany: jest.fn().mockResolvedValue([]) },
    electronicInvoice: { findMany: jest.fn().mockResolvedValue([]) },
  } as any;
}

const factura = (over: any) => ({
  id: 'f', tid: 1, kind: 'RECURRENTE',
  invoiceDate: HOY, subtotal: 50000, total: 50000, paidAmount: 0,
  ...over,
});

describe('descuento de promoción al cobrar', () => {
  it('rebaja la mensualidad del mes en curso', async () => {
    const mensualidad = factura({ id: 'f-mes', tid: 500001 });
    const r = await descuentosDePromocionPendientes(prismaFake(), 'sub-1', [mensualidad], HOY);
    expect(r.get('f-mes')?.amount).toBe(2500);
  });

  /**
   * El portal de pagos del legacy aplica su 5 % en la CABECERA (`discount`) y el sync
   * lo trae; en nexus eso no deja `PromotionApplication`. Sin este candado, la factura
   * 503819 (2026-09-02) salió con el 5 % dos veces: 173.250 → 164.587 en el portal y
   * otro 5 % en ventanilla, calculado además sobre el total ya rebajado.
   */
  it('NO apila la promo sobre una factura que ya trae descuento de cabecera', async () => {
    const portal = factura({ id: 'f-portal', tid: 503819, subtotal: 173250, total: 164587.5, discount: 8662.5 });
    const r = await descuentosDePromocionPendientes(prismaFake(), 'sub-1', [portal], HOY);
    expect(r.has('f-portal')).toBe(false);
  });

  it('sin descuento de cabecera (o en 0) sí rebaja', async () => {
    const limpia = factura({ id: 'f-0', tid: 500111, discount: 0 });
    const r = await descuentosDePromocionPendientes(prismaFake(), 'sub-1', [limpia], HOY);
    expect(r.get('f-0')?.amount).toBe(2500);
  });

  it('NO rebaja el cargo de traslado aunque se haya emitido hoy', async () => {
    const traslado = factura({ id: 'f-traslado', tid: 500002, kind: 'FIJA', subtotal: 30000, total: 30000 });
    const r = await descuentosDePromocionPendientes(prismaFake(), 'sub-1', [traslado], HOY);
    expect(r.has('f-traslado')).toBe(false);
  });

  it('NO rebaja la mensualidad atrasada, sólo la del mes que se cobra', async () => {
    const agosto = factura({ id: 'f-ago', tid: 500000, invoiceDate: new Date(Date.UTC(2026, 7, 1)) });
    const septiembre = factura({ id: 'f-sep', tid: 500001 });
    const r = await descuentosDePromocionPendientes(prismaFake(), 'sub-1', [agosto, septiembre], HOY);
    expect(r.has('f-ago')).toBe(false);
    expect(r.get('f-sep')?.amount).toBe(2500);
  });

  /**
   * La campaña de cartera es la opuesta al pronto pago: lo que hay que rebajar es
   * justo la mora. Con la regla del pronto pago —la única que existía hasta el
   * 2026-09-02— no descontaba nunca: un cliente en CARTERA debe, por definición,
   * facturas de meses anteriores, así que en ventanilla no aparecía nada.
   */
  it('la promo de cartera SÍ rebaja la factura atrasada', async () => {
    const enero = factura({ id: 'f-ene', tid: 421533, invoiceDate: new Date(Date.UTC(2026, 0, 1)), subtotal: 76650, total: 76650 });
    const px = prismaFake([PROMO_CARTERA], 'CARTERA');
    const r = await descuentosDePromocionPendientes(px, 'sub-1', [enero], HOY);
    expect(r.get('f-ene')?.amount).toBe(38325);
    expect(r.get('f-ene')?.promotionName).toBe('cartera 50%');
  });

  /**
   * El cargo suelto NO entra en la campaña de cartera: un traslado facturado esta
   * misma mañana no es deuda vieja, y al 50% se cobraría a 15.000. Para perdonarlo
   * también hay que pedir `CUALQUIER_PENDIENTE` a propósito.
   */
  it('la promo de cartera NO toca el cargo suelto; CUALQUIER_PENDIENTE sí', async () => {
    const traslado = factura({ id: 'f-tras', tid: 504969, kind: 'FIJA', subtotal: 30000, total: 30000 });
    const cartera = await descuentosDePromocionPendientes(
      prismaFake([PROMO_CARTERA], 'CARTERA'), 'sub-1', [traslado], HOY);
    expect(cartera.has('f-tras')).toBe(false);

    const todo = await descuentosDePromocionPendientes(
      prismaFake([{ ...PROMO_CARTERA, invoiceScope: 'CUALQUIER_PENDIENTE' }], 'CARTERA'),
      'sub-1', [traslado], HOY);
    expect(todo.get('f-tras')?.amount).toBe(15000);
  });

  /**
   * Las dos campañas conviven: cada una decide por su cuenta a qué factura llega, y
   * sobre la que alcanzan las dos gana la que más descuenta.
   */
  it('conviviendo, cada promo llega a lo suyo y gana la que más descuenta', async () => {
    const agosto = factura({ id: 'f-ago', tid: 500000, invoiceDate: new Date(Date.UTC(2026, 7, 1)) });
    const septiembre = factura({ id: 'f-sep', tid: 500001 });
    const px = prismaFake([PROMO, { ...PROMO_CARTERA, subscriberStatuses: ['ACTIVO'] }], 'ACTIVO');
    const r = await descuentosDePromocionPendientes(px, 'sub-1', [agosto, septiembre], HOY);
    // La atrasada sólo la alcanza la de cartera.
    expect(r.get('f-ago')?.promotionName).toBe('cartera 50%');
    // La del mes la alcanzan las dos: 50% > 5%.
    expect(r.get('f-sep')?.amount).toBe(25000);
  });
});
