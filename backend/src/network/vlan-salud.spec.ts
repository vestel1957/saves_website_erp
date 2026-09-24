import {
  comandosOltParaVlan, detalleVlanDeSalida, vlansDePuertoDeRedDeSalida, vlansDeSalida, vlansPorPuertoDeSalida,
} from './olt/olt-huawei.driver';
import {
  lecturaMikrotikDeFilas, planMikrotikParaVlan, routerDeLaOlt, saludDeVlans, sugerirVlanParaPuerto,
  uplinkHabitual, interfazHaciaOlt, pasoRouterOsComoTexto, type LecturaOltVlans,
} from './vlan-salud';

/**
 * VLANs de punta a punta (2026-09-23). La 590 de Villanueva existía en la OLT
 * y en el Mikrotik pero no en el uplink: la ONU en línea, la clienta sin
 * internet. Las salidas de aquí son recortes REALES de las OLT VILLANUEVA y
 * MONTERREY y del Mikrotik Ip_Villanueva_GPON, leídos esa noche solo con
 * `display` / `print` (ver trabajos-nocturnos/vlans-2026-09-23/salida).
 */

// `display vlan all` de VILLANUEVA (recorte). La paginación deja líneas sin
// sangría ("300   smart…"): tienen que parsear igual.
const VLAN_ALL = `display vlan all
  -----------------------------------------------------------------------
  VLAN   Type      Attribute  STND-Port NUM   SERV-Port NUM  VLAN-Con NUM
  -----------------------------------------------------------------------
     1   smart     common                 8               0             -
     6   smart     common                 1               0             -
   102   smart     common                 0               6             -
   110   smart     common                 3              56             -

300   smart     common                 1              34             -
   570   smart     common                 1              15             -
   580   smart     common                 1               5             -
   590   smart     common                 1               1             -
   600   smart     common                 1              17             -
  1010   smart     common                 0               0             -
  -----------------------------------------------------------------------
  Total: 52
  Note : STND-Port--standard port, SERV-Port--service virtual port,
         VLAN-Con--vlan-connect`;

const VLAN_1 = `display vlan 1
  VLAN ID: 1
  VLAN name: VLAN_0001
  VLAN type: smart
  VLAN attribute: common
  VLAN priority: -
  -------------------------------
   F /S /P     Native VLAN  State
  -------------------------------
   0 /7 /0               1  down
   0 /7 /1               1  down
   0 /7 /2               1  down
   0 /7 /3               1  down
   0 /8 /0               1  up
   0 /8 /1               1  down
   0 /9 /0               1  down

0 /9 /1               1  down
  -------------------------------
  Standard port number: 8
  Service virtual port number: 0`;

const VLAN_590 = `display vlan 590
  VLAN ID: 590
  VLAN name: VLAN_0590
  VLAN type: smart
  VLAN attribute: common
  VLAN priority: -
  -------------------------------
   F /S /P     Native VLAN  State
  -------------------------------
   0 /8 /0               1  up
  -------------------------------
  Standard port number: 1
  ---------------------------------------------------------------------------
   INDEX  TYPE  STATE F /S /P   VPI  VCI   FLOWTYPE FLOWPARA   CVLAN
  ---------------------------------------------------------------------------
    3040  gpon  up    0 /2 /13  1    1     vlan     590        -

---------------------------------------------------------------------------
  Service virtual port number: 1`;

/** La 102: seis service-ports (GEM 2) y ningún puerto de red. */
const VLAN_102 = `display vlan 102
  VLAN ID: 102
  VLAN name: VLAN_0102
  VLAN type: smart
  VLAN attribute: common
  VLAN priority: -
  Standard port number: 0
  ---------------------------------------------------------------------------
   INDEX  TYPE  STATE F /S /P   VPI  VCI   FLOWTYPE FLOWPARA   CVLAN
  ---------------------------------------------------------------------------
    2078  gpon  up    0 /0 /14  102  2     vlan     102        -
    2131  gpon  up    0 /0 /2   34   2     vlan     102        -
  ---------------------------------------------------------------------------
  Service virtual port number: 6`;

