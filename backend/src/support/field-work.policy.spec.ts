import { esTrabajoDeCampo, tiposDeCampo } from './field-work.policy';

/**
 * Los 40 tipos distintos que existen de verdad en la base, con el volumen que
 * movió cada uno en el último año. Es la lista contra la que hay que probar: si
 * la clasificación falla aquí, falla en producción.
 */
const CATALOGO_REAL: [string, number][] = [
  ['Corte Internet', 15543], ['Reconexion Internet', 12014], ['Corte Television', 9867],
  ['Reconexion Television', 7780], ['Revision de Internet', 4143], ['Reconexion Internet2', 2184],
  ['Revision tv e internet', 2166], ['Revision de television', 2159], ['Reconexion Television2', 1636],
  ['Autenticacion', 1555], ['Cambio de clave', 914], ['Instalacion', 866],
  ['Retiro voluntario', 640], ['Traslado', 520], ['Cambio de equipo', 510],
  ['Migracion', 432], ['Reinstalación', 386], ['Corte Combo', 249],
  ['Subir megas', 237], ['Punto nuevo', 150], ['Suspension Television', 135],
  ['Traslado interno De Equipos Red en cliente final', 69], ['AgregarTelevision', 57],
  ['AgregarInternet', 54], ['Recuperación cable modem', 46], ['Suspension Internet', 37],
  ['Toma Adicional', 34], ['-', 26], ['Suspension Combo', 21],
  ['Mejoramiento y/o Mantenimiento Red Fibra Óptica', 17], ['Veeduria', 16],
  ['Bajar megas', 8], ['Equipo adicional', 5], ['Viabilidad y/o levantamiento técnico', 3],
  ['...', 2], ['Instalación y/o Mantenimiento de Equipos Activos d', 2],
  ['Reconexion Combo2', 1], ['Entrega De Servicio A Satisfacción', 1],
  ['Servicio Adicional', 1], ['Reconexion Combo', 1],
];

const TIPOS_REALES = CATALOGO_REAL.map(([t]) => t);

describe('esTrabajoDeCampo', () => {
  it('cuenta las visitas reales al domicilio', () => {
    for (const t of ['Revision de Internet', 'Revision tv e internet', 'Instalacion', 'Reinstalación', 'Punto nuevo', 'Cambio de equipo', 'Traslado']) {
      expect(esTrabajoDeCampo(t)).toBe(true);
    }
  });

  it('cuenta el trabajo en la red aunque no haya domicilio', () => {
    // Este es el caso que separa esta política de la geo-cerca: es trabajo de
    // campo, pero no hay casa de abonado contra la cual medir distancia.
    expect(esTrabajoDeCampo('Mejoramiento y/o Mantenimiento Red Fibra Óptica')).toBe(true);
    expect(esTrabajoDeCampo('Instalación y/o Mantenimiento de Equipos Activos d')).toBe(true);
  });

  it('descarta los cortes y reconexiones, que son el 81% del volumen', () => {
    for (const t of ['Corte Internet', 'Corte Television', 'Reconexion Internet', 'Reconexion Internet2', 'Reconexion Television2', 'Suspension Combo']) {
      expect(esTrabajoDeCampo(t)).toBe(false);
    }
  });

  it('descarta lo que suena a técnico pero se hace sentado', () => {
    // Autenticación se hace desde la OLT y el cambio de clave desde el panel.
    expect(esTrabajoDeCampo('Autenticacion')).toBe(false);
    expect(esTrabajoDeCampo('Cambio de clave')).toBe(false);
    expect(esTrabajoDeCampo('Subir megas')).toBe(false);
    expect(esTrabajoDeCampo('Bajar megas')).toBe(false);
    // La baja es administrativa; ir a recoger el equipo es otra orden.
    expect(esTrabajoDeCampo('Retiro voluntario')).toBe(false);
    expect(esTrabajoDeCampo('Recuperación cable modem')).toBe(true);
  });

  it('no revienta con la basura que trae el legacy', () => {
    for (const t of ['-', '...', '', null, undefined]) {
      expect(esTrabajoDeCampo(t)).toBe(false);
    }
  });

  it('ignora tildes y mayúsculas', () => {
    expect(esTrabajoDeCampo('REVISIÓN DE INTERNET')).toBe(true);
    expect(esTrabajoDeCampo('migración')).toBe(true);
  });
});

describe('tiposDeCampo', () => {
  it('deja fuera la mayoría del VOLUMEN, que es lo que importa', () => {
    // La prueba real no es cuántos tipos entran sino cuántas órdenes. Sobre el
    // último año el trabajo de campo es ~18% de las 65.000 órdenes: si esto se
    // dispara, se colaron los cortes y el tablero vuelve a mentir; si se
    // desploma, se cayó algo que sí era campo y quedan técnicos sin medir.
    const campo = new Set(tiposDeCampo(TIPOS_REALES));
    const total = CATALOGO_REAL.reduce((s, [, n]) => s + n, 0);
    const enCampo = CATALOGO_REAL.filter(([t]) => campo.has(t)).reduce((s, [, n]) => s + n, 0);
    const pct = (100 * enCampo) / total;
    expect(pct).toBeGreaterThan(12);
    expect(pct).toBeLessThan(25);
    expect(campo.has('Revision de Internet')).toBe(true);
    expect(campo.has('Corte Internet')).toBe(false);
  });

  it('el ajuste manual manda sobre los patrones', () => {
    // Gerencia decide medir SOLO instalaciones: los patrones no deben colarse.
    const campo = tiposDeCampo(TIPOS_REALES, 'Instalacion, Punto nuevo');
    expect(campo).toEqual(['Instalacion', 'Punto nuevo']);
  });

  it('el ajuste manual tolera tildes y espacios de más', () => {
    expect(tiposDeCampo(TIPOS_REALES, '  reinstalacion ,  MIGRACIÓN ')).toEqual(['Migracion', 'Reinstalación']);
  });

  it('un ajuste vacío cae de vuelta en los patrones', () => {
    expect(tiposDeCampo(TIPOS_REALES, '   ')).toEqual(tiposDeCampo(TIPOS_REALES));
  });
});
