import type { AgentUser, ToolContext } from '@s4gk/wa-agent';
import { TramitesToolset } from './tramites.toolset';
import { CHAT_CLIENTE_PERMISSION, CHAT_PUBLICO_PERMISSION, type ChatIdentity } from '../chatbot.identity';

/**
 * Lo que se prueba aquí es el port de SAM en su parte verificable: que el SERVIDOR
 * mande. SAM confiaba en que el modelo pidiera los datos y no repitiera radicados, y
 * pagó las dos cosas (se inventaba el número del radicado copiándolo del ejemplo del
 * prompt). Estas pruebas fijan lo contrario: sin los datos no hay orden, sin estar al
 * día no hay suspensión, y con una orden abierta no se abre otra — dígalo o no el
 * prompt.
 */

/** Ficha de abonado que devuelve `SubscribersService.detail`. */
function ficha(over: Partial<{ status: string; services: any[]; workOrders: any[] }> = {}) {
  return {
    status: 'ACTIVO',
    services: [{ kind: 'INTERNET' }],
    workOrders: [],
    ...over,
  };
}

type Dobles = {
  detalle?: ReturnType<typeof ficha>;
  deuda?: number;
  /** Qué contesta el ACS al intento de cambiar el WiFi en el equipo del cliente. */
  wifi?: { ok: boolean; resultado: string; detalle: string; redes?: string[] } | Error;
};

function armar(d: Dobles = {}) {
  const creados: any[] = [];
  const leads: any[] = [];
  const subscribers = { detail: jest.fn(async () => d.detalle ?? ficha()) };
  const cobranzas = {
    subscriberDebt: jest.fn(async () => ({ totalDebt: d.deuda ?? 0, invoices: [], balance: 0 })),
  };
  const write = {
    createTicket: jest.fn(async (dto: any) => {
      creados.push(dto);
      return { id: 'tk-1', code: 5001 };
    }),
    createLeadTicket: jest.fn(async (input: any) => {
      leads.push(input);
      return { id: 'tk-2', code: 5002 };
    }),
  };
  const genieacs = {
    setWifiBySubscriber: jest.fn(async () => {
      // Por defecto el equipo no está en el ACS: es el caso de 9 de cada 10 abonados.
      const r = d.wifi ?? { ok: false, resultado: 'SIN_EQUIPO', detalle: 'El equipo del abonado no está en el ACS.' };
      if (r instanceof Error) throw r;
      return r;
    }),
  };
  // Sólo lo usa el atajo de "pronto pago" para leer la promoción vigente; sin
  // promociones en la base la respuesta cae al texto de siempre.
  const prisma = { promotion: { findMany: jest.fn(async () => []) } };
  const toolset = new TramitesToolset(subscribers as any, cobranzas as any, write as any, genieacs as any, prisma as any);
  return { toolset, creados, leads, write, genieacs, prisma };
}

const CLIENTE: ChatIdentity = { kind: 'cliente', subscriberId: 'sub-1', abonado: 1234 };
const CLIENTE_BASICO: ChatIdentity = { kind: 'cliente', subscriberId: 'sub-1', abonado: 1234, acceso: 'basico' };
const PUBLICO: ChatIdentity = { kind: 'publico', phone: '573001112233' };

function ctx(identity: ChatIdentity, committing = false) {
  const user: AgentUser = {
    id: identity.kind === 'cliente' ? 'sub-1' : 'wa:573001112233',
    name: 'Prueba',
    permissions: [identity.kind === 'cliente' ? CHAT_CLIENTE_PERMISSION : CHAT_PUBLICO_PERMISSION],
    meta: { identity },
  };
  const pendientes: any[] = [];
  const c = {
    user,
    convKey: 'kapso:573001112233',
    committing,
    can: (p: string) => user.permissions.includes(p),
    canStrict: (p: string) => user.permissions.includes(p),
    preparePending: (a: any) => {
      pendientes.push(a);
      return `PREPARADO: ${a.summary}`;
    },
    sendDocument: async () => true,
    audit: async () => undefined,
  } as unknown as ToolContext;
  return { ctx: c, pendientes };
}

const registrar = (t: TramitesToolset, c: ToolContext, input: Record<string, unknown>) =>
  t.execute('registrar_solicitud', input, c);

