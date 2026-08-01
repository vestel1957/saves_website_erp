import { interpretarConfirmacion } from './confirmacion.parser';

/**
 * Este clasificador decide si una avería se cierra o si sale un técnico, así que los
 * dos errores cuestan distinto:
 *
 *  - un falso SÍ cierra en falso el caso de alguien que sigue sin internet, y ese
 *    cliente ya no vuelve a escribir: vuelve a llamar, molesto;
 *  - un falso NO manda una visita que no hacía falta.
 *
 * El primero es el grave. Y es justo el que la versión de SAM cometía al revés y en
 * los dos sentidos, por comparar subcadenas.
 */

describe('lo que SAM clasificaba mal', () => {
  it('"bueno" es un sí, no un no ("no" vive dentro de "bue-no")', () => {
    // El fallo original: `'no' in 'bueno'` → SAM abría una re-visita al cliente que
    // acababa de decirle que todo estaba bien.
    expect(interpretarConfirmacion('bueno')).toBe('si');
    expect(interpretarConfirmacion('Bueno, muchas gracias')).toBe('si');
  });

  it('"sigue igual" es un no, y no un sí y un no a la vez ("si" vive dentro de "sigue")', () => {
    expect(interpretarConfirmacion('sigue igual')).toBe('no');
    expect(interpretarConfirmacion('Sigue igual de lento')).toBe('no');
  });
});

describe('confirma que quedó', () => {
  it.each([
    'sí',
    'Sí señor',
    'si ya quedó',
    'ya quedó funcionando',
    'listo, gracias',
    'perfecto muchas gracias',
    'ya me funciona',
    'quedó bien',
    'ok',
    'excelente, ya navega normal',
    'Muchas gracias, todo bien',
  ])('«%s» → sí', (texto) => {
    expect(interpretarConfirmacion(texto)).toBe('si');
  });
});

describe('dice que NO quedó', () => {
  it.each([
    'no',
    'No señor',
    'no me funciona',
    'no quedó',
    'no ha quedado',
    'sigue sin internet',
    'sigue fallando',
    'todavía nada',
    'nada',
    'peor que antes',
    'está intermitente',
    'no, sigue igual',
    'sin señal todavía',
  ])('«%s» → no', (texto) => {
    expect(interpretarConfirmacion(texto)).toBe('no');
  });

  it('un "sí" seguido de un pero NO es un sí', () => {
    // El caso que más se ve en la práctica: el cliente es amable y luego dice la verdad.
    expect(interpretarConfirmacion('sí pero sigue lento')).toBe('no');
    expect(interpretarConfirmacion('ya prendió, pero se cae cada rato')).toBe('no');
    expect(interpretarConfirmacion('funciona pero muy lento')).toBe('no');
  });

  it('"ya reinicié y nada" no cuenta como confirmación', () => {
    expect(interpretarConfirmacion('ya reinicié el equipo y nada')).toBe('no');
  });
});

describe('manda la última frase decisiva', () => {
  it('"no, ya quedó" es un sí: el "no" niega el problema, no la solución', () => {
    expect(interpretarConfirmacion('no, ya quedó')).toBe('si');
    expect(interpretarConfirmacion('No, ya me funciona, gracias')).toBe('si');
  });

  it('una corrección al final se respeta', () => {
    expect(interpretarConfirmacion('ya quedó. no, mentiras, sigue igual')).toBe('no');
  });
});

describe('cuando no está contestando la pregunta', () => {
  it.each([
    '¿cuánto debo?',
    'quiero cambiar mi plan',
    'me pueden enviar la factura',
    'a qué hora pasa el técnico',
    '3001234567',
    '',
    '   ',
  ])('«%s» → no-claro (se le pasa al bot en vez de insistir)', (texto) => {
    expect(interpretarConfirmacion(texto)).toBe('no-claro');
  });

  it('no revienta con emojis ni con lo que sea', () => {
    expect(interpretarConfirmacion('👍')).toBe('no-claro');
    expect(() => interpretarConfirmacion(undefined as unknown as string)).not.toThrow();
    // Un emoji de pulgar arriba se lee como conformidad, pero no está en el catálogo:
    // ante la duda no se cierra un caso. Lo atiende el bot.
    expect(interpretarConfirmacion('👍 gracias')).toBe('si');
  });
});
