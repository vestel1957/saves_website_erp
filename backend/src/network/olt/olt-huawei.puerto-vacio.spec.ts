import { OltHuawei, perfilesParaPuertoVacio, puertosAjenosConVlan } from './olt-huawei.driver';

/**
 * PRIMER alta de un puerto PON (2026-09-22). En VILLANUEVA el traslado 506510
 * cayó en 0/2/13, que no tenía ninguna ONU: el alta clonaba a las vecinas y, sin
 * vecinas, moría con "No se pudo deducir el perfil de alta". Las salidas de aquí
 * son recortes reales de esa OLT del mismo día.
 */

const LINE = `
  -----------------------------------------------------------------------------
  Profile-ID  Profile-name                                Binding times
  -----------------------------------------------------------------------------
  0           line-profile_default_0                      0
  2           SMARTOLT_FLEXIBLE_GPON                      320
  3           SMARTOLT_FLEXIBLE_XGPON                     0
  60          SmartOLT_G                                  173
  65          Generic_1_V590                              1
  590         line-profile_590                            0
  -----------------------------------------------------------------------------
  Total: 6`;

const SRV = `
  Profile-ID  Profile-name                                Binding times
  -----------------------------------------------------------------------------
  2           GENERICO                                    67
  4           BCD-FD702XW-X-R410                          176
  9           BCD-FD702XW-AX-R411                         99
  87          F680V9.0                                    3
  -----------------------------------------------------------------------------`;

/** `display service-port vlan 590` con el único abonado que hoy tiene 0/2/13. */
const VLAN_590_SOLO_ESE_PUERTO = `
   INDEX VLAN VLAN     PORT F/ S/ P VPI  VCI   FLOW  FLOW       RX   TX   STATE
         ID   ATTR     TYPE                    TYPE  PARA
  -----------------------------------------------------------------------------
     335  590 common   gpon 0/2 /13 0    1     vlan  590        37   47   up
  -----------------------------------------------------------------------------`;

const VLAN_570_EN_OTRO = `
      66  570 common   gpon 0/2 /11 0    1     vlan  570        37   47   up
     161  570 common   gpon 0/2 /11 13   1     vlan  570        55   58   up   `;

const PUERTO_VACIO = `
  Failure: There is no ONT available
`;

function driver(respuestas: Record<string, string>) {
  const d = new OltHuawei('10.0.0.1', '22', 'u', 'p');
  const enviados: string[] = [];
  (d as any).sendCommand = async (cmd: string) => {
    enviados.push(cmd);
    for (const [k, v] of Object.entries(respuestas)) if (cmd.startsWith(k)) return v;
    return '';
  };
  return { d, enviados };
}

describe('perfilesParaPuertoVacio', () => {
  const parse = (out: string) => (new OltHuawei('h', '22', 'u', 'p') as any).parseProfiles(out);

  it('lee las "Binding times" y elige el flexible GPON más usado, no el XGPON', () => {
    const r = perfilesParaPuertoVacio(parse(LINE), parse(SRV), 'BCD-FD702XW-AX-R411');
    expect(r.lineprofile).toBe('2');
    expect(r.lineprofileNombre).toBe('SMARTOLT_FLEXIBLE_GPON');
    expect(r.srvprofile).toBe('9');
  });

  it('sin srv-profile con el nombre del modelo NO se adivina uno', () => {
    const r = perfilesParaPuertoVacio(parse(LINE), parse(SRV), 'HG8145V5');
    expect(r.srvprofile).toBeNull();
    expect(r.srvMotivo).toContain('HG8145V5');
  });

  it('sin perfil flexible no hay line-profile (el del nombre de la VLAN no se usa)', () => {
    const r = perfilesParaPuertoVacio(parse(LINE).filter((p: any) => !/FLEXIBLE/.test(p.name)), parse(SRV), 'F680V9.0');
    expect(r.lineprofile).toBeNull();
    expect(r.srvprofile).toBe('87');
  });
});

describe('puertosAjenosConVlan', () => {
  it('la VLAN solo en el mismo puerto (o en ninguno) está libre', () => {
    expect(puertosAjenosConVlan(VLAN_590_SOLO_ESE_PUERTO, 0, 2, 13)).toEqual([]);
    expect(puertosAjenosConVlan('', 0, 2, 13)).toEqual([]);
  });
  it('devuelve los otros PON que la usan', () => {
    expect(puertosAjenosConVlan(VLAN_570_EN_OTRO, 0, 2, 13)).toEqual(['0/2/11']);
  });
});

