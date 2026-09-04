import { OltHuawei } from './olt-huawei.driver';

/**
 * ONU que ya está autenticada en la OLT ("SN already exists").
 *
 * Las salidas de aquí NO son inventadas: son las que devolvió la OLT de
 * VILLANUEVA (MA5683T) el 19/08/2026 con la ONU de un abonado real que se había
 * autenticado desde SmartOLT y que el sistema intentó dar de alta tres veces
 * seguidas. Lo que se prueba es lo que falló entonces:
 *
 *   1. que el rechazo se cuente como lo que es (SN ya existe, y DÓNDE está) en
 *      vez de "revise la salida cruda", que fue lo que llevó a reintentar
 *      cambiando el srv-profile —cosa que nunca iba a funcionar—;
 *   2. que adoptarla no toque el equipo más de lo necesario: al abonado que ya
 *      navega no se le reescribe el service-port porque sí.
 */

/** Rechazo real del `ont add` sobre un SN ya dado de alta. */
const SN_YA_EXISTE = `
ont add 1 sn-auth "5A544547C9E3311B" omci ont-lineprofile-id 60 ont-srvprofile-id 1 desc "DR_ORLANDO"
  { <cr>|ont-type<K> }:

  Command:
          ont add 1 sn-auth "5A544547C9E3311B" omci ont-lineprofile-id 60 ont-srvprofile-id 1 desc "DR_ORLANDO"
  Failure: SN already exists

`;

/** Otro rechazo distinto, para comprobar que ya no se responde en genérico. */
const PERFIL_MALO = `
  Command:
          ont add 1 sn-auth "5A544547C9E3311B" omci ont-lineprofile-id 99 ont-srvprofile-id 1
  Failure: The ont-lineprofile does not exist
`;

/** `display ont info by-sn 5A544547C9E3311B` recortado a lo que se parsea. */
const INFO_POR_SN = `
  F/S/P                   : 0/0/1
  ONT-ID                  : 5
  Control flag            : active
  Run state               : online
  Config state            : failed
  Match state             : mismatch
  Authentic type          : SN-auth
  SN                      : 5A544547C9E3311B (ZTEG-C9E3311B)
  Management mode         : OMCI
  Description             : Dr,                             
                            Orlando_zone_PRINCIPAL_authd_202
                            60818
  Line profile ID      : 60
  Line profile name    : SmartOLT_G
  Service profile ID   : 87
  Service profile name : F680V9.0
`;

/** `display service-port port 0/0/1`: la ONT-ID 5 es la fila del índice 358. */
const SERVICE_PORTS = `
  Switch-Oriented Flow List
  -----------------------------------------------------------------------------
   INDEX VLAN VLAN     PORT F/ S/ P VPI  VCI   FLOW  FLOW       RX   TX   STATE
         ID   ATTR     TYPE                    TYPE  PARA
  -----------------------------------------------------------------------------
      25  110 common   gpon 0/0 /1  1    1     vlan  110        17   47   up
     358  110 common   gpon 0/0 /1  5    1     vlan  110        55   58   up
     465  110 common   gpon 0/0 /1  44   1     vlan  110        22   21   up
  -----------------------------------------------------------------------------
`;

/** El mismo puerto después de reapuntar las traffic-tables de la ONT 5. */
const SERVICE_PORTS_TRAS_CAMBIO = SERVICE_PORTS.replace(
  '358  110 common   gpon 0/0 /1  5    1     vlan  110        55   58   up',
  '358  110 common   gpon 0/0 /1  5    1     vlan  110        11   9    up',
);

/**
 * Driver con la sesión SSH doblada: cada comando devuelve la salida real que da
 * la OLT. `enviados` es lo que se comprueba — sobre un abonado que ya navega,
 * los comandos que NO se mandan importan tanto como los que sí.
 */
function armar(respuestas: Array<[RegExp, string | ((cmd?: string) => string)]>) {
  const enviados: string[] = [];
  class Doble extends OltHuawei {
    protected async sendCommand(cmd: string): Promise<string> {
      enviados.push(cmd);
      for (const [re, out] of respuestas) {
        if (re.test(cmd)) return typeof out === 'function' ? out(cmd) : out;
      }
      return '';
    }
  }
  return { driver: new Doble('1.2.3.4', 22, 'u', 'p'), enviados };
}

/** Respuestas de una ONU que YA está dada de alta y navegando. */
const yaAutenticada = (sp: () => string): Array<[RegExp, string | ((cmd?: string) => string)]> => [
  [/^ont add/, SN_YA_EXISTE],
  [/^display ont info by-sn/, INFO_POR_SN],
  [/^display service-port port/, sp],
  // La relectura de verificación: online y con su service-port.
  [/^display ont info \d+ \d+ \d+ \d+/, INFO_POR_SN],
];

/**
 * `display ont info 0 1 4 28` de YOPAL: la ONT del caso del GEM-port. Su perfil
 * declara `<Gem Index 250>` — pedirle el GEM 1 es lo que tumbó el service-port.
 */
