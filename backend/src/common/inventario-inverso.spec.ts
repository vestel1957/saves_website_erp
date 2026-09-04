/**
 * Mapeos PG → legacy del inventario (la vuelta que se abrió el 2026-08-27).
 *
 * Lo que se comprueba aquí es lo que rompe una fila entera en MySQL estricto: un ENUM con
 * un valor que allá no existe, o un NOT NULL sin default que llega vacío. Un fallo así no
 * se ve hasta que alguien crea el primer equipo o el primer material.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- los scripts del sync son JS puro (corren sin build), no hay módulo TS que importar
const map = require('../../scripts/lib/vestel-map');

describe('inventario: mapeo hacia el legacy', () => {
  it('material: un ENUM que allá no existe viaja como NULL, no rompe la fila', () => {
    const fila = map.invMaterial({ name: 'Conector', qty: 5, serviceType: 'Inventado', tvOrNet: 'Tv' });
    expect(fila.tipo_servicio).toBeNull();
    expect(fila.pertence_a_tv_o_net).toBe('Tv');
  });

  it('material: categoría y bodega caen a las de por defecto del legacy si faltan', () => {
    const fila = map.invMaterial({ name: 'Conector' });
    expect(fila.pcat).toBe(1);
    expect(fila.warehouse).toBe(1);
    expect(fila.qty).toBe(0);
  });

  it('material: el nombre se corta a los 50 de la columna', () => {
    const fila = map.invMaterial({ name: 'x'.repeat(80) });
    expect(fila.product_name).toHaveLength(50);
  });

  it('equipo: las fechas NOT NULL se rellenan y las opcionales se respetan', () => {
    const fila = map.invEquipo({ serial: 'ABC', arrival: null, endDate: null }, '2026-08-27');
    expect(fila.llegada).toBe('2026-08-27');
    expect(fila.final).toBe('2026-08-27');
    // `asignado` es NOT NULL allá: vacío, nunca null.
    expect(fila.asignado).toBe('');
    expect(fila.estado).toBe('Bodega');
  });

  it('orden: rellena los campos del flujo del legacy que aquí no existen', () => {
    const fila = map.invOrden({ tid: 3300, total: 100, status: 'aprobado' }, 7, '2026-08-27');
    expect(fila.csd).toBe(7);
    expect(fila.status).toBe('aprobado');
    expect(fila).toMatchObject({ eid: 0, aid: 0, a2id: 0, discstatus: 0, term: 0 });
  });

  it('orden: un estado que el ENUM de allá no conoce cae a "pendiente"', () => {
    expect(map.invOrden({ tid: 1, status: 'a-medio-recibir' }, 1, '2026-08-27').status).toBe('pendiente');
  });

  it('renglón de orden: el puente es el tid de la orden, no su id', () => {
    const fila = map.invOrdenItem({ product: 'Cable', qty: 3, price: 1500, materialLegacy: 42 }, 3300);
    expect(fila).toMatchObject({ tid: 3300, pid: 42, qty: 3, price: 1500 });
  });
});
