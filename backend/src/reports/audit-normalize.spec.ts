import { moduloDe, normalizarRuta } from './audit-normalize';

describe('normalizarRuta', () => {
  it('reemplaza los cuid de Prisma para que las rutas se puedan agrupar', () => {
    // Estos son valores reales de la bitácora: sin normalizar, cada uno de los
    // 40 cierres de orden cuenta como una "acción" distinta.
    expect(normalizarRuta('POST /support/tickets/cmrtp1j100001dz8t0hrhq7ot/status'))
      .toBe('POST /support/tickets/:id/status');
    expect(normalizarRuta('orders/cmrxqyhsm0007dzciiz4swt7d')).toBe('orders/:id');
  });

  it('reemplaza varios identificadores en la misma ruta', () => {
    expect(normalizarRuta('PATCH /staff/cmr3q42nx002tdzpmptvtkz86/roles/cmri1ha130000dziw6wldkseh'))
      .toBe('PATCH /staff/:id/roles/:id');
  });

  it('reemplaza uuid e ids numéricos', () => {
    expect(normalizarRuta('/files/3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe('/files/:id');
    expect(normalizarRuta('/invoices/48213/pay')).toBe('/invoices/:id/pay');
  });

  it('deja intactas las acciones que no llevan identificadores', () => {
    expect(normalizarRuta('LOGIN')).toBe('LOGIN');
    expect(normalizarRuta('LOGIN_FAILED')).toBe('LOGIN_FAILED');
    expect(normalizarRuta('POST /inventory/alerts/run')).toBe('POST /inventory/alerts/run');
  });

  it('no confunde una palabra normal con un cuid', () => {
    // "categories" empieza por c pero no es un identificador.
    expect(normalizarRuta('POST /config/categories')).toBe('POST /config/categories');
    expect(normalizarRuta('/network/conexiones')).toBe('/network/conexiones');
  });

  it('sobrevive a valores vacíos', () => {
    expect(normalizarRuta(null)).toBe('—');
    expect(normalizarRuta('')).toBe('—');
  });
});

describe('moduloDe', () => {
  it('toma el primer tramo de la ruta', () => {
    expect(moduloDe('support/tickets/cmr3mhret00c3dzvc6xbf4uaw')).toBe('support');
    expect(moduloDe('network/olt')).toBe('network');
    expect(moduloDe('login')).toBe('login');
  });

  it('unifica mayúsculas: la bitácora escribe Auth y auth indistintamente', () => {
    expect(moduloDe('Auth')).toBe('auth');
    expect(moduloDe('auth/roles')).toBe('auth');
  });

  it('sobrevive a valores vacíos', () => {
    expect(moduloDe(null)).toBe('—');
    expect(moduloDe('   ')).toBe('—');
  });
});
