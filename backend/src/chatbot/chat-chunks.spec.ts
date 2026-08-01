import { pausaMs, trocear, aFormatoWhatsapp } from './chat-chunks';

/** Lo que el agente contesta a "cómo van los técnicos": el caso que motivó todo esto. */
const RESPUESTA_LARGA = [
  'Este año el equipo cerró 5.446 órdenes de campo, con 11% de re-visita.',
  '',
  'Los que más se salen de la mediana:',
  '• Paula Andrea Unas — 16,7%',
  '• Luz Neidi Barrera Forero — 16%',
  '• Miguel Ángel Fonseca — 16%',
  '• Nayme Jimenez — 15,1%',
  '',
  'Hay 66 órdenes abiertas y 66 vencidas, repartidas sobre todo en tres técnicos.',
  '',
  '¿Te mando el PDF completo con el detalle por persona?',
].join('\n');

describe('trocear', () => {
  it('deja pasar entero lo corto: partir un "listo" es el tic que se quiere quitar', () => {
    expect(trocear('Listo: el corte quedó aplicado.')).toEqual(['Listo: el corte quedó aplicado.']);
  });

  it('no inventa mensajes con texto vacío', () => {
    expect(trocear('')).toEqual([]);
    expect(trocear('   \n  ')).toEqual([]);
  });

  it('parte una respuesta larga en varios mensajes', () => {
    const t = trocear(RESPUESTA_LARGA);
    expect(t.length).toBeGreaterThan(1);
  });

  it('NO pierde ni una línea de lo que el agente decidió decir', () => {
    for (const texto of [RESPUESTA_LARGA, 'a'.repeat(400), `${'x'.repeat(200)}\n\n${'y'.repeat(200)}`]) {
      const original = texto.split('\n').map((l) => l.trim()).filter(Boolean);
      const partido = trocear(texto).join('\n').split('\n').map((l) => l.trim()).filter(Boolean);
      expect(partido).toEqual(original);
    }
  });

  it('nunca separa una lista de la línea que la presenta', () => {
    const t = trocear(RESPUESTA_LARGA);
    const intro = t.find((x) => x.includes('Los que más se salen'));
    expect(intro).toBeDefined();
    // La intro tiene que venir con sus viñetas en el MISMO mensaje.
    expect(intro).toContain('• Paula Andrea Unas — 16,7%');
    // Y ningún mensaje puede empezar por una viñeta huérfana.
    for (const x of t) expect(x.trimStart().startsWith('•')).toBe(false);
  });

  it('respeta el tope de 4 mensajes aunque el texto tenga muchos bloques', () => {
    const muchos = Array.from({ length: 30 }, (_, i) => `Párrafo número ${i} con algo de relleno.`).join('\n\n');
    const t = trocear(muchos);
    expect(t.length).toBeLessThanOrEqual(4);
  });

  it('un solo bloque indivisible viaja entero en vez de cortarse a mitad de frase', () => {
    const parrafo = `${'palabra '.repeat(120)}`.trim();
    expect(trocear(parrafo)).toEqual([parrafo]);
  });

  it('agrupa bloques pequeños en vez de mandar un mensaje por línea', () => {
    const texto = Array.from({ length: 8 }, (_, i) => `Línea corta ${i}.`).join('\n\n');
    const t = trocear(texto);
    expect(t.length).toBeLessThan(8);
  });
});

describe('pausaMs', () => {
  it('crece con el largo pero con techo: nadie mira el "escribiendo…" 4 segundos', () => {
    expect(pausaMs('hola')).toBeLessThan(pausaMs('x'.repeat(300)));
    expect(pausaMs('x'.repeat(5000))).toBeLessThanOrEqual(2000);
    expect(pausaMs('')).toBeGreaterThanOrEqual(500);
  });
});

describe('aFormatoWhatsapp', () => {
  it('convierte la negrita de markdown a la de WhatsApp', () => {
    // El caso real, visto en el banco: el cliente recibía los asteriscos literales.
    expect(aFormatoWhatsapp('• **900 Megas + TV**: $140.000'))
      .toBe('• *900 Megas + TV*: $140.000');
  });

  it('NO se come los asteriscos sueltos', () => {
    // El motor pregunta "Responde *SÍ* para confirmar": borrarlos a lo bruto
    // se llevaría por delante su formato.
    expect(aFormatoWhatsapp('Responde *SÍ* para confirmar')).toBe('Responde *SÍ* para confirmar');
    expect(aFormatoWhatsapp('* uno\n* dos')).toBe('* uno\n* dos');
  });

  it('traduce encabezados y subrayados, que WhatsApp tampoco tiene', () => {
    expect(aFormatoWhatsapp('## Planes para el hogar')).toBe('*Planes para el hogar*');
    expect(aFormatoWhatsapp('__importante__')).toBe('_importante_');
  });

  it('aguanta texto vacío o nulo sin reventar', () => {
    expect(aFormatoWhatsapp('')).toBe('');
    expect(aFormatoWhatsapp(undefined as unknown as string)).toBe('');
  });
});
