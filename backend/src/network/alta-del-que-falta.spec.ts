import { MikrotikService, esElMismoNombre, ipLocalDeLaRed } from './mikrotik.service';

/**
 * El abonado que no existe en el router.
 *
 * El barrido de madrugada CONTABA los que no tenían `/ppp/secret` (1.681 el
 * 2026-09-09) y seguía adelante, así que el cliente recién instalado cuyo alta
 * se cayó se quedaba sin navegar hasta que llamara. Ahora se le da de alta —o
 * se dice por qué no se puede, que es la lista de fichas a corregir—.
 *
 * Lo que se comprueba aquí es justo lo que NO puede hacer un proceso que corre
 * de madrugada sin nadie mirando: inventarse un perfil, crear el secret de un
 * cliente de TV, duplicar a alguien que ya está con el nombre mal escrito, o
 * devolverle el internet a un moroso por el camino.
 */
describe('MikrotikService · dar de alta al que no tiene secret', () => {
  const PERFILES = [
    { id: '*0', name: 'default' },
    { id: '*24', name: '100Megas' },
    { id: '*25', name: '100MegasD' },
    { id: '*26', name: '100MegasSt' },
  ];
  const ROUTER = { id: 'r1', name: 'ip_tauramena', ip: '10.0.0.1', port: '5051' } as any;

  /** Abonado tipo: usuario y perfil buenos, IP fija en la ficha. */
  const abonado = (extra: Record<string, unknown> = {}) => ({
    id: 's1', abonado: 56335, legacyId: 20970, pppUsername: 'OSTILOCONTRERASROJAS',
    pppPassword: '74857070', pppProfile: '100Megas', pppService: 'pppoe',
    ipRemote: '10.100.11.4', ipLocal: '10.100.0.1', netComment: 'LA LIBERTAD 56335 VLAN 70',
    status: 'ACTIVO', installTech: 'GPON', branch: { legacyId: 7 }, ...extra,
  });

  const armar = () => {
    const enviado: { path: string; args: any }[] = [];
    const api = {
      comm: jest.fn(async (path: string, args: any) => {
        enviado.push({ path, args });
        return []; // ninguna address-list tiene nada
      }),
    };
    const prisma = { subscriber: { update: jest.fn().mockResolvedValue({}) } };
    const ips = { asignar: jest.fn(), confirmar: jest.fn(), liberar: jest.fn() };
    const svc = new MikrotikService(prisma as any, {} as any, ips as any);
    const resumen = {
      creados: 0, porCrear: 0, sinUsuarioReal: 0, perfilSinResolver: 0,
      posibleDuplicado: 0, ipDeFichaOcupada: 0, noSePudoCrear: 0, faltantes: [] as any[], muestra: [] as any[],
    };
    const parte = { creados: 0 };
    const correr = (sub: any, opts: Partial<{ crear: boolean; ipsUsadas: Set<string>; nombrePorIp: Map<string, string> }> = {}) =>
      (svc as any).altaDelQueFalta(api, sub, ROUTER, resumen, parte, {
        crear: opts.crear ?? true,
        ipsUsadas: opts.ipsUsadas ?? new Set<string>(),
        nombrePorIp: opts.nombrePorIp ?? new Map<string, string>(),
        perfiles: PERFILES,
      });
    const add = () => enviado.find((e) => e.path === '/ppp/secret/add')?.args;
    return { correr, resumen, parte, add, enviado, ips, prisma };
  };

  it('crea el secret con lo que dice la ficha', async () => {
    const { correr, resumen, parte, add } = armar();
    await correr(abonado());
    expect(resumen.creados).toBe(1);
    expect(parte.creados).toBe(1);
    expect(add()).toMatchObject({
      name: 'OSTILOCONTRERASROJAS',
      password: '74857070',
      profile: '*24', // el .id, nunca el nombre: por prefijo el router se equivoca
      service: 'pppoe',
      'remote-address': '10.100.11.4',
      'local-address': '10.100.0.1',
      comment: 'LA LIBERTAD 56335 VLAN 70',
    });
  });

  it('el cliente de TV no lleva secret: el name_s del legacy trae relleno', async () => {
    for (const relleno of ['0', '-', '', 'null']) {
      const { correr, resumen, add } = armar();
      await correr(abonado({ pppUsername: relleno }));
      expect(add()).toBeUndefined();
      expect(resumen.creados).toBe(0);
      expect(resumen.sinUsuarioReal).toBe(1);
      // No es un pendiente: no hay nada que arreglar en esa ficha.
      expect(resumen.faltantes).toHaveLength(0);
    }
  });

  it('no inventa el perfil: si la ficha dice "100" se apunta y no se crea', async () => {
    const { correr, resumen, add } = armar();
    await correr(abonado({ pppProfile: '100' }));
    expect(add()).toBeUndefined();
    expect(resumen.perfilSinResolver).toBe(1);
    expect(resumen.faltantes[0].motivo).toMatch(/ambiguo.*100Megas, 100MegasD, 100MegasSt/);
  });

  it('el perfil "-" heredado del legacy queda listado, no creado con otro', async () => {
    const { correr, resumen, add } = armar();
    await correr(abonado({ pppProfile: '-' }));
    expect(add()).toBeUndefined();
    expect(resumen.perfilSinResolver).toBe(1);
    expect(resumen.faltantes[0].motivo).toMatch(/no existe en el router/);
  });

  /**
   * El respaldo que destapa a los 620 que el barrido no podía dar de alta: las
   * fichas traen "-" o un número suelto del legacy, pero el PLAN contratado sí
   * guarda el nombre exacto del perfil del router.
   */
  describe('cuando el perfil de la ficha no sirve, manda el plan contratado', () => {
    for (const roto of ['-', '100', '', null]) {
      it(`ficha con ${JSON.stringify(roto)} → se crea con el perfil del plan`, async () => {
        const { correr, resumen, add } = armar();
        await correr(abonado({ pppProfile: roto, planPppProfile: '100Megas' }));
        expect(resumen.creados).toBe(1);
        expect(add()).toMatchObject({ profile: '*24' });
        expect(resumen.perfilSinResolver).toBe(0);
      });
    }

    it('la ficha manda mientras resuelva: no se le cambia la velocidad a quien ya la tiene', async () => {
      const { correr, add } = armar();
      await correr(abonado({ pppProfile: '100Megas', planPppProfile: '100MegasSt' }));
      expect(add()).toMatchObject({ profile: '*24' });
    });

    it('si el plan tampoco resuelve, se apunta el fallo de la FICHA (que es lo que hay que corregir)', async () => {
      const { correr, resumen, add } = armar();
      await correr(abonado({ pppProfile: '100', planPppProfile: '900Megas26F' }));
      expect(add()).toBeUndefined();
      expect(resumen.perfilSinResolver).toBe(1);
      expect(resumen.faltantes[0].motivo).toMatch(/el perfil "100" es ambiguo/);
    });

    /**
     * `default` existe en los ocho routers: si valiera de respaldo, cada ficha
     * rota se crearía a la velocidad de ese perfil y el problema quedaría tapado.
     */
    it('un perfil que la ficha pide y no existe NO se cae a default', async () => {
      const { correr, resumen, add } = armar();
      await correr(abonado({ pppProfile: '-', planPppProfile: null }));
      expect(add()).toBeUndefined();
      expect(resumen.perfilSinResolver).toBe(1);
    });

    it('la ficha vacía y sin plan sigue cayendo a default, como antes', async () => {
      const { correr, add } = armar();
      await correr(abonado({ pppProfile: '', planPppProfile: null }));
      expect(add()).toMatchObject({ profile: '*0' });
    });
  });

  /**
   * La IP de la ficha ya está en el router. Distinguir de quién es decide si el
   * abonado se queda sin internet o no: con el nombre casi igual es él mismo mal
   * escrito (no se duplica), con un nombre ajeno la ficha arrastra basura del
   * legacy y hay que darle de alta con una dirección libre.
   */
  describe('cuando su IP ya la tiene otro secret', () => {
    it('si el otro es su mismo nombre mal escrito, NO se duplica', async () => {
      const { correr, resumen, add } = armar();
      await correr(abonado({ pppUsername: 'MIRIAMCUBIDESCUESTA' }), {
        ipsUsadas: new Set(['10.100.11.4']),
        nombrePorIp: new Map([['10.100.11.4', 'MIRAMCUBIDESCUESTA']]),
      });
      expect(add()).toBeUndefined();
      expect(resumen.posibleDuplicado).toBe(1);
      expect(resumen.faltantes[0].motivo).toMatch(/nombre mal escrito/);
    });

    it('si el otro es un abonado distinto, se le da de alta con una IP libre', async () => {
      const { correr, resumen, add, ips } = armar();
      ips.asignar.mockResolvedValue({ ip: '10.100.11.90', libres: 500 });
      await correr(abonado(), {
        ipsUsadas: new Set(['10.100.11.4']),
        nombrePorIp: new Map([['10.100.11.4', 'CARLOSJULIOLESMESMELO']]),
      });
      expect(resumen.creados).toBe(1);
      expect(resumen.ipDeFichaOcupada).toBe(1);
      expect(resumen.posibleDuplicado).toBe(0);
      expect(add()['remote-address']).toBe('10.100.11.90');
    });
  });

  it('el secret de un cortado nace en MOROSOS: crearlo no le devuelve el mes', async () => {
    const { correr, enviado, add } = armar();
    await correr(abonado({ status: 'CARTERA' }));
    expect(add()).toBeDefined();
    const marca = enviado.find((e) => e.path === '/ip/firewall/address-list/add');
    expect(marca?.args).toMatchObject({ address: '10.100.11.4', list: 'MOROSOS', comment: 'activo_20970' });
  });

  it('el de un abonado al día nace limpio', async () => {
    const { correr, enviado } = armar();
    await correr(abonado({ status: 'ACTIVO' }));
    expect(enviado.some((e) => e.path === '/ip/firewall/address-list/add')).toBe(false);
  });

  it('modo informe: dice quién está listo sin escribir nada en el router', async () => {
    const { correr, resumen, add } = armar();
    await correr(abonado(), { crear: false });
    expect(add()).toBeUndefined();
    expect(resumen.porCrear).toBe(1);
    expect(resumen.faltantes[0].motivo).toBe('listo para dar de alta');
  });

  it('sin IP en la ficha se le reparte una libre y se guarda en la ficha', async () => {
    const { correr, add, ips, prisma } = armar();
    ips.asignar.mockResolvedValue({ ip: '10.100.11.28', libres: 2333 });
    await correr(abonado({ ipRemote: null }));
    expect(add()['remote-address']).toBe('10.100.11.28');
    expect(ips.confirmar).toHaveBeenCalled();
    // `editedAt` o el sync del legacy devuelve la IP vieja a los 15 minutos.
    expect(prisma.subscriber.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ ipRemote: '10.100.11.28', editedAt: expect.any(Date) }) }),
    );
  });

  it('si el router rechaza el alta se suelta la IP reservada, no se quema', async () => {
    const enviado: any[] = [];
    const api = {
      comm: jest.fn(async (path: string) => {
        if (path === '/ppp/secret/add') throw new Error('failure: already have secret with the same name');
        enviado.push(path);
        return [];
      }),
    };
    const ips = { asignar: jest.fn().mockResolvedValue({ ip: '10.100.11.28', libres: 10 }), confirmar: jest.fn(), liberar: jest.fn() };
    const svc = new MikrotikService({ subscriber: { update: jest.fn() } } as any, {} as any, ips as any);
    const resumen = { creados: 0, porCrear: 0, sinUsuarioReal: 0, perfilSinResolver: 0, posibleDuplicado: 0, ipDeFichaOcupada: 0, noSePudoCrear: 0, faltantes: [] as any[], muestra: [] as any[] };
    await (svc as any).altaDelQueFalta(api, abonado({ ipRemote: null }), ROUTER, resumen, { creados: 0 }, {
      crear: true, ipsUsadas: new Set<string>(), nombrePorIp: new Map<string, string>(), perfiles: PERFILES,
    });
    expect(resumen.noSePudoCrear).toBe(1);
    expect(ips.liberar).toHaveBeenCalledWith(ROUTER, '10.100.11.28');
    expect(ips.confirmar).not.toHaveBeenCalled();
    expect(resumen.faltantes[0].motivo).toMatch(/already have secret/);
  });
});