const PORT_VLAN_080 = `---------------------------------------
     1      6    101    103    110    120
   130    140    150    160    170    180
   190    200    210    220    230    240
   250    300    310    320    330    340
   350    360    370    380    390    400
   410    420    430    440    450    460
   470    480    490    500    510    520
   530    540    550    560    570    580
   590    600
  ---------------------------------------
  Total: 50
  Native VLAN: 1`;

const PORT_VLAN_081 = `---------------------------------------
     1    110
  ---------------------------------------
  Total: 2
  Native VLAN: 1`;

const SERVICE_PORTS = `
   INDEX VLAN VLAN     PORT F/ S/ P VPI  VCI   FLOW  FLOW       RX   TX   STATE
         ID   ATTR     TYPE                    TYPE  PARA
  -----------------------------------------------------------------------------
      66  570 common   gpon 0/2 /11 0    1     vlan  570        37   47   up
      73  580 common   gpon 0/2 /12 1    1     vlan  580        55   58   up
     294  580 common   gpon 0/2 /12 2    1     vlan  580        9    9    up
    3040  590 common   gpon 0/2 /13 1    1     vlan  590        37   47   up
     533  600 common   gpon 0/2 /14 0    1     vlan  600        46   39   up
     534  600 common   gpon 0/2 /14 1    1     vlan  600        46   39   up
     300  300 common   gpon 0/1 /0  4    1     vlan  300        46   39   up
    2078  102 common   gpon 0/0 /14 102  2     vlan  102        7    7    up
  -----------------------------------------------------------------------------`;

/** `/interface/vlan/print` y `/interface/pppoe-server/server/print` de Ip_Villanueva_GPON (recorte). */
const MK_VLANS = [
  { '.id': '*3F', name: 'vlan570', 'vlan-id': '570', interface: 'sfp-sfpplus2_OLT', running: 'true', disabled: 'false' },
  { '.id': '*40', name: 'vlan580', 'vlan-id': '580', interface: 'sfp-sfpplus2_OLT', running: 'true', disabled: 'false' },
  { '.id': '*43', name: 'vlan590', 'vlan-id': '590', interface: 'sfp-sfpplus2_OLT', running: 'true', disabled: 'false' },
  { '.id': '*44', name: 'vlan600', 'vlan-id': '600', interface: 'sfp-sfpplus2_OLT', running: 'true', disabled: 'false' },
  { '.id': '*20', name: 'vlan300', 'vlan-id': '300', interface: 'sfp-sfpplus2_OLT', running: 'true', disabled: 'false' },
  { '.id': '*21', name: 'vlan110', 'vlan-id': '110', interface: 'sfp-sfpplus2_OLT', running: 'true', disabled: 'false' },
];
const pppoe = (id: string, servicio: string, iface: string) => ({
  '.id': id, 'service-name': servicio, interface: iface, 'max-mtu': 'auto', 'max-mru': 'auto', mrru: 'disabled',
  authentication: 'pap,chap,mschap1,mschap2', 'keepalive-timeout': '10', 'one-session-per-host': 'false',
  'max-sessions': 'unlimited', 'pado-delay': '0', 'default-profile': 'default', 'pppoe-over-vlan-range': '',
  'accept-untagged': 'true', invalid: 'false', disabled: 'false',
});
const MK_PPPOE = [
  pppoe('*54', 'pppoe570', 'vlan570'), pppoe('*55', 'pppoe_580', 'vlan580'), pppoe('*57', 'pppoe590', 'vlan590'),
  pppoe('*58', 'pppoe600', 'vlan600'), pppoe('*30', 'pppoe300', 'vlan300'), pppoe('*31', 'pppoe110', 'vlan110'),
];

