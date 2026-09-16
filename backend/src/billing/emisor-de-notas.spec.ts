/**
 * El candado de quién emite notas crédito/débito.
 *
 * Lo que se prueba de verdad es el caso que hace inútil un permiso normal: el
 * SUPERUSUARIO. Los dos autorizados son `system.admin`, igual que los otros once,
 * así que si esta comprobación heredara el atajo de `exigirPermisos()` no estaría
 * restringiendo a nadie y el test pasaría igual. Por eso hay un caso explícito.
 */
import { puedeEmitirNotas, exigirEmisorDeNotas } from './emisor-de-notas';
import { APP_PERMISSIONS, ALL_ROLES, PERMISOS_NOMINALES } from '../auth/permissions.catalog';

const con = (...permissions: string[]) => ({ permissions });

describe('puedeEmitirNotas', () => {
  it('deja emitir a quien tiene el permiso concedido', () => {
    expect(puedeEmitirNotas(con(APP_PERMISSIONS.BILLING_NOTES_EMIT))).toBe(true);
  });

  it('NO deja emitir al superusuario por el hecho de serlo', () => {
    expect(puedeEmitirNotas(con(APP_PERMISSIONS.SYSTEM_ADMIN))).toBe(false);
  });

  it('sí deja emitir al superusuario que además tiene el permiso', () => {
    expect(puedeEmitirNotas(con(APP_PERMISSIONS.SYSTEM_ADMIN, APP_PERMISSIONS.BILLING_NOTES_EMIT))).toBe(true);
  });

  it('no deja emitir a contabilidad ni a caja', () => {
    expect(puedeEmitirNotas(con(APP_PERMISSIONS.AREA_CONTABILIDAD, APP_PERMISSIONS.ACCOUNTING_MANAGE))).toBe(false);
    expect(puedeEmitirNotas(con(APP_PERMISSIONS.AREA_CAJA))).toBe(false);
  });

  it('aguanta la sesión vacía', () => {
    expect(puedeEmitirNotas(null)).toBe(false);
    expect(puedeEmitirNotas(undefined)).toBe(false);
    expect(puedeEmitirNotas({ permissions: [] })).toBe(false);
  });
});

describe('exigirEmisorDeNotas', () => {
  it('no lanza con el permiso', () => {
    expect(() => exigirEmisorDeNotas(con(APP_PERMISSIONS.BILLING_NOTES_EMIT))).not.toThrow();
  });

  it('lanza 403 con un mensaje que dice qué falta', () => {
    expect(() => exigirEmisorDeNotas(con(APP_PERMISSIONS.SYSTEM_ADMIN))).toThrow(/notas crédito/i);
  });
});

describe('permisos nominales', () => {
  it('el rol super-admin NO se lleva los nominales al sembrarse', () => {
    const superAdmin = ALL_ROLES.find((r) => r.key === 'super-admin')!;
    for (const nominal of PERMISOS_NOMINALES) {
      expect(superAdmin.permissions).not.toContain(nominal);
    }
  });

  it('ningún rol del catálogo reparte un permiso nominal', () => {
    for (const rol of ALL_ROLES) {
      for (const nominal of PERMISOS_NOMINALES) {
        expect({ rol: rol.key, tiene: rol.permissions.includes(nominal) }).toEqual({ rol: rol.key, tiene: false });
      }
    }
  });
});
