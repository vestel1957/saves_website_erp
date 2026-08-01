import type { Turn } from '@s4gk/wa-agent';
import { recortarHistorial, sanearHistorial } from './chat-history';

const user = (c: string): Turn => ({ role: 'user', content: c });
const bot = (c: string): Turn => ({ role: 'assistant', content: c });
const pide = (...ids: string[]): Turn => ({
  role: 'assistant', content: '', toolCalls: ids.map((id) => ({ id, name: 'x', input: {} })) as any,
});
const resp = (id: string): Turn => ({ role: 'tool', toolCallId: id, name: 'x', content: 'ok' });

describe('sanearHistorial', () => {
  it('deja intacto un historial sano', () => {
    const h = [user('hola'), pide('a'), resp('a'), bot('listo')];
    expect(sanearHistorial(h)).toEqual(h);
  });

  /** El caso real: le pasó a un superusuario y lo dejó sin bot casi dos días. */
  it('quita el resultado de herramienta HUÉRFANO que dejaba la conversación muerta', () => {
    const h = [resp('perdido'), bot('respuesta'), user('otra cosa')];
    expect(sanearHistorial(h)).toEqual([bot('respuesta'), user('otra cosa')]);
  });

  it('quita varios huérfanos seguidos', () => {
    const h = [resp('p1'), resp('p2'), bot('x')];
    expect(sanearHistorial(h)).toEqual([bot('x')]);
  });

  it('descarta un bloque de herramientas al que le falta una respuesta', () => {
    // El proceso murió entre la petición y el resultado.
    const h = [user('a'), pide('t1', 't2'), resp('t1'), user('b')];
    expect(sanearHistorial(h)).toEqual([user('a'), user('b')]);
  });

  it('descarta una petición de herramienta que quedó colgando al final', () => {
    const h = [user('a'), bot('ok'), pide('t9')];
    expect(sanearHistorial(h)).toEqual([user('a'), bot('ok')]);
  });

  it('acepta un assistant con VARIAS herramientas si llegan todas sus respuestas', () => {
    const h = [user('a'), pide('t1', 't2'), resp('t1'), resp('t2'), bot('fin')];
    expect(sanearHistorial(h)).toEqual(h);
  });

  it('no se cae con basura', () => {
    expect(sanearHistorial(null as any)).toEqual([]);
    expect(sanearHistorial([null as any, undefined as any, user('a')])).toEqual([user('a')]);
  });
});

describe('recortarHistorial', () => {
  it('nunca deja la ventana empezando por un resultado de herramienta', () => {
    // Recortar a 3 partiría el par pide/resp por la mitad.
    const h = [user('1'), pide('a'), resp('a'), bot('2'), user('3')];
    const r = recortarHistorial(h, 3);
    expect(r[0].role).not.toBe('tool');
    expect(r).toEqual([bot('2'), user('3')]);
  });

  it('respeta el tope', () => {
    const h = Array.from({ length: 40 }, (_, i) => user(`m${i}`));
    expect(recortarHistorial(h, 20)).toHaveLength(20);
  });

  it('conserva el par completo cuando sí cabe', () => {
    const h = [user('1'), pide('a'), resp('a'), bot('2')];
    expect(recortarHistorial(h, 20)).toEqual(h);
  });
});