function lecturaVillanueva(portVlan080 = PORT_VLAN_080): LecturaOltVlans {
  return {
    vlans: vlansDeSalida(VLAN_ALL),
    puertosDeRed: detalleVlanDeSalida(1, VLAN_1).uplinks.map((u) => ({ fsp: u.fsp, estado: u.estado })),
    vlansPorPuertoDeRed: {
      '0/8/0': vlansDePuertoDeRedDeSalida(portVlan080),
      '0/8/1': vlansDePuertoDeRedDeSalida(PORT_VLAN_081),
    },
    puertos: vlansPorPuertoDeSalida(SERVICE_PORTS),
  };
}
const routerVillanueva = () => lecturaMikrotikDeFilas('mk1', 'Ip_Villanueva_GPON', MK_VLANS, MK_PPPOE);
const CATALOGO = [
  { id: 'c570', vlan: 570, detail: 'BELLO AMANECER', tray: 2, oltPort: 11, oltId: 'olt-v' },
  { id: 'c580', vlan: 580, detail: 'Brisas del Aguaclara', tray: 2, oltPort: 12, oltId: 'olt-v' },
  { id: 'c590', vlan: 590, detail: 'VILLA CAMPESTRE 3', tray: 2, oltPort: 13, oltId: 'olt-v' },
  { id: 'c300', vlan: 300, detail: 'Centro', tray: 1, oltPort: 0, oltId: null },
  { id: 'c110', vlan: 110, detail: 'cabecera', tray: 0, oltPort: 1, oltId: 'olt-v' },
  // Heredada sin OLT que esta OLT no tiene: no se juzga aquí.
  { id: 'c20', vlan: 20, detail: 'Cra 11 36', tray: null, oltPort: null, oltId: null },
];

describe('parsers de VLAN de la OLT Huawei (salidas reales)', () => {
  it('display vlan all: todas las filas, también las que la paginación deja sin sangría', () => {
    const v = vlansDeSalida(VLAN_ALL);
    expect(v.map((x) => x.vlan)).toEqual([1, 6, 102, 110, 300, 570, 580, 590, 600, 1010]);
    expect(v.find((x) => x.vlan === 102)).toEqual({ vlan: 102, tipo: 'smart', atributo: 'common', estandar: 0, servicePorts: 6 });
    expect(v.find((x) => x.vlan === 300)?.servicePorts).toBe(34);
  });

  it('display vlan N: puertos de red con su estado, sin confundirlos con los service-ports', () => {
    expect(detalleVlanDeSalida(590, VLAN_590)).toEqual({
      vlan: 590, existe: true, tipo: 'smart', uplinks: [{ fsp: '0/8/0', nativa: 1, estado: 'up' }], servicePorts: 1,
    });
    const d102 = detalleVlanDeSalida(102, VLAN_102);
    expect(d102.uplinks).toEqual([]);
    expect(d102.servicePorts).toBe(6);
    expect(detalleVlanDeSalida(1, VLAN_1).uplinks.map((u) => `${u.fsp}:${u.estado}`)).toEqual([
      '0/7/0:down', '0/7/1:down', '0/7/2:down', '0/7/3:down', '0/8/0:up', '0/8/1:down', '0/9/0:down', '0/9/1:down',
    ]);
  });

  it('display vlan N de una VLAN que no existe', () => {
    const d = detalleVlanDeSalida(9999, 'display vlan 9999\n  Failure: VLAN list parameter error');
    expect(d.existe).toBe(false);
    expect(d.uplinks).toEqual([]);
  });

  it('display port vlan: la lista de VLANs del puerto de red', () => {
    const v = vlansDePuertoDeRedDeSalida(PORT_VLAN_080);
    expect(v).toHaveLength(50);
    expect(v).toContain(590);
    expect(vlansDePuertoDeRedDeSalida(PORT_VLAN_081)).toEqual([1, 110]);
  });
});