describe('registrar_solicitud — los datos obligatorios los exige el servidor', () => {
  it('no crea nada si falta un dato, y devuelve la pregunta exacta que hay que hacer', async () => {
    const { toolset, creados } = armar();
    const { ctx: c, pendientes } = ctx(CLIENTE);

    // Falla de internet sin el bombillo rojo: SAM lo preguntaba "casi siempre".
    const r = await registrar(toolset, c, {
      tipo: 'falla_internet',
      descripcion: 'se cae cada rato',
      datos: { descripcion: 'se cae cada rato' },
    });

    expect(r).toContain('bombillo_rojo');
    expect(r).toContain('¿De casualidad al equipo le alumbra algún bombillo rojo?');
    expect(pendientes).toHaveLength(0);
    expect(creados).toHaveLength(0);
  });

  it('el traslado sin dirección nueva no se registra', async () => {
    const { toolset, creados } = armar();
    const { ctx: c } = ctx(CLIENTE);
    const r = await registrar(toolset, c, { tipo: 'traslado', descripcion: 'me mudo' });
    expect(r).toContain('direccion_nueva');
    expect(creados).toHaveLength(0);
  });

  it('el cambio de WiFi exige al menos el nombre o la clave (los dos son opcionales por separado)', async () => {
    const { toolset } = armar();
    const { ctx: c } = ctx(CLIENTE);
    const r = await registrar(toolset, c, { tipo: 'cambio_wifi', descripcion: 'cambiar wifi', datos: {} });
    expect(r).toContain('al menos');

    const { ctx: c2, pendientes } = ctx(CLIENTE);
    const ok = await registrar(toolset, c2, {
      tipo: 'cambio_wifi', descripcion: 'cambiar la clave', datos: { wifi_clave: 'NuevaClave123' },
    });
    expect(ok).toContain('PREPARADO');
    expect(pendientes).toHaveLength(1);
  });
});

describe('registrar_solicitud — confirmación antes de escribir', () => {
  it('la primera llamada solo prepara; el número de orden lo pone el ERP al confirmar', async () => {
    const { toolset, creados } = armar();

    const { ctx: c, pendientes } = ctx(CLIENTE);
    const preparado = await registrar(toolset, c, {
      tipo: 'falla_internet',
      descripcion: 'internet lento',
      datos: { descripcion: 'internet lento', bombillo_rojo: 'si' },
    });
    expect(preparado).toContain('PREPARADO');
    expect(creados).toHaveLength(0);
    // El resumen le lee al cliente lo que el bot entendió, que es lo que confirma.
    expect(pendientes[0].summary).toContain('bombillo rojo');
    expect(pendientes[0].permission).toBe(CHAT_CLIENTE_PERMISSION);

    const { ctx: commit } = ctx(CLIENTE, true);
    const hecho = await registrar(toolset, commit, pendientes[0].commitInput);
    expect(hecho).toContain('#5001');
    expect(creados).toHaveLength(1);
    expect(creados[0].type).toBe('Revision de Internet');
    expect(creados[0].subscriberId).toBe('sub-1');
  });

  it('la televisión abre una orden de revisión de TV, no de internet', async () => {
    const { toolset, creados } = armar();
    const { ctx: c } = ctx(CLIENTE, true);
    await registrar(toolset, c, {
      tipo: 'falla_tv', descripcion: 'sin señal', datos: { descripcion: 'sin señal' },
    });
    expect(creados[0].type).toBe('Revision de television');
  });

  it('deja los datos capturados en la orden, para quien la atienda', async () => {
    const { toolset, creados } = armar();
    const { ctx: c } = ctx(CLIENTE, true);
    await registrar(toolset, c, {
      tipo: 'traslado',
      descripcion: 'traslado de servicio',
      datos: { direccion_nueva: 'Calle 5 #3-10', telefono_contacto: '3009876543' },
    });
    expect(creados[0].section).toContain('Calle 5 #3-10');
    expect(creados[0].section).toContain('3009876543');
    expect(creados[0].type).toBe('Traslado');
  });
});

