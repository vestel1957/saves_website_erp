import { OnuProvisionService, modoDeOrden, formaHex } from './onu-provision.service';

/**
 * Elegir SOLO qué ONU autenticar: el equipo del cliente, o uno de la bodega de
 * su sede si es un cliente nuevo.
 *
 * Lo que estas pruebas defienden no es que acierte, sino que NO adivine. El daño
 * de equivocarse aquí no lo paga el que instala: se le autentica al vecino la ONU
 * de esta casa, y el vecino se queda sin internet mientras el nuevo navega con un
 * equipo que en el inventario figura en otra dirección. Por eso solo decide sola
 * cuando hay una única lectura posible; en cuanto hay dos, devuelve el motivo y
 * la elección vuelve al técnico.
 */
describe('OnuProvisionService · qué ONU se autentica sin preguntar', () => {
  const SUB = 'sub-1';
  const SEDE = 2; // Yopal

  /**
   * Una ONU tal y como la reporta el autofind. `haceMin` = cuántos minutos lleva
   * anunciándose; por defecto 5, o sea la que el técnico acaba de conectar.
   */
  const onu = (sn: string, haceMin = 5, fsp = '0/1/3') => ({
    sn, fsp, model: 'HG8145V5', vendor: 'HWTC', mac: null,
    autofind_time: new Date(Date.now() - haceMin * 60000).toISOString(),
  });

  /**
   * @param autofind  lo que la OLT está viendo anunciarse
   * @param inventario filas de `Equipment` que casan con esos SN
   * @param stock     unidad sin rotular disponible en la bodega de la sede
   */
  const armar = (opts: {
    autofind: any[];
    inventario?: any[];
    stock?: any[];
    equiposDelAbonado?: any[];
    /** Tipo de la orden: manda en si se puede echar mano de la bodega o no. */
    tipo?: string;
    /** Filas de `OltOnu` (las altas conocidas y las ONUs vinculadas al abonado). */
    onusDelCliente?: any[];
    /** Lo que contesta la OLT al buscar un SN que no está en el autofind. */
    estadoPorSn?: any;
  }) => {
    const prisma: any = {
      ticket: {
        findUnique: jest.fn().mockResolvedValue({
          id: 't1', code: 900, type: opts.tipo ?? 'Instalacion', subscriberId: SUB,
          planToId: null, planToName: null, planToMegas: null, planAppliedAt: null,
        }),
      },
      subscriber: {
        findUnique: jest.fn().mockResolvedValue({
          id: SUB, abonado: 57439, branchId: 'br-1', fullName: 'ANA GOMEZ',
          firstName: 'ANA', secondName: null, lastName1: 'GOMEZ', lastName2: null, companyName: null,
          branch: { name: 'Yopal', legacyId: SEDE },
        }),
      },
      olt: { findFirst: jest.fn().mockResolvedValue({ id: 'olt-1', name: 'YOPAL', ip: '10.0.0.1' }) },
      subscriberService: {
        findMany: jest.fn().mockResolvedValue([
          { planId: 'plan-100', planName: '100 Megas F-26', megas: 100, status: 'ACTIVO', plan: { megas: 100 } },
        ]),
      },
      oltOnu: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue(opts.onusDelCliente ?? []) },
      equipment: { findMany: jest.fn().mockResolvedValue(opts.equiposDelAbonado ?? []) },
      // Las dos consultas crudas del servicio se distinguen por su texto: el
      // cruce SN↔inventario compara contra una lista, y la toma de stock filtra
      // por la sede de la bodega.
      $queryRaw: jest.fn(async (partes: TemplateStringsArray) => {
        const sql = partes.join(' ');
        if (sql.includes('branchLegacy" =')) return opts.stock ?? [];
        return opts.inventario ?? [];
      }),
    };
    const olt: any = {
      mode: jest.fn().mockResolvedValue({ live: true }),
      autofind: jest.fn().mockResolvedValue({ ok: true, onus: opts.autofind }),
      estadoPorSn: jest.fn().mockResolvedValue(opts.estadoPorSn ?? { ok: false, estado: null }),
    };
    const planProfiles: any = {
      resolveConEtiqueta: jest.fn().mockResolvedValue({ trafficIn: 11, trafficOut: 9, origen: 'PLAN' }),
      resolve: jest.fn().mockResolvedValue({ trafficIn: 11, trafficOut: 9 }),
    };
    // La vía Mikrotik (abonados EPON) no entra en estas pruebas: aquí todo es
    // GPON y el servicio ni la roza. Se pasa un doble mudo para armarlo.
    const mikrotik: any = { isLive: true, resolveRouter: jest.fn(), applyProfile: jest.fn() };
    return new OnuProvisionService(prisma, olt, planProfiles, mikrotik);
  };

  /** Fila cruda de `Equipment` como la devuelve `equiposPorSn`. */
  const equipo = (x: { serial: string; code: number; subscriberId?: string | null; bodega?: string | null; sede?: number | null }) => ({
    id: `eq-${x.code}`, code: x.code, serial: x.serial, status: 'Bueno', brand: 'Bestcom',
    norma: x.serial.toUpperCase().replace(/[^A-Z0-9]/g, ''),
    bodega: x.bodega ?? null, bodega_sede: x.sede ?? null,
    subscriberId: x.subscriberId ?? null,
    sub_abonado: null, sub_full: null, sub_n1: null, sub_a1: null, sub_emp: null,
  });

  it('autentica el equipo que el cliente YA tiene asignado', async () => {
    const svc = armar({
      autofind: [onu('48575443A1B2C3D4')],
      inventario: [equipo({ serial: '48575443A1B2C3D4', code: 5001, subscriberId: SUB })],
    });
    const r: any = await svc.estado('t1');
    expect(r.auto.sn).toBe('48575443A1B2C3D4');
    expect(r.auto.origen).toBe('DEL_ABONADO');
    expect(r.auto.equipo.code).toBe(5001);
  });

  it('el equipo del cliente manda aunque haya más ONUs anunciándose', async () => {
    // Es el único caso en que el ruido no importa: que ESE aparato esté
    // anunciándose y figure a su nombre no admite otra lectura.
    const svc = armar({
      autofind: [onu('48575443A1B2C3D4'), onu('5A544547FFFF0001', 3, '0/2/7')],
      inventario: [equipo({ serial: '48575443A1B2C3D4', code: 5001, subscriberId: SUB })],
    });
    const r: any = await svc.estado('t1');
    expect(r.auto.origen).toBe('DEL_ABONADO');
  });

  it('cliente nuevo: toma la unidad libre de la bodega de SU sede', async () => {
    const svc = armar({
      autofind: [onu('48575443A1B2C3D4')],
      inventario: [equipo({ serial: '48575443A1B2C3D4', code: 6002, bodega: 'Yopal', sede: SEDE })],
    });
    const r: any = await svc.estado('t1');
    expect(r.auto.origen).toBe('BODEGA_SEDE');
    expect(r.auto.equipo.code).toBe(6002);
  });

  it('cliente nuevo con una ONU que el inventario no conoce: le carga una unidad del stock', async () => {
    const svc = armar({
      autofind: [onu('48575443A1B2C3D4')],
      inventario: [],
      stock: [{ id: 'eq-7003', code: 7003, serial: 'asignar', brand: 'Bestcom', bodega: 'Yopal' }],
    });
    const r: any = await svc.estado('t1');
    expect(r.auto.origen).toBe('STOCK_SEDE');
    expect(r.auto.deStock).toBe(true);
    expect(r.auto.equipo.code).toBe(7003);
  });

  it('en un TRASLADO no se saca nada de la bodega: es la ONU que el cliente ya tenía', async () => {
    // Mismo escenario que el de arriba —una ONU que el inventario no conoce y stock
    // disponible— pero en un traslado el aparato no es nuevo: se autentica igual y
    // no se descuenta ninguna unidad (2026-09-04, dicho por el usuario).
    const svc = armar({
      tipo: 'Traslado',
      autofind: [onu('48575443A1B2C3D4')],
      inventario: [],
      stock: [{ id: 'eq-7003', code: 7003, serial: 'asignar', brand: 'Bestcom', bodega: 'Yopal' }],
    });
    const r: any = await svc.estado('t1');
    expect(r.auto.sn).toBe('48575443A1B2C3D4');
    expect(r.auto.deStock).toBe(false);
    expect(r.auto.equipo).toBeNull();
    expect(r.auto.motivo).toMatch(/no se entrega equipo/i);
  });

  it('sin unidades en la bodega sigue adelante, pero lo dice', async () => {
    // El servicio del cliente no puede esperar a que repongan stock; lo que no
    // puede es quedarse callado, o nadie sabrá que falta cargarle el equipo.
    const svc = armar({ autofind: [onu('48575443A1B2C3D4')], inventario: [], stock: [] });
    const r: any = await svc.estado('t1');
    expect(r.auto.sn).toBe('48575443A1B2C3D4');
    expect(r.auto.equipo).toBeNull();
    expect(r.auto.motivo).toMatch(/no quedan unidades/i);
  });

  it('dos ONUs recién aparecidas y ninguna del cliente: NO decide', async () => {
    const svc = armar({
      autofind: [onu('48575443A1B2C3D4'), onu('5A544547FFFF0001', 8, '0/2/7')],
      inventario: [],
      stock: [{ id: 'eq-7003', code: 7003, serial: 'asignar', brand: 'Bestcom', bodega: 'Yopal' }],
    });
    const r: any = await svc.estado('t1');
    expect(r.auto.sn).toBeNull();
    expect(r.auto.motivo).toMatch(/elija a mano/i);
  });

  it('el ruido viejo del autofind no estorba: solo cuenta la recién aparecida', async () => {
    // El caso real de VILLANUEVA: 66 ONUs sonando, la más vieja desde hace 15
    // días. Sin el filtro de la hora no habría automático nunca.
    const viejas = ['5A544547FFFF0001', '5A544547FFFF0002', '5A544547FFFF0003']
      .map((sn, i) => onu(sn, 60 * 24 * (i + 2), `0/2/${i}`));
    const svc = armar({
      autofind: [...viejas, onu('48575443A1B2C3D4', 4)],
      inventario: [equipo({ serial: '48575443A1B2C3D4', code: 6002, bodega: 'Yopal', sede: SEDE })],
    });
    const r: any = await svc.estado('t1');
    expect(r.auto.origen).toBe('BODEGA_SEDE');
    expect(r.auto.equipo.code).toBe(6002);
  });

  it('si ninguna apareció en las últimas 2 horas, no se elige nada', async () => {
    // Todas llevan días sonando: la que el técnico instaló no está (aún no le
    // llega luz, o la conectó a otro puerto). Adivinar aquí sería lo peor.
    const svc = armar({
      autofind: [onu('48575443A1B2C3D4', 60 * 30), onu('5A544547FFFF0001', 60 * 50, '0/2/7')],
      inventario: [],
      stock: [{ id: 'eq-7003', code: 7003, serial: 'asignar', brand: 'Bestcom', bodega: 'Yopal' }],
    });
    const r: any = await svc.estado('t1');
    expect(r.auto.sn).toBeNull();
    expect(r.auto.motivo).toMatch(/últimas 2 horas/i);
  });

  it('la lista se ordena por la recién aparecida, no por puerto', async () => {
    const svc = armar({
      autofind: [onu('5A544547FFFF0001', 900, '0/0/1'), onu('48575443A1B2C3D4', 3, '0/9/9')],
      inventario: [],
      stock: [],
    });
    const r: any = await svc.estado('t1');
    expect(r.candidatos[0].sn).toBe('48575443A1B2C3D4');
    expect(r.candidatos[0].haceMin).toBeLessThanOrEqual(4);
  });

  it('la unidad de la bodega de OTRA sede no se elige sola', async () => {
    const svc = armar({
      autofind: [onu('48575443A1B2C3D4')],
      inventario: [equipo({ serial: '48575443A1B2C3D4', code: 6002, bodega: 'Villanueva', sede: 3 })],
    });
    const r: any = await svc.estado('t1');
    expect(r.auto.sn).toBeNull();
    expect(r.auto.motivo).toMatch(/figura en la bodega "Villanueva" y no en la de Yopal/i);
  });

  it('una ONU instalada en OTRO cliente no es candidata para nada', async () => {
    const svc = armar({
      autofind: [onu('48575443A1B2C3D4')],
      inventario: [equipo({ serial: '48575443A1B2C3D4', code: 5001, subscriberId: 'sub-vecino' })],
    });
    const r: any = await svc.estado('t1');
    expect(r.candidatos[0].impedimento).toBeTruthy();
    expect(r.auto.sn).toBeNull();
    expect(r.auto.motivo).toMatch(/otros clientes/i);
  });

  it('el serial de la etiqueta (ASCII+hex) casa con el SN de 16 hex de la OLT', async () => {
    // 47504F4E120278E5 → "GPON" + 120278E5. Sin esta traducción el equipo del
    // cliente parecería no estar en el inventario y se le cargaría otro.
    const svc = armar({
      autofind: [onu('47504F4E120278E5')],
      inventario: [equipo({ serial: 'GPON120278E5', code: 5002, subscriberId: SUB })],
    });
    const r: any = await svc.estado('t1');
    expect(r.auto.origen).toBe('DEL_ABONADO');
    expect(r.auto.equipo.code).toBe(5002);
  });

  it('equipo asignado que no se anuncia porque SIGUE dado de alta en la OLT: dice dónde (2026-09-15, 311071)', async () => {
    // OltOnu no lo conocía (alta del cliente anterior): la orden decía "la OLT
    // todavía no lo ve" y mandaba a revisar la fibra de un equipo encendido.
    const svc = armar({
      autofind: [onu('5A544547FFFF0001', 900, '0/2/7')],
      equiposDelAbonado: [{ id: 'eq-311071', code: 311071, serial: 'XPON1D8D6564', status: 'Asignado', reservedTicketId: null, warehouse: null }],
      estadoPorSn: {
        ok: true,
        estado: { fsp: '0/1/11', ont_id: 45, run_state: 'online', description: '2378BARBARA_zone_PRINCIPAL' },
      },
    });
    const r: any = await svc.estado('t1');
    expect(r.equipoAsignado.anunciandose).toBe(false);
    expect(r.equipoAsignado.autenticada).toBe(true);
    expect(r.equipoAsignado.sn).toBe('58504F4E1D8D6564');
    expect(r.equipoAsignado.autenticadaEn).toEqual({ fsp: '0/1/11', ontId: 45, runState: 'online', descripcion: '2378BARBARA_zone_PRINCIPAL' });
  });

  it('si la OLT tampoco lo tiene dado de alta, se queda el aviso de siempre (sin autenticadaEn)', async () => {
    const svc = armar({
      autofind: [onu('5A544547FFFF0001', 900, '0/2/7')],
      equiposDelAbonado: [{ id: 'eq-311071', code: 311071, serial: 'XPON1D8D6564', status: 'Asignado', reservedTicketId: null, warehouse: null }],
    });
    const r: any = await svc.estado('t1');
    expect(r.equipoAsignado.autenticada).toBe(false);
    expect(r.equipoAsignado.autenticadaEn).toBeNull();
  });

  it('devuelve todas las ONUs vinculadas al cliente, para avisar de un cambio de equipo a medias', async () => {
    const dos = [
      { sn: '58504F4E1D8D6564', frame: 0, slot: 1, port: 11, ontId: 45, runState: 'online', olt: { name: 'MONTERREY' } },
      { sn: '47504F4E0027F048', frame: 0, slot: 1, port: 0, ontId: 44, runState: 'online', olt: { name: 'MONTERREY' } },
    ];
    const svc = armar({ autofind: [onu('48575443A1B2C3D4')], onusDelCliente: dos });
    const r: any = await svc.estado('t1');
    expect(r.onusDelCliente).toHaveLength(2);
  });
});