const ONT_GEM_250 = `
  F/S/P                   : 0/1/4
  ONT-ID                  : 28
  Run state               : online
  Config state            : failed
  Match state             : match
  SN                      : 44433830E6983A40 (DC80-E6983A40)
  Description             : ONT_NO_DESCRIPTION
  <T-CONT   0>          DBA Profile-ID:1
  <T-CONT   5>          DBA Profile-ID:100
   <Gem Index 250>
  Line profile ID      : 250
  Line profile name    : vlan250
  Service profile ID   : 10
  Service profile name : srv-profile_10
`;

/** El puerto 0/1/4: los vecinos que sí navegan usan VLAN 250 y GEM 250. */
const SERVICE_PORTS_0_1_4 = `
   INDEX VLAN VLAN     PORT F/ S/ P VPI  VCI   FLOW  FLOW       RX   TX   STATE
  -----------------------------------------------------------------------------
     731  250 common   gpon 0/1 /4  13   250   vlan  250        50   10   down
     908  250 common   gpon 0/1 /4  30   250   vlan  250        50   10   up
    1004  250 common   gpon 0/1 /4  4    250   vlan  250        50   10   up
`;

describe('ONU ya autenticada en la OLT', () => {
  it('el alta dice que el SN ya existe y en qué puerto está, no "revise la salida cruda"', async () => {
    const { driver } = armar(yaAutenticada(() => SERVICE_PORTS));
    const r: any = await driver.provisionOnu({
      frame: 0, slot: 0, port: 1, sn: '5A544547C9E3311B',
      lineprofile: 60, srvprofile: 1, vlan: 110, gemport: 1, desc: 'DR_ORLANDO',
    });

    expect(r.codigo).toBe('SN_YA_EXISTE');
    expect(r.error).toContain('0/0/1');
    expect(r.error).not.toMatch(/salida cruda/i);
    expect(r.existente).toMatchObject({ fsp: '0/0/1', ont_id: 5, run_state: 'online' });
    // Y con lo que hace falta para decidir: dónde, cómo y a qué velocidad.
    expect(r.existente.servicePorts).toEqual([
      { index: '358', vlan: '110', ontId: '5', gemport: '1', rx: '55', tx: '58' },
    ]);
  });

  it('un rechazo por otra causa se cuenta con la línea que dio la OLT', async () => {
    const { driver } = armar([[/^ont add/, PERFIL_MALO]]);
    const r = await driver.provisionOnu({
      frame: 0, slot: 0, port: 1, sn: '5A544547C9E3311B', lineprofile: 99, srvprofile: 1,
    });

    expect(r).toBe(false);
    expect(driver.getError()).toContain('The ont-lineprofile does not exist');
  });

  it('adoptarla con la velocidad que ya tiene no reescribe el service-port', async () => {
    const { driver, enviados } = armar(yaAutenticada(() => SERVICE_PORTS));
    // 55/58 es justo lo que la ONU ya tiene puesto.
    const r: any = await driver.adoptarOnu({
      sn: '5A544547C9E3311B', desc: 'Dr,Orlando_zone_PRINCIPAL_authd_20260818',
      traffic_in: 55, traffic_out: 58,
    });

    expect(r.ok).toBe(true);
    expect(r.fsp).toBe('0/0/1');
    expect(r.ont_id).toBe('5');
    expect(enviados.some((c) => /^service-port \d+/.test(c))).toBe(false);
    expect(enviados.some((c) => /^ont modify/.test(c))).toBe(false);
    expect(r.cambios.join(' ')).toMatch(/ya correcta/);
  });

  it('adoptarla con otra velocidad y otro comentario sí los aplica', async () => {
    let sp = SERVICE_PORTS;
    const { driver, enviados } = armar([
      ...yaAutenticada(() => sp),
      // Tras el cambio, la OLT ya reporta las tablas nuevas.
      [/^service-port 358/, () => { sp = SERVICE_PORTS_TRAS_CAMBIO; return ''; }],
      [/^ont modify/, ''],
    ]);
    const r: any = await driver.adoptarOnu({
      sn: '5A544547C9E3311B', desc: '54321ORLANDO', traffic_in: 11, traffic_out: 9,
    });

    expect(r.ok).toBe(true);
    expect(enviados).toContain('ont modify 1 5 desc "54321ORLANDO"');
    expect(enviados).toContain('service-port 358 inbound traffic-table index 11 outbound traffic-table index 9');
    expect(r.velocidad.despues).toEqual({ traffic_in: '11', traffic_out: '9' });
    expect(r.avisos).toEqual([]);
  });

  it('si el service-port falla, el alta lo dice con la causa (no un "0 service-port" mudo)', async () => {
    // Rechazo real de Huawei cuando el GEM pedido no existe en el srv-profile.
    const { driver } = armar([
      [/^ont add/, '\n  Command:\n          ont add 4 sn-auth "44433830E6983A40" omci\n  ONTID :28\n'],
      [/^service-port/, '\n  Command:\n          service-port vlan 250 gpon 0/1/4 ont 28 gemport 1\n  Failure: The GEM port does not exist\n'],
      // La ONT quedó creada pero sin servicio: offline y sin service-ports.
      [/^display ont info \d+ \d+ \d+ \d+/, '  F/S/P : 0/1/4\n  ONT-ID : 28\n  Run state : offline\n  Config state : initial\n  Match state : initial\n'],
      [/^display service-port port/, '   INDEX VLAN VLAN     PORT F/ S/ P VPI  VCI\n'],
    ]);
    // La verificación reintenta con esperas (la ONT tarda en registrarse por
    // OMCI): se adelanta el reloj en vez de esperarlas de verdad.
    jest.useFakeTimers();
    const pendiente = driver.provisionOnu({
      frame: 0, slot: 1, port: 4, sn: '44433830E6983A40',
      lineprofile: 250, srvprofile: 10, vlan: 250, gemport: 1, traffic_in: 31, traffic_out: 31,
    });
    await jest.advanceTimersByTimeAsync(30_000);
    const r: any = await pendiente;
    jest.useRealTimers();

    expect(r.ok).toBe(true);
    expect(r.ont_id).toBe('28');
    // El motivo que dio la OLT llega hasta los avisos del técnico.
    const avisos = r.verificacion.avisos.join(' ');
    expect(avisos).toContain('The GEM port does not exist');
    expect(avisos).toMatch(/SERVICE-PORT no/);
    // Y queda registrado comando a comando para poder diagnosticarlo después.
    expect(r.respuestas.map((x: any) => x.cmd)).toEqual([
      expect.stringContaining('ont add'),
      expect.stringContaining('service-port vlan 250'),
    ]);
    expect(r.respuestas[1].out).toContain('Failure: The GEM port does not exist');
  });

  it('el service-port usa el GEM que declara la ONT, no el 1 por defecto', async () => {
    let creado = '';
    const { driver } = armar([
      [/^ont add/, '  ONTID :28'],
      [/^display ont info 0 1 4 28/, ONT_GEM_250],
      [/^service-port vlan/, (c?: string) => { creado = c ?? ''; return '  Command:\n  Success'; }],
      [/^display service-port port/, SERVICE_PORTS_0_1_4],
    ]);
    const r: any = await driver.provisionOnu({
      frame: 0, slot: 1, port: 4, sn: '44433830E6983A40',
      lineprofile: 250, srvprofile: 10, vlan: 250, gemport: 1, traffic_in: 31, traffic_out: 31,
    });

    expect(r.ok).toBe(true);
    // Se pidió el GEM 1; la ONT solo tiene el 250 y es el que se usa.
    expect(creado).toContain('gemport 250');
    expect(r.verificacion.avisos.join(' ')).toContain('GEM-port 1 no existe');
  });

  it('adoptar una ONU registrada SIN service-port se lo crea con lo del puerto', async () => {
    let creado = '';
    let sinSp = true;
    const { driver } = armar([
      [/^display ont info by-sn/, ONT_GEM_250],
      [/^display ont info 0 1 4 28/, ONT_GEM_250],
      [/^display ont info 0 1 4 all/, ''],
      [/^service-port vlan/, (c?: string) => { creado = c ?? ''; sinSp = false; return '  Success'; }],
      // Antes de crearlo la ONT 28 no aparece; después sí.
      [/^display service-port port/, () => (sinSp
        ? SERVICE_PORTS_0_1_4
        : SERVICE_PORTS_0_1_4 + '    1500  250 common   gpon 0/1 /4  28   250   vlan  250        31   31   up\n')],
    ]);
    const r: any = await driver.adoptarOnu({ sn: '44433830E6983A40', traffic_in: 31, traffic_out: 31 });

    expect(r.ok).toBe(true);
    // VLAN y GEM salen de lo que ya funciona en ese puerto (250/250).
    expect(creado).toContain('service-port vlan 250');
    expect(creado).toContain('gemport 250');
    expect(creado).toContain('inbound traffic-table index 31 outbound traffic-table index 31');
    expect(r.cambios.join(' ')).toMatch(/service-port creado/);
  });

  it('lee entero el comentario que la OLT parte en varias líneas', async () => {
    const { driver } = armar(yaAutenticada(() => SERVICE_PORTS));
    const r: any = await driver.estadoPorSn('5A544547C9E3311B');

    // Quedándose con la primera línea el comentario era "Dr," y con eso no casa
    // el abonado por ningún lado.
    expect(r.description).toBe('Dr,Orlando_zone_PRINCIPAL_authd_20260818');
  });

  it('no se adopta lo que no existe: eso hay que autenticarlo', async () => {
    const { driver } = armar([[/^display ont info by-sn/, '  Failure: The required ONT does not exist']]);
    const r = await driver.adoptarOnu({ sn: '5A544547C9E3311B' });

    expect(r).toBe(false);
    expect(driver.getError()).toMatch(/no está autenticada/i);
  });
});
