import { elegirRedes, esDeFabrica, planWifi, validarClave, validarSsid } from './wifi-targets';

/**
 * Los árboles de aquí NO son inventados: son la forma real que devuelve el NBI para
 * los modelos que más pesan en el parque de Vestel, sacados de un censo de los 549
 * equipos vivos. Importan porque el error que esta pieza tiene que evitar es mudo:
 * escribirle la clave nueva a la red de fábrica que nadie usa deja al cliente con su
 * clave vieja y al sistema diciendo que ya quedó.
 */

/** Azúcar para no repetir `{ _value, _writable }` cincuenta veces. */
const v = (value: unknown, writable = true) => ({ _value: value, _writable: writable });

/** BCD-FD702XW-X-R410 — 322 equipos: la del cliente en la 1, tres de fábrica detrás. */
const BCD_702XW = {
  '1': { SSID: v('VESTEL_MAIK'), KeyPassphrase: v('', true) },
  '2': { SSID: v('AP-1111'), KeyPassphrase: v('', true) },
  '3': { SSID: v('AP-2222'), KeyPassphrase: v('', true) },
  '4': { SSID: v('AP-3333'), KeyPassphrase: v('', true) },
};

/**
 * BCD-FD702GW-DX-R471 — 124 equipos, y el caso que rompe cualquier atajo por índice:
 * la 5 GHz del cliente es la instancia 1 y la de 2.4 es la 6; en medio, ocho SSIDs de
 * fábrica. Quien escriba "siempre la 1 y la 5" le cambia la clave a HGW-737719-5G-4.
 */
const BCD_702GW = {
  '1': { SSID: v('FLIA-PACHECO-5G'), KeyPassphrase: v('', true) },
  '2': { SSID: v('HGW-737719-5G-1'), KeyPassphrase: v('', true) },
  '3': { SSID: v('HGW-737719-5G-2'), KeyPassphrase: v('', true) },
  '4': { SSID: v('HGW-737719-5G-3'), KeyPassphrase: v('', true) },
  '5': { SSID: v('HGW-ABCD12-5G-4'), KeyPassphrase: v('', true) },
  '6': { SSID: v('FLIA-PACHECO'), KeyPassphrase: v('', true) },
  '7': { SSID: v('HGW-737719-1'), KeyPassphrase: v('', true) },
  '8': { SSID: v('HGW-737719-2'), KeyPassphrase: v('', true) },
};

describe('elegirRedes — sobre qué redes se escribe', () => {
  it('escoge la del cliente y deja en paz las de fábrica', () => {
    const redes = elegirRedes(BCD_702XW);
    expect(redes.map((r) => r.instancia)).toEqual(['1']);
    expect(redes[0].ssidActual).toBe('VESTEL_MAIK');
  });

  it('encuentra las dos bandas aunque estén en índices salteados (1 y 6, no 1 y 5)', () => {
    const redes = elegirRedes(BCD_702GW);
    expect(redes.map((r) => r.instancia)).toEqual(['1', '6']);
    expect(redes.find((r) => r.instancia === '1')!.esCincoGhz).toBe(true);
    expect(redes.find((r) => r.instancia === '6')!.esCincoGhz).toBe(false);
  });

  it('no toca las redes apagadas', () => {
    const redes = elegirRedes({
      '1': { SSID: v('CASA_LOPEZ'), Enable: v(true), KeyPassphrase: v('', true) },
      '2': { SSID: v('CASA_LOPEZ_INVITADOS'), Enable: v(false), KeyPassphrase: v('', true) },
    });
    expect(redes.map((r) => r.ssidActual)).toEqual(['CASA_LOPEZ']);
  });

  it('si el cliente nunca le cambió el nombre, cae en la primera encendida y no se queda sin hacer nada', () => {
    const redes = elegirRedes({
      '1': { SSID: v('HGW-737719-1'), KeyPassphrase: v('', true) },
      '2': { SSID: v('HGW-737719-2'), KeyPassphrase: v('', true) },
    });
    expect(redes.map((r) => r.instancia)).toEqual(['1']);
  });

  it('descarta la instancia que no deja escribir ni el nombre ni la clave', () => {
    const redes = elegirRedes({
      '1': { SSID: v('CASA_RUIZ', false), KeyPassphrase: v('', false) },
      '2': { SSID: v('CASA_RUIZ_5G'), KeyPassphrase: v('', true) },
    });
    expect(redes.map((r) => r.instancia)).toEqual(['2']);
  });

  it('usa PreSharedKey cuando el equipo no expone KeyPassphrase', () => {
    const redes = elegirRedes({
      '1': { SSID: v('CASA_DIAZ'), PreSharedKey: { '1': { KeyPassphrase: v('', true) } } },
    });
    expect(redes[0].paramsClave).toEqual([
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase',
    ]);
  });

  it('sin subárbol WiFi no devuelve nada (y quien llame abrirá la orden)', () => {
    expect(elegirRedes(undefined)).toEqual([]);
    expect(elegirRedes({})).toEqual([]);
  });
});

