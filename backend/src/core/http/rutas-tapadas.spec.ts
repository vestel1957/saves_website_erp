/**
 * El candado que impide que se repita el fallo de las 22 rutas muertas.
 *
 * Dos capas:
 *  - la lógica de detección, con casos armados a mano (rápido, sin base de datos);
 *  - las rutas REALES del proyecto, para que el día que alguien reordene un router
 *    o añada un endpoint literal bajo un `/:id` el fallo salga aquí y no en
 *    producción tres semanas después.
 *
 * Contexto completo en `rutas-tapadas.ts`.
 */
// Los DTO llevan decoradores de class-validator: sin esto, importar los routers
// reales revienta con "Reflect.getMetadata is not a function". `main.ts` lo carga
// igual, en su primera línea.
import 'reflect-metadata';
import { crearRouter, manejar } from './ruta';
import { rutasTapadas } from './rutas-tapadas';

const nada = manejar(() => null);

describe('rutasTapadas', () => {
  it('detecta la literal que queda debajo de una paramétrica', () => {
    const r = crearRouter();
    r.get('/:id', nada);
    r.get('/stats', nada);

    expect(rutasTapadas([{ prefijo: 'x', router: r }])).toEqual([
      { metodo: 'GET', prefijo: 'x', tapada: '/stats', tapadora: '/:id' },
    ]);
  });

  it('no se queja si la literal va primero (el orden correcto)', () => {
    const r = crearRouter();
    r.get('/stats', nada);
    r.get('/:id', nada);

    expect(rutasTapadas([{ prefijo: 'x', router: r }])).toEqual([]);
  });

  it('no confunde verbos distintos', () => {
    const r = crearRouter();
    r.delete('/:id', nada);
    r.get('/stats', nada);

    expect(rutasTapadas([{ prefijo: 'x', router: r }])).toEqual([]);
  });

  it('sí cuenta `all`, que responde a cualquier verbo', () => {
    const r = crearRouter();
    r.all('/:id', nada);
    r.get('/stats', nada);

    expect(rutasTapadas([{ prefijo: 'x', router: r }])).toHaveLength(1);
  });

  it('mira segmento a segmento, no la ruta entera', () => {
    const r = crearRouter();
    r.get('/tickets/:id', nada);
    r.get('/tickets/export.xlsx', nada); // el caso real de support
    r.get('/otros/export.xlsx', nada); // distinto padre: no lo tapa

    expect(rutasTapadas([{ prefijo: 'x', router: r }])).toEqual([
      { metodo: 'GET', prefijo: 'x', tapada: '/tickets/export.xlsx', tapadora: '/tickets/:id' },
    ]);
  });

  it('no señala rutas con distinto número de segmentos', () => {
    const r = crearRouter();
    r.get('/:id', nada);
    r.get('/:id/historial', nada);

    expect(rutasTapadas([{ prefijo: 'x', router: r }])).toEqual([]);
  });

  it('no señala dos paramétricas ni una repetida (no es este fallo)', () => {
    const r = crearRouter();
    r.get('/:id', nada);
    r.get('/:otro', nada);
    r.get('/:id', nada);

    expect(rutasTapadas([{ prefijo: 'x', router: r }])).toEqual([]);
  });

  it('calla ante un parámetro con patrón propio, que no acepta cualquier cosa', () => {
    const r = crearRouter();
    r.get('/:id(\\d+)', nada);
    r.get('/stats', nada);

    expect(rutasTapadas([{ prefijo: 'x', router: r }])).toEqual([]);
  });

  it('cruza routers que comparten prefijo, respetando el orden de montaje', () => {
    // `network`, `whatsapp`, `admin` y `profile` montan varios routers bajo la
    // misma raíz: ahí el solapamiento cruza ficheros y ningún generador lo ve.
    const primero = crearRouter();
    primero.get('/:id', nada);
    const segundo = crearRouter();
    segundo.get('/modo', nada);

    expect(
      rutasTapadas([
        { prefijo: 'compartido', router: primero },
        { prefijo: 'compartido', router: segundo },
      ]),
    ).toEqual([
      { metodo: 'GET', prefijo: 'compartido', tapada: '/modo', tapadora: '/:id' },
    ]);

    // Al revés no hay conflicto: el literal se prueba antes.
    expect(
      rutasTapadas([
        { prefijo: 'compartido', router: segundo },
        { prefijo: 'compartido', router: primero },
      ]),
    ).toEqual([]);
  });

  it('no mezcla prefijos distintos', () => {
    const uno = crearRouter();
    uno.get('/:id', nada);
    const otro = crearRouter();
    otro.get('/stats', nada);

    expect(rutasTapadas([{ prefijo: 'a', router: uno }, { prefijo: 'b', router: otro }])).toEqual([]);
  });
});

describe('las rutas reales del proyecto', () => {
  it('no tiene ninguna ruta inalcanzable', () => {
    // Import perezoso: arrastra los 48 routers y con ellos el contenedor.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { RUTAS } = require('../rutas') as typeof import('../rutas');

    const conflictos = rutasTapadas(RUTAS);
    // El mensaje de fallo lista las rutas muertas, que es lo que hay que arreglar.
    expect(conflictos.map((c) => `${c.metodo} /api/${c.prefijo}${c.tapada} <- ${c.tapadora}`)).toEqual([]);
  });
});
