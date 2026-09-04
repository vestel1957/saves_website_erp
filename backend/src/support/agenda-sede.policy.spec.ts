import { esDeMisSedes, sedesDelStaff } from './agenda-sede';

/** Las sedes reales, para que los casos se lean como lo que pasa en la calle. */
const YOPAL = 2;
const VILLANUEVA = 3;
const MONTERREY = 4;

describe('sedesDelStaff', () => {
  it('lee el CSV del legacy', () => {
    expect(sedesDelStaff('-3-')).toEqual([VILLANUEVA]);
    expect(sedesDelStaff('-3-,-4-')).toEqual([VILLANUEVA, MONTERREY]);
  });

  it('vacío o basura = sin sede atada', () => {
    expect(sedesDelStaff(null)).toEqual([]);
    expect(sedesDelStaff('')).toEqual([]);
    expect(sedesDelStaff('-0-,--')).toEqual([]);
  });
});

/**
 * El caso que lo motivó (2026-08-31): Mireya, cajera de Villanueva, veía en el
 * tablero a tres técnicos de Yopal. La lista de técnicos SÍ se acotaba, pero el
 * rescate de "los que ya tienen algo agendado hoy" no, así que el acotado por sede
 * sólo se cumplía los días en que las otras sedes no tenían agenda.
 */
describe('esDeMisSedes', () => {
  it('la cajera de Villanueva ve a los suyos', () => {
    expect(esDeMisSedes('-3-', [VILLANUEVA])).toBe(true);
  });

  it('y NO ve a los de Yopal, tengan o no trabajo puesto', () => {
    expect(esDeMisSedes('-2-', [VILLANUEVA])).toBe(false);
  });

  it('el técnico compartido entre dos sedes sale en las dos', () => {
    expect(esDeMisSedes('-3-,-4-', [VILLANUEVA])).toBe(true);
    expect(esDeMisSedes('-3-,-4-', [MONTERREY])).toBe(true);
    expect(esDeMisSedes('-3-,-4-', [YOPAL])).toBe(false);
  });

  it('sin alcance (gerencia, superusuario) se ve a todo el mundo', () => {
    expect(esDeMisSedes('-2-', [])).toBe(true);
    expect(esDeMisSedes(null, [])).toBe(true);
  });

  it('el técnico sin sede en la ficha lo ve todo el mundo, no nadie', () => {
    // Las dos convenciones son opuestas y es justo donde se equivocaría el arreglo:
    // dejarlo fuera lo volvería invisible para TODAS las cajeras a la vez.
    expect(esDeMisSedes(null, [VILLANUEVA])).toBe(true);
    expect(esDeMisSedes('', [YOPAL])).toBe(true);
  });
});