/**
 * Los cinco tipos de orden que el usuario pidió que autenticaran solos
 * (2026-09-03), escritos EXACTAMENTE como están en la base — que es lo que se va
 * a comparar en producción, no una versión bonita de los nombres.
 */
describe('modoDeOrden · qué órdenes tocan la OLT', () => {
  it('los cinco tipos pedidos autentican ONU', () => {
    for (const tipo of ['Instalacion', 'Cambio de equipo', 'Subir megas', 'Traslado', 'Migracion']) {
      expect(['AUTENTICAR', 'AMBOS']).toContain(modoDeOrden(tipo));
    }
  });

  it('«Subir megas» hace las dos cosas: velocidad y, si cambió el equipo, autenticar', () => {
    // Es el único de los cinco donde la ONU normalmente ya está puesta.
    expect(modoDeOrden('Subir megas')).toBe('AMBOS');
  });

  it('«Migracion» ya no se queda fuera (2.134 órdenes en la base)', () => {
    expect(modoDeOrden('Migracion')).toBe('AUTENTICAR');
    expect(modoDeOrden('Migración')).toBe('AUTENTICAR');
  });

  it('«Cambio de plan» sigue siendo solo velocidad y no se confunde con «Cambio de equipo»', () => {
    // Los dos empiezan igual: con un `else if` mal ordenado uno tapaba al otro.
    expect(modoDeOrden('Cambio de plan')).toBe('VELOCIDAD');
    expect(modoDeOrden('Cambio de equipo')).toBe('AUTENTICAR');
  });

  it('lo que no toca la OLT sigue sin tocarla', () => {
    for (const tipo of ['Cambio de clave', 'Retiro voluntario', 'Corte Internet', '', null]) {
      expect(modoDeOrden(tipo)).toBeNull();
    }
  });

  /**
   * 'AgregarInternet' no cae en ningún fragmento ('instalac', 'traslado'…), así
   * que el bloque de la ONU no salía en estas órdenes: la orden decía "no aplica
   * la autenticación" y el técnico tenía que irse a /red/olt.
   */
  it('«AgregarInternet» autentica Y aplica velocidad', () => {
    expect(modoDeOrden('AgregarInternet')).toBe('AMBOS');
    expect(modoDeOrden(' agregarinternet ')).toBe('AMBOS');
  });

  it('las variantes reales del legacy también entran', () => {
    expect(modoDeOrden('Traslado interno De Equipos Red en cliente final')).toBe('AUTENTICAR');
  });

  /**
   * La reinstalación contiene 'instalac' y entraba de rebote. El usuario la sacó
   * (2026-09-08): el equipo ya está en la casa y ya está de alta en la OLT, así
   * que en esas órdenes el bloque de la ONU no tiene nada que hacer.
   */
  it('la REINSTALACIÓN no autentica, aunque calce con «instalac»', () => {
    for (const tipo of ['Reinstalación', 'Reinstalacion', 'REINSTALACIÓN', ' reinstalación ']) {
      expect([tipo, modoDeOrden(tipo)]).toEqual([tipo, null]);
    }
    // Y no se lleva por delante a la instalación de verdad.
    expect(modoDeOrden('Instalacion')).toBe('AUTENTICAR');
  });
});

