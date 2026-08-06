import { PUNTAJE_MAX, PUNTAJE_MIN, PUNTAJE_POR_DEFECTO, esPuntajeValido, puntajeSugerido } from './order-score.policy';
import { DETALLES_POR_CLASE } from './order-types';

describe('puntajeSugerido', () => {
  it('pone la instalación en lo más alto de la escala', () => {
    expect(puntajeSugerido('Instalacion')).toBe(5);
    expect(puntajeSugerido('Instalación y/o Mantenimiento de Equipos Activos d')).toBe(5);
  });

  it('NO cobra una reinstalación como una instalación nueva', () => {
    // El patrón 'instalac' calza con 'Reinstalación'. Si el orden de la lista se
    // altera, esta prueba es la que avisa: sería un punto de más en 1.205 órdenes.
    expect(puntajeSugerido('Reinstalación')).toBe(4);
    expect(puntajeSugerido('Reinstalacion')).toBe(4);
  });

  it('vale lo mismo con tildes, mayúsculas o espacios de más', () => {
    expect(puntajeSugerido('  REVISION   DE INTERNET ')).toBe(puntajeSugerido('Revisión de Internet'));
  });

  it('deja el trabajo de escritorio en el mínimo', () => {
    for (const t of ['Corte Internet', 'Reconexion Television', 'Suspension Combo', 'Cambio de clave', 'Subir megas']) {
      expect(puntajeSugerido(t)).toBe(1);
    }
  });

  it('un tipo que no conoce vale una visita normal, no cero', () => {
    expect(puntajeSugerido('Trabajo que nadie ha inventado todavía')).toBe(PUNTAJE_POR_DEFECTO);
    expect(puntajeSugerido(null)).toBe(PUNTAJE_POR_DEFECTO);
    expect(puntajeSugerido('')).toBe(PUNTAJE_POR_DEFECTO);
  });

  it('todo el catálogo cae dentro de la escala', () => {
    for (const lista of Object.values(DETALLES_POR_CLASE)) {
      for (const tipo of lista) {
        const p = puntajeSugerido(tipo);
        expect(Number.isInteger(p)).toBe(true);
        expect(p).toBeGreaterThanOrEqual(PUNTAJE_MIN);
        expect(p).toBeLessThanOrEqual(PUNTAJE_MAX);
      }
    }
  });
});

describe('esPuntajeValido', () => {
  it('acepta sólo enteros de 1 a 5', () => {
    expect(esPuntajeValido(1)).toBe(true);
    expect(esPuntajeValido(5)).toBe(true);
    expect(esPuntajeValido(0)).toBe(false);
    expect(esPuntajeValido(6)).toBe(false);
    expect(esPuntajeValido(3.5)).toBe(false);
    expect(esPuntajeValido('4')).toBe(false);
    expect(esPuntajeValido(null)).toBe(false);
  });
});
