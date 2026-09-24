import { ProrrateoReconexionService } from './prorrateo-reconexion.service';

/**
 * Lo que se prueba aquí es la DECISIÓN, que es donde está el dinero: a quién se le
 * cobran los días que quedan del mes y —sobre todo— a quién NO. Cobrar de más al
 * que ya tiene su mes facturado es el error caro de este módulo, porque el cliente
 * lo ve en la factura y llama.
 *
 * La escritura (inyectar el renglón o crear la factura) no se prueba con un doble
 * de Prisma: sería probar que el mock hace lo que el mock hace.
 */

const dia = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

type Servicio = { kind: string; planName: string | null; price: number | null; taxRate: number; qty: number };
type Item = { productName: string | null; description: string | null; price: number };

type Factura = { id: string; tid: number; status: string; total: number; paidAmount: number; items: Item[] };

function servicioDePrueba(opts: {
  ajuste?: string | null;
  servicios?: Servicio[];
  /** La única factura del mes. Atajo de `facturas: [factura]`. */
  factura?: Factura | null;
  /** Varias facturas del mes, de la última a la primera (como las lee el servicio). */
  facturas?: Factura[];
  /** Lo que el abonado pagó HOY: una entrada por factura pagada. */
  pagosDeHoy?: Array<{ tid: number; items: Item[] }>;
  catalogo?: Array<{ name: string; kind: string }>;
  /**
   * Lo que devuelve el respaldo `planDeUltimaFactura` (el plan deducido de sus
   * facturas, para los 2.350 abonados sin fila de servicio). Viaja por SQL crudo.
   */
  derivados?: Array<{ kind: string; name: string; price: number; taxRate?: number }>;
}) {
  const delMes: Factura[] = opts.facturas ?? (opts.factura ? [opts.factura] : []);
  const prisma: any = {
    appSetting: { findUnique: async () => (opts.ajuste === undefined ? { value: 'on' } : opts.ajuste === null ? null : { value: opts.ajuste }) },
    subscriberService: {
      findMany: async ({ where }: any) =>
        (opts.servicios ?? []).filter((s) => where.kind.in.includes(s.kind)),
    },
    subInvoice: {
      findMany: async () =>
        delMes.map((f) => ({ ...f, subtotal: f.total, tax: 0, electronicInvoices: [] })),
    },
    // El catálogo de planes: sirve para saber de QUÉ servicio es cada renglón de la
    // factura, que es como se detecta el mes ya facturado cuando la ficha y la
    // factura llaman distinto al mismo plan.
    plan: { findMany: async () => opts.catalogo ?? [
      { name: '100 Megas F-26', kind: 'INTERNET' },
      { name: '50 Megas F', kind: 'INTERNET' },
      { name: 'Television26', kind: 'TV' },
      { name: 'Punto Adicional', kind: 'PUNTOS' },
    ] },
    // Los pagos de HOY, para saber si lo único que pagó fue un cargo puntual.
    transaction: { findMany: async () => (opts.pagosDeHoy ?? []).map((f) => ({ invoice: f })) },
    // El respaldo "plan de su última factura" va por SQL crudo: la 1ª llamada es la
    // de los ítems y la 2ª la de la cabecera (que aquí nunca hace falta).
    $queryRaw: (() => {
      let n = 0;
      return async () => {
        n += 1;
        if (n > 1) return [];
        return (opts.derivados ?? []).map((d) => ({
          subscriberId: 'sub-1', kind: d.kind, name: d.name, price: d.price,
          taxRate: d.taxRate ?? 0, veces: BigInt(3), planPrice: d.price,
        }));
      };
    })(),
  };
  const posting: any = { postSalesInvoice: async () => null, postSalesInvoiceAdjustment: async () => null, centroDeAbonado: async () => null };
  return new ProrrateoReconexionService(prisma, posting);
}

const INTERNET: Servicio = { kind: 'INTERNET', planName: '100 Megas F-26', price: 50500, taxRate: 0, qty: 1 };
const TV: Servicio = { kind: 'TV', planName: 'Television26', price: 22269, taxRate: 19, qty: 1 };

