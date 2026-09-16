import {
  TIPOS_DE_CAMPO_POR_DEFECTO,
  esOrdenDeCampo,
  estaExento,
  evaluarCierre,
  margenPorPrecision,
  normalizarTipo,
  type EntradaCerca,
} from './geofence.policy';

/** Vivienda de un abonado real de Yopal. */
const CASA = { lat: 5.3407689, lng: -72.369472 };
/** ~2,9 km en línea recta (4,5 por carretera): la oficina. Cerrar desde aquí
 *  es justo el caso que se quiere detectar. */
const OFICINA = { lat: 5.3378, lng: -72.3959 };
/** ~60 m de la casa: el técnico en la acera de enfrente. */
const EN_LA_PUERTA = { lat: 5.3413, lng: -72.369472 };

const base: EntradaCerca = {
  modo: 'exigir',
  radioM: 100,
  tiposCampo: TIPOS_DE_CAMPO_POR_DEFECTO,
  tipoOrden: 'Revision de Internet',
  permisosUsuario: ['area.tecnicos'],
  cliente: CASA,
  tecnico: { ...EN_LA_PUERTA, accuracyM: 10 },
};

const con = (p: Partial<EntradaCerca>): EntradaCerca => ({ ...base, ...p });

describe('normalizarTipo / esOrdenDeCampo', () => {
  it('iguala las variantes de tildes y mayúsculas del legacy', () => {
    expect(normalizarTipo('Revisión de Televisión')).toBe('revision de television');
    expect(normalizarTipo('  REVISION   DE  INTERNET ')).toBe('revision de internet');
  });

  it('reconoce las órdenes que sí van al domicilio', () => {
    for (const t of ['Instalacion', 'Revisión de Internet', 'Traslado', 'Cambio de equipo']) {
      expect(esOrdenDeCampo(t, TIPOS_DE_CAMPO_POR_DEFECTO)).toBe(true);
    }
  });

  it('NO marca como de campo los cortes y reconexiones, que son el 85% del trabajo', () => {
    for (const t of [
      'Corte Internet', 'Corte Television', 'Reconexion Internet',
      'Reconexion Television', 'Autenticacion', 'Cambio de clave',
    ]) {
      expect(esOrdenDeCampo(t, TIPOS_DE_CAMPO_POR_DEFECTO)).toBe(false);
    }
  });
});

describe('estaExento', () => {
  it('exime a gerencia, administración y al superusuario', () => {
    expect(estaExento(['area.gerencia'])).toBe(true);
    expect(estaExento(['area.administracion'])).toBe(true);
    expect(estaExento(['system.admin'])).toBe(true);
  });

  it('NO exime al técnico ni a caja', () => {
    expect(estaExento(['area.tecnicos'])).toBe(false);
    expect(estaExento(['area.caja'])).toBe(false);
    expect(estaExento([])).toBe(false);
    expect(estaExento(undefined)).toBe(false);
  });
});

describe('margenPorPrecision', () => {
  it('descuenta el error que declara el GPS', () => {
    expect(margenPorPrecision(80)).toBe(80);
  });

  it('lo acota: mandar una precisión enorme no debe desactivar la cerca', () => {
    expect(margenPorPrecision(999999)).toBe(250);
  });

  it('ignora valores ausentes o absurdos', () => {
    expect(margenPorPrecision(null)).toBe(0);
    expect(margenPorPrecision(undefined)).toBe(0);
    expect(margenPorPrecision(-5)).toBe(0);
    expect(margenPorPrecision(NaN)).toBe(0);
  });
});

describe('evaluarCierre — cuándo NO aplica', () => {
  it('modo apagado: pasa todo', () => {
    expect(evaluarCierre(con({ modo: 'off', tecnico: null })).accion).toBe('permitir');
  });

  it('una orden remota se cierra desde la oficina sin problema', () => {
    const v = evaluarCierre(con({ tipoOrden: 'Corte Internet', tecnico: { ...OFICINA, accuracyM: 10 } }));
    expect(v).toEqual({ accion: 'permitir', motivo: 'no-es-de-campo' });
  });

  it('gerencia cierra una orden de campo desde donde sea', () => {
    const v = evaluarCierre(
      con({ permisosUsuario: ['area.gerencia'], tecnico: { ...OFICINA, accuracyM: 10 } }),
    );
    expect(v).toEqual({ accion: 'permitir', motivo: 'usuario-exento' });
  });
});