describe('salud de VLANs (catálogo + OLT + uplink + Mikrotik)', () => {
  it('Villanueva hoy: 590 OK en los cuatro sitios; 102 ROTA; 600 funciona pero falta en el catálogo', () => {
    const filas = saludDeVlans({ oltId: 'olt-v', lectura: lecturaVillanueva(), router: routerVillanueva(), catalogo: CATALOGO });
    const f = (n: number) => filas.find((x) => x.vlan === n)!;
    expect(f(590).estado).toBe('OK');
    expect(f(590).pon.principal).toEqual(['0/2/13']);
    expect(f(590).mikrotik).toMatchObject({ interfaz: 'vlan590', sobre: 'sfp-sfpplus2_OLT', pppoe: true, ok: true });
    expect(f(102).estado).toBe('ROTA');
    expect(f(102).falta).toEqual(expect.arrayContaining([
      'no sale por el uplink de la OLT', 'falta la interfaz VLAN en el Mikrotik Ip_Villanueva_GPON',
    ]));
    expect(f(600).estado).toBe('SIN_CATALOGO');
    expect(f(1010).estado).toBe('SIN_USO');
    // La 110 también sale por 0/8/1 (caído): con 0/8/0 arriba basta.
    expect(f(110).estado).toBe('OK');
    // La heredada 300 (sin OLT ligada) cuenta porque la OLT la tiene; la 20 no.
    expect(f(300).estado).toBe('OK');
    expect(filas.find((x) => x.vlan === 20)).toBeUndefined();
    expect(filas.find((x) => x.vlan === 1)).toBeUndefined();
  });

  it('la 590 del 22-sep (sin port vlan en 0/8/0): ROTA por el uplink, y el plan es SOLO `port vlan 590 0/8 0`', () => {
    const sin590 = PORT_VLAN_080.replace('   590    600', '   600');
    const l = lecturaVillanueva(sin590);
    const filas = saludDeVlans({ oltId: 'olt-v', lectura: l, router: routerVillanueva(), catalogo: CATALOGO });
    const f = filas.find((x) => x.vlan === 590)!;
    expect(f.estado).toBe('ROTA');
    expect(f.falta).toEqual(['no sale por el uplink de la OLT']);
    expect(f.mikrotik?.ok).toBe(true);

    const hab = uplinkHabitual(l);
    expect(hab).toMatchObject({ fsp: '0/8/0', ambiguo: false });
    expect(comandosOltParaVlan({ vlan: 590, crear: false, uplink: hab.fsp })).toEqual(['port vlan 590 0/8 0']);
    expect(planMikrotikParaVlan(routerVillanueva(), 590, 'sfp-sfpplus2_OLT').pasos).toEqual([]);
  });

  it('sin Mikrotik leído: no se da por bueno ese tramo, se dice por qué', () => {
    const filas = saludDeVlans({ oltId: 'olt-v', lectura: lecturaVillanueva(), router: null, routerError: 'Mikrotik en dry-run', catalogo: CATALOGO });
    const f = filas.find((x) => x.vlan === 590)!;
    expect(f.mikrotik).toBeNull();
    expect(f.falta).toEqual(['Mikrotik sin revisar: Mikrotik en dry-run']);
    expect(f.estado).toBe('OK'); // la OLT está bien; el aviso viaja en `falta`
  });

  it('el router de la OLT se deduce por las VLANs que tiene, no por la tabla', () => {
    const vacio = lecturaMikrotikDeFilas('mk2', 'Ip_Villanueva_EOC', [], [pppoe('*1', 'service1', 'ether8')]);
    expect(routerDeLaOlt(lecturaVillanueva(), [vacio, routerVillanueva()])?.name).toBe('Ip_Villanueva_GPON');
    expect(interfazHaciaOlt(lecturaVillanueva(), routerVillanueva(), '0/8/0')).toBe('sfp-sfpplus2_OLT');
  });
});

