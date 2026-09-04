import { OnuProvisionService, modoDeOrden } from './onu-provision.service';

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
  }) => {
    const prisma: any = {
      ticket: {
        findUnique: jest.fn().mockResolvedValue({
          id: 't1', code: 900, type: 'Instalacion', subscriberId: SUB,
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
      oltOnu: { findFirst: jest.fn().mockResolvedValue(null) },
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
    };
    const planProfiles: any = {
      resolveConEtiqueta: jest.fn().mockResolvedValue({ trafficIn: 11, trafficOut: 9, origen: 'PLAN' }),
      resolve: jest.fn().mockResolvedValue({ trafficIn: 11, trafficOut: 9 }),
    };
    return new OnuProvisionService(prisma, olt, planProfiles);
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

  it('las variantes reales del legacy también entran', () => {
    expect(modoDeOrden('Reinstalación')).toBe('AUTENTICAR');
    expect(modoDeOrden('Traslado interno De Equipos Red en cliente final')).toBe('AUTENTICAR');
  });
});