describe('registrar_solicitud — no se abren duplicados (la regla post-radicado de SAM)', () => {
  it('devuelve el número de la orden que ya está abierta en vez de crear otra', async () => {
    const { toolset, creados } = armar({
      detalle: ficha({ workOrders: [{ code: 4321, type: 'Revision de Internet', status: 'PENDIENTE' }] }),
    });
    const { ctx: c } = ctx(CLIENTE);
    const r = await registrar(toolset, c, {
      tipo: 'falla_internet', descripcion: 'sigue igual', datos: { descripcion: 'sigue igual', bombillo_rojo: 'no' },
    });
    expect(r).toContain('#4321');
    expect(r).toContain('NO abras otra');
    expect(creados).toHaveLength(0);
  });

  it('una orden ya resuelta no bloquea una nueva', async () => {
    const { toolset, creados } = armar({
      detalle: ficha({ workOrders: [{ code: 4321, type: 'Revision de Internet', status: 'RESUELTO' }] }),
    });
    const { ctx: c } = ctx(CLIENTE, true);
    await registrar(toolset, c, {
      tipo: 'falla_internet', descripcion: 'otra vez', datos: { descripcion: 'otra vez', bombillo_rojo: 'si' },
    });
    expect(creados).toHaveLength(1);
  });

  it('una orden abierta de OTRO tipo no bloquea', async () => {
    const { toolset, creados } = armar({
      detalle: ficha({ workOrders: [{ code: 999, type: 'Traslado', status: 'PENDIENTE' }] }),
    });
    const { ctx: c } = ctx(CLIENTE, true);
    await registrar(toolset, c, {
      tipo: 'falla_tv', descripcion: 'sin señal', datos: { descripcion: 'sin señal' },
    });
    expect(creados).toHaveLength(1);
  });
});

describe('suspensión temporal — las condiciones se comprueban, no se prometen', () => {
  const datos = { fecha_inicio: '2026-08-01', fecha_fin: '2026-09-30' };

  it('con deuda pendiente no se suspende', async () => {
    const { toolset, creados } = armar({ deuda: 85000 });
    const { ctx: c } = ctx(CLIENTE);
    const r = await registrar(toolset, c, { tipo: 'suspension', descripcion: 'me voy de viaje', datos });
    expect(r).toContain('No se puede suspender');
    expect(r).toContain('85.000');
    expect(creados).toHaveLength(0);
  });

  it('más de 3 meses se rechaza con la fecha tope calculada', async () => {
    const { toolset, creados } = armar();
    const { ctx: c } = ctx(CLIENTE);
    const r = await registrar(toolset, c, {
      tipo: 'suspension', descripcion: 'viaje largo',
      datos: { fecha_inicio: '2026-08-01', fecha_fin: '2026-12-01' },
    });
    expect(r).toContain('máximo de 3 meses');
    expect(creados).toHaveLength(0);
  });

  it('acepta fechas dictadas como DD/MM/YYYY', async () => {
    const { toolset } = armar();
    const { ctx: c, pendientes } = ctx(CLIENTE);
    const r = await registrar(toolset, c, {
      tipo: 'suspension', descripcion: 'viaje',
      datos: { fecha_inicio: '01/08/2026', fecha_fin: '15/09/2026' },
    });
    expect(r).toContain('PREPARADO');
    expect(pendientes).toHaveLength(1);
  });

  it('rechaza una fecha imposible en vez de correrla de mes', async () => {
    const { toolset } = armar();
    const { ctx: c } = ctx(CLIENTE);
    const r = await registrar(toolset, c, {
      tipo: 'suspension', descripcion: 'viaje',
      datos: { fecha_inicio: '31/02/2026', fecha_fin: '15/04/2026' },
    });
    expect(r).toContain('No entendí las fechas');
  });

  it('no suspende lo que ya está suspendido', async () => {
    const { toolset, creados } = armar({ detalle: ficha({ status: 'SUSPENDIDO' }) });
    const { ctx: c } = ctx(CLIENTE);
    const r = await registrar(toolset, c, { tipo: 'suspension', descripcion: 'viaje', datos });
    expect(r).toContain('SUSPENDIDO');
    expect(creados).toHaveLength(0);
  });

  it('el tipo de orden sigue a los servicios del abonado, porque el cierre corta lo suyo', async () => {
    const combo = armar({ detalle: ficha({ services: [{ kind: 'INTERNET' }, { kind: 'TV' }] }) });
    await registrar(combo.toolset, ctx(CLIENTE, true).ctx, { tipo: 'suspension', descripcion: 'viaje', datos });
    expect(combo.creados[0].type).toBe('Suspension Combo');

    const soloTv = armar({ detalle: ficha({ services: [{ kind: 'TV' }] }) });
    await registrar(soloTv.toolset, ctx(CLIENTE, true).ctx, { tipo: 'suspension', descripcion: 'viaje', datos });
    expect(soloTv.creados[0].type).toBe('Suspension Television');

    const soloInternet = armar();
    await registrar(soloInternet.toolset, ctx(CLIENTE, true).ctx, { tipo: 'suspension', descripcion: 'viaje', datos });
    expect(soloInternet.creados[0].type).toBe('Suspension Internet');
  });
});