describe('Monterrey: dos uplinks → hay que elegir', () => {
  // `display vlan 1` real de MONTERREY y las VLANs de cada uplink (de sus `display vlan N`).
  const l: LecturaOltVlans = {
    vlans: [101, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250, 260, 270, 280, 290, 300, 310, 320]
      .map((vlan) => ({ vlan, tipo: 'smart', atributo: 'common', estandar: 1, servicePorts: 40 }))
      .concat([{ vlan: 330, tipo: 'smart', atributo: 'common', estandar: 0, servicePorts: 0 }]),
    puertosDeRed: detalleVlanDeSalida(1, `  -------------------------------
   F /S /P     Native VLAN  State
  -------------------------------
   0 /3 /0               1  up
   0 /3 /1               1  up
   0 /3 /2               1  down
   0 /3 /3               1  up
  -------------------------------`).uplinks.map((u) => ({ fsp: u.fsp, estado: u.estado })),
    vlansPorPuertoDeRed: {
      '0/3/0': [1, 6, 101, 140, 150, 190, 200, 210, 220, 230, 240, 250, 260, 270, 280, 290, 310, 320],
      '0/3/1': [1],
      '0/3/2': [1],
      '0/3/3': [1, 110, 120, 130, 160, 170, 180, 300],
    },
    puertos: [],
  };
  const router = lecturaMikrotikDeFilas('mkm', 'ip_Monterrey',
    [
      { name: 'vlan101', 'vlan-id': '101', interface: 'sfp-sfpplus2', disabled: 'false', running: 'true' },
      { name: 'vlan140', 'vlan-id': '140', interface: 'sfp-sfpplus2', disabled: 'false', running: 'true' },
      { name: 'vlan110', 'vlan-id': '110', interface: 'ether2', disabled: 'false', running: 'true' },
      { name: 'vlan120', 'vlan-id': '120', interface: 'ether2', disabled: 'false', running: 'true' },
      { name: 'vlan320', 'vlan-id': '320', interface: 'sfp-sfpplus2', disabled: 'false', running: 'true' },
      { name: 'AZTECA', 'vlan-id': '148', interface: 'sfp-sfpplus2', disabled: 'true', running: 'false' },
    ],
    [pppoe('*24', 'service24', 'vlan320'), pppoe('*3', 'service3', 'vlan110')],
  );

  it('uplink ambiguo (16 contra 7): no se elige solo', () => {
    const h = uplinkHabitual(l);
    expect(h.fsp).toBeNull();
    expect(h.ambiguo).toBe(true);
    expect(h.candidatos.map((c) => `${c.fsp}:${c.vlans}`)).toEqual(['0/3/0:16', '0/3/3:7']);
  });

  it('cada uplink casa con su puerto del Mikrotik', () => {
    expect(interfazHaciaOlt(l, router, '0/3/0')).toBe('sfp-sfpplus2');
    expect(interfazHaciaOlt(l, router, '0/3/3')).toBe('ether2');
  });

  it('la 330 (creada, sin uplink): plan de Mikrotik copiando al hermano más cercano del mismo puerto', () => {
    const plan = planMikrotikParaVlan(router, 330, 'sfp-sfpplus2');
    expect(plan.avisos).toEqual([]);
    expect(plan.pasos.map(pasoRouterOsComoTexto)).toEqual([
      '/interface/vlan add name=vlan330 vlan-id=330 interface=sfp-sfpplus2',
      // "service24" no lleva el número de su VLAN → nombre neutro pppoe330.
      '/interface/pppoe-server/server add interface=vlan330 service-name=pppoe330 default-profile=default '
        + 'authentication="pap,chap,mschap1,mschap2" one-session-per-host=false max-mtu=auto max-mru=auto '
        + 'mrru=disabled keepalive-timeout=10 max-sessions=unlimited pado-delay=0',
    ]);
  });
});