/**
 * Reconectar a quien no tiene secret no era reconectar nada.
 *
 * El cliente pagaba, la cajera veía "reconexión aplicada" —porque la primitiva
 * devolvía `ok: true` con una línea que decía "no existe en el router"— y el
 * abonado seguía sin internet. Es la fuga viva del problema: los otros 1.681 son
 * herencia del legacy, éste se produce todos los días.
 */
describe('MikrotikService · reconectar a quien no tiene secret lo da de alta', () => {
  const PERFILES = [{ id: '*24', name: '100Megas' }];
  const ROUTER = { id: 'r1', name: 'ip_tauramena', ip: '10.0.0.1', port: '5051' } as any;
  const SUB = {
    id: 's1', legacyId: 20970, pppUsername: 'OSTILOCONTRERASROJAS', pppPassword: '74857070',
    pppProfile: '100Megas', pppService: 'pppoe', ipRemote: '10.100.11.4', ipLocal: '10.100.0.1',
    netComment: 'LA LIBERTAD', status: 'CORTADO', installTech: 'GPON', branch: { legacyId: 7 },
  } as any;

  const armar = (opts: { conSecret: boolean }) => {
    const enviado: { path: string; args: any }[] = [];
    const api = {
      comm: jest.fn(async (path: string, args: any) => {
        enviado.push({ path, args });
        if (path === '/ppp/secret/getall') {
          return opts.conSecret ? [{ '.id': '*1', name: SUB.pppUsername, 'remote-address': '10.100.11.4', disabled: 'false' }] : [];
        }
        if (path === '/ppp/profile/getall') return [{ '.id': '*24', name: '100Megas' }];
        return [];
      }),
    };
    const svc = new MikrotikService({ subscriber: { update: jest.fn() } } as any, {} as any, { asignar: jest.fn(), confirmar: jest.fn(), liberar: jest.fn() } as any);
    return { api, enviado, correr: () => (svc as any).reconnectOnApi(api, SUB, ROUTER) };
  };

  it('sin secret: lo crea y la reconexión sale bien de verdad', async () => {
    const { correr, enviado } = armar({ conSecret: false });
    const r = await correr();
    expect(r.ok).toBe(true);
    expect(enviado.find((e) => e.path === '/ppp/secret/add')?.args).toMatchObject({
      name: 'OSTILOCONTRERASROJAS', profile: '*24', 'remote-address': '10.100.11.4',
    });
    // Y termina el trabajo: fuera de MOROSOS y dentro de ACTIVOS.
    expect(enviado.some((e) => e.path === '/ip/firewall/address-list/add' && e.args.list === 'ACTIVOS')).toBe(true);
  });

  it('si la ficha no da para crearlo, la reconexión FALLA y dice por qué', async () => {
    const enviado: any[] = [];
    const api = {
      comm: jest.fn(async (path: string) => {
        enviado.push(path);
        if (path === '/ppp/profile/getall') return [{ '.id': '*24', name: '100Megas' }, { '.id': '*25', name: '100MegasD' }];
        return [];
      }),
    };
    const svc = new MikrotikService({} as any, {} as any, {} as any);
    const r = await (svc as any).reconnectOnApi(api, { ...SUB, pppProfile: '100' }, ROUTER);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no existía el secret .* y no se pudo crear.*ambiguo/s);
    expect(enviado).not.toContain('/ppp/secret/add');
  });

  it('con secret no toca nada del alta: sigue siendo una reconexión normal', async () => {
    const { correr, enviado } = armar({ conSecret: true });
    const r = await correr();
    expect(r.ok).toBe(true);
    expect(enviado.some((e) => e.path === '/ppp/secret/add')).toBe(false);
  });
});