describe('esDeFabrica — no confundir el nombre de la caja con el de la familia', () => {
  it.each(['AP-1111', 'HGW-737719-1', 'HGW-ABCD12-5G-4', 'FTTH1-27B411', 'ONU_A1B2C3'])(
    'reconoce «%s» como de fábrica',
    (s) => expect(esDeFabrica(s)).toBe(true),
  );

  it.each(['VESTEL_MAIK', 'FLIA-PACHECO-5G', 'FAMILIA ESPINOSA', 'TALLER_TG', 'FLORAMARILLO'])(
    'respeta «%s» como red del cliente',
    (s) => expect(esDeFabrica(s)).toBe(false),
  );
});

describe('planWifi — qué se le manda al equipo', () => {
  it('cambia la clave en las dos bandas con una sola tarea', () => {
    const plan = planWifi(elegirRedes(BCD_702GW), { clave: 'ClaveNueva2026' });
    expect(plan.pares).toEqual([
      ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase', 'ClaveNueva2026'],
      ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.KeyPassphrase', 'ClaveNueva2026'],
    ]);
  });

  it('al renombrar, la de 5 GHz conserva el sufijo para que el cliente siga pudiendo elegir banda', () => {
    const plan = planWifi(elegirRedes(BCD_702GW), { ssid: 'CASA PACHECO' });
    const nombres = plan.pares.filter(([p]) => p.endsWith('.SSID')).map(([, val]) => val);
    expect(nombres).toEqual(['CASA PACHECO-5G', 'CASA PACHECO']);
  });

  it('no mete la clave en el resumen que se guarda', () => {
    const plan = planWifi(elegirRedes(BCD_702XW), { ssid: 'CASA', clave: 'SuperSecreta9' });
    expect(plan.resumen.join(' ')).not.toContain('SuperSecreta9');
    expect(plan.resumen.join(' ')).toContain('clave nueva');
  });

  it('sin redes escribibles no arma ningún par (nadie va a creer que se aplicó)', () => {
    expect(planWifi([], { clave: 'LoQueSea12' }).pares).toEqual([]);
  });

  it('avisa cuando una banda se queda con la clave vieja porque el equipo no la deja tocar', () => {
    const redes = elegirRedes({
      '1': { SSID: v('CASA_RUIZ'), KeyPassphrase: v('', true) },
      // La 5 GHz solo deja renombrarse: su clave no se puede escribir.
      '2': { SSID: v('CASA_RUIZ-5G'), KeyPassphrase: v('', false) },
    });
    const plan = planWifi(redes, { clave: 'ClaveNueva2026' });
    expect(plan.sinClave).toEqual(['CASA_RUIZ-5G']);
  });
});

describe('validación — las reglas son de WPA, no nuestras', () => {
  it('rechaza claves de menos de 8 y de más de 63', () => {
    expect(validarClave('corta')).toContain('8 caracteres');
    expect(validarClave('x'.repeat(64))).toContain('63');
    expect(validarClave('OchoChar')).toBeNull();
  });

  it('rechaza tildes, ñ y emojis: el equipo los acepta y el celular ya no conecta', () => {
    expect(validarClave('contraseña123')).toContain('tildes');
    expect(validarClave('clave🔒segura')).toContain('tildes');
  });

  it('el nombre de la red no pasa de 32 caracteres ni va vacío', () => {
    expect(validarSsid('')).toContain('vacío');
    expect(validarSsid('R'.repeat(33))).toContain('32');
    expect(validarSsid('CASA PACHECO')).toBeNull();
  });
});