describe('plan de Mikrotik: solo agrega, nunca toca lo que hay', () => {
  it('VLAN nueva 610 en Villanueva: nombre y PPPoE copiados de la 600', () => {
    const plan = planMikrotikParaVlan(routerVillanueva(), 610, 'sfp-sfpplus2_OLT');
    expect(plan.nombre).toBe('vlan610');
    expect(plan.pasos[0]).toEqual({ cmd: '/interface/vlan/add', params: { name: 'vlan610', 'vlan-id': '610', interface: 'sfp-sfpplus2_OLT' } });
    expect(plan.pasos[1].cmd).toBe('/interface/pppoe-server/server/add');
    expect(plan.pasos[1].params).toMatchObject({ interface: 'vlan610', 'service-name': 'pppoe610', 'one-session-per-host': 'false', 'default-profile': 'default' });
  });

  it('interfaz ya existente sobre OTRO puerto: no se toca, se avisa', () => {
    const r = lecturaMikrotikDeFilas('y', 'Yopal',
      [{ name: 'vlan185', 'vlan-id': '185', interface: 'sfp-sfpplus4', disabled: 'false', running: 'true' }],
      [pppoe('*64', 'service64', 'vlan185')]);
    const plan = planMikrotikParaVlan(r, 185, 'sfp-sfpplus2');
    expect(plan.pasos).toEqual([]);
    expect(plan.avisos[0]).toMatch(/sobre sfp-sfpplus4, no sobre sfp-sfpplus2/);
  });

  it('interfaz deshabilitada: se avisa y no se habilita', () => {
    const r = lecturaMikrotikDeFilas('m', 'ip_Monterrey',
      [{ name: 'AZTECA', 'vlan-id': '148', interface: 'sfp-sfpplus2', disabled: 'true', running: 'false' }], []);
    const plan = planMikrotikParaVlan(r, 148, 'sfp-sfpplus2');
    expect(plan.pasos.every((p) => p.cmd !== '/interface/vlan/add')).toBe(true);
    expect(plan.avisos.join(' ')).toMatch(/deshabilitada/);
  });

  it('sin puerto hacia la OLT conocido: no inventa', () => {
    expect(planMikrotikParaVlan(routerVillanueva(), 777, null)).toMatchObject({ pasos: [], nombre: null });
  });
});

describe('comandos de OLT', () => {
  it('crear + uplink, solo uplink, nada', () => {
    expect(comandosOltParaVlan({ vlan: 610, crear: true, uplink: '0/8/0' })).toEqual(['vlan 610 smart', 'port vlan 610 0/8 0']);
    expect(comandosOltParaVlan({ vlan: 185, crear: false, uplink: '0/9/0' })).toEqual(['port vlan 185 0/9 0']);
    expect(comandosOltParaVlan({ vlan: 600, crear: false, uplink: null })).toEqual([]);
  });
  it('rechaza números y uplinks raros (nada de inyectar comandos)', () => {
    expect(() => comandosOltParaVlan({ vlan: 1, crear: true, uplink: null })).toThrow();
    expect(() => comandosOltParaVlan({ vlan: 5000, crear: true, uplink: null })).toThrow();
    expect(() => comandosOltParaVlan({ vlan: 610, crear: false, uplink: '0/8/0; undo vlan 600' })).toThrow();
  });
});

describe('sugerir VLAN para un PON sin VLAN', () => {
  const puertos = vlansPorPuertoDeSalida(SERVICE_PORTS);
  it('Villanueva 0/2/15 → 610 (460 + puerto·10)', () => {
    const s = sugerirVlanParaPuerto(puertos, 0, 2, 15, { olt: [570, 580, 590, 600], catalogo: [570, 580, 590] });
    expect(s).toEqual({ vlan: 610, motivo: 'patrón de la tarjeta 0/2: 460 + puerto·10' });
  });
  it('0/2/13 antes de su primer cliente: la 590 ya creada pero vacía SÍ se sugiere', () => {
    const sinClientes = puertos.filter((p) => !(p.slot === 2 && p.port === 13));
    expect(sugerirVlanParaPuerto(sinClientes, 0, 2, 13, { olt: [570, 580, 600], catalogo: [] }).vlan).toBe(590);
  });
  it('un puerto con clientes ya tiene su VLAN: se devuelve esa', () => {
    expect(sugerirVlanParaPuerto(puertos, 0, 2, 13, { olt: [570, 580, 590, 600], catalogo: [] }))
      .toEqual({ vlan: 590, motivo: 'el puerto 0/2/13 ya usa la 590' });
  });
  it('si el número ya lo usan clientes o el catálogo, no se propone', () => {
    expect(sugerirVlanParaPuerto(puertos, 0, 2, 15, { olt: [610], catalogo: [] }).vlan).toBeNull();
    expect(sugerirVlanParaPuerto(puertos, 0, 2, 15, { olt: [], catalogo: [610] }).vlan).toBeNull();
  });
  it('tarjeta sin patrón suficiente: no adivina', () => {
    expect(sugerirVlanParaPuerto(puertos, 0, 1, 5, { olt: [], catalogo: [] }).vlan).toBeNull();
  });
});