/**
 * El umbral que decide si dos secrets son la misma persona. Es una heurística,
 * así que se fija con los pares REALES del router: las erratas de tecleo de años
 * de altas a mano, y nombres distintos que comparten una IP mal apuntada.
 */
describe('esElMismoNombre · errata de tecleo contra abonado distinto', () => {
  const mismos: [string, string][] = [
    ['MIRIAMCUBIDESCUESTA', 'MIRAMCUBIDESCUESTA'],          // falta una I
    ['EPIMENIAVEGADEBUITRAGO2', 'EPIMENIAVEGABUITRAGO2'],   // falta el DE
    ['JOSERUBENGONZALESGUTIERREZ', 'JOSERUBENGONZALEZGUTIERREZ'], // S/Z
    ['LUISORLANDORICAUTEPEREZ', 'luis orlando ricaute perez'], // espacios y minúsculas
  ];
  const distintos: [string, string][] = [
    ['MARIAALEJANDRAARENASBOLANOS', 'CARLOSJULIOLESMESMELO'],
    ['OSTILOCONTRERASROJAS', 'KARENLUCEROPEREZBURGOS2'],
    ['ANALUCIASANCHEZAVILA', 'ANALUCINDAGAMEZRODRIGUEZ'],   // empiezan igual y NO lo son
  ];

  for (const [a, b] of mismos) {
    it(`${a} ≡ ${b}`, () => expect(esElMismoNombre(a, b)).toBe(true));
  }
  for (const [a, b] of distintos) {
    it(`${a} ≠ ${b}`, () => expect(esElMismoNombre(a, b)).toBe(false));
  }

  it('un nombre corto no se da por igual por una letra: ahí sí puede ser otro', () => {
    expect(esElMismoNombre('ANAROA', 'ANAROJA')).toBe(false);
  });

  it('vacío nunca es igual a nada', () => {
    expect(esElMismoNombre('', 'OSTILOCONTRERASROJAS')).toBe(false);
  });
});