describe('ProrrateoReconexionService.evaluar', () => {
  it('un solo renglón por servicio aunque el respaldo devuelva dos planes del mismo tipo', async () => {
    // El abonado 4286 (08-09-2026): sin fila de servicio, su internet se deduce de las
    // facturas y el catálogo tiene '10MegasF' repetido con distinta caja, así que el
    // respaldo devolvía el mismo plan dos veces y la reconexión le cobró $73.600 —dos
    // veces $36.800— en vez de $36.800. Es la misma regla de la corrida mensual.
    const svc = servicioDePrueba({
      servicios: [],
      derivados: [
        { kind: 'INTERNET', name: '10MegasF', price: 48000 },
        { kind: 'INTERNET', name: '10megasF', price: 48000 },
      ],
      factura: null,
    });
    const r = await svc.evaluar('sub-1', ['INTERNET'], dia('2026-09-08'));
    expect(r.aplica).toBe(true);
    expect(r.lineas).toHaveLength(1);
    expect(r.lineas[0]).toMatchObject({ kind: 'INTERNET', concepto: '10MegasF' });
  });

  it('cobra los días que quedan cuando el servicio NO está en la factura del mes', async () => {
    // El caso real: cortado desde julio, la corrida de agosto no le facturó internet
    // y el 24 paga. Quedan 8 días de los 31.
    const svc = servicioDePrueba({
      servicios: [INTERNET],
      factura: { id: 'f1', tid: 455006, status: 'DUE', total: 26500, paidAmount: 0, items: [{ productName: 'Television26', description: null, price: 22269 }] },
    });
    const r = await svc.evaluar('sub-1', ['INTERNET'], dia('2026-08-24'));
    expect(r.aplica).toBe(true);
    expect(r.dias).toBe(8);
    expect(r.lineas).toHaveLength(1);
    expect(r.lineas[0]).toMatchObject({ kind: 'INTERNET', concepto: '100 Megas F-26', base: 13032, iva: 0 });
    expect(r.invoiceTid).toBe(455006);
  });

  it('el renglón "Agregar Internet" NO cuenta como internet facturado: es un pago único', async () => {
    // El caso de la orden #505503 (07-09-2026). Al abrir un 'AgregarInternet' se le
    // factura el cargo de 30.000, y ese renglón cae en la MISMA factura del mes en la
    // que después hay que cobrarle los días del internet nuevo. Leyéndolo como
    // "internet ya facturado", al cliente que estrena el servicio no se le cobraba ni
    // un solo día: el cargo de la orden se comía la mensualidad.
    const svc = servicioDePrueba({
      servicios: [INTERNET],
      factura: {
        id: 'f1', tid: 505017, status: 'DUE', total: 54000, paidAmount: 0,
        items: [
          { productName: 'Agregar Internet', description: null, price: 30000 },
          { productName: 'SoloTelevision22', description: null, price: 20168 },
        ],
      },
    });
    const r = await svc.evaluar('sub-1', ['INTERNET'], dia('2026-09-07'));
    expect(r.aplica).toBe(true);
    expect(r.lineas).toHaveLength(1);
    expect(r.lineas[0]).toMatchObject({ kind: 'INTERNET', concepto: '100 Megas F-26' });
  });

  it('el renglón "Traslado" tampoco tapa nada: no es la mensualidad de ningún servicio', async () => {
    const svc = servicioDePrueba({
      servicios: [INTERNET],
      factura: { id: 'f1', tid: 505020, status: 'DUE', total: 30000, paidAmount: 0, items: [{ productName: 'Traslado', description: null, price: 30000 }] },
    });
    const r = await svc.evaluar('sub-1', ['INTERNET'], dia('2026-09-07'));
    expect(r.aplica).toBe(true);
  });

  it('los días NO caen en la factura del traslado: esa se cobra por su valor cerrado', async () => {
    // La factura 500029 (28-08-2026) salió con 'Traslado 30.000' + '10Megas(F) ·
    // reconexión 28–31 ago 5.161' = 35.161, porque el destino del cobro era «la
    // última factura del mes» y esa era la de los 30.000 recién emitida. El traslado
    // vale 30.000 y ya: los días van en factura aparte.
    const svc = servicioDePrueba({
      servicios: [INTERNET],
      factura: { id: 'f1', tid: 500029, status: 'DUE', total: 30000, paidAmount: 0, items: [{ productName: 'Traslado', description: null, price: 30000 }] },
    });
    const r = await svc.evaluar('sub-1', ['INTERNET'], dia('2026-08-28'));
    expect(r.aplica).toBe(true);
    expect(r.invoiceId).toBeUndefined();   // → factura nueva
    expect(r.invoiceTid).toBeUndefined();
  });

  it('con traslado Y mensualidad en el mismo mes, los días van a la mensualidad', async () => {
    const svc = servicioDePrueba({
      servicios: [INTERNET, TV],
      facturas: [
        { id: 'traslado', tid: 505067, status: 'DUE', total: 30000, paidAmount: 0, items: [{ productName: 'Traslado', description: null, price: 30000 }] },
        { id: 'mes', tid: 505001, status: 'DUE', total: 22269, paidAmount: 0, items: [{ productName: 'Television26', description: null, price: 22269 }] },
      ],
    });
    const r = await svc.evaluar('sub-1', ['INTERNET'], dia('2026-09-07'));
    expect(r.aplica).toBe(true);
    expect(r.invoiceTid).toBe(505001);
  });

  it('un cargo emitido DESPUÉS de la mensualidad no tapa la mensualidad', async () => {
    // Antes sólo se leía la última factura del mes: si al cliente ya facturado se le
    // emitía un traslado, el internet parecía sin facturar y se le cobraban los días
    // de un mes que ya había pagado.
    const svc = servicioDePrueba({
      servicios: [INTERNET],
      facturas: [
        { id: 'traslado', tid: 505067, status: 'DUE', total: 30000, paidAmount: 0, items: [{ productName: 'Traslado', description: null, price: 30000 }] },
        { id: 'mes', tid: 505001, status: 'DUE', total: 50500, paidAmount: 0, items: [{ productName: '100 Megas F-26', description: null, price: 50500 }] },
      ],
    });
    const r = await svc.evaluar('sub-1', ['INTERNET'], dia('2026-09-07'));
    expect(r.aplica).toBe(false);
    expect(r.mensaje).toMatch(/ya está facturado/i);
  });

  it('NO cobra si ese servicio ya está facturado este mes', async () => {
    // Corte del mismo mes: la mensualidad se emitió el día 1 y después lo cortaron.
    // Ya pagó agosto entero; cobrarle otra vez sería cobrar dos veces el mismo mes.
    const svc = servicioDePrueba({
      servicios: [INTERNET],
      factura: { id: 'f1', tid: 500001, status: 'DUE', total: 50500, paidAmount: 0, items: [{ productName: '100 Megas F-26', description: null, price: 50500 }] },
    });
    const r = await svc.evaluar('sub-1', ['INTERNET'], dia('2026-08-24'));
    expect(r.aplica).toBe(false);
    expect(r.mensaje).toMatch(/ya está facturado/i);
  });

  it('es idempotente: la segunda reconexión del mes no vuelve a cobrar', async () => {
    // La primera dejó el renglón prorrateado en la factura; el nombre del concepto es
    // el mismo plan, así que la segunda lo encuentra y no cobra. Esto es lo que evita
    // el doble cobro cuando el pago reconecta y después el técnico cierra la orden.
    const svc = servicioDePrueba({
      servicios: [INTERNET],
      factura: { id: 'f1', tid: 500001, status: 'DUE', total: 13032, paidAmount: 0, items: [{ productName: '100 Megas F-26', description: '100 Megas F-26 · reconexión 24–31 ago (8 días)', price: 13032 }] },
    });
    expect((await svc.evaluar('sub-1', ['INTERNET'], dia('2026-08-24'))).aplica).toBe(false);
  });

  it('compara los conceptos sin fijarse en mayúsculas ni espacios de más', async () => {
    const svc = servicioDePrueba({
      servicios: [INTERNET],
      factura: { id: 'f1', tid: 1, status: 'DUE', total: 50500, paidAmount: 0, items: [{ productName: '  100  MEGAS f-26 ', description: null, price: 50500 }] },
    });
    expect((await svc.evaluar('sub-1', ['INTERNET'], dia('2026-08-24'))).aplica).toBe(false);
  });

  it('NO cobra dos veces cuando la ficha y la factura llaman distinto al mismo plan', async () => {
    // Caso real del abonado 54872: su ficha dice "50 Megas F" y la factura de agosto
    // que le hizo el legacy dice "100 Megas F-26". Comparando sólo por nombre, el
    // prorrateo le habría cobrado el internet de agosto por segunda vez. Por eso el
    // renglón se resuelve contra el catálogo `Plan` y se compara por TIPO.
    const svc = servicioDePrueba({
      servicios: [{ kind: 'INTERNET', planName: '50 Megas F', price: 50400, taxRate: 0, qty: 1 }],
      factura: { id: 'f1', tid: 474959, status: 'DUE', total: 14661, paidAmount: 0, items: [{ productName: '100 Megas F-26', description: null, price: 14661 }] },
    });
    expect((await svc.evaluar('sub-1', ['INTERNET'], dia('2026-08-22'))).aplica).toBe(false);
  });

  it('un renglón que no está en el catálogo se reconoce igual por su nombre', async () => {
    // Las facturas viejas traen 'SoloTelevision22' y 'Television' a secas, que ya no
    // son planes del catálogo. Si no se reconocieran, la TV se cobraría dos veces.
    const svc = servicioDePrueba({
      servicios: [TV],
      factura: { id: 'f1', tid: 1, status: 'DUE', total: 25210, paidAmount: 0, items: [{ productName: 'SoloTelevision22', description: null, price: 25210 }] },
    });
    expect((await svc.evaluar('sub-1', ['TV'], dia('2026-08-22'))).aplica).toBe(false);
  });

  it('la TV arrastra sus puntos y cada línea lleva su propio IVA', async () => {
    // El punto de TV va al 0% y la TV al 19% (ver `puntos-adicionales-iva`): el IVA
    // sale de cada servicio, no de la factura.
    const svc = servicioDePrueba({
      servicios: [TV, { kind: 'PUNTOS', planName: 'Punto Adicional', price: 5000, taxRate: 0, qty: 2 }],
      factura: null,
    });
    const r = await svc.evaluar('sub-1', ['TV'], dia('2026-08-24'));
    expect(r.lineas.map((l) => l.kind)).toEqual(['TV', 'PUNTOS']);
    expect(r.lineas[0]).toMatchObject({ base: 5747, ivaPct: 19 });
    expect(r.lineas[1]).toMatchObject({ base: 2580, iva: 0, qty: 2 }); // 5000/31*8 = 1290, x2
    expect(r.total).toBe(r.lineas[0].total + r.lineas[1].total);
  });

  it('un combo sale en UNA sola evaluación, con las dos líneas', async () => {
    const svc = servicioDePrueba({ servicios: [INTERNET, TV], factura: null });
    const r = await svc.evaluar('sub-1', ['INTERNET', 'TV'], dia('2026-08-24'));
    expect(r.lineas).toHaveLength(2);
    expect(r.base).toBe(13032 + 5747);
  });

  it('no cobra de memoria: sin precio en la ficha, no cobra', async () => {
    const svc = servicioDePrueba({
      servicios: [{ kind: 'INTERNET', planName: '100 Megas F-26', price: null, taxRate: 0, qty: 1 }],
      factura: null,
    });
    const r = await svc.evaluar('sub-1', ['INTERNET'], dia('2026-08-24'));
    expect(r.aplica).toBe(false);
    expect(r.mensaje).toMatch(/no tiene precio/i);
  });

  it('sin servicio en la ficha lo dice, en vez de cobrar cualquier cosa', async () => {
    const svc = servicioDePrueba({ servicios: [], factura: null });
    const r = await svc.evaluar('sub-1', ['INTERNET'], dia('2026-08-24'));
    expect(r.aplica).toBe(false);
    expect(r.mensaje).toMatch(/SubscriberService/);
  });

  it('con el interruptor apagado ni siquiera calcula', async () => {
    const svc = servicioDePrueba({ ajuste: 'off', servicios: [INTERNET], factura: null });
    const r = await svc.evaluar('sub-1', ['INTERNET'], dia('2026-08-24'));
    expect(r.aplica).toBe(false);
    expect(r.modo).toBe('off');
    expect(r.lineas).toHaveLength(0);
  });
});