describe('sugerenciaDePuerto en un puerto vacío', () => {
  it('arma el alta con la VLAN del catálogo, el flexible y el srv-profile del modelo', async () => {
    const { d } = driver({
      'display service-port port': '',
      'display ont info': PUERTO_VACIO,
      'display ont-lineprofile': LINE,
      'display ont-srvprofile': SRV,
      'display service-port vlan 590': '',
    });
    const s = await d.sugerenciaDePuerto(0, 2, 13, { model: 'BCD-FD702XW-AX-R411', vlanCatalogo: [590] });
    expect(s).toMatchObject({ vlan: '590', user_vlan: '590', lineprofile: '2', srvprofile: '9', gemport: '1' });
    expect(s.puertoVacio.vlanDeCatalogo).toBe('590');
  });

  it('no usa la VLAN del catálogo si es la PRINCIPAL de otro puerto', async () => {
    const { d } = driver({
      'display service-port port 0/2/13': '',
      'display service-port port 0/2/11': VLAN_570_EN_OTRO,
      'display ont info': PUERTO_VACIO,
      'display ont-lineprofile': LINE,
      'display ont-srvprofile': SRV,
      'display service-port vlan 570': VLAN_570_EN_OTRO,
    });
    const s = await d.sugerenciaDePuerto(0, 2, 13, { model: 'BCD-FD702XW-AX-R411', vlanCatalogo: [570] });
    expect(s.vlan).toBeNull();
    expect(s.puertoVacio.vlanMotivo).toContain('0/2/11');
  });

  it('sí la usa si en el otro puerto es minoritaria (un abonado trasladado)', async () => {
    const TRASLADADO = `
     900  590 common   gpon 0/2 /7  3    1     vlan  590        37   47   up   `;
    const { d } = driver({
      'display service-port port 0/2/13': '',
      'display service-port port 0/2/7': VLAN_570_EN_OTRO.replace(/0\/2 \/11/g, '0/2 /7') + TRASLADADO,
      'display ont info': PUERTO_VACIO,
      'display ont-lineprofile': LINE,
      'display ont-srvprofile': SRV,
      'display service-port vlan 590': TRASLADADO,
    });
    const s = await d.sugerenciaDePuerto(0, 2, 13, { model: 'BCD-FD702XW-AX-R411', vlanCatalogo: [590] });
    expect(s.vlan).toBe('590');
  });

  it('dos VLANs en el catálogo para el mismo puerto: no elige', async () => {
    const { d, enviados } = driver({
      'display ont info': PUERTO_VACIO,
      'display ont-lineprofile': LINE,
      'display ont-srvprofile': SRV,
    });
    const s = await d.sugerenciaDePuerto(0, 2, 13, { model: 'X', vlanCatalogo: [590, 600] });
    expect(s.vlan).toBeNull();
    expect(enviados.some((c) => c.startsWith('display service-port vlan'))).toBe(false);
  });

  it('con vecinas no pregunta perfiles ni catálogo: manda lo que ya funciona', async () => {
    const { d, enviados } = driver({
      'display service-port port': VLAN_590_SOLO_ESE_PUERTO,
      'display ont info 0 2 13 all': `
  0/ 2/13   0  58504F4E1D52284E  active      online   failed   match    no `,
      'display ont info 0 2 13 0': `
  Config state            : failed
  Line profile ID      : 65
  Service profile ID   : 97
  Service profile name : Generic_1_V590`,
    });
    const s = await d.sugerenciaDePuerto(0, 2, 13, { model: 'BCD-FD702XW-AX-R411', vlanCatalogo: [600] });
    expect(s).toMatchObject({ vlan: '590', lineprofile: '65', srvprofile: '97', puertoVacio: null });
    expect(enviados.some((c) => c.startsWith('display ont-lineprofile'))).toBe(false);
  });
});

describe('vlansPorPuertoDeSalida (display service-port all)', () => {
  const { vlansPorPuertoDeSalida } = require('./olt-huawei.driver');
  const { puertosDeTarjeta } = require('../olt.service');
  const SALIDA = `
   INDEX VLAN VLAN     PORT F/ S/ P VPI  VCI   FLOW  FLOW       RX   TX   STATE
  -----------------------------------------------------------------------------
       1  130 common   gpon 0/0 /3  3    1     vlan  130        37   47   down
     335  590 common   gpon 0/2 /13 0    1     vlan  590        37   47   up
      66  570 common   gpon 0/2 /11 0    1     vlan  570        37   47   up
     161  570 common   gpon 0/2 /11 13   1     vlan  570        55   58   up
    2194  571 common   gpon 0/2 /11 15   1     vlan  571        20   20   down
   Total : 5  (Up/Down :    3/2)`;

  it('agrupa por puerto, ordena y pone primero la VLAN más usada', () => {
    const r = vlansPorPuertoDeSalida(SALIDA);
    expect(r.map((p: any) => `${p.slot}/${p.port}`)).toEqual(['0/3', '2/11', '2/13']);
    expect(r[1]).toEqual({ frame: 0, slot: 2, port: 11, servicios: 3, vlans: [{ vlan: 570, servicios: 2 }, { vlan: 571, servicios: 1 }] });
  });

  it('tarjetas: GPBD de 8 puertos, GPFD (las de esta planta) de 16', () => {
    expect(puertosDeTarjeta('H806GPFD')).toBe(16);
    expect(puertosDeTarjeta('H805GPBD')).toBe(8);
  });
});
