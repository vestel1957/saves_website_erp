/**
 * Reglas de traducción de las OBSERVACIONES y los ARCHIVOS que el legacy pinta al pie
 * del perfil del cliente. El módulo bajo prueba vive en `scripts/lib` porque lo
 * comparten el volcado histórico y la pasada de sincronización, que son scripts.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const legacy = require('../../scripts/lib/observaciones-legacy');

describe('limpiarHtml', () => {
  it('deja texto plano de lo que escribió el editor del legacy', () => {
    expect(legacy.limpiarHtml('2026-08-30/<p>COMPROMISO&nbsp;</p>')).toBe('2026-08-30/COMPROMISO');
  });

  it('convierte los saltos de línea del HTML en saltos de verdad', () => {
    expect(legacy.limpiarHtml('<p>uno</p><p>dos</p>')).toBe('uno\ndos');
    expect(legacy.limpiarHtml('uno<br>dos')).toBe('uno\ndos');
  });

  it('devuelve cadena vacía para null/undefined', () => {
    expect(legacy.limpiarHtml(null)).toBe('');
    expect(legacy.limpiarHtml(undefined)).toBe('');
  });
});

describe('cuerpoObservacion', () => {
  it('compone el titular nuevo en "Cambio Titular" (el legacy no muestra observacion ahí)', () => {
    expect(legacy.cuerpoObservacion({
      tipos: 'Cambio Titular', nombres: 'ANA GOMEZ', tdocumento: 'CC', documento2: 52123456,
      observacion: '',
    })).toBe('ANA GOMEZ, CC: 52123456');
  });

  it('en el resto de tipos copia la observación limpia', () => {
    expect(legacy.cuerpoObservacion({ tipos: 'Traslado', observacion: '<p>Direccion anterior</p>' }))
      .toBe('Direccion anterior');
  });
});

describe('mapObservacion', () => {
  const fila = { idn: 7, tipos: 'Compromiso', observacion: 'paga el 30', colaborador: 'LizethTa11', fecha: '2026-08-26' };

  it('traduce el usuario del legacy al nombre del funcionario', () => {
    const n = legacy.mapObservacion(fila, 'sub1', (u: string) => (u === 'LizethTa11' ? 'Lizeth Tavera' : u));
    expect(n).toMatchObject({ legacyId: 7, subscriberId: 'sub1', kind: 'Compromiso', body: 'paga el 30', authorName: 'Lizeth Tavera' });
  });

  it('descarta la fila si el cliente no existe aquí', () => {
    expect(legacy.mapObservacion(fila, null, (u: string) => u)).toBeNull();
  });

  it('sin texto pero con tipo, la fila se conserva (la fecha ya dice algo)', () => {
    const n = legacy.mapObservacion({ ...fila, observacion: '' }, 'sub1', (u: string) => u);
    expect(n.body).toBe('Compromiso');
  });
});

describe('nombreVisible', () => {
  it('quita el prefijo aleatorio que antepone el legacy al subir', () => {
    expect(legacy.nombreVisible('657200cartaderetiroJENNYFORERO.pdf')).toBe('cartaderetiroJENNYFORERO.pdf');
  });

  it('no recorta cuando el nombre es todo dígitos (una cédula escaneada)', () => {
    expect(legacy.nombreVisible('1000487449.pdf')).toBe('1000487449.pdf');
  });
});

describe('mimeDe / nombreEnDisco', () => {
  it('deduce el MIME por extensión, sin importar mayúsculas', () => {
    expect(legacy.mimeDe('foto.JPEG')).toBe('image/jpeg');
    expect(legacy.mimeDe('carta.pdf')).toBe('application/pdf');
    expect(legacy.mimeDe('raro.xyz')).toBe('application/octet-stream');
  });

  it('el nombre en disco es determinista: repetir la importación no duplica', () => {
    expect(legacy.nombreEnDisco(64954, '657200x.pdf')).toBe('legacy-64954.pdf');
  });
});