describe('quién puede pedir qué', () => {
  it('un número desconocido NO puede tramitar nada de una cuenta', async () => {
    const { toolset, creados } = armar();
    const { ctx: c } = ctx(PUBLICO);
    const r = await registrar(toolset, c, {
      tipo: 'traslado', descripcion: 'me mudo', datos: { direccion_nueva: 'Calle 1' },
    });
    expect(r).toContain('validar_mi_identidad');
    expect(creados).toHaveLength(0);
  });

  it('y no se le ofrecen esas herramientas ni en el enum', async () => {
    const { toolset } = armar();
    const { ctx: c } = ctx(PUBLICO);
    const def = toolset.definitions(c).find((d) => d.name === 'registrar_solicitud')!;
    const tipos = (def.input_schema as any).properties.tipo.enum as string[];
    expect(tipos).toEqual(expect.arrayContaining(['afiliacion', 'cobertura', 'pqr']));
    expect(tipos).not.toContain('traslado');
    expect(tipos).not.toContain('falla_internet');
  });

  it('quien entró con validación básica reporta averías pero no cambia la cuenta', async () => {
    const { toolset, creados } = armar();
    const { ctx: c } = ctx(CLIENTE_BASICO);

    const cambio = await registrar(toolset, c, {
      tipo: 'cambio_plan', descripcion: 'subir plan', datos: { plan_nuevo: '600 megas' },
    });
    expect(cambio).toContain('pedir_codigo_al_titular');
    expect(creados).toHaveLength(0);

    const { ctx: c2, pendientes } = ctx(CLIENTE_BASICO);
    const falla = await registrar(toolset, c2, {
      tipo: 'falla_internet', descripcion: 'sin internet', datos: { descripcion: 'sin internet', bombillo_rojo: 'si' },
    });
    expect(falla).toContain('PREPARADO');
    expect(pendientes).toHaveLength(1);
  });

  it('el enum del abonado con acceso básico tampoco trae los trámites que modifican', async () => {
    const { toolset } = armar();
    const def = toolset.definitions(ctx(CLIENTE_BASICO).ctx).find((d) => d.name === 'registrar_solicitud')!;
    const tipos = (def.input_schema as any).properties.tipo.enum as string[];
    expect(tipos).toContain('falla_internet');
    expect(tipos).toContain('pqr');
    expect(tipos).not.toContain('traslado');
    expect(tipos).not.toContain('cambio_titular');
  });
});

describe('la sonda con la que el motor arma su enrutador', () => {
  /**
   * El motor llama una vez a `definitions()` con un usuario VACÍO para saber qué
   * toolset atiende cada nombre de herramienta (ver `esSonda`). Si ante la sonda se
   * declarara menos de lo posible, esas herramientas no quedarían registradas y toda
   * llamada moriría con "herramienta desconocida" — el mismo fallo que ya se documentó
   * en `combineToolsets`, y que pasa desapercibido porque el modelo SÍ las ve.
   */
  it('declara TODOS los trámites, para que el motor los pueda enrutar', () => {
    const { toolset } = armar();
    const sonda = { user: { id: '', name: '', permissions: [] }, convKey: '', committing: false } as unknown as ToolContext;
    const def = toolset.definitions(sonda).find((d) => d.name === 'registrar_solicitud')!;
    const tipos = (def.input_schema as any).properties.tipo.enum as string[];
    expect(tipos).toEqual(expect.arrayContaining(['traslado', 'cambio_titular', 'falla_internet', 'afiliacion']));
  });
});