describe('evaluarCierre — cliente sin coordenada', () => {
  it('deja cerrar y georreferencia con el punto del técnico', () => {
    const v = evaluarCierre(con({ cliente: null }));
    expect(v).toEqual({ accion: 'permitir-y-georreferenciar' });
  });

  // 2026-09-10: «exigir el registro de las coordenadas de ubicación». Que el cliente
  // no tenga punto guardado dejó de ser una puerta — era por donde pasaba entero un
  // cierre sin GPS, y justo en los abonados peor georreferenciados.
  it('en modo exigir, sin punto del técnico NO se cierra aunque el cliente no tenga', () => {
    const v = evaluarCierre(con({ cliente: null, tecnico: null }));
    expect(v).toMatchObject({ accion: 'exigir-ubicacion' });
  });

  it('observando sí pasa: sin punto de nadie no hay nada que comparar ni que anotar', () => {
    const v = evaluarCierre(con({ modo: 'observar', cliente: null, tecnico: null }));
    expect(v).toEqual({ accion: 'permitir', motivo: 'sin-datos' });
  });
});

describe('evaluarCierre — con coordenada del cliente', () => {
  it('el técnico en la puerta cierra normal', () => {
    const v = evaluarCierre(base);
    expect(v.accion).toBe('permitir');
  });

  it('desde la oficina, a 4,5 km, NO se cierra', () => {
    const v = evaluarCierre(con({ tecnico: { ...OFICINA, accuracyM: 10 } }));
    expect(v.accion).toBe('exigir-presencia');
    if (v.accion === 'exigir-presencia') expect(v.distanciaM).toBeGreaterThan(2500);
  });

  it('escribir un motivo ya NO abre la cerca (2026-09-10)', () => {
    // Antes bastaban 10 caracteres y la orden se cerraba igual; el usuario lo quitó:
    // «no dejar que cierren las órdenes si no están en la ubicación del cliente».
    const v = evaluarCierre({
      ...con({ tecnico: { ...OFICINA, accuracyM: 10 } }),
      // Aunque el cliente viejo siga mandando el campo, la política ni lo mira.
      ...({ justificacion: 'El cliente confirmó por teléfono que ya tiene servicio.' } as object),
    });
    expect(v.accion).toBe('exigir-presencia');
  });

  it('la salida es el exento, no el técnico: administración sí puede cerrarla', () => {
    const v = evaluarCierre(
      con({ tecnico: { ...OFICINA, accuracyM: 10 }, permisosUsuario: ['area.administracion'] }),
    );
    expect(v.accion).toBe('permitir');
  });

  it('un GPS impreciso no bloquea a quien sí está en la casa', () => {
    // 200 m de distancia real, pero el teléfono declara ±180 m dentro de la vivienda.
    const cerca = { lat: CASA.lat + 0.0018, lng: CASA.lng };
    const v = evaluarCierre(con({ tecnico: { ...cerca, accuracyM: 180 } }));
    expect(v.accion).toBe('permitir');
  });

  it('pero una precisión inventada NO abre la cerca desde la oficina', () => {
    const v = evaluarCierre(con({ tecnico: { ...OFICINA, accuracyM: 999999 } }));
    expect(v.accion).toBe('exigir-presencia');
  });

  it('sin ubicación y en modo exigir, la pide', () => {
    expect(evaluarCierre(con({ tecnico: null })).accion).toBe('exigir-ubicacion');
  });
});

describe('evaluarCierre — modo observación', () => {
  it('deja cerrar desde la oficina, pero lo deja marcado', () => {
    const v = evaluarCierre(con({ modo: 'observar', tecnico: { ...OFICINA, accuracyM: 10 } }));
    expect(v.accion).toBe('permitir-marcado');
    if (v.accion === 'permitir-marcado') expect(v.distanciaM).toBeGreaterThan(2500);
  });

  it('sin ubicación no frena a nadie mientras solo se observa', () => {
    const v = evaluarCierre(con({ modo: 'observar', tecnico: null }));
    expect(v).toEqual({ accion: 'permitir', motivo: 'sin-ubicacion-observando' });
  });
});