/**
 * Preguntarle a la OLT por un equipo del inventario.
 *
 * El almacén rotula `ZTEGDE519D2C` y la OLT habla en 16 hex: sin esta traducción,
 * "¿la OLT está viendo el equipo de este cliente?" se contesta siempre que no, y
 * la orden diría que hay que sacar otra caja cuando la buena ya está encendida.
 */
describe('formaHex · el serial del inventario en el idioma de la OLT', () => {
  it('traduce la etiqueta del fabricante a los 16 hex', () => {
    expect(formaHex('ZTEGDE519D2C')).toBe('5A544547DE519D2C');
    expect(formaHex('HWTC12345678')).toBe('4857544312345678');
    // Con espacios y guiones, que es como los teclea el almacén.
    expect(formaHex(' ztegde519d2c ')).toBe('5A544547DE519D2C');
  });

  it('deja intacto el que ya viene en hex', () => {
    expect(formaHex('5A544547DE519D2C')).toBe('5A544547DE519D2C');
  });

  it('no inventa un SN donde no lo hay', () => {
    // Etiqueta de puente EoC, seriales de relleno y vacíos: no son ONUs.
    for (const s of ['BA1305-1704003199', 'solicitar', '', null, undefined]) {
      expect(formaHex(s)).toBeNull();
    }
  });
});
