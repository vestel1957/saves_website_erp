import { prontoPagoVigente, textoProntoPago, vigenciaEnPalabras } from './pronto-pago-vigente';

/**
 * Lo que el chatbot le promete al cliente sale de las promociones, no de una
 * constante. Estas pruebas cubren el caso que lo destapó (2026-09-08): la promo
 * venció el día 5 y el bot seguía ofreciendo el 5% el día 8.
 */

const d = (s: string) => new Date(`${s}T00:00:00Z`);

const PROMO_BASE = {
  name: '5% Pronto pago',
  percentage: 5,
  startDate: d('2026-09-01'),
  endDate: d('2026-09-05'),
  allSubscribers: false,
  subscriberStatuses: ['ACTIVO'],
  neighborhoodRefs: [],
  subscribers: [],
  plans: [],
  branches: [],
  invoiceKinds: ['RECURRENTE'],
  onlyCurrentMonth: true,
};

/** Prisma de pega que respeta los filtros del `where`: vigencia y alcance. */
const prismaFalso = (filas: any[]) => ({
  promotion: {
    findMany: async ({ where }: any) =>
      filas.filter((p) => p.startDate <= where.startDate.lte && p.endDate >= where.endDate.gte
        && p.onlyCurrentMonth === where.onlyCurrentMonth
        && p.invoiceKinds.includes('RECURRENTE') && !p.invoiceKinds.includes('FIJA')),
  },
}) as any;

describe('prontoPagoVigente', () => {
  it('dentro de la ventana devuelve la promoción', async () => {
    const p = await prontoPagoVigente(prismaFalso([PROMO_BASE]), d('2026-09-03'));
    expect(p).toMatchObject({ porcentaje: 5, nombre: '5% Pronto pago' });
  });

  it('el día que vence todavía cuenta', async () => {
    expect(await prontoPagoVigente(prismaFalso([PROMO_BASE]), d('2026-09-05'))).not.toBeNull();
  });

  it('pasada la ventana NO hay descuento', async () => {
    expect(await prontoPagoVigente(prismaFalso([PROMO_BASE]), d('2026-09-08'))).toBeNull();
  });

  it('sin ninguna promoción tampoco', async () => {
    expect(await prontoPagoVigente(prismaFalso([]), d('2026-09-08'))).toBeNull();
  });

  // Una campaña dirigida no se le anuncia al que pregunta: el que no entra en ella se
  // sentiría engañado, y el que sí entra la recibe igual al pagar.
  it('no anuncia una promoción dirigida a clientes sueltos', async () => {
    const dirigida = { ...PROMO_BASE, subscribers: [{ id: 's1' }] };
    expect(await prontoPagoVigente(prismaFalso([dirigida]), d('2026-09-03'))).toBeNull();
  });

  // El pronto pago es la mensualidad del mes que corre. Una campaña que alcance lo
  // atrasado es de cartera, y una que rebaje la instalación es otra cosa: prometer
  // cualquiera de las dos como "descuento por pronto pago" es prometer lo que no es.
  it('no anuncia una campaña de cartera ni una de cargos', async () => {
    const cartera = { ...PROMO_BASE, name: 'cartera 50%', onlyCurrentMonth: false };
    const cargos = { ...PROMO_BASE, name: 'Instalación 50%', invoiceKinds: ['FIJA'] };
    expect(await prontoPagoVigente(prismaFalso([cartera]), d('2026-09-03'))).toBeNull();
    expect(await prontoPagoVigente(prismaFalso([cargos]), d('2026-09-03'))).toBeNull();
  });

  it('no anuncia una promoción atada a un plan o a una sede', async () => {
    const porPlan = { ...PROMO_BASE, plans: [{ id: 'p1' }] };
    const porSede = { ...PROMO_BASE, branches: [{ id: 'b1' }] };
    expect(await prontoPagoVigente(prismaFalso([porPlan]), d('2026-09-03'))).toBeNull();
    expect(await prontoPagoVigente(prismaFalso([porSede]), d('2026-09-03'))).toBeNull();
  });

  it('una promo para TODOS los clientes sí se anuncia', async () => {
    const todos = { ...PROMO_BASE, allSubscribers: true, subscriberStatuses: [] };
    expect(await prontoPagoVigente(prismaFalso([todos]), d('2026-09-03'))).not.toBeNull();
  });

  it('una dirigida sólo a CARTERA no es pronto pago', async () => {
    const cartera = { ...PROMO_BASE, subscriberStatuses: ['CARTERA'] };
    expect(await prontoPagoVigente(prismaFalso([cartera]), d('2026-09-03'))).toBeNull();
  });
});

describe('textoProntoPago', () => {
  it('sin promoción vigente NO promete ningún porcentaje', () => {
    const t = textoProntoPago(null);
    expect(t).toContain('NO hay descuento por pronto pago vigente');
    expect(t).not.toMatch(/\d+ ?%/);
  });

  it('con promoción dice el porcentaje y las fechas', () => {
    const t = textoProntoPago({ nombre: 'x', porcentaje: 5, desde: d('2026-10-01'), hasta: d('2026-10-05') });
    expect(t).toContain('5%');
    expect(t).toContain('del 1 al 5 de octubre');
    expect(t).toContain('NO a facturas atrasadas');
  });
});

describe('vigenciaEnPalabras', () => {
  it('mismo mes', () => {
    expect(vigenciaEnPalabras(d('2026-09-01'), d('2026-09-05'))).toBe('del 1 al 5 de septiembre');
  });
  it('un solo día', () => {
    expect(vigenciaEnPalabras(d('2026-09-07'), d('2026-09-07'))).toBe('el 7 de septiembre');
  });
  it('a caballo entre dos meses', () => {
    expect(vigenciaEnPalabras(d('2026-09-28'), d('2026-10-02'))).toBe('del 28 de septiembre al 2 de octubre');
  });
});