/**
 * Una sede tiene varios equipos y al abonado se le busca sólo en el que le toca
 * por `installTech`. Cuando esa tecnología está mal, su secret vive en el otro y
 * el barrido lo daba por ausente: le habría creado un segundo secret con la
 * misma IP en otra caja. Lo que hay que arreglar ahí es la ficha.
 */
describe('MikrotikService · el que ya está en otro equipo de su sede no se duplica', () => {
  const ROUTER = { id: 'r1', name: 'Ip_Villanueva_EPON', ip: '1.1.1.1', port: '5000' } as any;

  const correr = async (enLaSede?: Map<string, string>) => {
    const enviado: any[] = [];
    const api = { comm: jest.fn(async (path: string, args: any) => { enviado.push({ path, args }); return []; }) };
    const svc = new MikrotikService({ subscriber: { update: jest.fn() } } as any, {} as any, { asignar: jest.fn(), confirmar: jest.fn(), liberar: jest.fn() } as any);
    const resumen = {
      creados: 0, porCrear: 0, sinUsuarioReal: 0, perfilSinResolver: 0, posibleDuplicado: 0,
      ipDeFichaOcupada: 0, enOtroEquipoDeLaSede: 0, noSePudoCrear: 0, faltantes: [] as any[], muestra: [] as any[],
    };
    await (svc as any).altaDelQueFalta(
      api,
      { id: 's1', abonado: 57347, legacyId: 1, pppUsername: 'ELISABETHRODRIGUEZSANABRIA', pppProfile: '300MegasSt',
        ipRemote: '80.0.9.232', status: 'ACTIVO', installTech: 'EPON', branch: { legacyId: 3 } },
      ROUTER, resumen, { creados: 0 },
      { crear: true, ipsUsadas: new Set<string>(), nombrePorIp: new Map<string, string>(),
        perfiles: [{ id: '*9', name: '300MegasSt' }], enLaSede },
    );
    return { resumen, add: enviado.find((e) => e.path === '/ppp/secret/add')?.args };
  };

  it('si su nombre está en el equipo hermano, no se crea y se dice qué ficha corregir', async () => {
    const { resumen, add } = await correr(new Map([['elisabethrodriguezsanabria', 'Ip_Villanueva_GPON']]));
    expect(add).toBeUndefined();
    expect(resumen.creados).toBe(0);
    expect(resumen.enOtroEquipoDeLaSede).toBe(1);
    expect(resumen.faltantes[0].motivo).toMatch(/ya existe en Ip_Villanueva_GPON.*EPON/);
  });

  it('si no está en ningún equipo de la sede, se crea normalmente', async () => {
    const { resumen, add } = await correr(new Map());
    expect(add).toMatchObject({ name: 'ELISABETHRODRIGUEZSANABRIA', profile: '*9' });
    expect(resumen.creados).toBe(1);
  });

  it('sin censo de la sede (un equipo no respondió) se sigue pudiendo dar de alta', async () => {
    const { resumen } = await correr(undefined);
    expect(resumen.creados).toBe(1);
  });
});