describe('interesados que todavía no son clientes', () => {
  it('la afiliación queda como orden SIN abonado y avisa a ventas', async () => {
    const { toolset, leads } = armar();
    const { ctx: c, pendientes } = ctx(PUBLICO);

    const prep = await registrar(toolset, c, {
      tipo: 'afiliacion',
      descripcion: 'quiere instalación nueva',
      datos: { nombre: 'Juan Pérez', telefono: '3009876543', direccion: 'Calle 5 #3-10', plan_interes: '600 megas' },
    });
    expect(prep).toContain('PREPARADO');
    // El público también confirma: para eso existe su permiso sintético.
    expect(pendientes[0].permission).toBe(CHAT_PUBLICO_PERMISSION);

    const { ctx: commit } = ctx(PUBLICO, true);
    const hecho = await registrar(toolset, commit, pendientes[0].commitInput);
    expect(hecho).toContain('#5002');
    expect(leads).toHaveLength(1);
    expect(leads[0].type).toBe('Instalacion');
    expect(leads[0].post).toBe('ventas');
    expect(leads[0].section).toContain('Juan Pérez');
  });

  it('una PQR se recibe siempre, aunque no sea cliente, y con prioridad alta', async () => {
    const { toolset, leads } = armar();
    const { ctx: c } = ctx(PUBLICO, true);
    await registrar(toolset, c, {
      tipo: 'pqr', descripcion: 'llevo tres días sin servicio y nadie responde',
      datos: { descripcion: 'tres días sin servicio' },
    });
    expect(leads[0].type).toBe('PQR');
    expect(leads[0].priority).toBe('Alta');
    expect(leads[0].post).toBe('pqr');
  });

  it('la cobertura no se adivina: queda registrada para que un asesor confirme', async () => {
    const { toolset, leads } = armar();
    const { ctx: c } = ctx(PUBLICO, true);
    const r = await registrar(toolset, c, {
      tipo: 'cobertura', descripcion: '¿hay cobertura en el barrio El Prado?',
      datos: { direccion: 'Barrio El Prado, Yopal', telefono: '3001112233' },
    });
    expect(leads[0].type).toBe('Consulta de cobertura');
    expect(r).toContain('asesor');
  });
});

describe('el conocimiento comercial sale del catálogo, no de la memoria del modelo', () => {
  it('las condiciones de un trámite traen costo, tiempo y las preguntas a hacer', async () => {
    const { toolset } = armar();
    const { ctx: c } = ctx(CLIENTE);
    const r = await toolset.execute('condiciones_de_tramite', { tipo: 'traslado' }, c);
    expect(r).toContain('$30.000');
    expect(r).toContain('1 día hábil');
    expect(r).toContain('¿A qué dirección se va a trasladar el servicio?');
  });

  it('las apps por nivel distinguen las permanentes de las de 2 meses', async () => {
    const { toolset } = armar();
    const { ctx: c } = ctx(CLIENTE);
    const premium = await toolset.execute('apps_incluidas', { nivel: 'premium' }, c);
    expect(premium).toContain('Disney+ con anuncios');
    expect(premium).toContain('gratis por 2 meses');

    const diamante = await toolset.execute('apps_incluidas', { nivel: 'diamante' }, c);
    expect(diamante).toContain('PERMANENTE');
  });

  it('la mora explica que no se cobra reconexión', async () => {
    const { toolset } = armar();
    const { ctx: c } = ctx(PUBLICO);
    const r = await toolset.execute('info_comercial', { tema: 'mora' }, c);
    expect(r).toContain('NO se cobra reconexión');
  });

  it('un tipo de trámite inventado por el modelo no revienta: se le dice cuáles hay', async () => {
    const { toolset, creados } = armar();
    const { ctx: c } = ctx(CLIENTE);
    const r = await registrar(toolset, c, { tipo: 'cancelar_todo', descripcion: 'x' });
    expect(r).toContain('No conozco ese trámite');
    expect(creados).toHaveLength(0);
  });
});