describe('ProrrateoReconexionService.aplicar — el pago que lo dispara', () => {
  const TRASLADO: Item = { productName: 'Traslado', description: null, price: 30000 };
  const MENSUALIDAD: Item = { productName: '100 Megas F-26', description: null, price: 50500 };

  it('si hoy sólo pagó el traslado, NO se le cobran los días', async () => {
    // «Las facturas de traslado solo deben cobrar los 30.000 y ya» (08-09-2026). El
    // pago reconecta al cortado y la reconexión cobraba los días detrás: el cliente
    // pagaba 30.000 y le nacía un cobro que no pidió.
    const svc = servicioDePrueba({
      servicios: [INTERNET],
      factura: null,
      pagosDeHoy: [{ tid: 505068, items: [TRASLADO] }],
    });
    const r = await svc.aplicar('sub-1', ['INTERNET'], { porPago: true });
    expect(r.aplica).toBe(false);
    expect(r.cobrado).toBe(false);
    expect(r.mensaje).toMatch(/Traslado/);
  });

  it('si además de traslado pagó su mensualidad, los días se cobran como siempre', async () => {
    const svc = servicioDePrueba({
      servicios: [INTERNET],
      factura: null,
      pagosDeHoy: [{ tid: 505068, items: [TRASLADO] }, { tid: 505001, items: [MENSUALIDAD] }],
    });
    const r = await svc.aplicar('sub-1', ['INTERNET'], { porPago: true });
    expect(r.aplica).toBe(true);
  });

  it('sin pago de por medio (el técnico cierra la reconexión) cobra igual', async () => {
    const svc = servicioDePrueba({ servicios: [INTERNET], factura: null, pagosDeHoy: [] });
    const r = await svc.aplicar('sub-1', ['INTERNET'], { porPago: true });
    expect(r.aplica).toBe(true);
  });

  it('el freno sólo mira los pagos cuando el disparo ES un pago', async () => {
    // El alta de internet al cerrar la orden (`aplicarAltaDeInternet`) cobra los días
    // del servicio que estrena aunque ese mismo día se hayan pagado los 30.000 del
    // cargo: ahí el cargo y la mensualidad son cosas distintas.
    const svc = servicioDePrueba({
      servicios: [INTERNET],
      factura: null,
      pagosDeHoy: [{ tid: 505017, items: [{ productName: 'Agregar Internet', description: null, price: 30000 }] }],
    });
    const r = await svc.aplicar('sub-1', ['INTERNET']);
    expect(r.aplica).toBe(true);
  });
});

