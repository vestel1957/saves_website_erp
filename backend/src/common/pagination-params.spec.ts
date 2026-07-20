import { paginacion } from './pagination-params';

describe('paginacion', () => {
  it('valores normales', () => {
    expect(paginacion({ page: 3, pageSize: 50 })).toEqual({ page: 3, pageSize: 50, skip: 100, take: 50 });
  });

  it('sin parámetros: primera página con el tamaño por defecto', () => {
    expect(paginacion({})).toMatchObject({ page: 1, pageSize: 25, skip: 0 });
  });

  it.each([
    ['texto', 'abc'],
    ['vacío', ''],
    ['nulo', null],
    ['Infinity', '1e999'],
    ['-Infinity', '-1e999'],
  ])('basura (%s) cae en el valor por defecto', (_etq, valor) => {
    expect(paginacion({ page: valor, pageSize: valor })).toMatchObject({ page: 1, pageSize: 25 });
  });

  it('Infinity es el caso que se colaba: no es NaN, así que `|| 1` no lo atrapaba', () => {
    // Llegaba como `skip: Infinity` a Prisma, que lo rechaza (500 antes del filtro
    // global de excepciones, 400 después). Ahora ni una cosa ni la otra.
    expect(Number('1e999')).toBe(Infinity);
    expect(Number('1e999') || 1).toBe(Infinity); // el clamp viejo lo dejaba pasar
    expect(paginacion({ page: '1e999' }).skip).toBe(0);
  });

  it('page negativa se acota a la primera', () => {
    expect(paginacion({ page: -5 }).page).toBe(1);
  });

  it('pageSize 0 o negativo = "no me lo mandaron", no "un elemento"', () => {
    // Los controllers hacen `Number(pageSize)` antes de llamar aquí, así que un
    // `?pageSize=` vacío llega como 0. Acotarlo a 1 serviría 1 fila por página.
    expect(paginacion({ pageSize: 0 }).pageSize).toBe(25);
    expect(paginacion({ pageSize: -10 }).pageSize).toBe(25);
  });

  it('un pageSize desmedido se capa al máximo', () => {
    expect(paginacion({ pageSize: 99999 }).pageSize).toBe(100);
  });

  it('el máximo es parametrizable (la vista de abonados con plan carga 500)', () => {
    expect(paginacion({ pageSize: 500 }, { maxPageSize: 500 }).pageSize).toBe(500);
  });

  it('los decimales se truncan, no redondean: pedir la página 2.9 es pedir la 2', () => {
    expect(paginacion({ page: 2.9 }).page).toBe(2);
  });
});