/**
 * El cambio de WiFi es el único trámite que el bot puede RESOLVER, no solo radicar:
 * si el equipo del cliente está en el ACS y contesta, la clave cambia en el momento.
 *
 * Lo que se fija aquí es que las dos ramas sean honestas. Cuando se aplica, no puede
 * quedar una orden abierta para que un técnico vaya a hacer algo que ya está hecho.
 * Y cuando NO se aplica —que es lo normal: solo 605 de 5.097 abonados activos tienen
 * equipo en el ACS— tiene que quedar la orden de siempre, con el motivo dentro para
 * que el técnico no repita el intento a ciegas.
 */
describe('cambio de WiFi — primero el equipo, y la orden solo si no se pudo', () => {
  const DATOS = { tipo: 'cambio_wifi', descripcion: 'quiere otra clave', datos: { wifi_clave: 'ClaveNueva2026' } };

  it('si el equipo lo aplica, NO se abre orden y se le explica que debe reconectar sus aparatos', async () => {
    const { toolset, creados, genieacs } = armar({
      wifi: { ok: true, resultado: 'APLICADO', detalle: 'Aplicado en el equipo (2 redes).', redes: ['CASA: clave nueva'] },
    });
    const { ctx: c } = ctx(CLIENTE, true);

    const r = await registrar(toolset, c, DATOS);

    expect(genieacs.setWifiBySubscriber).toHaveBeenCalledWith(
      'sub-1', { ssid: '', clave: 'ClaveNueva2026' }, expect.objectContaining({ id: 'chatbot' }),
    );
    expect(creados).toHaveLength(0);
    expect(r).toContain('NO hay orden');
    expect(r).toContain('volver a conectar');
  });

  it('si el equipo no está en el ACS, se abre la orden de siempre con el motivo dentro', async () => {
    const { toolset, creados } = armar({
      wifi: { ok: false, resultado: 'SIN_EQUIPO', detalle: 'El equipo del abonado no está en el ACS.' },
    });
    const { ctx: c } = ctx(CLIENTE, true);

    const r = await registrar(toolset, c, DATOS);

    expect(r).toContain('#5001');
    expect(creados).toHaveLength(1);
    expect(creados[0].type).toBe('Cambio de clave');
    expect(creados[0].section).toContain('SIN_EQUIPO');
    // Y la clave que pidió el cliente viaja en la orden: es lo que el técnico va a poner.
    expect(creados[0].section).toContain('ClaveNueva2026');
  });

  it('si el ACS está caído, el trámite no se cae con él: queda la orden', async () => {
    const { toolset, creados } = armar({ wifi: new Error('NBI /devices → HTTP 502') });
    const { ctx: c } = ctx(CLIENTE, true);

    const r = await registrar(toolset, c, DATOS);

    expect(r).toContain('#5001');
    expect(creados[0].section).toContain('no se pudo contactar el ACS');
  });

  it('antes de confirmar se le advierte que se le desconectan todos los aparatos', async () => {
    const { toolset, genieacs } = armar();
    const { ctx: c, pendientes } = ctx(CLIENTE);

    await registrar(toolset, c, DATOS);

    expect(pendientes[0].summary).toContain('se desconectan TODOS los aparatos');
    // Y hasta que no confirme no se toca el equipo de nadie.
    expect(genieacs.setWifiBySubscriber).not.toHaveBeenCalled();
  });

  it('el resto de trámites ni se asoma al ACS', async () => {
    const { toolset, genieacs, creados } = armar();
    const { ctx: c } = ctx(CLIENTE, true);

    await registrar(toolset, c, { tipo: 'falla_tv', descripcion: 'sin señal', datos: { descripcion: 'sin señal' } });

    expect(genieacs.setWifiBySubscriber).not.toHaveBeenCalled();
    expect(creados).toHaveLength(1);
  });
});

describe('cambio de WiFi — una clave que WPA rechaza no se convierte en una orden', () => {
  it('pide otra clave en vez de mandar al técnico a teclear algo que el equipo no acepta', async () => {
    const { toolset, creados } = armar({
      wifi: {
        ok: false, resultado: 'DATOS_INVALIDOS',
        detalle: 'La clave del WiFi debe tener al menos 8 caracteres.',
      },
    });
    const { ctx: c } = ctx(CLIENTE, true);

    const r = await registrar(toolset, c, {
      tipo: 'cambio_wifi', descripcion: 'quiere otra clave', datos: { wifi_clave: 'corta' },
    });

    expect(r).toContain('al menos 8 caracteres');
    expect(creados).toHaveLength(0);
  });
});
