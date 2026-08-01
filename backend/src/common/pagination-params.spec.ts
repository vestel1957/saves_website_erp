import { direccion, orden, ordenSql, paginacion } from './pagination-params';

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

describe('direccion', () => {
  it.each([
    ['desc', 'desc'],
    ['DESC', 'desc'],
    ['asc', 'asc'],
    ['cualquier cosa', 'asc'],
    [undefined, 'asc'],
    [null, 'asc'],
  ])('%s → %s', (entrada, esperado) => {
    expect(direccion(entrada)).toBe(esperado);
  });
});

describe('orden', () => {
  const PERMITIDAS = {
    nombre: 'name',
    sede: 'branch.name',
    saldo: (dir: 'asc' | 'desc') => ({ balance: { sort: dir, nulls: 'last' } }),
  };
  const PORDEFECTO = { createdAt: 'desc' };

  it('columna permitida: la traduce y añade el desempate', () => {
    expect(orden({ sortBy: 'nombre', sortDir: 'asc' }, PERMITIDAS, PORDEFECTO)).toEqual([
      { name: 'asc' },
      { id: 'asc' },
    ]);
  });

  it('ruta anidada', () => {
    expect(orden({ sortBy: 'sede', sortDir: 'desc' }, PERMITIDAS, PORDEFECTO)).toEqual([
      { branch: { name: 'desc' } },
      { id: 'asc' },
    ]);
  });

  it('función para lo fino (nulos al final)', () => {
    expect(orden({ sortBy: 'saldo', sortDir: 'desc' }, PERMITIDAS, PORDEFECTO)).toEqual([
      { balance: { sort: 'desc', nulls: 'last' } },
      { id: 'asc' },
    ]);
  });

  it('sin sortBy: el orden de siempre, intacto', () => {
    expect(orden({}, PERMITIDAS, PORDEFECTO)).toBe(PORDEFECTO);
  });

  it('columna que no está en la lista blanca: se ignora, no revienta', () => {
    // Es lo que llegaría si alguien juega con la URL o si el frontend marca
    // `sortable` en una columna que el endpoint no conoce.
    expect(orden({ sortBy: 'password' }, PERMITIDAS, PORDEFECTO)).toBe(PORDEFECTO);
    expect(orden({ sortBy: '../../etc/passwd' }, PERMITIDAS, PORDEFECTO)).toBe(PORDEFECTO);
    expect(orden({ sortBy: '' }, PERMITIDAS, PORDEFECTO)).toBe(PORDEFECTO);
    expect(orden({ sortBy: 42 }, PERMITIDAS, PORDEFECTO)).toBe(PORDEFECTO);
    expect(orden({ sortBy: { name: 'asc' } }, PERMITIDAS, PORDEFECTO)).toBe(PORDEFECTO);
  });

  it('el desempate evita que una fila salga en dos páginas', () => {
    // Sin clave única al final, dos filas con el mismo `name` pueden salir en
    // distinto orden en la consulta de la página 1 y la de la página 2: una
    // aparece repetida y otra no aparece nunca.
    const r = orden({ sortBy: 'nombre' }, PERMITIDAS, PORDEFECTO) as unknown as unknown[];
    expect(r[r.length - 1]).toEqual({ id: 'asc' });
  });

  it('se puede quitar el desempate (listados sin id)', () => {
    expect(orden({ sortBy: 'nombre' }, PERMITIDAS, PORDEFECTO, { desempate: null })).toEqual([
      { name: 'asc' },
    ]);
  });

  it('desempate propio', () => {
    expect(orden({ sortBy: 'nombre' }, PERMITIDAS, PORDEFECTO, { desempate: { code: 'asc' } })).toEqual([
      { name: 'asc' },
      { code: 'asc' },
    ]);
  });

  it('una traducción de varias claves se conserva entera', () => {
    const varias = { fecha: () => [{ date: 'desc' }, { hora: 'desc' }] };
    expect(orden({ sortBy: 'fecha' }, varias, PORDEFECTO)).toEqual([
      { date: 'desc' },
      { hora: 'desc' },
      { id: 'asc' },
    ]);
  });
});

describe('ordenSql', () => {
  const PERMITIDAS = { nombre: 's.name', saldo: 's.balance' };

  it('columna permitida', () => {
    expect(ordenSql({ sortBy: 'saldo', sortDir: 'desc' }, PERMITIDAS, 's.name ASC')).toBe(
      's.balance DESC NULLS LAST',
    );
  });

  it('nunca interpola lo que llega del usuario', () => {
    // El sortBy solo sirve para *elegir* de la lista blanca; el SQL sale de ahí.
    const inyeccion = "s.name; DROP TABLE subscribers; --";
    expect(ordenSql({ sortBy: inyeccion }, PERMITIDAS, 's.name ASC')).toBe('s.name ASC');
    expect(ordenSql({ sortBy: 'nombre', sortDir: "asc; DROP TABLE x" }, PERMITIDAS, 's.name ASC')).toBe(
      's.name ASC NULLS LAST',
    );
  });

  it('con desempate', () => {
    expect(ordenSql({ sortBy: 'nombre' }, PERMITIDAS, 's.name ASC', { desempate: 's.id ASC' })).toBe(
      's.name ASC NULLS LAST, s.id ASC',
    );
  });
});