describe('ipLocalDeLaRed · la IP local del secret que nace', () => {
  const s = (remota: string, local: string) => ({ 'remote-address': remota, 'local-address': local });

  it('toma la más usada en el /24 de su IP remota (Tauramena mezcla por red)', () => {
    const router = [
      s('10.100.12.4', '10.1.100.1'), s('10.100.12.5', '10.1.100.1'), s('10.100.12.6', '10.100.0.1'),
      s('10.100.11.4', '10.100.0.1'), s('10.100.11.5', '10.100.0.1'), s('10.100.11.6', '10.100.0.1'),
    ];
    expect(ipLocalDeLaRed(router, '10.100.12.50')).toBe('10.1.100.1');
    expect(ipLocalDeLaRed(router, '10.100.11.50')).toBe('10.100.0.1');
  });

  it('ignora los vacíos y, si su red no tiene ninguna, usa la del router', () => {
    const router = [s('10.100.12.4', ''), s('10.20.0.4', '10.1.100.1'), s('10.20.0.5', '10.1.100.1')];
    expect(ipLocalDeLaRed(router, '10.100.12.50')).toBe('10.1.100.1');
    expect(ipLocalDeLaRed(router, null)).toBe('10.1.100.1');
    expect(ipLocalDeLaRed([s('10.100.12.4', '')], '10.100.12.50')).toBeNull();
  });
});
