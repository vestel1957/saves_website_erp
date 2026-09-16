/**
 * El plan del abonado leído de la cabecera de su recurrente del legacy (combo/television).
 * Es lo que hace bajar un 'Subir megas' cerrado allá hasta la ficha de aquí.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- los scripts del sync son JS puro (corren sin build), no hay módulo TS que importar
const pc = require('../../scripts/lib/plan-cabecera');

const catalogo = pc.armarCatalogo([
  { id: 'p100', kind: 'INTERNET', name: '100 Megas F-26', price: 58000 },
  { id: 'p300', kind: 'INTERNET', name: '300Megas26F', price: 58500 },
  { id: 'p300b', kind: 'INTERNET', name: '300megas26f', price: 60000 },
  { id: 'p0', kind: 'INTERNET', name: 'Gratis', price: 0 },
  { id: 'tv26', kind: 'TV', name: 'Television26', price: 22269 },
]);

describe('plan desde la cabecera del legacy', () => {
  it('lee vacío como "no lo dice", "no" y SoloTelevision como quitar', () => {
    expect(pc.leerColumna('INTERNET', '').que).toBe('nada');
    expect(pc.leerColumna('INTERNET', ' - ').que).toBe('nada');
    expect(pc.leerColumna('TV', 'no').que).toBe('quitar');
    expect(pc.leerColumna('INTERNET', 'SoloTelevision22').que).toBe('quitar');
    expect(pc.leerColumna('TV', 'SoloTelevision')).toEqual({ que: 'plan', nombre: 'SoloTelevision' });
  });

  it('un espacio o una mayúscula no es un cambio de plan', () => {
    expect(pc.mismaCabecera({ tv: 'SoloTelevision ', combo: 'no', puntos: null }, { tv: 'solotelevision', combo: 'NO', puntos: 0 })).toBe(true);
    expect(pc.serviciosMovidos({ tv: 'Television26', combo: '100 Megas F-26' }, { tv: 'Television26', combo: '600Megas26F' })).toEqual(['INTERNET']);
    expect(pc.mismaCabecera({ tv: 'x', combo: 'y', puntos: 1 }, { tv: 'x', combo: 'y', puntos: 2 })).toBe(false);
  });

  it('subir megas: cambia el internet al plan del catálogo, el más caro de los duplicados', () => {
    const cambios = pc.cambiosDePlan({
      cabecera: { combo: '300Megas26F', tv: 'Television26' },
      servicios: [{ id: 's1', kind: 'INTERNET', planName: '100 Megas F-26' }, { id: 's2', kind: 'TV', planName: 'Television26' }],
      catalogo,
    });
    expect(cambios).toEqual([{ tipo: 'cambiar', kind: 'INTERNET', id: 's1', de: '100 Megas F-26', plan: expect.objectContaining({ id: 'p300b' }) }]);
  });

  it('sólo toca los servicios que se movieron', () => {
    const cambios = pc.cambiosDePlan({
      cabecera: { combo: '300Megas26F', tv: 'no' },
      servicios: [{ id: 's1', kind: 'INTERNET', planName: '100 Megas F-26' }, { id: 's2', kind: 'TV', planName: 'Television26' }],
      catalogo,
      kinds: ['TV'],
    });
    expect(cambios).toEqual([{ tipo: 'quitar', kind: 'TV', id: 's2', de: 'Television26' }]);
  });

  it('no crea la pata que le falta a la ficha (la corrida la deriva) y reporta el plan fuera del catálogo', () => {
    const cambios = pc.cambiosDePlan({
      cabecera: { combo: '300 Megas F-S', tv: 'Television26' },
      servicios: [{ id: 's1', kind: 'INTERNET', planName: '100 Megas F-26' }],
      catalogo,
    });
    expect(cambios).toEqual([
      { tipo: 'sinCatalogo', kind: 'INTERNET', nombre: '300 Megas F-S', de: '100 Megas F-26' },
      { tipo: 'pataFaltante', kind: 'TV', nombre: 'Television26' },
    ]);
  });

  it('al abonado sin ficha (plan derivado de sus facturas) no le siembra la tarifa de catálogo', () => {
    const soloPuntos = [{ id: 'pt', kind: 'PUNTOS', planName: 'Punto Adicional' }];
    expect(pc.cambiosDePlan({ cabecera: { combo: '300Megas26F', tv: 'Television26' }, servicios: [], catalogo })).toEqual([{ tipo: 'derivado' }]);
    expect(pc.cambiosDePlan({ cabecera: { combo: '300Megas26F' }, servicios: soloPuntos, catalogo })).toEqual([{ tipo: 'derivado' }]);
  });

  it('un plan sin precio no tarifa', () => {
    const cambios = pc.cambiosDePlan({
      cabecera: { combo: 'Gratis' }, servicios: [{ id: 's2', kind: 'INTERNET', planName: '100 Megas F-26' }], catalogo, kinds: ['INTERNET'],
    });
    expect(cambios[0].tipo).toBe('sinCatalogo');
  });
});