describe('ProrrateoReconexionService.aplicar', () => {
  it('en modo informe calcula y avisa, pero NO toca la factura', async () => {
    const svc = servicioDePrueba({ ajuste: 'informe', servicios: [INTERNET], factura: null });
    const r = await svc.aplicar('sub-1', ['INTERNET']);
    expect(r.aplica).toBe(true);
    expect(r.cobrado).toBe(false);
    expect(r.mensaje).toMatch(/NO se cobró/);
  });

  it('un fallo de base de datos no tumba a quien está cobrando', async () => {
    const svc = servicioDePrueba({ servicios: [INTERNET], factura: null });
    (svc as any).prisma.subscriberService.findMany = async () => { throw new Error('conexión caída'); };
    const r = await svc.aplicar('sub-1', ['INTERNET']);
    expect(r.cobrado).toBe(false);
    expect(r.mensaje).toMatch(/conexión caída/);
  });
});

describe('ProrrateoReconexionService.arrastraMes', () => {
  it('dice que sí cuando el mes no está facturado (la orden se llamará "…2")', async () => {
    const svc = servicioDePrueba({ servicios: [TV], factura: null });
    expect(await svc.arrastraMes('sub-1', ['TV'])).toBe(true);
  });

  it('dice que no cuando el mes ya está cubierto', async () => {
    const svc = servicioDePrueba({
      servicios: [TV],
      factura: { id: 'f1', tid: 1, status: 'DUE', total: 22269, paidAmount: 0, items: [{ productName: 'Television26', description: null, price: 22269 }] },
    });
    expect(await svc.arrastraMes('sub-1', ['TV'])).toBe(false);
  });
});
